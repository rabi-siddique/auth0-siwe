import { createRemoteJWKSet, jwtVerify } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from './log.js';

/**
 * OAuth wiring for the MCP server. This server acts purely as an OAuth *resource server*: it does
 * not run login — it validates the JWT access tokens that Keycloak (the authorization server) issues,
 * and advertises where clients should go to obtain one.
 *
 * Everything here is platform-agnostic (jose uses Web Crypto, discovery is a plain fetch), so the
 * same verifier runs on Cloudflare Workers. The Hono host in `worker.ts` wires it in.
 */

// The env bindings the resource server needs. On Workers these come from `c.env` (wrangler vars).
export type Env = {
  KEYCLOAK_ISSUER: string; // full realm issuer, e.g. "https://<host>/realms/ymax" — NO trailing slash
  KEYCLOAK_AUDIENCE: string; // expected `aud` claim (stamped by the realm's Audience mapper)
  MCP_SERVER_URL: string; // this server's public /mcp URL; drives the resource-metadata document
  CONSENT_SECRET?: string; // HS256 secret shared with the Keycloak consent-redirect authenticator (see src/consent.ts)
};

// The settings every token is checked against, plus our own public URL for advertising.
export type AuthConfig = {
  issuer: string; // expected `iss` claim, e.g. "https://<host>/realms/ymax"
  audience: string; // expected `aud` claim
  resourceServerUrl: URL; // this server's public /mcp URL
};

// Read + validate env config. Throws at startup (fail-fast) rather than 401-ing every request later.
export const readConfig = (env: Partial<Env>): AuthConfig => {
  const issuer = env.KEYCLOAK_ISSUER;
  const audience = env.KEYCLOAK_AUDIENCE;
  const serverUrl = env.MCP_SERVER_URL;
  if (!issuer || !audience || !serverUrl) {
    throw new Error(
      'Missing auth env vars: KEYCLOAK_ISSUER, KEYCLOAK_AUDIENCE, MCP_SERVER_URL are all required.',
    );
  }
  return {
    // Keycloak's `iss` has no trailing slash (e.g. https://host/realms/ymax); strip a stray one so
    // the value matches the token exactly and relative-URL joins below behave.
    issuer: issuer.replace(/\/$/, ''),
    audience,
    resourceServerUrl: new URL(serverUrl),
  };
};

// `.well-known/openid-configuration` is a spec-defined path (RFC 8414 / OIDC Discovery), so any
// compliant provider serves its endpoints here. Keycloak serves it under the realm issuer, e.g.
// `https://<host>/realms/ymax/.well-known/openid-configuration`. We read the real document (rather
// than synthesise endpoints) so we pick up the provider's actual token/jwks/registration URLs.
export const fetchOAuthMetadata = async (
  issuer: string,
): Promise<OAuthMetadata> => {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Keycloak OIDC metadata: ${res.status}`);
  }
  return (await res.json()) as OAuthMetadata;
};

// The verified token, repackaged into the SDK's AuthInfo shape (ends up on the tool `extra.authInfo`).
export type VerifyAccessToken = (token: string) => Promise<AuthInfo>;

// Builds the token verifier — the actual security gate, called on every authenticated request.
// `jwksUri` comes from the discovery document (Keycloak serves keys at
// `.../protocol/openid-connect/certs`, NOT `.well-known/jwks.json`), so we never hardcode the path.
export const makeVerifier = (
  config: AuthConfig,
  jwksUri: string,
): VerifyAccessToken => {
  // createRemoteJWKSet fetches and caches the provider's public signing keys, so verification stays
  // local (no network per request).
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  return async (token: string): Promise<AuthInfo> => {
    // The core check: validates signature (against Keycloak's keys) + issuer + audience + expiry.
    // Throws on any mismatch — the caller turns that into a 401.
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid token';
      log('auth: token REJECTED —', message);
      // Rethrow as InvalidTokenError so the bearer middleware responds 401 (+ WWW-Authenticate),
      // not 500 — a 401 is what tells the client to re-authenticate.
      throw new InvalidTokenError(message);
    }
    // Repackage the JWT claims into the SDK's AuthInfo shape (ends up on `req.auth`).
    // Merge three claim styles into one scope list (per-tool gating checks it):
    //  - `scope`      : space-delimited OAuth scopes
    //  - `permissions`: array (from role/authorization mappers, if used)
    //  - `https://ymax.app/scopes`: namespaced custom claim set by the consent-redirect authenticator
    //    via a User Attribute protocol mapper — the reliable carrier for consent-selected scopes.
    const scopeClaim =
      typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
    const permissionClaim = Array.isArray(payload.permissions)
      ? (payload.permissions as string[])
      : [];
    const customScopeClaim = Array.isArray(payload['https://ymax.app/scopes'])
      ? (payload['https://ymax.app/scopes'] as string[])
      : [];
    const scopes = [
      ...new Set([...scopeClaim, ...permissionClaim, ...customScopeClaim]),
    ];
    const clientId =
      (payload.azp as string) ?? (payload.client_id as string) ?? '';
    // The Ethereum wallet the user signed in with. Unlike Auth0, Keycloak's `sub` is the internal
    // user UUID, NOT the wallet — so the wallet is carried in a dedicated claim (`wallet_address`
    // user attribute → `https://ymax.app/wallet`, via a User Attribute mapper). We expose it as the
    // authInfo `sub` so downstream portfolio-ownership checks find the `0x…` address there.
    const wallet =
      typeof payload['https://ymax.app/wallet'] === 'string'
        ? (payload['https://ymax.app/wallet'] as string)
        : undefined;
    // The agent wallet the user provisioned at consent (set by the authenticator, projected by a
    // User Attribute mapper). A tool would use this as the Agoric identity acting on the portfolio.
    const agent =
      typeof payload['https://ymax.app/agent'] === 'string'
        ? (payload['https://ymax.app/agent'] as string)
        : undefined;
    log('auth: token verified —', {
      sub: payload.sub, // Keycloak user UUID
      wallet, // the Ethereum wallet (via SIWE)
      clientId, // which MCP client (its DCR id)
      scopes, // granted scopes/permissions
      agent, // the agent wallet (agoric1…) provisioned at consent
    });
    return {
      token,
      clientId,
      scopes,
      expiresAt: payload.exp,
      // `sub` here = the wallet (for portfolio-ownership checks), falling back to the Keycloak
      // user id if the wallet claim is absent; `agent` = the agent wallet address.
      extra: { sub: wallet ?? payload.sub, agent },
    };
  };
};
