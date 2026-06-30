import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Principal, Scope } from './types.ts';
import { makeAuth } from './auth.ts';
import { readPortfolio, setTargetAllocation } from './tools.ts';
import { buildMcpServer } from './mcp.ts';

const PORT = Number(process.env.PORT ?? 8799);
const HOST = `localhost:${PORT}`;

const auth = makeAuth({
  domain: HOST,
  uri: `http://${HOST}`,
  chainId: 1,
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-not-a-secret',
});

const app = express();
app.use(cors());
app.use(express.json());

// Log every request (method, path, status, duration)
app.use((req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `  ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`,
    );
  });
  next();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'ui')));

// --- shared: pull a Principal off the Authorization: Bearer <jwt> header -----

const principalFrom = (req: Request): Principal | undefined => {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return undefined;
  try {
    return auth.principalFromToken(token);
  } catch {
    return undefined;
  }
};

const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const principal = principalFrom(req);
  if (!principal) {
    res.status(401).json({ error: 'missing or invalid Bearer token' });
    return;
  }
  res.locals.principal = principal;
  next();
};

// --- AuthN endpoints ---------------------------------------------------------

app.post('/api/nonce', (req: Request, res: Response) => {
  const address = String(req.body?.address ?? '');
  if (!address) {
    res.status(400).json({ error: 'address required' });
    return;
  }
  res.json(auth.prepareLogin(address));
});

app.post('/api/login', async (req: Request, res: Response) => {
  try {
    const { message, signature } = req.body ?? {};
    const requestedScopes: Scope[] = Array.isArray(req.body?.scopes)
      ? req.body.scopes
      : [];
    const out = await auth.completeLogin({
      message,
      signature,
      requestedScopes,
    });
    res.json(out);
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

// --- HUMAN front door: REST tool calls (used by the UI) ----------------------

app.get('/api/portfolio', requireAuth, async (_req: Request, res: Response) => {
  res.json(await readPortfolio(res.locals.principal as Principal));
});

app.post(
  '/api/set-allocation',
  requireAuth,
  async (req: Request, res: Response) => {
    res.json(
      await setTargetAllocation(
        res.locals.principal as Principal,
        req.body?.allocation ?? {},
      ),
    );
  },
);

// --- AGENT front door: the MCP server (stateless Streamable HTTP) ----------

app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
  const principal = res.locals.principal as Principal;
  const server = buildMcpServer(principal);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: a fresh transport per request
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Server up on port ${PORT}`);
});
