/**
 * Auth0 Action — Login flow — "capability-consent"
 *
 * Replaces the old hardcoded post-login-scopes Action (which granted every scope to every wallet).
 * Instead, after the user signs in with their wallet, this suspends the login and redirects them to
 * the MCP server's /consent page, where they tick which portfolio capabilities to grant. The page
 * hands the chosen scopes back and we write exactly those into the token.
 *
 * ── Auth0 setup ──────────────────────────────────────────────────────────────────────────────────
 *  1. Actions → Library → Build Custom → Login / Post Login. Paste this. Deploy.
 *  2. Add it to the Login flow.
 *  3. On the Action, add two Secrets:
 *       CONSENT_SECRET  — a long random string. MUST match the Worker's CONSENT_SECRET
 *                         (`wrangler secret put CONSENT_SECRET`, and .dev.vars for local).
 *       CONSENT_URL     — the consent page URL, e.g. https://<worker-host>/consent
 *  4. The custom-claim namespace must be a valid URL (bare hosts are silently dropped by Auth0).
 *
 * The RS (src/auth.ts) merges `https://ymax.app/scopes` into its scope list — custom claims are
 * never filtered for third-party (DCR) apps, unlike api.accessToken.addScope().
 */

const SCOPES_CLAIM = 'https://ymax.app/scopes';
const AGENT_CLAIM = 'https://ymax.app/agent';

exports.onExecutePostLogin = async (event, api) => {
  const token = api.redirect.encodeToken({
    secret: event.secrets.CONSENT_SECRET,
    expiresInSeconds: 300,
    // `sub` (the Auth0 user_id, which embeds the wallet address for SIWE users) is added
    // automatically by encodeToken; the consent page reads it to show who is signing in.
    payload: {},
  });
  api.redirect.sendUserTo(event.secrets.CONSENT_URL, {
    query: { session_token: token },
  });
};

exports.onContinuePostLogin = async (event, api) => {
  // Validates the return token's HS256 signature + expiry, and that its `state` claim matches the
  // state on the /continue request (guards against a token replayed into another session).
  const payload = api.redirect.validateToken({
    secret: event.secrets.CONSENT_SECRET,
    tokenParameterName: 'session_token',
  });
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  api.accessToken.setCustomClaim(SCOPES_CLAIM, scopes);
  // The agent wallet (agoric1…) the consent page provisioned for this user — stamped into the token
  // so the resource server / tools know which Agoric identity acts on the portfolio.
  if (typeof payload.agent === 'string' && payload.agent) {
    api.accessToken.setCustomClaim(AGENT_CLAIM, payload.agent);
  }
};
