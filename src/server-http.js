// Express HTTP transport + OAuth 2.1 for the Mycelium MCP server.
//
// Layout (verified against spike/oauth, RESULT.md = GO; better-auth@1.6.12):
//   GET  /.well-known/oauth-authorization-server   (root)
//   GET  /.well-known/oauth-protected-resource     (root)
//   ALL  /api/auth/*splat   → toNodeHandler(auth)   (Express 5 NAMED splat)
//   ALL  /mcp               → Bearer-guarded, stateful Streamable HTTP
//
// AUTH (verified against better-auth@1.6.12 source): the library's withMcpAuth
// returns a WEB-style `async (req) => Response` handler and validates the token
// via `auth.api.getMcpSession({ request, headers })`. That Response/Web-Request
// shape does not compose with the Node req/res the Streamable transport needs,
// so we run the SAME check ourselves — building a Web `Headers` + `Request` and
// calling `getMcpSession` — then hand the raw Node req/res to the transport.
// No/invalid token → 401 + WWW-Authenticate pointing at the protected-resource
// metadata (fail closed; RFC 9728).
//
// CRITICAL [spec corrected]: the Streamable HTTP transport is STATEFUL, keyed
// by `mcp-session-id`. On an `initialize` POST we create ONE transport (real
// randomUUID sessionIdGenerator), call server.connect() once, store it in a
// Map, then route later requests carrying `mcp-session-id` to the stored
// transport. Evict + close the per-session vault db on transport close / HTTP
// DELETE / failed init. Never per-request.
import { randomUUID } from 'node:crypto';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from 'better-auth/plugins';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { boot } from './index.js';
import { createAuth, migrateAuth, ensureOperatorUser } from './auth.js';
import { uploadAttachment } from './ingest/upload.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';

/**
 * Build the Express app (no listen). Returns { app, auth, baseURL, transports }.
 * @param {object} [opts]
 * @param {object} [opts.authOpts]   passed to createAuth
 * @param {object} [opts.bootOpts]   passed to boot (e.g. dbPath, kcvPath, keys)
 * @param {{email?:string,password?:string}} [opts.operator]
 */
export async function createHttpApp(opts = {}) {
  const { auth, baseURL } = createAuth(opts.authOpts);
  await migrateAuth(auth);

  // Seed the single operator account when credentials are available.
  const seedPassword = opts.operator?.password || process.env.MYCELIUM_USER_PASSWORD;
  if (seedPassword) {
    await ensureOperatorUser(auth, {
      email: opts.operator?.email,
      password: seedPassword,
    });
  }

  const app = express();

  // Two well-knowns at ROOT (MCP clients probe here first).
  app.get(
    '/.well-known/oauth-authorization-server',
    toNodeHandler(oAuthDiscoveryMetadata(auth)),
  );
  app.get(
    '/.well-known/oauth-protected-resource',
    toNodeHandler(oAuthProtectedResourceMetadata(auth)),
  );

  // better-auth owns everything under /api/auth/* (Express 5 NAMED splat).
  // Mounted BEFORE express.json() so better-auth parses its own bodies.
  app.all('/api/auth/*splat', toNodeHandler(auth));

  // JSON parsing for the MCP route only (after the auth handler).
  app.use(express.json());

  // Shared vault handle for the authenticated ingestion routes (one per app,
  // not per request — unlike /mcp which isolates per session). Reuses the SAME
  // captureMessage/importMessages handlers as the stdio + REST surfaces.
  const ingest = await boot(opts.bootOpts);
  // Enrichment nudge for upload-created messages (same best-effort seam as MCP).
  ingest.enqueueEnrichment = createEnqueueEnrichment({ userId: ingest.userId });

  // Stateful transport registry: sessionId → { transport, close }.
  const transports = new Map();

  function evict(sessionId) {
    const entry = transports.get(sessionId);
    if (!entry) return;
    transports.delete(sessionId);
    // Best-effort vault-db teardown; never throw out of cleanup.
    try { entry.close?.(); } catch { /* ignore */ }
  }

  const wwwAuthenticate =
    `Bearer resource_metadata="${baseURL}/.well-known/oauth-protected-resource"`;

  // Validate the Bearer access token → better-auth MCP session, or null.
  async function authenticate(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return null;
    const headers = new Headers({ authorization: authHeader });
    const request = new Request(`${baseURL}/mcp`, { method: 'POST', headers });
    try {
      return await auth.api.getMcpSession({ request, headers });
    } catch {
      return null;
    }
  }

  const mcpHandler = async (req, res) => {
    // Fail closed: every /mcp request must carry a valid Bearer token.
    const session = await authenticate(req);
    if (!session) {
      res
        .status(401)
        .set('WWW-Authenticate', wwwAuthenticate)
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Unauthorized: Authentication required' },
          id: null,
        });
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];

      // Existing session → route to its stored transport.
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId).transport.handleRequest(req, res, req.body);
        return;
      }

      // No known session: only an `initialize` POST may open a new one.
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        // Fresh server + db per session for isolation; reuses the SAME
        // tools/handlers assembly as the stdio path via boot().
        const { server, close } = await boot(opts.bootOpts);

        let registered = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, close });
            registered = true;
          },
        });

        // Evict + tear down on transport close (client disconnect / DELETE).
        transport.onclose = () => {
          if (transport.sessionId) evict(transport.sessionId);
        };

        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          // If init failed before the session registered, onclose-eviction will
          // never fire — close the orphaned vault db here so it does not leak.
          if (!registered) {
            try { close?.(); } catch { /* ignore */ }
          }
          throw err;
        }
        return;
      }

      // Anything else without a valid session is a protocol error.
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: no valid session for a non-initialize request',
        },
        id: null,
      });
    } catch (err) {
      // Never leak internals or plaintext; fail closed.
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  app.all('/mcp', mcpHandler);

  // ── Authenticated ingestion routes (Bearer-guarded, same token as /mcp) ──
  // "Any message that comes in should be saved." These are thin HTTP wrappers
  // over the SAME captureMessage/importMessages handlers the MCP + REST surfaces
  // expose; the encrypting db layer handles encryption-at-rest transparently.
  async function requireAuth(req, res) {
    const session = await authenticate(req);
    if (!session) {
      res.status(401).set('WWW-Authenticate', wwwAuthenticate)
        .json({ ok: false, error: 'Unauthorized: Bearer token required' });
      return null;
    }
    return session;
  }

  // POST /ingest/message — save one inbound message. Body = captureMessage args.
  app.post('/ingest/message', async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'body must be a JSON object' });
      return;
    }
    try {
      const result = await ingest.handlers.captureMessage(body);
      res.json({ ok: true, result });
    } catch (err) {
      // Distinguish caller error from internal; never leak internals/plaintext.
      const msg = /required|must be|invalid/i.test(err.message) ? err.message : 'ingest failed';
      res.status(/required|must be|invalid/i.test(err.message) ? 400 : 500).json({ ok: false, error: msg });
    }
  });

  // POST /ingest/upload — store a file. Raw bytes = body (dependency-free; V1
  // uploaders are connectors/CLI/scripts, not browser forms). Query params:
  //   ?filename=<name>&type=<mime>&asMessage=1
  // Bytes are encrypted at rest by the blob store; row encrypted at the db layer.
  app.post('/ingest/upload',
    express.raw({ type: '*/*', limit: '50mb' }),
    async (req, res) => {
      if (!(await requireAuth(req, res))) return;
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        res.status(400).json({ ok: false, error: 'request body must be non-empty file bytes' });
        return;
      }
      try {
        const result = await uploadAttachment(ingest.db, {
          userId: ingest.userId || 'local-user',
          bytes,
          fileName: req.query.filename ? String(req.query.filename) : undefined,
          fileType: req.query.type ? String(req.query.type) : (req.headers['content-type'] || undefined),
          asMessage: req.query.asMessage === '1' || req.query.asMessage === 'true',
        }, ingest.enqueueEnrichment);
        res.json({ ok: true, result });
      } catch (err) {
        const caller = /required|must be|invalid/i.test(err.message);
        res.status(caller ? 400 : 500).json({ ok: false, error: caller ? err.message : 'upload failed' });
      }
    });

  // POST /ingest/import — bulk history backfill. Body = { messages: [...] }.
  app.post('/ingest/import', async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      res.status(400).json({ ok: false, error: 'body must be { messages: [...] }' });
      return;
    }
    try {
      const result = await ingest.handlers.importMessages(body);
      res.json({ ok: true, result });
    } catch {
      res.status(500).json({ ok: false, error: 'import failed' });
    }
  });

  return { app, auth, baseURL, transports, close: ingest.close };
}

/** Build the app and start listening. Resolves with the http.Server. */
export async function startHttpServer(opts = {}) {
  const { app, baseURL } = await createHttpApp(opts);
  const port =
    opts.port || Number(process.env.MYCELIUM_PORT) || urlPort(baseURL) || 4711;
  return new Promise((resolve) => {
    const httpServer = app.listen(port, () => {
      // stderr so it never pollutes a stdio MCP stream.
      console.error(`[mycelium] HTTP+OAuth listening on ${baseURL} (port ${port})`);
      resolve(httpServer);
    });
  });
}

function urlPort(u) {
  try {
    const p = new URL(u).port;
    return p ? Number(p) : undefined;
  } catch {
    return undefined;
  }
}
