import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from './types.ts';
import { readPortfolio, setTargetAllocation } from './tools.ts';

const asContent = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});

export const buildMcpServer = (principal: Principal): McpServer => {
  const server = new McpServer({
    name: 'ymax-portfolio-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'read_portfolio',
    {
      title: 'Read portfolio',
      description: 'Return the current positions and target allocation.',
      inputSchema: {},
    },
    async () => {
      const result = await readPortfolio(principal);
      return { ...asContent(result), isError: !result.ok };
    },
  );

  server.registerTool(
    'set_target_allocation',
    {
      title: 'Set target allocation',
      description:
        'Re-weight the existing instruments. Percents must sum to 100; bounded by policy (allowlist, concentration cap, locked instrument set).',
      inputSchema: {
        allocation: z
          .record(z.string(), z.number().int().min(0).max(100))
          .describe('instrument -> integer percent, summing to 100'),
      },
    },
    async ({ allocation }) => {
      const result = await setTargetAllocation(principal, allocation);
      return { ...asContent(result), isError: !result.ok };
    },
  );

  return server;
};
