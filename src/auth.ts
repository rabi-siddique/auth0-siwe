import { createRemoteJWKSet, jwtVerify } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from './log.js';

/**
 * OAuth wiring for the MCP server. This server acts purely as an OAuth *resource server*: it does
 * not run login — it validates the JWT access tokens that Auth0 (the authorization server) issues,
 * and advertises where clients should go to obtain one.
 *
 * Everything here is platform-agnostic (jose uses Web Crypto, discovery is a plain fetch), so the
 * same verifier runs on Cloudflare Workers. The Hono host in `worker.ts` wires it in.
 */

// The env bindings the resource server needs. On Workers these come from `c.env` (wrangler vars).
export type Env = {
  AUTH0_DOMAIN: string; // e.g. "rabi-mcp.us.auth0.com" — derives issuer + discovery + JWKS
  AUTH0_AUDIENCE: string; // expected `aud` claim = our Auth0 API identifier
  MCP_SERVER_URL: string; // this server's public /mcp URL; drives the resource-metadata document
};

// The three settings every token is checked against, plus our own public URL for advertising.
export type AuthConfig = {
  issuer: string; // expected `iss` claim, e.g. "https://rabi-mcp.us.auth0.com/"
  audience: string; // expected `aud` claim = our Auth0 API identifier
  resourceServerUrl: URL; // this server's public /mcp URL
};

// Read + validate env config. Throws at startup (fail-fast) rather than 401-ing every request later.
export const readConfig = (env: Partial<Env>): AuthConfig => {
  const domain = env.AUTH0_DOMAIN;
  const audience = env.AUTH0_AUDIENCE;
  const serverUrl = env.MCP_SERVER_URL;
  if (!domain || !audience || !serverUrl) {
    throw new Error(
      'Missing auth env vars: AUTH0_DOMAIN, AUTH0_AUDIENCE, MCP_SERVER_URL are all required.',
    );
  }
  return {
    issuer: `https://${domain}/`,
    audience,
    resourceServerUrl: new URL(serverUrl),
  };
};

// `.well-known/openid-configuration` is a spec-defined path (RFC 8414 / OIDC Discovery), so any
// compliant provider serves its endpoints here — we derive them all from just the issuer domain.
// We fetch Auth0's *real* document (rather than synthesising endpoints) because Auth0 uses
// non-standard paths (`/oauth/token`, `/oidc/register`) that a synthesiser would get wrong.
export const fetchOAuthMetadata = async (
  issuer: string,
): Promise<OAuthMetadata> => {
  const res = await fetch(new URL('.well-known/openid-configuration', issuer));
  if (!res.ok) {
    throw new Error(`Failed to fetch Auth0 OIDC metadata: ${res.status}`);
  }
  return (await res.json()) as OAuthMetadata;
};

// The verified token, repackaged into the SDK's AuthInfo shape (ends up on the tool `extra.authInfo`).
export type VerifyAccessToken = (token: string) => Promise<AuthInfo>;

// Builds the token verifier — the actual security gate, called on every authenticated request.
export const makeVerifier = (config: AuthConfig): VerifyAccessToken => {
  // `.well-known/jwks.json` (RFC 7517) — the provider's public signing keys, also a standard path.
  // createRemoteJWKSet fetches and caches them, so verification stays local (no network per request).
  const jwks = createRemoteJWKSet(
    new URL('.well-known/jwks.json', config.issuer),
  );
  return async (token: string): Promise<AuthInfo> => {
    // The core check: validates signature (against Auth0's keys) + issuer + audience + expiry.
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
    // TEMP DEBUG: dump the ENTIRE decoded payload so we see every claim Auth0 issues.
    log('auth: FULL token payload —', JSON.stringify(payload, null, 2));
    // Repackage the JWT claims into the SDK's AuthInfo shape (ends up on `req.auth`).
    // Merge three claim styles into one scope list (per-tool gating checks it):
    //  - `scope`      : space-delimited OAuth scopes
    //  - `permissions`: array added by Auth0 RBAC
    //  - `https://ymax.app/scopes`: namespaced custom claim set by an Auth0 Action — Auth0 never
    //    filters custom claims, so this reliably carries scopes for third-party (DCR) apps.
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
    log('auth: token verified —', {
      sub: payload.sub, // which user (the wallet address, via SIWE)
      clientId, // which MCP client (ChatGPT's DCR id)
      scopes, // granted scopes/permissions
    });
    return {
      token,
      clientId,
      scopes,
      expiresAt: payload.exp,
      extra: { sub: payload.sub }, // `sub` = the user id, in case a tool needs to know who called.
    };
  };
};
