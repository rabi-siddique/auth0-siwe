import type {
  ActionResult,
  Allocation,
  PortfolioView,
  Scope,
} from './types.ts';

const json = (extra?: Record<string, string>): Record<string, string> => ({
  'content-type': 'application/json',
  ...extra,
});

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** AuthN step 1: ask the server for the exact EIP-4361 message to sign. */
export const getNonceMessage = async (address: string): Promise<string> => {
  const res = await fetch('/api/nonce', {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ address }),
  });
  const { message } = (await res.json()) as { message: string };
  return message;
};

/** AuthN step 2: submit the signed message; receive a scoped session JWT. */
export const login = async (
  message: string,
  signature: string,
  scopes: Scope[],
): Promise<{ token: string; principal: { scopes: Scope[] } }> => {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ message, signature, scopes }),
  });
  if (!res.ok) {
    const { error } = (await res.json()) as { error: string };
    throw new Error(error);
  }
  return res.json();
};

export const getPortfolio = async (
  token: string,
): Promise<ActionResult<PortfolioView>> =>
  fetch('/api/portfolio', { headers: bearer(token) }).then((r) => r.json());

export const setAllocation = async (
  token: string,
  allocation: Allocation,
): Promise<ActionResult<PortfolioView>> =>
  fetch('/api/set-allocation', {
    method: 'POST',
    headers: json(bearer(token)),
    body: JSON.stringify({ allocation }),
  }).then((r) => r.json());
