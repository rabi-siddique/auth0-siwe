# siwe-oidc — Integration & Security Guide

Integrating **siwe-oidc** (an OpenID Connect Identity Provider for Sign-In with
Ethereum) behind **Auth0** or **Keycloak**, plus the security context you need
to run it safely.

> **Scope of this guide**: siwe-oidc acts as an upstream OIDC provider; Auth0 or
> Keycloak is the _relying party_ (RP) that brokers the identity into your app.
> This is a **confidential-client** setup — the RP holds a client secret and
> does the code→token exchange server-to-server.

---

## Table of contents

1. [How it works (mental model)](#1-how-it-works-mental-model)
2. [Security prerequisites — read before deploying](#2-security-prerequisites--read-before-deploying)
3. [Part 1 — Deploy & configure siwe-oidc](#3-part-1--deploy--configure-siwe-oidc)
4. [Part 2 — Configure Keycloak](#4-part-2--configure-keycloak)
5. [Part 3 — Configure Auth0](#5-part-3--configure-auth0)
6. [Part 4 — Runtime request flow](#6-part-4--runtime-request-flow)
7. [The role of `redirect_uri`](#7-the-role-of-redirect_uri)
8. [Do I need PKCE?](#8-do-i-need-pkce)
9. [Security findings summary](#9-security-findings-summary)
10. [Pre-launch checklist](#10-pre-launch-checklist)

---

## 1. How it works (mental model)

There are **two independent trust hops**. Confusing them is the most common
mistake.

| Hop                        | What proves identity                        | Protected by                                               |
| -------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| User ↔ siwe-oidc           | Ethereum wallet signature (EIP-4361 / SIWE) | SIWE: signature, per-session nonce, domain + expiry checks |
| siwe-oidc ↔ Keycloak/Auth0 | the OAuth authorization `code`              | **client secret** (confidential client)                    |

- **SIWE** authenticates the _user_ to siwe-oidc. This is solid in the codebase.
- The **client secret** protects the _code exchange_ between siwe-oidc and your
  RP. PKCE would protect the same hop, but is unnecessary for a confidential RP
  (see [§8](#8-do-i-need-pkce)).

The endpoints split into two groups — this matters for network hardening:

| Group                               | Endpoints                                                                  | Called by                  | Can be IP-restricted to the RP? |
| ----------------------------------- | -------------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| **Front-channel** (browser)         | `/authorize`, `/`, `/sign_in`, `/jwk`, `/.well-known/openid-configuration` | end user's **browser**     | ❌ No — must stay public        |
| **Back-channel** (server-to-server) | `/token`, `/userinfo`, `/register`, `/client/:id`                          | Keycloak/Auth0 **backend** | ✅ Yes                          |

---

## 2. Security prerequisites — read before deploying

Two fixes are **independent of your network setup** and must be done regardless:

1. **Enforce the client secret.** By default `require_secret` is `false`, and the
   secret is only checked _if presented_. With it off, an intercepted `code` can
   be redeemed at `/token` with **no credentials at all**. Set
   `SIWEOIDC_REQUIRE_SECRET=true`.

   > ⚠️ On the **Cloudflare Worker** target this flag is currently **hardcoded
   > `false`** (`src/worker_lib.rs`, in the `/token` handler). To enforce secrets
   > on the Worker you must patch that code. The **stand-alone binary** exposes
   > it as config — prefer the binary for this reason.

2. **Provide a stable RSA signing key, and never log it.** If no key is supplied,
   the binary **generates a new one on every startup and prints it via `info!`**
   (`src/axum_lib.rs`). Consequences: anyone with log access can forge id_tokens,
   and a per-process key breaks multi-instance/restart deployments (JWKS
   mismatch). Always set `SIWEOIDC_RSA_PEM`.

Restricting the service to only Auth0/Keycloak (network ACLs) is good
defense-in-depth but does **not** substitute for the two fixes above — it can't
touch key handling, and it can't cover the browser-facing front-channel.

---

## 3. Part 1 — Deploy & configure siwe-oidc

The **stand-alone binary** serves the frontend _and_ the API on one host (so the
"frontend and API on the same host" requirement is automatic) and lets you
configure `require_secret`. This guide uses it.

### 3a. Build the frontend with a WalletConnect project ID

The shipped Docker image has a **non-functional frontend** because `PROJECT_ID`
is baked in at build time (`js/ui/src/App.svelte` reads `process.env.PROJECT_ID`).
Get a project ID from <https://cloud.walletconnect.com>, then:

```bash
cd js/ui && PROJECT_ID=<your_walletconnect_id> npm install && npm run build
# outputs to /static, which the binary serves
```

### 3b. Generate a stable RSA signing key (PKCS#1 PEM)

```bash
openssl genrsa -traditional -out siwe-oidc.pem 2048
```

### 3c. Run it

Config is [figment](https://docs.rs/figment): env vars prefixed `SIWEOIDC_` map
to the fields in `src/config.rs`.

```bash
docker run -p 8000:8000 \
  -e SIWEOIDC_ADDRESS="0.0.0.0" \
  -e SIWEOIDC_BASE_URL="https://siwe.example.com" \
  -e SIWEOIDC_REDIS_URL="redis://redis:6379" \
  -e SIWEOIDC_REQUIRE_SECRET="true" \
  -e SIWEOIDC_RSA_PEM="$(cat siwe-oidc.pem)" \
  -e SIWEOIDC_DEFAULT_CLIENTS='{keycloak="{\"secret\":\"<STRONG_SECRET>\", \"metadata\": {\"redirect_uris\": [\"https://keycloak.example.com/realms/master/broker/siwe/endpoint\"]}}"}' \
  <your-image>
```

Key points:

- **`SIWEOIDC_BASE_URL`** — the public HTTPS URL, also the host that serves the
  frontend (the binary handles both).
- **`SIWEOIDC_REQUIRE_SECRET=true`** — forces the client secret on `/token`.
- **`SIWEOIDC_DEFAULT_CLIENTS`** — pre-provisions the RP so you don't need open
  dynamic registration. It's a map `client_id = "<JSON ClientEntry>"`. The JSON
  needs just `secret` + `metadata.redirect_uris` (same shape as
  `test/docker-compose.yml`). Here the client_id is `keycloak`.
- **`redirect_uris` must match the broker/callback URL exactly** (host + path;
  query is ignored, fragment forbidden). See [§7](#7-the-role-of-redirect_uri).

### 3d. Config reference (`SIWEOIDC_*`)

| Env var                    | Field                    | Notes                             |
| -------------------------- | ------------------------ | --------------------------------- |
| `SIWEOIDC_ADDRESS`         | bind IP                  | e.g. `0.0.0.0`                    |
| `SIWEOIDC_PORT`            | bind port                | default `8000`                    |
| `SIWEOIDC_BASE_URL`        | issuer / public URL      | advertised in discovery           |
| `SIWEOIDC_REDIS_URL`       | Redis connection         | required for the binary           |
| `SIWEOIDC_RSA_PEM`         | signing key (PKCS#1 PEM) | **always set this**               |
| `SIWEOIDC_REQUIRE_SECRET`  | enforce client secret    | **set `true`**                    |
| `SIWEOIDC_DEFAULT_CLIENTS` | pre-provisioned clients  | map of id → JSON `ClientEntry`    |
| `SIWEOIDC_ETH_PROVIDER`    | Ethereum RPC URL         | optional; enables ENS name/avatar |

### 3e. Verify discovery

```bash
curl https://siwe.example.com/.well-known/openid-configuration
```

Expect: `authorization_endpoint` `/authorize`, `token_endpoint` `/token`,
`userinfo_endpoint` `/userinfo`, `jwks_uri` `/jwk`, RS256 signing, and
`code` / `id_token` response types. This URL is what you paste into
Keycloak/Auth0.

---

## 4. Part 2 — Configure Keycloak

1. **Identity Providers → Add provider → OpenID Connect v1.0.**
2. **Alias**: `siwe` — ⚠️ this becomes part of the redirect URI:
   `https://keycloak.example.com/realms/<realm>/broker/siwe/endpoint`. It must
   equal the `redirect_uris` value from step 3c.
3. **Use discovery endpoint**:
   `https://siwe.example.com/.well-known/openid-configuration` — auto-fills the
   endpoints.
4. **Client ID**: `keycloak` (matches your `DEFAULT_CLIENTS` key).
5. **Client Secret**: `<STRONG_SECRET>` (matches the `secret` in
   `DEFAULT_CLIENTS`).
6. **Client authentication**: _Client secret sent as basic auth_ or _as post_ —
   both are advertised by the metadata and both work.
7. **Default Scopes**: `openid` (add `profile` for ENS username/avatar; those are
   the only two scopes supported).
8. Save. Keycloak now shows a "siwe" button on its login page.

---

## 5. Part 3 — Configure Auth0

Auth0 treats siwe-oidc as an **Enterprise OpenID Connect connection**:

1. **Authentication → Enterprise → OpenID Connect → Create Connection.**
2. **Issuer URL / Discovery**:
   `https://siwe.example.com/.well-known/openid-configuration`.
3. **Client ID / Client Secret**: the values from your `DEFAULT_CLIENTS`.
4. **Type**: **Back-Channel (code flow)** so the exchange happens
   server-to-server with the secret.
5. **Callback URL** (register this as the `redirect_uri` in step 3c instead of
   the Keycloak one): `https://<your-tenant>.auth0.com/login/callback`
   (or your custom-domain equivalent).
6. Enable the connection for your applications.

> **Auth0 + network ACLs**: Auth0 is SaaS with wide, changing egress ranges, so
> IP-allowlisting the back-channel is painful. Prefer the enforced client secret
> (and mTLS if you need transport-level restriction).

---

## 6. Part 4 — Runtime request flow

The browser drives the front-channel; the RP backend drives the back-channel.

```
1. User clicks "Sign in with Ethereum" in Keycloak/Auth0
        │  (browser 302)
        ▼
2. GET  siwe.example.com/authorize?client_id=keycloak
        &redirect_uri=<broker/callback>&state=...&response_type=code&scope=openid
        → validates client_id + redirect_uri, sets a HttpOnly session cookie,
          302s to the frontend
        ▼
3. Browser loads the SIWE frontend → user connects wallet & signs the SIWE
   (EIP-4361) message → frontend stores it in a `siwe` cookie
        ▼
4. GET  siwe.example.com/sign_in?redirect_uri=...&state=...&client_id=keycloak
        → verifies signature, nonce, domain, expiry; mints a one-time `code`;
          302s the browser to:
        ▼
5. <broker/callback>?code=<code>&state=<state>
        → browser lands back on Keycloak/Auth0
   ─────────── front-channel ends, back-channel begins ───────────
        ▼
6. POST siwe.example.com/token           ← RP BACKEND, server-to-server
        Authorization: Basic base64(keycloak:<STRONG_SECRET>)
        body: grant_type=authorization_code&code=<code>&redirect_uri=...
        → checks the secret (require_secret=true), checks the code is unused,
          returns a signed RS256 id_token
        ▼
7. GET  siwe.example.com/userinfo        ← RP BACKEND (optional)
        Authorization: Bearer <access_token>   (access_token == the code)
        → returns sub (eip155:<chain>:<address>), preferred_username (ENS), picture
        ▼
8. RP verifies the id_token against siwe.example.com/jwk, maps
   sub/preferred_username to a local user, and issues ITS OWN session.
```

**Steps 6 and 7 are the only calls Keycloak/Auth0 makes directly to
siwe-oidc** — both server-to-server, both authenticated by the client secret.
Everything in 2–5 is the end user's browser.

---

## 7. The role of `redirect_uri`

The `redirect_uri` is the **callback address** where siwe-oidc sends the user's
browser (carrying the `code`) after sign-in — in this setup, the RP's broker
endpoint. It has **three roles**, two of which are security controls.

### 7.1 Delivery destination for the code

At the end of `/sign_in`, siwe-oidc 302s to this URL with the code appended:

```
https://.../broker/siwe/endpoint?code=<code>&state=<state>
```

That is how the code gets back to the RP (via the browser) for exchange at
`/token`.

### 7.2 Allowlist check — anti-open-redirect / anti-exfiltration

At `/authorize`, the requested `redirect_uri` is compared against the URIs
**registered** for that client and rejected if not present:

```rust
if !r_us.contains(&r_u) {
    return Err(CustomError::Redirect("/error?message=unregistered_redirect_uri"));
}
```

Without this, an attacker could start a flow with
`redirect_uri=https://attacker.com/...` and have the code delivered to their
server. This is why the config value **must match the callback URL exactly**.
Matching: query stripped from both sides, fragments forbidden at registration,
but **host + scheme + path must match exactly**.

### 7.3 Binds the signed SIWE message to this RP

The frontend puts the `redirect_uri` into the SIWE message's `resources`, and
`/sign_in` requires the signed resource to equal the `redirect_uri`, so the user
is cryptographically signing "I'm authenticating for _this_ destination."

### Caveat (see finding #3)

The strong allowlist check happens at **`/authorize`**. `/sign_in` reads
`redirect_uri` fresh from its own query string and only checks role 7.3 — it does
**not** re-validate against the registered list, because the session doesn't
carry the validated value forward. Not an impersonation hole (the code is bound
to whoever signed the SIWE message), but the allowlist guarantee lives entirely
in the `/authorize` step.

---


## 8. Security findings summary

From a review of the codebase:

1. **Code exchange unprotected by default** _(must-fix)_ — `require_secret`
   defaults to `false` (hardcoded `false` on the Worker); the secret is only
   checked if presented. Fix: `SIWEOIDC_REQUIRE_SECRET=true` (+ patch the Worker
   if used).
2. **Ephemeral RSA key, and it's logged** _(must-fix)_ — auto-generated on every
   startup and printed via `info!`; breaks multi-instance and leaks the signing
   key to logs. Fix: always provide `SIWEOIDC_RSA_PEM`; never log it.

---

## 9. Pre-launch checklist

- [ ] Frontend built with a real `PROJECT_ID`
- [ ] Stable `SIWEOIDC_RSA_PEM` provided; key **not** left to auto-generation
- [ ] `SIWEOIDC_REQUIRE_SECRET=true` (binary) / Worker patched if used
- [ ] RP pre-provisioned via `DEFAULT_CLIENTS`; strong secret; `/register` not exposed
- [ ] `redirect_uri` in config matches the broker/callback URL **exactly**
- [ ] Discovery URL returns valid metadata over HTTPS
- [ ] (Optional hardening) `/token` + `/userinfo` network-restricted to the RP
- [ ] TLS enforced on every hop
