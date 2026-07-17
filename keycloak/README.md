# Self-hosted Keycloak — authorization server for the Ymax MCP setup

Keycloak plays the OAuth **authorization server** role (DCR, login, token issuance) that Auth0 used
to. It delegates wallet login to the self-hosted `siwe-oidc` provider (as an OIDC identity provider)
and runs a custom **consent-redirect authenticator** that bounces the user to the MCP server's
`/consent` page mid-login, exactly like the old Auth0 Redirect Action.

```
MCP client ──DCR + OAuth──▶ Keycloak (realm: ymax) ──OIDC broker──▶ siwe-oidc ──▶ wallet signature
                              │  consent-redirect authenticator ──▶ MCP /consent page
                              └─ issues JWT: aud=<mcp>/mcp, https://ymax.app/{wallet,scopes,agent}
```

## What's in here

| Path                 | What                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` | Keycloak + Postgres. Brings the whole thing up.                                                                                  |
| `Dockerfile`         | Builds the authenticator JAR (Maven stage) and layers it + the realm onto Keycloak.                                              |
| `realm-export.json`  | Realm `ymax`: the `siwe-oidc` IdP, its attribute importer, and the `ymax-portfolio` client scope with all four protocol mappers. |
| `authenticator/`     | Maven module → the `ymax-consent-redirect` authenticator (`provider.jar`).                                                       |

> The realm export covers the **declarative, version-stable** parts. The five steps below (**§3**) are
> done in the admin console / `kcadm` because they're either version-fragile to hand-author (the
> browser flow) or environment-specific (secrets). This split is deliberate.

## 1. Bring it up

```bash
# CONSENT_SECRET must be >= 32 bytes and equal the Worker's CONSENT_SECRET.
export CONSENT_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

Keycloak: `http://localhost:8080` (admin console `/admin`, `admin`/`admin`). The `ymax` realm is
imported on **first boot only** — to re-apply an edited `realm-export.json`, `docker compose down -v`
(drops the Postgres volume) then `up` again.

## 2. What the realm import already sets up

- **`siwe-oidc` identity provider** (OIDC v1.0) — endpoints/secret are placeholders (`REPLACE-…`); fill
  them in step 3.4.
- **IdP attribute importer** — copies the incoming `sub` (the `eip155:1:0x…` wallet) into the
  `wallet_address` user attribute. (Keycloak's own `sub` is the internal user UUID, so the wallet
  must ride in a claim — see the mappers below.)
- **`ymax-portfolio` client scope** with four access-token mappers:
  - `wallet_address` → `https://ymax.app/wallet` (the MCP server reads the wallet from here)
  - `ymax_scopes` (multivalued) → `https://ymax.app/scopes`
  - `ymax_agent` → `https://ymax.app/agent`
  - **Audience** → hardcoded `aud` (placeholder `REPLACE-with-https://<worker-url>/mcp`)

  > The dots in the claim names are escaped (`https://ymax\.app/…`) on purpose: Keycloak treats an
  > unescaped dot as a nested-object separator, which would bury the claim under `ymax → app/…`. The
  > emitted claim string is still the flat `https://ymax.app/scopes`.

## 3. Finish the setup (console / `kcadm`)

`kcadm` lives in the container: `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh`. Log in
first: `… config credentials --server http://localhost:8080 --realm master --user admin --password admin`.

### 3.1 Make `ymax-portfolio` a realm **default** client scope (critical for DCR)

DCR-registered clients (ChatGPT/Claude) only inherit **default** client scopes. Without this they get
none of the custom claims or the audience.

- Console: **Realm settings → Client scopes** is per-client; use **Client scopes → ymax-portfolio →**
  set as realm default via _Realm settings → Client scopes → Add_ **Default**. Or `kcadm`:
  ```bash
  kcadm.sh update realms/ymax/default-default-client-scopes/<ymax-portfolio-id> -r ymax
  ```
  (Get the id with `kcadm.sh get client-scopes -r ymax --fields id,name`.)

### 3.2 Enable unmanaged user attributes

The authenticator writes `ymax_scopes` / `ymax_agent` as user attributes; strict user-profile
handling rejects undeclared attributes otherwise.

- Console: **Realm settings → User profile → Unmanaged Attributes → Enabled**.

### 3.3 Relax anonymous DCR (Trusted Hosts)

Anonymous DCR is **off by default** (Trusted Hosts policy, empty host list). MCP clients register from
unpredictable IPs/callback URIs, so for this POC we relax the host/URI matching (mirrors the old Auth0
"open DCR"; production should prefer Initial Access Tokens — see the design doc follow-ups).

- Console: **Realm settings → Client registration → Anonymous access policies**:
  - **Trusted Hosts** → turn off _Host Sending Registration Request Must Match_ and _Client URIs Must
    Match_ (or add your trusted hosts).
  - **Max Clients** → raise from the default **200** to a comfortable ceiling.

### 3.4 Point the `siwe-oidc` IdP at your instance

Register a client on your siwe-oidc instance with Keycloak's broker callback as the redirect URI:

```bash
curl -X POST https://<your-siwe-url>/register \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:8080/realms/ymax/broker/siwe-oidc/endpoint"]}'
```

Then in **Identity providers → siwe-oidc**, either paste the siwe-oidc **Discovery endpoint**
(`https://<your-siwe-url>/.well-known/openid-configuration`) to auto-fill the URLs, or replace the
`REPLACE-…` values, and set the **Client ID / Client Secret** from the `/register` response.

### 3.5 Wire the consent-redirect authenticator into the browser flow

Hand-authoring the browser flow in JSON is version-fragile, so do it in the console (one-time, ~1 min):

1. **Authentication → Flows →** duplicate **browser** → name it `browser-ymax`.
2. At the **end** of `browser-ymax`, **Add step → "Ymax Consent Redirect"**, set requirement
   **Required**.
3. On that step, **⚙ Config** → set **Consent page URL** = `http://localhost:8787/consent` (the MCP
   server's public `/consent`; use the deployed Worker URL in prod).
4. **Action → Bind flow → Browser flow**.

The shared secret is passed to the authenticator via the `KC_SPI_AUTHENTICATOR_YMAX_CONSENT_REDIRECT_SECRET`
env in `docker-compose.yml` — not a per-execution config property (those are readable in the console).

## 4. Endpoints the MCP resource server uses

- Issuer: `http://localhost:8080/realms/ymax` (**no** trailing slash)
- Discovery: `…/realms/ymax/.well-known/openid-configuration`
- JWKS: `…/realms/ymax/protocol/openid-connect/certs` (the server reads this from `jwks_uri`, never hardcoded)
- DCR: `…/realms/ymax/clients-registrations/openid-connect`

Set the MCP server's `KEYCLOAK_ISSUER` to the issuer above and `KEYCLOAK_AUDIENCE` = `MCP_SERVER_URL`
= the same `/mcp` URL you put in the Audience mapper (§2 / §3, `REPLACE-with-…`).

## 4b. Deploy to production (Sevalla)

A hosted MCP client (ChatGPT / Claude) can't reach `localhost`, so Keycloak needs a public HTTPS URL.
Sevalla is the natural home (siwe-oidc already lives there). The image (Dockerfile) is production-ready:
it bakes an optimized build and defaults to `start --optimized --import-realm`.

1. **Postgres** — Sevalla → Databases → Postgres. Note the internal host/port/db/user/password.
2. **Deploy the app** — Sevalla → Application → this repo, **Dockerfile path `keycloak/Dockerfile`**,
   **build context `keycloak`** (the `COPY authenticator/…` / `realm-export.json` paths are relative to
   it), container **port 8080**. Set env (below), deploy, copy the public URL, then set `KC_HOSTNAME`
   to it and redeploy (same chicken-and-egg as siwe-oidc's `BASE_URL`).

   | Env | Value |
   | --- | --- |
   | `KC_DB_URL` | `jdbc:postgresql://<internal-host>:5432/<db>` |
   | `KC_DB_USERNAME` / `KC_DB_PASSWORD` | from step 1 |
   | `KC_HOSTNAME` | `https://<keycloak-host>` (the app's public URL) |
   | `KC_PROXY_HEADERS` | `xforwarded` (Sevalla terminates TLS, forwards HTTP) |
   | `KC_HTTP_ENABLED` | `true` |
   | `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` | initial admin |
   | `KC_SPI_AUTHENTICATOR_YMAX_CONSENT_REDIRECT_SECRET` | the shared consent secret (≥32 bytes; = the Worker's `CONSENT_SECRET`) |

   (`KC_DB=postgres` is baked into the image.) A wrong/unset `KC_HOSTNAME` is the #1 failure — the
   token `iss` would then not match the Worker's `KEYCLOAK_ISSUER` and every call 401s.
3. **Finish realm config** — do the five §3 steps against `https://<keycloak-host>/admin`. For the
   consent authenticator's **Consent page URL**, use the deployed Worker's `/consent`
   (`https://auth0-siwe-mcp.rs-first-cf.workers.dev/consent`).
4. **Register the siwe-oidc client** with the deployed broker callback:
   ```bash
   curl -X POST https://siwe-oidc-qct6w.sevalla.app/register -H 'Content-Type: application/json' \
     -d '{"redirect_uris":["https://<keycloak-host>/realms/ymax/broker/siwe-oidc/endpoint"]}'
   ```
   Put the returned `client_id`/`client_secret` into the `siwe-oidc` IdP (§3.4).
5. **Point the Worker at deployed Keycloak** — in `wrangler.toml` set
   `KEYCLOAK_ISSUER=https://<keycloak-host>/realms/ymax`; keep `KEYCLOAK_AUDIENCE` = `MCP_SERVER_URL` =
   the Worker's `/mcp` URL and set the realm **Audience mapper** to that same value;
   `wrangler secret put CONSENT_SECRET` (same value as the SPI secret); `yarn deploy`.
6. **Connect the client** — add the connector pointing at the Worker's `/mcp` URL. It discovers
   Keycloak, self-registers (DCR), runs SIWE login → consent → token → tool calls.

> Realm import runs only when the realm doesn't yet exist, so your five §3 console changes persist in
> Postgres across restarts. To re-apply an edited `realm-export.json`, drop/recreate the Postgres DB.

## 5. Status / validation

Validated live against Keycloak 26.7.0 (Docker) during authoring:

- **Image builds** — the `authenticator/` Maven module compiles and `keycloak-consent-redirect.jar`
  lands in `/opt/keycloak/providers/`. The provider dependency set is `keycloak-server-spi`,
  `keycloak-server-spi-private`, `keycloak-core` (for `org.keycloak.Config`) and `keycloak-common`,
  all `provided` — deliberately **not** `keycloak-services` (the whole server impl; a huge transitive
  download this authenticator doesn't need). The Dockerfile uses a single `mvn package` with a BuildKit
  `.m2` cache mount, so rebuilds don't re-download deps.
- **Realm imports cleanly** — `realm-export.json` imports with no errors; the `ymax-portfolio` client
  scope (all four mappers, dot-escaped claim names), the `siwe-oidc` IdP and its `sub → wallet_address`
  importer all land as intended (checked via the admin API).
- **Provider registers** — Keycloak loads `ymax-consent-redirect` and it's available to bind into a
  flow (§3.5).

Still requires a real run to verify (needs a browser wallet + siwe-oidc up + an MCP client):

- The **end-to-end login/token round-trip** — wallet signature → consent screen → the
  `https://ymax.app/{wallet,scopes,agent}` claims + `aud` landing in the issued token → an authenticated
  tool call. The five console steps in §3 are required before this works.

Caveats:

- The **agent wallet** is still prototype scaffolding (key not persisted) — carried through consent as
  a display/claim value only, per PAK-550.
- `RESOURCE_INDICATORS` (native `resource`-param handling) is experimental-on-`main` only; until it
  ships, the hardcoded Audience mapper is required.
