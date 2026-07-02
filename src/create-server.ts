import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerRequest,
  ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from './log.js';

const TOOL_SCOPES = {
  // Portfolio scopes — granted to Sign-In-with-Ethereum users at login (via an Auth0 Action).
  getPositions: 'portfolio:positions',
  getAllocation: 'portfolio:allocation',
} as const;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Throws unless the caller's token carries the required scope.
const requireScope = (extra: Extra, scope: string) => {
  const scopes = extra.authInfo?.scopes ?? [];
  if (!scopes.includes(scope)) {
    log('authz: DENIED —', { need: scope, have: scopes });
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Forbidden: missing required scope "${scope}".`,
    );
  }
  log('authz: allowed —', { scope });
};

const YMAX_API_BASE = 'https://main1.ymax.app';

// Portfolio-ownership authorization for wallet (SIWE) callers.
// The wallet address is proven by Sign-In with Ethereum (it's the token's `sub`); we then check
// with Ymax whether that address owns a portfolio. Owns one -> authorized (scoped to it).
// None -> Forbidden. This is the per-portfolio access gate.
const requirePortfolio = async (extra: Extra) => {
  const sub = String(extra.authInfo?.extra?.sub ?? '');
  const address = sub.match(/0x[a-fA-F0-9]{40}/)?.[0];
  if (!address) {
    log('authz: DENIED — no wallet address on token', { sub });
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Forbidden: no wallet identity on the token.',
    );
  }
  const res = await fetch(`${YMAX_API_BASE}/portfolios/by-wallet/${address}`);
  if (res.status === 404) {
    log('authz: DENIED — wallet owns no portfolio', { address });
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Forbidden: this wallet has no Ymax portfolio.',
    );
  }
  if (!res.ok) {
    throw new McpError(
      ErrorCode.InternalError,
      `Portfolio lookup failed (${res.status}).`,
    );
  }
  const { data } = await res.json();
  log('authz: portfolio authorized —', {
    address,
    portfolioId: data?.portfolioId,
  });
  return data;
};

const toText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export const createServer = () => {
  const server = new McpServer({ name: 'portfolio-mcp', version: '1.0.0' });

  // Portfolio tools. Each requires (1) its scope — granted to SIWE users at login — and
  // (2) portfolio ownership (requirePortfolio), which also yields the portfolio to scope to.
  server.registerTool(
    'get_positions',
    {
      title: 'Get portfolio positions',
      description:
        "Return the current positions and balances of the caller's Ymax portfolio.",
      inputSchema: {},
    },
    async (_args, extra) => {
      requireScope(extra, TOOL_SCOPES.getPositions);
      const p = await requirePortfolio(extra);
      return toText({
        portfolioId: p.portfolioId,
        totalValueUsdc: p.latestSnapshot?.totalValueUsdc,
        positions: p.latestSnapshot?.balances?.positions,
        accounts: p.latestSnapshot?.balances?.accounts,
        positionStatus: p.positionStatus,
      });
    },
  );

  server.registerTool(
    'get_allocation',
    {
      title: 'Get portfolio allocation',
      description:
        "Return the current target allocation of the caller's Ymax portfolio.",
      inputSchema: {},
    },
    async (_args, extra) => {
      requireScope(extra, TOOL_SCOPES.getAllocation);
      const p = await requirePortfolio(extra);
      return toText({
        portfolioId: p.portfolioId,
        targetAllocation: p.targetAllocation,
      });
    },
  );

  return server;
};
