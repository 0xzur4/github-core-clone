// app.ts — the forge's HTTP server: one shared Store behind git smart HTTP, REST v3,
// GraphQL v4 and MCP, on a single node:http server. Handlers read request bodies
// themselves (git needs raw Buffer bodies), so this file never pre-reads a body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER, type Ctx } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * Build the per-request context. `authed` is true when the Authorization header is
 * `Bearer <token>` and the token equals MAKEFUN_SHOP_TOKEN when that variable is
 * non-empty, or any non-empty Bearer token when it is unset/empty.
 */
function buildCtx(req: IncomingMessage): Ctx {
  const authHeader = req.headers.authorization ?? '';
  let authed = false;
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    authed = token.length > 0 && (expected.length === 0 || token === expected);
  }
  return { viewer: VIEWER, authHeader, authed };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // One shared store for every surface; constructed here, after env vars are set
  // (Store's timestamp base reads MAKEFUN_TRIAL_NOW at construction).
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = (req.method ?? 'GET').toUpperCase();
        const ctx = buildCtx(req);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3: every path under /api/v3 (including the GET /api/v3/ root).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store, ctx)) return;
        }

        // GraphQL v4: POST /api/graphql only.
        if (method === 'POST' && path === '/api/graphql') {
          if (await handleGraphql(req, res, store, ctx)) return;
        }

        // MCP over streamable HTTP: /mcp (POST initialize/tools, DELETE teardown).
        if (path === '/mcp' || path === '/mcp/') {
          if (await handleMcp(req, res, store, ctx)) return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(req, res, store, ctx)) return;
        }

        // Anything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[app] request handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.writableEnded && !res.headersSent) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch {
            // The response is already gone; nothing left to do.
          }
        }
      }
    })();
  });
}
