// Remote transport: Streamable HTTP MCP + OAuth 2.1 (better-auth mcp plugin).
//
// One Express app exposes:
//   GET  /.well-known/oauth-authorization-server   (root, OAuth AS metadata)
//   GET  /.well-known/oauth-protected-resource      (root, PRM metadata)
//   ALL  /api/auth/*splat                            (better-auth handler)
//   ALL  /mcp                                        (Bearer-guarded MCP)
//
// The MCP tool/handler surface is the SAME assembly the stdio path uses: the
// async boot() from src/index.js (two-key unlock -> encrypting db -> tool
// domains -> low-level Server). Only the wire differs.
//
// STATEFUL Streamable HTTP transport (spec CORRECTED): the transport is NOT
// created per-request. On an `initialize` POST (no session id) we create ONE
// StreamableHTTPServerTransport with a real randomUUID sessionIdGenerator,
// connect a fresh boot() assembly to it, and store it by session id. Later
// requests carry `mcp-session-id` and are routed back to the stored transport
// (which itself handles the GET SSE stream, subsequent POSTs, and DELETE
// teardown). Eviction fires from the transport's onsessionclosed (DELETE) and a
// chained onclose (stream drop / shutdown).
//
// Auth: enforced via `auth.api.getMcpSession({ headers })` — the exact call
// `withMcpAuth` makes internally (verified:
// node_modules/better-auth/dist/plugins/mcp/index.mjs). withMcpAuth's returned
// handler is a Web-fetch-style fn returning a Response on 401, which does not
// compose with raw Express (req,res) — so we call getMcpSession directly and
// emit a spec-compliant 401 + WWW-Authenticate ourselves (fail closed).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import {
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from 'better-auth/plugins';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { boot } from './index.js';
import { createAuth } from './auth.js';

/**
 * Read the HTTP/OAuth config from the environment. Mirrors boot()'s env-var
 * conventions for the vault; adds the HTTP-only knobs.
 */
export function loadHttpConfig(overrides = {}) {
  const port = Number(overrides.port ?? process.env.MYCELIUM_HTTP_PORT ?? 4477);
  const host = overrides.host ?? process.env.MYCELIUM_HTTP_HOST ?? '127.0.0.1';
  // Public base URL the OAuth metadata advertises. Behind a Cloudflare Tunnel
  // this is the public https origin; locally it defaults to the bind address.
  const baseURL =
    overrides.baseURL ?? process.env.MYCELIUM_BASE_URL ?? `http://localhost:${port}`;
  return {
    port,
    host,
    baseURL,
    // better-auth sqlite DB (NOT the encrypted vault DB). Gitignored (data/+*.db).
    authDbPath:
      overrides.authDbPath ??
      process.env.MYCELIUM_AUTH_DB ??
      path.resolve(process.cwd(), 'data', 'auth.db'),
    // better-auth signing secret. MUST be set in production.
    authSecret: overrides.authSecret ?? process.env.MYCELIUM_AUTH_SECRET,
    trustedOrigins:
      overrides.trustedOrigins ??
      (process.env.MYCELIUM_TRUSTED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    // Single-user account seeded so the OAuth authorize flow has a user to
    // authenticate. Password from env; memory-only. No default password is ever
    // invented (fail closed: absent password => operator provisions manually).
    user: {
      email: overrides.userEmail ?? process.env.MYCELIUM_USER_EMAIL ?? 'owner@mycelium.local',
      password: overrides.userPassword ?? process.env.MYCELIUM_USER_PASSWORD ?? null,
    },
  };
}

/** Resolve a better-auth metadata helper (auth -> async (Request) -> Response) to JSON. */
async function metadataJson(helperFn, req) {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  const out = await helperFn(new Request(url, { headers }));
  return out instanceof Response ? await out.json() : out;
}

/**
 * Build (but do not listen) the Express app + better-auth instance.
 * Exposed for tests/probes that drive it without binding a port early.
 *
 * @param {object} [overrides] config overrides (see loadHttpConfig)
 * @returns {Promise<{ app: import('express').Express, auth: object, http: object, sessions: Map<string, object>, close: () => void }>}
 */
export async function createHttpApp(overrides = {}) {
  const http = loadHttpConfig(overrides);

  // Ensure the auth DB directory exists before better-sqlite3 opens the file.
  if (http.authDbPath && http.authDbPath !== ':memory:') {
    mkdirSync(path.dirname(http.authDbPath), { recursive: true });
  }

  const { auth, runMigrations } = createAuth({
    baseURL: http.baseURL,
    authDbPath: http.authDbPath,
    authSecret: http.authSecret,
    trustedOrigins: http.trustedOrigins,
  });

  // better-auth migrations in-process (creates user/session/oauth tables).
  // Fail closed: if migrations throw, boot fails rather than serving an
  // unmigrated DB.
  await runMigrations();

  // Single-user seeding: ensure exactly one owner account exists. Idempotent.
  await seedOwner(auth, http.user);

  const app = express();
  app.disable('x-powered-by');

  // --- Root well-knowns (clients probe these at the origin root) ---
  app.get('/.well-known/oauth-authorization-server', async (req, res, next) => {
    try {
      res.json(await metadataJson(oAuthDiscoveryMetadata(auth), req));
    } catch (err) {
      next(err);
    }
  });
  app.get('/.well-known/oauth-protected-resource', async (req, res, next) => {
    try {
      res.json(await metadataJson(oAuthProtectedResourceMetadata(auth), req));
    } catch (err) {
      next(err);
    }
  });

  // --- better-auth handler (Express 5 requires a NAMED splat) ---
  // Mounted BEFORE any body parser so better-auth owns its own parsing.
  //
  // CRITICAL: toNodeHandler(auth) returns a function whose arity is 4, which
  // Express would register as ERROR-handling middleware (it then never runs on
  // normal requests). Wrap it in a 3-arg arrow so Express registers it as a
  // normal request handler. Verified: arity of toNodeHandler's return is 4.
  const authHandler = toNodeHandler(auth);
  app.all('/api/auth/*splat', (req, res, next) => authHandler(req, res, next));

  // --- MCP endpoint (Bearer-guarded, stateful Streamable HTTP) ---
  // Map<sessionId, transport>. Survives across requests.
  const sessions = new Map();

  // express.json is scoped to /mcp ONLY (so /api/auth stays raw). The parsed
  // body feeds isInitializeRequest() and is passed to handleRequest().
  app.all('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
    // 1. Authenticate (central Bearer check — fail closed).
    let session = null;
    try {
      session = await auth.api.getMcpSession({ headers: req.headers });
    } catch {
      session = null;
    }
    if (!session) {
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${http.baseURL}/.well-known/oauth-protected-resource"`,
        )
        .json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];

    try {
      // 2a. Known session -> delegate to its stored transport (handles the GET
      //     SSE stream, subsequent POSTs, and DELETE teardown itself).
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId).handleRequest(req, res, req.body);
        return;
      }

      // 2b. New session — only valid on an `initialize` POST with no id.
      if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        // Fresh server assembly per session keeps tool/vault state isolated.
        const { server, close } = await boot();
        // Idempotent teardown: a DELETE fires BOTH onsessionclosed and (via the
        // transport's close path) the chained onclose, so guard against running
        // the map-evict + vault-close twice. `released` makes teardown run once.
        let released = false;
        const release = (id) => {
          if (released) return;
          released = true;
          if (id) sessions.delete(id);
          try {
            close();
          } catch {
            /* vault already closed */
          }
        };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
          // Fires from handleDeleteRequest() on an HTTP DELETE teardown. This
          // is the constructor hook — it survives server.connect(), unlike
          // transport.onclose (which Protocol.connect overwrites). Verified
          // against node_modules @modelcontextprotocol/sdk.
          onsessionclosed: (id) => release(id),
        });

        // server.connect() (Protocol.connect) OVERWRITES transport.onclose, so
        // chain AFTER connect to also catch non-DELETE closes (GET stream drop,
        // shutdown) and release the per-session vault handle.
        await server.connect(transport);
        const protocolOnClose = transport.onclose;
        transport.onclose = () => {
          try {
            protocolOnClose?.();
          } finally {
            release(transport.sessionId);
          }
        };

        await transport.handleRequest(req, res, req.body);
        return;
      }

      // 2b'. Idempotent teardown: a DELETE for an unknown/expired session is a
      //      no-op success, not an error (the session may already be gone after
      //      a close or restart).
      if (req.method === 'DELETE') {
        res.status(204).end();
        return;
      }

      // 2c. No/unknown session and not an initialize -> protocol error.
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: no valid session id and not an initialize request',
        },
        id: null,
      });
    } catch (err) {
      // Never leak internals; log to stderr only, return a safe error.
      console.error('[mycelium] /mcp error:', err?.message ?? err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  function close() {
    for (const transport of sessions.values()) {
      try {
        transport.close();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
  }

  return { app, auth, http, sessions, close };
}

/**
 * Ensure the single owner user exists. Idempotent: a duplicate sign-up just
 * fails and is swallowed. Requires a password; if none is configured we leave
 * provisioning to the operator (fail closed: no default password is invented).
 */
async function seedOwner(auth, user) {
  if (!user?.password) return;
  try {
    await auth.api.signUpEmail({
      body: { email: user.email, password: user.password, name: 'Mycelium Owner' },
    });
  } catch {
    // Already exists (or sign-up rejected) — fine for an idempotent seed.
  }
}

/**
 * Start the HTTP server listening. Default entrypoint for `--http`.
 *
 * @param {object} [overrides] config overrides (see loadHttpConfig)
 * @returns {Promise<import('node:http').Server>}
 */
export async function startHttpServer(overrides = {}) {
  const { app, http } = await createHttpApp(overrides);
  return new Promise((resolve) => {
    const httpServer = app.listen(http.port, http.host, () => {
      console.error(
        `[mycelium] HTTP MCP + OAuth on http://${http.host}:${http.port} (baseURL ${http.baseURL})`,
      );
      resolve(httpServer);
    });
  });
}
