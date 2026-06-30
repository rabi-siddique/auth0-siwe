/**
 * The capability core — the single place tools are implemented and authorized.
 * Both front doors (the human REST API and the agent MCP server) call THESE
 * functions, so authorization is identical no matter who connects.
 *
 * Each tool takes a Principal (derived from verified auth) and:
 *   1. checks the required SCOPE      (AuthZ — capability: may you call this?)
 *   2. checks POLICY bounds            (AuthZ — bounds: is this within limits?)
 *   3. only then touches the portfolio (execution)
 *
 * Reads are LIVE from YDS (the wallet's real portfolio); a wallet with no
 * portfolio gets `not_found`. Writes are SIMULATED — the backend holds no key,
 * so it cannot sign an on-chain tx (see README). The read path
 * (`fetchPortfolioByWallet`) already overlays any prior simulated write.
 */

import type {
  ActionResult,
  Allocation,
  PortfolioView,
  Principal,
  Scope,
} from './types.ts';
import { checkAllocation } from './policy.ts';

type YdsConfig = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = 'https://main1.ymax.app';

// owner address -> locally applied (simulated) portfolio view.
const localWrites = new Map<string, PortfolioView>();

const toAllocation = (raw: unknown): Allocation => {
  const out: Allocation = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = Math.round(Number(v) || 0);
    }
  }
  return out;
};

const fetchPortfolioByWallet = async (
  address: string,
  { baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }: YdsConfig = {},
): Promise<PortfolioView | null> => {
  const local = localWrites.get(address);
  if (local) return local; // a prior simulated tx wins over live data
  try {
    const res = await fetchImpl(`${baseUrl}/portfolios/by-wallet/${address}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data;
    if (!d || typeof d.portfolioId !== 'string') return null;

    const snapshot = d.latestSnapshot as
      { totalValueUsdc?: number } | undefined;
    const structure = (d.vstorage as { structure?: { policyVersion?: number } })
      ?.structure;

    return {
      portfolioId: d.portfolioId,
      totalUsdc: Number(snapshot?.totalValueUsdc ?? 0),
      targetAllocation: toAllocation(d.targetAllocation),
      policyVersion: Number(structure?.policyVersion ?? 0),
    };
  } catch {
    return null; // network/parse failure -> treat as no portfolio
  }
};

const NO_PORTFOLIO = (address: string) =>
  ({
    ok: false,
    code: 'not_found',
    message: `no Ymax portfolio found for ${address}`,
  }) as const;

const requireScope = (
  principal: Principal,
  scope: Scope,
): { ok: false; code: 'auth_required'; message: string } | undefined =>
  principal.scopes.includes(scope)
    ? undefined
    : {
        ok: false,
        code: 'auth_required',
        message: `this tool requires the "${scope}" scope; your session has [${principal.scopes.join(', ')}]`,
      };

export const readPortfolio = async (
  principal: Principal,
): Promise<ActionResult<PortfolioView>> => {
  const denied = requireScope(principal, 'portfolio:read');
  if (denied) return denied;

  const view = await fetchPortfolioByWallet(principal.address);
  if (!view) return NO_PORTFOLIO(principal.address);
  return { ok: true, value: view };
};

/**
 * Simulate the on-chain rebalance tx: the backend holds no key, so instead of
 * signing, record the new allocation locally (version bumped like the chain
 * would) so later reads reflect it.
 */
const simulateTx = (
  owner: string,
  current: PortfolioView,
  targetAllocation: Allocation,
): PortfolioView => {
  const next: PortfolioView = {
    ...current,
    targetAllocation,
    policyVersion: current.policyVersion + 1,
  };
  localWrites.set(owner, next);
  return next;
};

export const setTargetAllocation = async (
  principal: Principal,
  targetAllocation: Allocation,
): Promise<ActionResult<PortfolioView>> => {
  const denied = requireScope(principal, 'portfolio:trade');
  if (denied) return denied;

  const current = await fetchPortfolioByWallet(principal.address);
  if (!current) return NO_PORTFOLIO(principal.address);

  const verdict = checkAllocation(targetAllocation, current.targetAllocation);
  if (!verdict.allowed) {
    return { ok: false, code: 'policy_denied', message: verdict.reason };
  }

  // Simulated: no on-chain signing. Reads reflect it afterward.
  const next = simulateTx(principal.address, current, targetAllocation);
  return { ok: true, value: next };
};
