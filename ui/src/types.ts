export type Scope = 'portfolio:read' | 'portfolio:trade';

export type Allocation = Record<string, number>;

export type PortfolioView = {
  portfolioId: string;
  totalUsdc: number;
  targetAllocation: Allocation;
  policyVersion: number;
};

export type ActionResult<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string };
