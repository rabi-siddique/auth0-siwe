# Self-hosted Sign-In with Ethereum (SIWE) OIDC provider

A private instance of [`spruceid/siwe-oidc`](https://github.com/spruceid/siwe-oidc) that lets users log in with an Ethereum wallet. Auth0 uses this as the identity source behind its SIWE connection.

**Why self-host?** SpruceID's public instance (`oidc.login.xyz`) sits behind Cloudflare's bot
challenge, which blocks Auth0's server-to-server calls (`/token`, `/userinfo`) — so wallet login
fails at the `/authorize/resume` step. Hosting our own instance removes Cloudflare entirely.

## Architecture

```
ChatGPT ──OAuth+DCR──▶ Auth0 ──OIDC social connection──▶ THIS service ──▶ wallet signature
                        │                                  (issues profile: sub = 0x address)
                        └── still does DCR, tokens, RBAC
```

Nothing else in the project changes — Auth0 keeps doing DCR + tokens + RBAC; this only replaces the
_wallet-login_ piece.

## What it needs

| Requirement        | Note                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Docker image       | `ghcr.io/spruceid/siwe_oidc:latest` (via the `Dockerfile` here), listens on **:8000**                                                    |
| **Redis**          | Mandatory — stores registered clients + sessions. No in-memory mode.                                                                     |
| **Pinned RSA key** | `SIWEOIDC_RSA_PEM` in **PKCS#1** format. If omitted it regenerates on every restart → rotates the JWKS → breaks all tokens. Must pin it. |

### Environment variables

| Var                  | Value                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| `SIWEOIDC_ADDRESS`   | `0.0.0.0`                                                                           |
| `SIWEOIDC_REDIS_URL` | Redis connection URL (Sevalla managed Redis internal URL)                           |
| `SIWEOIDC_BASE_URL`  | This service's public URL, e.g. `https://siwe-rabi.sevalla.app` (no trailing slash) |
| `SIWEOIDC_RSA_PEM`   | A PKCS#1 RSA private key (see below)                                                |

### Generate the signing key (PKCS#1 — required format)

```bash
openssl genrsa 2048 | openssl rsa -traditional
# copy the entire "-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----" block
```

Paste that whole multi-line block as the value of `SIWEOIDC_RSA_PEM`. **Never commit it.**

## Local test

```bash
docker compose up        # starts redis + siwe-oidc on :8000
curl http://localhost:8000/.well-known/openid-configuration
```

## Deploy on Sevalla

1. **Create a Redis database** (Sevalla → Databases → Redis). Note its **internal** connection URL.
2. **Create an Application** pointing at this repo, with **Dockerfile path** `siwe-oidc/Dockerfile`
   and container **port 8000**.
3. Set env vars: `SIWEOIDC_ADDRESS`, `SIWEOIDC_REDIS_URL` (internal Redis URL), `SIWEOIDC_RSA_PEM`
   (the PKCS#1 key). Leave `SIWEOIDC_BASE_URL` for the next step.
4. Deploy → copy the app's public URL → set `SIWEOIDC_BASE_URL` to it → redeploy.
5. **Register a client** on your instance (used by the Auth0 connection):
   ```bash
   curl -X POST https://<your-siwe-url>/register \
     -H 'Content-Type: application/json' \
     -d '{"redirect_uris":["https://rabi-mcp.us.auth0.com/login/callback"]}'
   ```
   Save the returned `client_id` + `client_secret`.
6. **Point Auth0's SIWE connection** at this instance: set its issuer/endpoints to
   `https://<your-siwe-url>` and its Client ID/Secret to the pair from step 5.
7. Reconnect the connector in ChatGPT (fresh token) → wallet login should complete, and the token's
   `sub` becomes the wallet address.

## Note on wallets

The upstream image bakes a WalletConnect `PROJECT_ID` at build time, so the hosted login page may
only support injected wallets (MetaMask) out of the box. Injected-wallet login is enough for testing.
