export type Scope = 'portfolio:read' | 'portfolio:trade';

/**
 * A Principal is derived from verified auth material (a SIWE-proven address +
 * granted scopes), never supplied by the caller. It is the input to every
 * authorization decision.
 */
export type Principal = {
  address: string; // SIWE-proven wallet address (identity)
  portfolioId: string; // the one portfolio this session may touch
  scopes: Scope[]; // what this session was granted (consent)
};

export type Allocation = Record<string, number>;

/** What both front doors return for a portfolio (real YDS data or local). */
export type PortfolioView = {
  portfolioId: string;
  totalUsdc: number;
  targetAllocation: Allocation;
  policyVersion: number;
};

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ActionErrorCode; message: string };

export type ActionErrorCode =
  | 'auth_required' // missing/insufficient scope
  | 'policy_denied' // failed a bound
  | 'not_found';
