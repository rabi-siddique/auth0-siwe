/**
 * The portfolio capabilities a wallet user can grant at login.
 *
 * These are rendered as checkboxes on the consent page (`src/consent.ts`); the subset the user
 * selects is what the Keycloak consent-redirect authenticator writes (as user attributes projected
 * by a mapper) into the token's `https://ymax.app/scopes` claim, which the resource server
 * (`src/auth.ts` + `src/create-server.ts`) then gates each tool on.
 *
 * This is the single source of truth for the selectable scopes — the consent page renders it and the
 * submit handler validates the user's choice against it (so a tampered form can't inject an unknown
 * scope).
 */
export type ScopeInfo = {
  scope: string;
  label: string;
  description: string;
};

export const AVAILABLE_SCOPES: ScopeInfo[] = [
  {
    scope: 'portfolio:positions',
    label: 'Read positions',
    description:
      'View the current positions, balances, and total value of your Ymax portfolio.',
  },
  {
    scope: 'portfolio:allocation',
    label: 'Read allocation',
    description: 'View the target allocation of your Ymax portfolio.',
  },
  {
    scope: 'portfolio:rebalance',
    label: 'Rebalance',
    description:
      'Write access: rebalance your Ymax portfolio and execute allocation changes on your behalf.',
  },
];

export const AVAILABLE_SCOPE_SET = new Set(
  AVAILABLE_SCOPES.map((s) => s.scope),
);
