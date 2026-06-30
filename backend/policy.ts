/**
 * AuthZ layer [2] — the bounds. Pure, stateless checks over a proposed
 * allocation. This is where "whatever the agent does is bounded under certain
 * rules" lives. None of these can be talked around by the agent; they run
 * before the change is applied.
 */

import type { Allocation } from './types.ts';

export type PolicyConfig = {
  instrumentAllowlist: string[]; // only these venues may appear
  maxPortion: number; // concentration cap, percent (e.g. 80)
};

export const defaultPolicy: PolicyConfig = {
  instrumentAllowlist: [
    'Aave_USDC',
    'Compound_USDC',
    'Beefy_USDC',
    'USDN_USDC',
  ],
  maxPortion: 80,
};

export type PolicyVerdict =
  { allowed: true } | { allowed: false; reason: string };

export const checkAllocation = (
  proposed: Allocation,
  current: Allocation,
  policy: PolicyConfig = defaultPolicy,
): PolicyVerdict => {
  const keys = Object.keys(proposed);

  if (keys.length === 0) {
    return { allowed: false, reason: 'allocation is empty' };
  }

  // Allowed venues = the static allowlist plus whatever the portfolio already
  // holds (real YDS instruments like Aave_Avalanche).
  const allowed = new Set([
    ...policy.instrumentAllowlist,
    ...Object.keys(current),
  ]);

  for (const [instrument, portion] of Object.entries(proposed)) {
    if (!allowed.has(instrument)) {
      return {
        allowed: false,
        reason: `instrument "${instrument}" is not on the allowlist`,
      };
    }
    if (portion > policy.maxPortion) {
      return {
        allowed: false,
        reason: `portion for "${instrument}" (${portion}%) exceeds the ${policy.maxPortion}% concentration cap`,
      };
    }
  }

  const sum = Object.values(proposed).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    return { allowed: false, reason: `portions must sum to 100 (got ${sum})` };
  }

  return { allowed: true };
};
