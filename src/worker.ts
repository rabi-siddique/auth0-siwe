import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPTransport } from '@hono/mcp';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createServer } from './create-server.js';
import {
  readConfig,
  makeVerifier,
  fetchOAuthMetadata,
  type AuthConfig,
  type Env,
  type VerifyAccessToken,
} from './auth.js';
import { consentPage, consentSubmit } from './consent.js';
import { log } from './log.js';

/**
 * Cloudflare Workers host for the portfolio MCP server (Hono + @hono/mcp).
 *
 * This is the resource-server half of the OAuth setup: it validates Auth0-issued JWTs and gates the
 * tools. Auth0 still does DCR, login (via the self-hosted SIWE connection) and token issuance.
 *
 * The Express host was replaced by this; the token-verification core lives in `auth.ts` and is
 * runtime-agnostic (jose = Web Crypto), so nothing about the auth behaviour changed.
 */

type Vars = { auth: AuthInfo }; // @hono/mcp's transport reads the AuthInfo from `c.get('auth')`.

const SCOPES_SUPPORTED = ['openid', 'profile', 'email'];
const RESOURCE_NAME = 'portfolio-mcp';

// The bearer guard: validates the token via our verifier, stashes the AuthInfo on the context
// (where the transport picks it up), and on failure returns 401 + a WWW-Authenticate header that
// points clients at the protected-resource metadata to kick off discovery/re-auth (RFC 9728).
const bearerAuth = (
  verify: VerifyAccessToken,
  resourceMetadataUrl: string,
): MiddlewareHandler<{ Variables: Vars }> => {
  const challenge = (error?: string, description?: string) =>
    [
      'Bearer',
      error && `error="${error}"`,
      description && `error_description="${description}"`,
      `resource_metadata="${resourceMetadataUrl}"`,
    ]
      .filter(Boolean)
      .join(' ');

  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': challenge(),
      });
    }
    let authInfo: AuthInfo;
    try {
      authInfo = await verify(token);
    } catch (err) {
      const description = err instanceof Error ? err.message : 'invalid token';
      return c.json(
        { error: 'invalid_token', error_description: description },
        401,
        {
          'WWW-Authenticate': challenge('invalid_token', description),
        },
      );
    }
    c.set('auth', authInfo);
    await next();
  };
};

// The RFC 9728 "breadcrumb" naming Auth0 as this resource's authorization server. Served at both the
// resource-suffixed path (what our WWW-Authenticate points at) and the bare path some clients probe.
const protectedResourceMetadata = (config: AuthConfig) => ({
  resource: config.resourceServerUrl.href,
  authorization_servers: [config.issuer],
  scopes_supported: SCOPES_SUPPORTED,
  resource_name: RESOURCE_NAME,
});

const buildApp = (
  config: AuthConfig,
  oauthMetadata: OAuthMetadata,
  verify: VerifyAccessToken,
) => {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use('*', cors());

  // Log every request and its response status + duration.
  app.use('*', async (c, next) => {
    const start = Date.now();
    log(`--> ${c.req.method} ${c.req.path}`);
    await next();
    log(
      `<-- ${c.req.method} ${c.req.path} ${c.res.status} (${Date.now() - start}ms)`,
    );
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const prm = protectedResourceMetadata(config);
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(prm));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(prm));
  // Mirror Auth0's authorization-server metadata for clients that fetch it from the resource origin.
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(oauthMetadata),
  );

  // Capability-selection consent page — a step in Auth0's *login* flow, not the resource server.
  // Auth0's Redirect Action sends the user here after wallet sign-in to pick scopes; unauthenticated
  // by design (no token exists yet). See src/consent.ts + auth0-actions/capability-consent.js.
  app.get('/consent', consentPage);
  app.post('/consent', consentSubmit);

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    config.resourceServerUrl,
  ).toString();

  app.post('/mcp', bearerAuth(verify, resourceMetadataUrl), async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const tool = body?.method === 'tools/call' ? body?.params?.name : undefined;
    log('MCP request:', {
      id: body?.id,
      method: body?.method,
      tool,
      scopes: c.get('auth')?.scopes,
    });

    // Stateless: a fresh server + transport per request (sessionIdGenerator undefined), and
    // enableJsonResponse so the reply is a single JSON body — no long-lived SSE stream to keep a
    // Worker isolate open. Mirrors the previous Express handler.
    const server = createServer();
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c, body);
  });

  // Only POST carries JSON-RPC; GET/DELETE would open/close a session we don't keep.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      },
      405,
    ),
  );

  return app;
};

// Per-isolate memoised setup: read config, fetch Auth0 discovery once, build the verifier + app.
// Env is stable across requests within an isolate, so we build this lazily on the first request.
let setup: Promise<ReturnType<typeof buildApp>> | undefined;

const getApp = (env: Env) => {
  if (!setup) {
    setup = (async () => {
      const config = readConfig(env);
      const oauthMetadata = await fetchOAuthMetadata(config.issuer);
      const verify = makeVerifier(config);
      log('auth: OAuth configured —', {
        issuer: config.issuer,
        audience: config.audience,
        protecting: '/mcp',
      });
      return buildApp(config, oauthMetadata, verify);
    })();
  }
  return setup;
};

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const app = await getApp(env);
    return app.fetch(request, env, ctx);
  },
};
