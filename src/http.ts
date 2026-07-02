import 'dotenv/config';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './create-server.js';
import { setupAuth } from './auth.js';
import { log } from './log.js';

const app = express();
app.use(express.json());

// Log every request and its response status + duration.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  log(`--> ${req.method} ${req.path}`);
  res.on('finish', () =>
    log(
      `<-- ${req.method} ${req.path} ${res.statusCode} (${Date.now() - start}ms)`,
    ),
  );
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const handleMcp = async (req: Request, res: Response) => {
  const { method, id, params } = req.body ?? {};
  const tool = method === 'tools/call' ? params?.name : undefined;
  log('MCP request:', {
    id,
    method,
    tool,
    args: tool ? params?.arguments : undefined,
    scopes: req.auth?.scopes, // caller's granted scopes/permissions (for per-tool gating)
  });

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error.' },
        id: id ?? null,
      });
    }
  }
};

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });

const bootstrap = async () => {
  const requireAuth = await setupAuth(app);

  app.post('/mcp', requireAuth, handleMcp);
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    log(`portfolio-mcp HTTP listening on :${port}/mcp`);
  });
};

bootstrap().catch((err) => {
  log('Fatal startup error:', err);
  process.exit(1);
});
