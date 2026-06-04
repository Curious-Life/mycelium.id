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
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { boot } from './index.js';
import { createAuth, migrateAuth, ensureOperatorUser } from './auth.js';
import { uploadAttachment } from './ingest/upload.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';
import { createGatewayHandlers } from './gateway/openai-compat.js';
import { matchStaticBearer } from './gateway/static-bearer.js';

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

  // CORS for ALL discovery endpoints. Browser-based MCP clients (e.g. the MCP
  // Inspector UI) probe several .well-known URLs during OAuth discovery — the
  // path-aware RFC 8414 variant (`/.well-known/oauth-authorization-server/mcp`)
  // and OpenID Connect (`/.well-known/openid-configuration[/mcp]`). Any that 404
  // WITHOUT CORS headers are rejected by Safari/WebKit as "TypeError: Load failed"
  // BEFORE the SDK can fall back to the working root document — which is exactly why
  // the browser flow died while server-side clients (Claude, the Inspector CLI)
  // sailed through (they don't enforce CORS). Blanket every .well-known response
  // (including 404s) with CORS and answer the OPTIONS preflight, so the browser can
  // always read the response and the SDK falls back to the root metadata.
  app.use('/.well-known', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Authorization-server metadata (RFC 8414) — better-auth's helper is correct.
  app.get(
    '/.well-known/oauth-authorization-server',
    toNodeHandler(oAuthDiscoveryMetadata(auth)),
  );

  // Protected-resource metadata (RFC 9728). We serve a MINIMAL body (matching
  // production servers Sentry/Linear/Notion/GitHub) at BOTH the root AND the
  // path-suffixed `/.well-known/oauth-protected-resource/mcp`. The suffixed
  // location (well-known prefix inserted before the resource's `/mcp` path) is
  // what Claude probes FIRST (RFC 9728 §3.1; mandatory in MCP spec 2025-11-25).
  // better-auth serves only the root and bakes in openid/RS256 fields working
  // servers omit, so we hand-build it. CORS is required — Claude's web client
  // fetches this cross-origin (every working server returns it + answers OPTIONS).
  const protectedResourceMetadata = {
    resource: `${baseURL}/mcp`,
    authorization_servers: [baseURL],
    bearer_methods_supported: ['header'],
  };
  const sendPrm = (req, res) => {
    console.error('[myc-prm]', req.method, req.path, 'ip=', req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?', 'ua=', (req.headers['user-agent'] || '').slice(0, 48)); // TEMP — remove pre-merge
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, *');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    res.json(protectedResourceMetadata);
  };
  app.options(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], sendPrm);
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], sendPrm);

  // better-auth owns everything under /api/auth/* (Express 5 NAMED splat).
  // Mounted BEFORE express.json() so better-auth parses its own bodies.
  const authHandler = toNodeHandler(auth);
  app.all('/api/auth/*splat', (req, res) => {
    const p = req.url.split('?')[0];
    const origin = req.headers.origin;
    // CORS preflight: browser-based MCP clients (e.g. the MCP Inspector UI) send an
    // OPTIONS preflight before the cross-origin DCR POST (Content-Type: application/json)
    // and token exchange. better-auth registers no OPTIONS route for its /mcp/* endpoints,
    // so the preflight 404s → the browser blocks the real request ("TypeError: Load failed").
    // Answer the preflight here, before better-auth. We REFLECT the origin (+ credentials)
    // rather than "*", because the SDK's token exchange is a credentialed request and
    // browsers reject "*" for those. (Server-side clients — Claude's backend, the Inspector
    // CLI — skip preflight entirely, which is why they already connect.)
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', origin || '*');
      if (origin) { res.set('Access-Control-Allow-Credentials', 'true'); res.set('Vary', 'Origin'); }
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    // The mcp() plugin emits ACAO:* on /register (public DCR) but NO CORS on /token —
    // and better-auth's trustedOrigins doesn't govern these plugin endpoints. So a browser
    // MCP client's cross-origin token exchange is blocked ("Origin ... not allowed by
    // Access-Control-Allow-Origin"). Reflect the caller's origin (+ credentials) for the
    // token endpoint. It is PKCE-protected and carries no ambient-cookie authority (the grant
    // needs the code + verifier), so reflecting is safe; we deliberately do NOT touch
    // /authorize (a top-level navigation, never a CORS fetch). Force the headers through
    // res.writeHead so they survive better-auth's response writing.
    if (origin && p.endsWith('/mcp/token')) {
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (...args) => {
        try {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          res.setHeader('Vary', 'Origin');
        } catch { /* headers already sent */ }
        return writeHead(...args);
      };
    }
    res.on('finish', () => { if (/(authorize|token|register|jwks|sign-in)/.test(p)) console.error('[myc-oauth]', req.method, p, '→', res.statusCode); });
    return authHandler(req, res);
  });

  // ── /login: the OAuth authorize login page ─────────────────────────────────
  // better-auth's mcp() plugin redirects an UNauthenticated /authorize to
  // `loginPage?<original query>` (loginPage:'/login' in auth.js). We host it: a
  // minimal form that signs the operator in, then bounces back to
  // /api/auth/mcp/authorize with the SAME params — now with a session, so the
  // authorization code is issued. Without this a fresh MCP client (Claude) gets a
  // 404 at /login (the spike pre-authenticated its session, so it never hit this).
  // sign-in is called SERVER-SIDE (auth.api), which bypasses better-auth's
  // HTTP-layer Origin/CSRF check; we forward its Set-Cookie to the browser.
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const loginPage = (qs, err) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mycelium — Sign in</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0c;color:#eaeaea;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#15151a;padding:2rem;border-radius:14px;width:320px;border:1px solid #26262e}h1{font-size:1.05rem;margin:0 0 1.2rem;color:#c9a227;font-weight:600}input{width:100%;box-sizing:border-box;margin:.35rem 0;padding:.65rem;background:#0a0a0c;border:1px solid #26262e;border-radius:8px;color:#eaeaea}button{width:100%;margin-top:1rem;padding:.7rem;background:#c9a227;color:#0a0a0c;border:0;border-radius:8px;font-weight:700;cursor:pointer}.e{color:#f87171;font-size:.85rem;margin:.3rem 0}.s{color:#8a8a99;font-size:.72rem;margin-top:1rem;text-align:center}</style></head><body><form method="POST" action="/login?${escHtml(qs)}"><h1>Connect to your vault</h1>${err ? `<div class="e">${escHtml(err)}</div>` : ''}<input name="email" type="email" placeholder="email" value="operator@mycelium.local" autocomplete="username"><input name="password" type="password" placeholder="password" autocomplete="current-password" autofocus required><button type="submit">Sign in</button><div class="s">Authorizing an MCP client to reach this vault.</div></form></body></html>`;

  app.get('/login', (req, res) => {
    const qs = req.originalUrl.split('?').slice(1).join('?') || '';
    res.type('html').send(loginPage(qs, null));
  });
  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const qs = req.originalUrl.split('?').slice(1).join('?') || '';
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || !password) { res.status(400).type('html').send(loginPage(qs, 'Email and password required')); return; }
    try {
      const r = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      if (!r.ok) { res.status(401).type('html').send(loginPage(qs, 'Invalid email or password')); return; }
      const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.redirect(302, `/api/auth/mcp/authorize?${qs}`);
    } catch {
      res.status(401).type('html').send(loginPage(qs, 'Invalid email or password'));
    }
  });

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
    `Bearer error="invalid_token", error_description="Authentication required", ` +
    `resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`;

  // Validate the Bearer access token → better-auth MCP session, or null.
  async function authenticate(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      console.error('[myc-auth]', req.method, '/mcp — no/non-bearer header:', authHeader ? authHeader.slice(0, 14) : '(none)');
      return null;
    }
    // §3b opt-in static bearer (fail-closed: only when MYCELIUM_MCP_BEARER is set,
    // length-floored, constant-time compared — see gateway/static-bearer.js).
    // Accepted IN ADDITION to OAuth so a local harness / 2.0-only client connects
    // with a copy-paste token. Covers /mcp AND the /v1 gateway (both authenticate
    // through here). The token itself is never logged.
    if (matchStaticBearer(authHeader)) {
      console.error('[myc-auth]', req.method, '— static bearer accepted (MYCELIUM_MCP_BEARER)');
      return { userId: ingest.userId || 'local-user', static: true };
    }
    const headers = new Headers({ authorization: authHeader });
    const request = new Request(`${baseURL}/mcp`, { method: 'POST', headers });
    try {
      // CRITICAL: pass asResponse:false. Without it, getMcpSession returns a
      // truthy Response-shaped {} for EVERY input — valid token, invalid token,
      // even no token — so ANY Bearer header would authenticate (verified
      // 2026-06-04). With asResponse:false it returns the access-token ROW for a
      // valid token, or null for an unknown one — mirroring better-auth's own
      // withMcpAuth (node_modules/better-auth/dist/plugins/mcp/index.mjs:709).
      const s = await auth.api.getMcpSession({ request, headers, asResponse: false });
      if (!s) {
        console.error('[myc-auth]', req.method, '/mcp — token rejected (no session)');
        return null;
      }
      // Fail closed on expiry: the library's token lookup does NOT check the
      // access token's expiry, so enforce accessTokenExpiresAt here.
      if (s.accessTokenExpiresAt && new Date(s.accessTokenExpiresAt).getTime() < Date.now()) {
        console.error('[myc-auth]', req.method, '/mcp — access token expired');
        return null;
      }
      console.error('[myc-auth]', req.method, '/mcp — getMcpSession OK', `user=${s.userId || s.user?.id || '?'}`);
      return s;
    } catch (e) {
      console.error('[myc-auth]', req.method, '/mcp — getMcpSession threw:', e?.message);
      return null;
    }
  }

  const mcpHandler = async (req, res) => {
    // CORS: expose the MCP headers Claude's client must read; answer preflight
    // BEFORE auth (a preflight carries no credentials).
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    console.error('[myc-mcp]', req.method, 'bearer=', /^Bearer\s/i.test(req.headers['authorization'] || '') ? 'yes' : 'no', 'sid=', req.headers['mcp-session-id'] || '-', 'ip=', req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?'); // TEMP — remove pre-merge

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

  // ── OpenAI-compatible outbound gateway (S8), Bearer-guarded like /ingest/* ──
  // A user's harness points its model base-URL at <handle>.mycelium.id/v1 → it
  // gets sovereign, jurisdiction-gated, AUDITED inference through the operator's
  // own BYOK keys (no provider key of its own). Uses the SAME shared `ingest`
  // vault handle (db + userId) as the ingest routes; NEVER on the no-auth :8787.
  const gateway = createGatewayHandlers({ db: ingest.db, userId: ingest.userId, fetch: globalThis.fetch });
  const setGatewayCors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Mycelium-Sensitive');
  };
  app.options('/v1/*splat', (req, res) => { setGatewayCors(res); res.status(204).end(); });
  app.post('/v1/chat/completions', async (req, res) => {
    setGatewayCors(res);
    if (!(await requireAuth(req, res))) return;
    return gateway.chatCompletions(req, res);
  });
  app.get('/v1/models', async (req, res) => {
    setGatewayCors(res);
    if (!(await requireAuth(req, res))) return;
    return gateway.listModels(req, res);
  });

  return { app, auth, baseURL, transports, close: ingest.close };
}

/** Build the app and start listening. Resolves with the http.Server. */
export async function startHttpServer(opts = {}) {
  const { app, baseURL } = await createHttpApp(opts);
  const port =
    opts.port || Number(process.env.MYCELIUM_PORT) || urlPort(baseURL) || 4711;
  return new Promise((resolve) => {
    // Bind loopback ONLY. The remote transport reaches :4711 via localhost
    // (Caddy/frpc run on the same Mac); a 0.0.0.0 bind would expose the OAuth
    // surface to the LAN. See docs/REMOTE-CONNECT-TRANSPORT-DESIGN (T0).
    const httpServer = app.listen(port, '127.0.0.1', () => {
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
