# authn-authz-with-mcps

Prototyping **authentication & authorization for a per-portfolio MCP server**.

A portfolio owner signs in with their **wallet** (AuthN), grants **scopes**
(consent), and then operates their portfolio through tools that are **scope- and
policy-bounded** (AuthZ).

## The shape

One backend, two front doors over a single policy-enforced tool core:

```
Browser UI   ──SIWE login──▶  Backend ──┐
(the human)  ──REST tools──▶            ├─▶  tool core ─┬─ read_portfolio        ─▶ YDS (live)
                                        │   (scopes +    └─ set_target_allocation ─▶ local (simulated)
MCP client   ──MCP + Bearer──▶   /mcp  ─┘   policy bounds)
```

The human UI calls `/api/*`; an MCP client calls `/mcp`. Both resolve a
`Principal` from the session token and call the same `tools.ts`, so authorization
is identical no matter who connects.

## Run

The UI is a Vite + React app (`ui/` workspace) that connects to a **real browser
wallet** (MetaMask / Rabby / Coinbase extension) via **wagmi**. You need a browser
wallet to sign in.

```sh
yarn install
yarn dev          # terminal 1 — backend (http://localhost:8799)
yarn ui           # terminal 2 — React dev server (http://localhost:5173)
```

Open <http://localhost:5173> — **Connect** your wallet → **Sign-In With Ethereum**
(your wallet pops up to sign) → view your portfolio → re-target the allocation.
Tick `portfolio:trade` before signing for write access; leave it off to see a
read-only session refused at trade time. (Vite proxies `/api` and `/mcp` to the
backend.)

To see live data, connect a wallet that **has a real Ymax portfolio** — a wallet
with none gets a `not_found` (there is no fake fallback).

Scripts: `yarn dev` / `yarn start` (backend), `yarn ui` / `yarn ui:build` (React),
`yarn typecheck`, `yarn format` / `yarn format:check`.

## The three layers (and where each lives)

| Layer                               | Question                             | In this repo                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[1] AuthN** — login/identity      | who are you?                         | `backend/auth.ts` — SIWE / EIP-4361 → session JWT bound to the proven wallet address                                                                                                                       |
| **[2] AuthZ** — capability + bounds | what may you do, within what limits? | `backend/tools.ts` (scope gate) + `backend/policy.ts` (instrument allowlist, concentration cap, portions sum to 100)                                                                                       |
| **[3] Execution**                   | who signs the money move?            | **reads are LIVE** from YDS for the connected wallet (`not_found` if it has none); **writes are simulated** in memory (the backend holds no key). In production: a delegated on-chain key that can't drain |

## How auth flows

1. **AuthN (login):** `POST /api/nonce` (server mints a one-time nonce + the
   EIP-4361 message) → wallet signs it locally → `POST /api/login` (server
   verifies signature + nonce) → a **session JWT** bound to the wallet address +
   the consented scopes.
2. **Session:** every later request carries `Authorization: Bearer <jwt>`; the
   server derives the `Principal` from it (`requireAuth`).
3. **AuthZ:** each tool first checks its required **scope**
   (`portfolio:read` / `portfolio:trade`), then runs **policy bounds** before
   touching the portfolio. Both the REST routes and the MCP tools go through the
   same `tools.ts`.

## Honest gaps (this is a prototype)

- **MCP transport auth:** `/mcp` is Bearer-gated with the SIWE session JWT. Real
  MCP clients (Cowork / claude.ai) connect by URL with **OAuth**, not a custom
  Bearer — wiring OAuth at the MCP boundary is the open next step.
- **Replay:** a JWT/Bearer is replayable within its lifetime — fine for reads,
  but real money-moving writes want per-request signing or on-chain enforcement.
- **Reads are live, writes are simulated:** `read_portfolio` fetches the wallet's
  real portfolio from YDS (`https://main1.ymax.app/portfolios/by-wallet/<address>`);
  `set_target_allocation` is validated against that live state but recorded
  locally (no on-chain signing). The real write path is a delegated, low-authority
  on-chain key that _cannot_ withdraw — not built here.
- **Nonce/session stores** are in-memory; production uses Redis / Cloudflare KV.
- **Cosmos/Keplr wallets** use a different signature standard (ADR-036 /
  `signArbitrary`), not SIWE — out of scope.
