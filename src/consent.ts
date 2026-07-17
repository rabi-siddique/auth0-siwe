import type { Context } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { AVAILABLE_SCOPES, AVAILABLE_SCOPE_SET } from './scopes.js';
import { createAgentWallet } from './wallet.js';
import type { Env } from './auth.js';
import { log } from './log.js';

/**
 * Capability-selection consent page (the "authorization screen with checkboxes").
 *
 * This is NOT part of the resource-server core — it's a step in Keycloak's *login* flow. A custom
 * Keycloak Authenticator (see `keycloak/authenticator/`) suspends login right after the user signs
 * in with their wallet (brokered through the siwe-oidc identity provider) and redirects them here to
 * pick which portfolio capabilities to grant. We render checkboxes, and on submit redirect back to
 * the Keycloak action URL the authenticator handed us, carrying the chosen scopes so the authenticator
 * can write them onto the user (a User Attribute mapper then projects them into the token).
 *
 * Trust model — the authenticator and this page share a symmetric secret (`CONSENT_SECRET`, HS256):
 *  - inbound  `session_token` (minted by the authenticator) proves the request is part of a real,
 *    in-flight Keycloak login — we verify its signature + expiry before rendering or accepting.
 *  - outbound `session_token` (minted here) proves to the authenticator that the selection came from
 *    this page; it carries the chosen `scopes`, the `agent` wallet, and the `state` the authenticator
 *    checks against its auth-session note.
 *  - `redirect_uri` is the Keycloak `login-actions/authenticate` URL that re-enters the authenticator;
 *    we validate it against the configured Keycloak issuer origin to prevent an open redirect.
 * Neither token grants anything on its own — the user can only ever scope down their own login.
 *
 * NOTE: `CONSENT_SECRET` must be at least 32 bytes. The Keycloak side signs/verifies with Nimbus
 * (com.nimbusds), which rejects HS256 keys shorter than 256 bits; `jose` here would accept a shorter
 * one, so the 32-byte floor is what keeps both sides interoperable.
 */

const encoder = new TextEncoder();
const RETURN_TOKEN_TTL = '5m';

const secretKey = (secret: string) => encoder.encode(secret);

// Verify the token the Keycloak authenticator minted. jwtVerify checks HS256 signature + expiry.
const verifyInbound = (token: string, secret: string) =>
  jwtVerify(token, secretKey(secret)).then(({ payload }) => payload);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// The `sub` on the inbound token is the Keycloak user_id; for SIWE users it embeds the wallet address.
const walletFromSub = (sub: string) =>
  sub.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? sub;

// Guard against an open redirect: the return URL must live on the Keycloak issuer's origin.
const isTrustedRedirect = (redirectUri: string, issuer: string) => {
  try {
    return new URL(redirectUri).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
};

const renderConsent = (params: {
  token: string;
  state: string;
  redirectUri: string;
  address: string;
  agentAddress: string;
}) => {
  const { token, state, redirectUri, address, agentAddress } = params;
  const checkboxes = AVAILABLE_SCOPES.map(
    (s) => `
        <label class="scope">
          <input type="checkbox" name="scope" value="${escapeHtml(s.scope)}" checked />
          <span class="scope-text">
            <span class="scope-label">${escapeHtml(s.label)}</span>
            <code class="scope-name">${escapeHtml(s.scope)}</code>
            <span class="scope-desc">${escapeHtml(s.description)}</span>
          </span>
        </label>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize portfolio access</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #f5f5f7; color: #1d1d1f; padding: 24px;
    }
    .card {
      width: 100%; max-width: 460px; background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.08); padding: 32px; border: 1px solid #ececef;
    }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #6e6e73; font-size: 13px; margin: 0 0 20px; }
    .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      background: #f0f0f2; padding: 2px 6px; border-radius: 6px; word-break: break-all; }
    .agent { display: flex; flex-direction: column; gap: 4px; margin: 0 0 20px; padding: 12px 14px;
      border: 1px solid #e5e5ea; border-radius: 12px; background: #f9f9fb; }
    .agent-title { font-size: 12px; font-weight: 600; color: #6e6e73; }
    .agent-addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      word-break: break-all; color: #1d1d1f; }
    .scopes { display: flex; flex-direction: column; gap: 10px; margin: 20px 0 24px; }
    .scope { display: flex; gap: 12px; align-items: flex-start; padding: 14px;
      border: 1px solid #e5e5ea; border-radius: 12px; cursor: pointer; transition: border-color .15s; }
    .scope:hover { border-color: #c7c7cc; }
    .scope input { margin-top: 3px; width: 18px; height: 18px; accent-color: #0071e3; flex: none; }
    .scope-text { display: flex; flex-direction: column; gap: 2px; }
    .scope-label { font-weight: 600; }
    .scope-name { font-family: ui-monospace, monospace; font-size: 11px; color: #6e6e73; }
    .scope-desc { font-size: 13px; color: #6e6e73; }
    .actions { display: flex; gap: 10px; }
    button { flex: 1; font-size: 15px; font-weight: 600; padding: 12px; border-radius: 10px;
      border: none; cursor: pointer; }
    .allow { background: #0071e3; color: #fff; }
    .allow:hover { background: #0077ed; }
    .deny { background: #f0f0f2; color: #1d1d1f; }
    .deny:hover { background: #e5e5ea; }
    @media (prefers-color-scheme: dark) {
      body { background: #000; color: #f5f5f7; }
      .card { background: #1c1c1e; border-color: #2c2c2e; box-shadow: none; }
      .addr, .deny { background: #2c2c2e; color: #f5f5f7; }
      .agent { background: #161618; border-color: #2c2c2e; }
      .agent-addr { color: #f5f5f7; }
      .scope { border-color: #2c2c2e; }
      .scope:hover { border-color: #48484a; }
      .scope-name, .scope-desc, .sub { color: #98989d; }
    }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/consent">
    <h1>Authorize portfolio access</h1>
    <p class="sub">Signed in as <span class="addr">${escapeHtml(address)}</span>. Choose which capabilities to grant this connection.</p>
    <div class="agent">
      <span class="agent-title">An agent wallet was created to act on your behalf</span>
      <code class="agent-addr">${escapeHtml(agentAddress)}</code>
    </div>
    <input type="hidden" name="session_token" value="${escapeHtml(token)}" />
    <input type="hidden" name="state" value="${escapeHtml(state)}" />
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
    <input type="hidden" name="agent" value="${escapeHtml(agentAddress)}" />
    <div class="scopes">${checkboxes}</div>
    <div class="actions">
      <button class="deny" type="submit" name="deny" value="1">Deny all</button>
      <button class="allow" type="submit">Authorize</button>
    </div>
  </form>
</body>
</html>`;
};

// GET /consent — Keycloak redirects the user here mid-login with
// `?session_token=<jwt>&state=<state>&redirect_uri=<login-actions URL>`.
export const consentPage = async (c: Context<{ Bindings: Env }>) => {
  const secret = c.env.CONSENT_SECRET;
  const issuer = c.env.KEYCLOAK_ISSUER;
  if (!secret || !issuer) {
    log('consent: CONSENT_SECRET or KEYCLOAK_ISSUER not configured');
    return c.text('Consent not configured.', 500);
  }
  const token = c.req.query('session_token') ?? '';
  const state = c.req.query('state') ?? '';
  const redirectUri = c.req.query('redirect_uri') ?? '';
  if (!token || !state || !redirectUri) {
    return c.text('Missing session_token, state, or redirect_uri.', 400);
  }
  if (!isTrustedRedirect(redirectUri, issuer)) {
    log('consent: untrusted redirect_uri —', redirectUri);
    return c.text('Untrusted redirect_uri.', 400);
  }

  let payload;
  try {
    payload = await verifyInbound(token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    log('consent: inbound token rejected —', message);
    return c.text('Invalid or expired login session.', 400);
  }
  const address = walletFromSub(String(payload.sub ?? ''));
  // PAK-550: create the agent wallet that would act on the user's behalf, then show it on the
  // consent screen. Prototype — the key is not persisted (see src/wallet.ts).
  //
  // Extension point (PAK-550 multi-agent): instead of minting one fresh wallet, fetch the user's
  // existing agents here (keyed by `payload.sub`) and let them authorize per-agent. The plumbing —
  // inbound `sub`, per-capability checkboxes, signed return token — already supports carrying that
  // richer selection; only this render + the POST aggregation would grow.
  const agent = createAgentWallet();
  log('consent: agent wallet created —', {
    sub: payload.sub,
    agent: agent.address,
  });
  return c.html(
    renderConsent({
      token,
      state,
      redirectUri,
      address,
      agentAddress: agent.address,
    }),
  );
};

// POST /consent — the user's selection. Validate, then hand the chosen scopes back to Keycloak's
// login-actions URL via a signed return token that carries `state` (the authenticator checks it) +
// `scopes` + `agent`.
export const consentSubmit = async (c: Context<{ Bindings: Env }>) => {
  const secret = c.env.CONSENT_SECRET;
  const issuer = c.env.KEYCLOAK_ISSUER;
  if (!secret || !issuer) {
    log('consent: CONSENT_SECRET or KEYCLOAK_ISSUER not configured');
    return c.text('Consent not configured.', 500);
  }
  // `all: true` so a repeated checkbox name (`scope`) parses to an array rather than the last value.
  const form = await c.req.parseBody({ all: true });
  const token = String(form.session_token ?? '');
  const state = String(form.state ?? '');
  const redirectUri = String(form.redirect_uri ?? '');
  if (!token || !state || !redirectUri) {
    return c.text('Missing session_token, state, or redirect_uri.', 400);
  }
  if (!isTrustedRedirect(redirectUri, issuer)) {
    log('consent: untrusted redirect_uri on submit —', redirectUri);
    return c.text('Untrusted redirect_uri.', 400);
  }

  let payload;
  try {
    payload = await verifyInbound(token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    log('consent: inbound token rejected on submit —', message);
    return c.text('Invalid or expired login session.', 400);
  }

  // "Deny all" grants nothing; otherwise keep the checked scopes that are actually in our catalog.
  const raw = form.deny ? [] : (form.scope ?? []);
  const selected = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const scopes = [...new Set(selected)].filter((s) =>
    AVAILABLE_SCOPE_SET.has(s),
  );
  // The agent wallet shown on the consent page (carried in a hidden field) — passed back so the
  // authenticator can stamp it as the `ymax_agent` user attribute → `https://ymax.app/agent` claim.
  const agent = String(form.agent ?? '');

  // The return token echoes the standard claims the authenticator checks: `sub` (the Keycloak
  // user_id, echoed from the inbound token), `state` (matched against the auth-session note to block
  // replay), `exp`, plus the consent selection (`scopes`, `agent`).
  const reqUrl = new URL(c.req.url);
  const returnToken = await new SignJWT({ scopes, state, agent })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(payload.sub ?? ''))
    .setIssuer(`${reqUrl.origin}${reqUrl.pathname}`)
    .setIssuedAt()
    .setExpirationTime(RETURN_TOKEN_TTL)
    .sign(secretKey(secret));

  // Re-enter the Keycloak authenticator: the redirect_uri is its login-actions URL (already carrying
  // code/execution/tab_id); we append our signed selection as `session_token`.
  const url = new URL(redirectUri);
  url.searchParams.set('session_token', returnToken);
  log('consent: scopes selected —', { sub: payload.sub, scopes, agent });
  return c.redirect(url.toString(), 302);
};
