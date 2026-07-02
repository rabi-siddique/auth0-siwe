import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';

const main = async () => {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('portfolio-mcp server running on stdio');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
