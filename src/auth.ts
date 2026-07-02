import type { Express, RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from './log.js';

/**
 * OAuth wiring for the MCP server. This server acts purely as an OAuth *resource server*: it does
 * not run login — it validates the JWT access tokens that Auth0 (the authorization server) issues,
 * and advertises where clients should go to obtain one. See docs/oauth-explained.md.
 */

// The three settings every token is checked against, plus our own public URL for advertising.
type AuthConfig = {
  issuer: string; // expected `iss` claim, e.g. "https://rabi-mcp.us.auth0.com/"
  audience: string; // expected `aud` claim = our Auth0 API identifier
  resourceServerUrl: URL; // this server's public /mcp URL
};

// Read + validate env config. Throws at startup (fail-fast) rather than 401-ing every request later.
const readConfig = (): AuthConfig => {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;
  const serverUrl = process.env.MCP_SERVER_URL;
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
const fetchOAuthMetadata = async (issuer: string): Promise<OAuthMetadata> => {
  const res = await fetch(new URL('.well-known/openid-configuration', issuer));
  if (!res.ok) {
    throw new Error(`Failed to fetch Auth0 OIDC metadata: ${res.status}`);
  }
  return (await res.json()) as OAuthMetadata;
};

// Builds the token verifier — the actual security gate, called on every authenticated request.
const makeVerifier = (config: AuthConfig) => {
  // `.well-known/jwks.json` (RFC 7517) — the provider's public signing keys, also a standard path.
  // createRemoteJWKSet fetches and caches them, so verification stays local (no network per request).
  const jwks = createRemoteJWKSet(
    new URL('.well-known/jwks.json', config.issuer),
  );
  const verifyAccessToken = async (token: string): Promise<AuthInfo> => {
    // The core check: validates signature (against Auth0's keys) + issuer + audience + expiry.
    // Throws on any mismatch — the caller (requireBearerAuth) turns that into a 401.
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid token';
      log('auth: token REJECTED —', message);
      // Rethrow as InvalidTokenError so requireBearerAuth responds 401 (+ WWW-Authenticate),
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
      sub: payload.sub, // which user (from Google, via Auth0)
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
  return { verifier: { verifyAccessToken } };
};

/**
 * Wire OAuth into the Express app and return the middleware that guards `/mcp`.
 * Call once at startup: `const requireAuth = await setupAuth(app)`.
 */
export const setupAuth = async (app: Express): Promise<RequestHandler> => {
  const config = readConfig();
  const oauthMetadata = await fetchOAuthMetadata(config.issuer);
  log('auth: OAuth configured —', {
    issuer: config.issuer,
    audience: config.audience,
    protecting: '/mcp',
  });

  // Serve /.well-known/oauth-protected-resource/mcp — the "breadcrumb" that tells clients
  // this is a protected resource and names Auth0 as its authorization server (RFC 9728).
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: config.resourceServerUrl,
      resourceName: 'portfolio-mcp',
      scopesSupported: ['openid', 'profile', 'email'],
    }),
  );

  // The guard: validates the Bearer token via our verifier; on failure responds 401 with a
  // WWW-Authenticate header pointing at the metadata above, which kicks off client discovery.
  const { verifier } = makeVerifier(config);
  return requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
      config.resourceServerUrl,
    ),
  });
};
