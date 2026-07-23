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
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { boot } from './index.js';
import { createAuth, migrateAuth, ensureOperatorUser, ensurePasskeyLastUsedColumn } from './auth.js';
import { uploadAttachment } from './ingest/upload.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';
import { issueLoginCsrf, verifyLoginCsrf } from './http/login-csrf.js';
import { createGatewayHandlers } from './gateway/openai-compat.js';
import { createEmbeddingsHandler } from './gateway/embeddings.js';
import { matchStaticBearer } from './gateway/static-bearer.js';
import { createPathThrottle } from './http/rate-limit.js';
import { createFederationRouter } from './federation/router.js';
import { readRemoteConfig, resolveMcpBearer, passkeyEnrolled } from './remote/config.js';
import { currentHandle as handleServiceCurrentHandle, firstLabel } from './identity/handle-service.js';

/**
 * Build the Express app (no listen). Returns { app, auth, baseURL, transports }.
 * @param {object} [opts]
 * @param {object} [opts.authOpts]   passed to createAuth
 * @param {object} [opts.bootOpts]   passed to boot (e.g. dbPath, kcvPath, keys)
 * @param {{email?:string,password?:string}} [opts.operator]
 */
export async function createHttpApp(opts = {}) {
  const { auth, baseURL, database: authDb } = createAuth(opts.authOpts);
  await migrateAuth(auth);
  // Add the app-local `last_used_at` column to the passkey table (better-auth's
  // schema has none). Written by the afterVerification hook (auth.js), read by
  // GET /api/auth/passkeys below. After migrateAuth so the table exists.
  ensurePasskeyLastUsedColumn(authDb);
  // The static bearer for this :4711 surface. env MYCELIUM_MCP_BEARER wins; else a
  // stable value auto-provisioned + persisted in auth.db — so the self-hosted app
  // ALWAYS accepts a copy-paste bearer (the hooks / local harnesses) with no manual
  // setup, instead of being OAuth-only. Resolved ONCE here; retrievable by the
  // operator via GET /portal/mcp-bearer.
  const staticBearer = resolveMcpBearer();

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
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, *');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    res.json(protectedResourceMetadata);
  };
  app.options(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], sendPrm);
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], sendPrm);

  // Friendly root — a browser hitting :4711 used to get Express's bare
  // "Cannot GET /". Respond with a tiny static page that explains what this is,
  // WITHOUT enumerating routes or leaking the auth surface (the route-hiding 404
  // gate below stays intact). Exact "/" only, so it never shadows /mcp, /login,
  // the well-knowns, or OAuth endpoints. No inline script (inert).
  app.get('/', (req, res) => {
    if (req.accepts('html')) {
      return res.type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Mycelium</title>' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>:root{color-scheme:dark}body{background:#0A0A0C;color:#E8E8EC;display:grid;place-items:center;height:100vh;margin:0;font:15px/1.6 system-ui,-apple-system,sans-serif;text-align:center;padding:2rem}h1{font-weight:600;margin:0 0 .5rem}p{color:#9898A3;max-width:30rem}a{color:#E5B84C}</style>' +
        '<main><h1>Mycelium</h1><p>This is the Mycelium MCP server — your private, encrypted memory vault. It speaks the Model Context Protocol; connect an MCP client (Claude, the MCP Inspector, …) rather than a browser.</p><p><a href="https://mycelium.id">mycelium.id</a></p></main>',
      );
    }
    res.json({ service: 'mycelium-mcp', transport: 'mcp', docs: 'https://mycelium.id' });
  });

  // CRITICAL (security audit): block the relay-exposed HTTP sign-up. This is a
  // single-user vault — the operator account is seeded server-side at provisioning
  // (ensureOperatorUser, an in-process call that does NOT traverse this guard).
  // Left open, /api/auth/sign-up/* lets ANYONE on the relay mint a better-auth
  // account + session, which would pass the portal gate AND MCP authorize and
  // reach the owner's vault. 404 (do not reveal the route).
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.toLowerCase().startsWith('/api/auth/sign-up')) {
      return res.status(404).json({ error: 'not_found' });
    }
    return next();
  });

  // Require-passkey-for-web (hardening, opt-in). When the operator has turned it on
  // AND has at least one passkey enrolled, the operator PASSWORD is no longer a
  // sufficient web credential — every relay-reachable password sign-in is refused, so
  // the only way in over the web is the phishing-resistant passkey. Inert until both
  // conditions hold (no bootstrap lockout), and auto-disabled on a host change
  // (rpID-orphan safety, see config.writeRemoteConfig). Desktop loopback never hits
  // these endpoints (it's "always signed in" via the shim) and the recovery-key flow
  // is loopback-only, so this can NEVER permanently lock the owner out.
  // Read per-request (config is cheap, file-backed) so toggling takes effect live.
  const webPasswordLoginBlocked = () => {
    try { return readRemoteConfig().requirePasskeyForWeb === true && passkeyEnrolled(); }
    catch { return false; } // fail OPEN on a config/db read error — never lock out by accident
  };
  // Pre-handler guard for the better-auth catch-all password sign-in (the SPA's
  // raw path + any direct caller). The operator-login shim and /login form guard
  // themselves below (they render friendlier responses).
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.toLowerCase() === '/api/auth/sign-in/email' && webPasswordLoginBlocked()) {
      return res.status(403).json({ error: 'passkey_required', message: 'This vault requires a passkey for web sign-in.' });
    }
    return next();
  });

  // Brute-force throttle on the relay-exposed operator sign-in (gap review): a
  // GLOBAL bucket (un-evadable by header spoofing) — see src/http/rate-limit.js.
  // Mounted BEFORE the auth handler so a 429 short-circuits before better-auth.
  app.use(createPathThrottle({ method: 'POST', path: '/api/auth/sign-in/email', max: 5, windowMs: 60_000 }));
  app.use(createPathThrottle({ method: 'POST', path: '/api/auth/passkey/verify-authentication', max: 10, windowMs: 60_000 }));
  // /login is the OAuth-authorize login form — it ALSO checks the operator
  // password (signInEmail) and is relay-exposed, so throttle it too.
  app.use(createPathThrottle({ method: 'POST', path: '/login', max: 5, windowMs: 60_000 }));
  // The portal SPA's password-only sign-in shim (see below) is relay-exposed and
  // checks the operator password — throttle it on the same global bucket policy.
  app.use(createPathThrottle({ method: 'POST', path: '/api/auth/operator-login', max: 5, windowMs: 60_000 }));
  // OAuth code/token exchange + dynamic client registration are relay-exposed too.
  // Throttling the token endpoint blunts connector-credential guessing; throttling
  // registration blunts client-spam. Higher caps than sign-in (these are legitimately
  // hit a few times per connect) but still bounded.
  app.use(createPathThrottle({ method: 'POST', path: '/api/auth/mcp/token', max: 30, windowMs: 60_000 }));
  app.use(createPathThrottle({ method: 'POST', path: '/api/auth/mcp/register', max: 10, windowMs: 60_000 }));

  // Password-only operator sign-in for the portal SPA (the webview /login). The
  // vault is single-user, so the SPA never asks for or sees the operator account's
  // internal email — it POSTs just { password } and we inject the canonical
  // operatorEmail SERVER-SIDE, then relay better-auth's Set-Cookie. signInEmail is
  // called server-side (bypassing better-auth's HTTP Origin/CSRF guard), so we
  // enforce a trusted-Origin check here (login-CSRF defense) + the throttle above.
  // Mounted BEFORE the /api/auth/*splat catch-all so better-auth doesn't 404 it.
  app.post('/api/auth/operator-login', express.json(), async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== baseURL) return res.status(403).json({ error: 'forbidden' });
    // Passkey-required: refuse password sign-in; the SPA falls back to its passkey button.
    if (webPasswordLoginBlocked()) return res.status(403).json({ error: 'passkey_required', message: 'This vault requires a passkey for web sign-in.' });
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: 'password required' });
    const email = readRemoteConfig().operatorEmail; // fixed internal identifier — never surfaced
    try {
      const r = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      if (!r.ok) return res.status(401).json({ error: 'invalid password' });
      const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      return res.status(200).json({ ok: true });
    } catch { return res.status(401).json({ error: 'invalid password' }); }
  });

  // Enriched passkey list for the Settings panel. better-auth's own
  // /api/auth/passkey/list-user-passkeys drops our app-local `last_used_at`
  // column (its adapter transformOutput only emits schema fields), so the panel
  // reads its list here instead. Session-gated (the browser's better-auth cookie,
  // same-origin over the relay) and scoped to the authenticated user's own rows —
  // it never lists another account's credentials and never returns the raw
  // credentialID or public key. Register/rename/delete still go through
  // better-auth's own owner-scoped endpoints. Mounted BEFORE the /api/auth/*splat
  // catch-all so better-auth doesn't 404 it.
  app.get('/api/auth/passkeys', async (req, res) => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user?.id) return res.status(401).json({ error: 'unauthorized' });
      let rows = [];
      try {
        rows = authDb
          .prepare('SELECT id, name, createdAt, last_used_at, deviceType, backedUp FROM passkey WHERE userId = ? ORDER BY createdAt ASC')
          .all(session.user.id);
      } catch { rows = []; }
      const passkeys = rows.map((r) => ({
        id: r.id,
        name: r.name || null,
        createdAt: r.createdAt || null,
        lastUsedAt: r.last_used_at || null,
        deviceType: r.deviceType || null,
        backedUp: r.backedUp === 1 || r.backedUp === true,
      }));
      // Whether the require-passkey-for-web policy is on, so the panel can warn
      // (not block) before removing the last passkey. Non-secret status only.
      let requirePasskeyForWeb = false;
      try { requirePasskeyForWeb = readRemoteConfig().requirePasskeyForWeb === true; } catch { /* default false */ }
      return res.json({ passkeys, requirePasskeyForWeb });
    } catch {
      return res.status(500).json({ error: 'passkey_list_failed' });
    }
  });

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
      // Scope the CREDENTIALED reflection to exactly the two browser-MCP CORS
      // endpoints that need it (DCR register + token exchange) — H6. Reflecting
      // Origin + Allow-Credentials on ALL /api/auth/* was a latent footgun on the
      // OAuth/session authority; other auth endpoints get a non-credentialed
      // preflight (origin still echoed so nothing breaks).
      const credentialed = !!origin && (p.endsWith('/mcp/register') || p.endsWith('/mcp/token'));
      res.set('Access-Control-Allow-Origin', origin || '*');
      if (origin) res.set('Vary', 'Origin');
      if (credentialed) res.set('Access-Control-Allow-Credentials', 'true');
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
  // The vault's tag (first label of publicHost), or null when no remote handle is
  // configured → the form brands generically. This is the IDENTITY the user sees;
  // the single operator account's internal email is never asked for or shown.
  const currentHandle = () => handleServiceCurrentHandle();
  // Is this /login visit an enrolment flow? `?enroll=1` — the desktop Settings
  // "Set up a passkey" action opens THIS relay page (the WebAuthn ceremony must run
  // on the relay origin, whose rpID = <handle>.mycelium.id; the loopback webview
  // can't mint a credential for that rpID). `step=passkey` = the post-sign-in enrol
  // view (a session now exists → generate-register-options is authorised).
  const wantsEnroll = (qs) => { try { return new URLSearchParams(qs).get('enroll') === '1'; } catch { return false; } };
  const loginPage = (qs, err, csrf = '', handle = null, opts = {}) => {
    const { passkeyRequired = false, enrollStep = false } = opts;
    const ident = handle ? `@${escHtml(handle)}` : 'your vault';
    // Auto-label the WebAuthn credential with the PUBLIC vault handle (no secret) so
    // the OS authenticator / password manager shows "<handle>.mycelium.id". Passed to
    // login.js as ?name=… on generate-register-options (@better-auth/passkey uses
    // ctx.query.name as userName). Generic fallback when no handle is claimed.
    const pkName = handle ? `${handle}.mycelium.id` : 'Mycelium vault';
    const enroll = wantsEnroll(qs);
    // The subtitle reflects WHY you're here: an OAuth connector flow (client_id in
    // the query) vs a plain web sign-in to open the vault.
    const isOAuth = (() => { try { return new URLSearchParams(qs).has('client_id'); } catch { return false; } })();
    const errBlock = `<div class="e" id="err"${err ? '' : ' style="display:none"'}>${err ? escHtml(err) : ''}</div>`;
    // Data attributes login.js reads (first-party, CSP-safe). data-enroll carries the
    // enrol intent across the password POST → redirect; data-pkname is the label.
    const dataAttrs = `data-qs="${escHtml(qs)}"${enroll ? ' data-enroll="1"' : ''} data-pkname="${escHtml(pkName)}"`;
    const shell = (inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mycelium — Sign in</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0c;color:#eaeaea;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#15151a;padding:2rem;border-radius:14px;width:320px;border:1px solid #26262e}h1{font-size:1.05rem;margin:0 0 .4rem;color:#c9a227;font-weight:600}.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a8a99;font-size:.85rem;margin:0 0 1.2rem}input{width:100%;box-sizing:border-box;margin:.35rem 0;padding:.65rem;background:#0a0a0c;border:1px solid #26262e;border-radius:8px;color:#eaeaea}button{width:100%;margin-top:1rem;padding:.7rem;background:#c9a227;color:#0a0a0c;border:0;border-radius:8px;font-weight:700;cursor:pointer}button.alt{background:transparent;color:#c9a227;border:1px solid #26262e}button.link{width:auto;display:block;margin:.7rem auto 0;padding:.3rem;background:transparent;color:#8a8a99;border:0;border-radius:0;font-weight:400;font-size:.8rem;text-decoration:underline}.e{color:#f87171;font-size:.85rem;margin:.3rem 0}.s{color:#8a8a99;font-size:.72rem;margin-top:1rem;text-align:center}</style></head><body>${inner}<script src="/login.js"></script></body></html>`;
    // Post-sign-in enrol view: session exists, run the registration ceremony (no
    // password field). login.js wires #pkreg to generate-register-options → create →
    // verify-registration, then to the vault.
    if (enrollStep) {
      return shell(`<form id="lf" ${dataAttrs}><h1>Add a passkey</h1><div class="id">${ident}</div><div class="s" style="margin-top:0;margin-bottom:1rem">Face ID, Touch ID, or a security key — for signing in to your vault on the web.</div>${errBlock}<button type="button" id="pkreg">Add a passkey</button><button type="button" class="alt" id="skip">Not now</button></form>`);
    }
    const sub = isOAuth ? 'Authorizing an app to reach this vault.'
      : (enroll ? 'Sign in to add a passkey to your vault.' : 'Sign in to open your vault.');
    // Passkey is the PRIMARY web credential (phishing-resistant) — shown first as the
    // main call-to-action. The operator PASSWORD stays a fully-working FALLBACK, kept
    // present in the DOM but demoted behind a "Use your password instead" disclosure
    // (revealed by login.js). A server-rendered error here is always a password-POST
    // failure, so we auto-reveal the password block on `err` (never hide the reason a
    // sign-in was rejected). Passkey-required → passkey-only (no password field at all).
    const pkBtn = `<button type="button" id="pk">Sign in with passkey</button>`;
    const pwOpen = !!err;
    const pwBlock = passkeyRequired ? ''
      : `<div id="pwblock"${pwOpen ? '' : ' style="display:none"'}><input name="password" type="password" placeholder="operator password" autocomplete="current-password"${pwOpen ? ' autofocus' : ''} required><button type="submit">Sign in with password</button></div>`
        + `<button type="button" id="pwtoggle" class="link"${pwOpen ? ' style="display:none"' : ''}>Use your password instead</button>`;
    const pkNote = passkeyRequired ? `<div class="s" style="margin-top:0;margin-bottom:.4rem">This vault requires a passkey.</div>` : '';
    return shell(`<form id="lf" method="POST" action="/login?${escHtml(qs)}" ${dataAttrs}><h1>Connect to your vault</h1><div class="id">${ident}</div>${pkNote}${errBlock}<input type="hidden" name="_csrf" value="${escHtml(csrf)}">${pkBtn}${pwBlock}<div class="s">${sub}</div></form>`);
  };

  // First-party WebAuthn driver for the OAuth /login passkey button (served 'self'
  // so it's CSP-safe; the plain form can't bundle @simplewebauthn). It drives the
  // same better-auth passkey endpoints the portal SPA uses, then resumes the flow:
  // an OAuth connect (client_id present) → /api/auth/mcp/authorize; else → portal.
  const LOGIN_JS = `(function(){
  var lf=document.getElementById('lf');
  var qs=(lf&&lf.dataset.qs)||''; var enroll=!!(lf&&lf.dataset.enroll); var pkname=(lf&&lf.dataset.pkname)||'';
  function b2b(s){s=String(s).replace(/-/g,'+').replace(/_/g,'/');var p=s.length%4;if(p)s+='='.repeat(4-p);var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}
  function b2u(buf){var u=new Uint8Array(buf),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
  function err(m){var e=document.getElementById('err');if(e){e.textContent=m;e.style.display='block';}}
  function hasClient(){try{return new URLSearchParams(qs).has('client_id');}catch(e){return false;}}
  // After a successful sign-in: resume an OAuth authorize, else — if the user came to
  // enrol (?enroll=1, not an OAuth flow) — go to the post-sign-in enrol step; else home.
  function afterAuth(){
    if(hasClient()) { window.location='/api/auth/mcp/authorize?'+qs; return; }
    if(enroll) { window.location='/login?enroll=1&step=passkey'; return; }
    window.location='/';
  }
  // ── Passkey SIGN-IN (existing) ──────────────────────────────────────────────
  var btn=document.getElementById('pk');
  if(btn) btn.addEventListener('click',async function(){
    btn.disabled=true; err('');
    try{
      var o=await fetch('/api/auth/passkey/generate-authenticate-options',{credentials:'same-origin'});
      if(!o.ok) throw new Error('No passkey is set up on this vault yet.');
      var opt=await o.json();
      var pub={challenge:b2b(opt.challenge),timeout:opt.timeout,rpId:opt.rpId,userVerification:opt.userVerification||'preferred',
        allowCredentials:(opt.allowCredentials||[]).map(function(c){return {id:b2b(c.id),type:c.type,transports:c.transports};})};
      var cred=await navigator.credentials.get({publicKey:pub});
      var resp={id:cred.id,rawId:b2u(cred.rawId),type:cred.type,response:{
        authenticatorData:b2u(cred.response.authenticatorData),clientDataJSON:b2u(cred.response.clientDataJSON),
        signature:b2u(cred.response.signature),userHandle:cred.response.userHandle?b2u(cred.response.userHandle):null}};
      var v=await fetch('/api/auth/passkey/verify-authentication',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({response:resp})});
      if(!v.ok) throw new Error('Passkey sign-in failed.');
      afterAuth();
    }catch(e){btn.disabled=false; err((e&&e.name==='NotAllowedError')?'Passkey sign-in cancelled':((e&&e.message)||'Passkey sign-in failed'));}
  });
  // ── Password FALLBACK disclosure ────────────────────────────────────────────
  // Passkey leads; the password form is hidden until the user asks for it. Reveal
  // it and focus the field (CSP-safe: no inline handler, driven from this 'self' JS).
  var tg=document.getElementById('pwtoggle'), pwb=document.getElementById('pwblock');
  if(tg&&pwb) tg.addEventListener('click',function(){pwb.style.display='block';tg.style.display='none';var pi=pwb.querySelector('input[name=password]');if(pi)pi.focus();});
  // ── Passkey ENROLMENT (post-sign-in, step=passkey) ──────────────────────────
  // The credential is bound to this page's rpID (= <handle>.mycelium.id), which is
  // why enrolment happens HERE (the relay origin), not in the loopback desktop app.
  // ?name=<handle> → the authenticator shows the handle (public, no secret).
  var rb=document.getElementById('pkreg');
  if(rb) rb.addEventListener('click',async function(){
    rb.disabled=true; err('');
    try{
      var o=await fetch('/api/auth/passkey/generate-register-options?name='+encodeURIComponent(pkname),{credentials:'same-origin'});
      if(o.status===401) throw new Error('Please sign in first, then add a passkey.');
      if(!o.ok) throw new Error('Could not start passkey setup.');
      var opt=await o.json();
      var pub={challenge:b2b(opt.challenge),rp:opt.rp,
        user:{id:b2b(opt.user.id),name:opt.user.name,displayName:opt.user.displayName},
        pubKeyCredParams:opt.pubKeyCredParams,timeout:opt.timeout,attestation:opt.attestation,
        authenticatorSelection:opt.authenticatorSelection,
        excludeCredentials:(opt.excludeCredentials||[]).map(function(c){return {id:b2b(c.id),type:c.type,transports:c.transports};})};
      var cred=await navigator.credentials.create({publicKey:pub});
      var resp={id:cred.id,rawId:b2u(cred.rawId),type:cred.type,response:{
        attestationObject:b2u(cred.response.attestationObject),clientDataJSON:b2u(cred.response.clientDataJSON)},
        clientExtensionResults:{}};
      var v=await fetch('/api/auth/passkey/verify-registration',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({response:resp,name:pkname})});
      if(!v.ok) throw new Error('Passkey setup failed.');
      window.location='/';
    }catch(e){rb.disabled=false; err((e&&e.name==='NotAllowedError')?'Passkey setup cancelled':((e&&e.message)||'Passkey setup failed'));}
  });
  var sk=document.getElementById('skip');
  if(sk) sk.addEventListener('click',function(){window.location='/';});
})();`;
  app.get('/login.js', (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send(LOGIN_JS);
  });

  app.get('/login', (req, res) => {
    const qs = req.originalUrl.split('?').slice(1).join('?') || '';
    // Post-sign-in enrol step (?enroll=1&step=passkey): render the add-a-passkey view.
    // No auth check here — generate-register-options is session-gated server-side, so
    // an unauthenticated hit fails closed (401 → "please sign in first"), never enrols.
    const step = (() => { try { return new URLSearchParams(qs).get('step'); } catch { return null; } })();
    if (step === 'passkey') {
      res.type('html').send(loginPage(qs, null, '', currentHandle(), { enrollStep: true }));
      return;
    }
    const csrf = issueLoginCsrf(req, res);
    res.type('html').send(loginPage(qs, null, csrf, currentHandle(), { passkeyRequired: webPasswordLoginBlocked() }));
  });
  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const qs = req.originalUrl.split('?').slice(1).join('?') || '';
    // Passkey-required: never process a password here — re-render passkey-only.
    if (webPasswordLoginBlocked()) {
      res.status(403).type('html').send(loginPage(qs, 'This vault requires a passkey — use the passkey button.', issueLoginCsrf(req, res), currentHandle(), { passkeyRequired: true }));
      return;
    }
    // CSRF + same-origin guard (H6): this server-side sign-in bypasses
    // better-auth's HTTP-layer CSRF check, so we enforce our own before touching
    // credentials. A failed check re-renders with a fresh token (no info leak).
    const csrfCheck = verifyLoginCsrf(req);
    if (!csrfCheck.ok) {
      res.status(403).type('html').send(loginPage(qs, 'Your session expired — please try again.', issueLoginCsrf(req, res), currentHandle()));
      return;
    }
    // Single-user vault: the identity is the seeded operator account; the user
    // authenticates with their password only. We never ask for or surface the
    // internal account email — fill the canonical operatorEmail server-side.
    const email = readRemoteConfig().operatorEmail;
    const password = String(req.body?.password || '');
    if (!password) { res.status(400).type('html').send(loginPage(qs, 'Password required', issueLoginCsrf(req, res), currentHandle())); return; }
    try {
      const r = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      if (!r.ok) { res.status(401).type('html').send(loginPage(qs, 'Invalid password', issueLoginCsrf(req, res), currentHandle())); return; }
      const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      // Two ways here: (1) an OAuth connector flow (Claude) bounced through /login —
      // the query carries client_id, so resume the authorize handshake; (2) a plain
      // WEB sign-in (the relay routes /login here) with NO client_id — resuming
      // authorize would dead-end at better-auth's invalid_client error page. Instead
      // send the now-authenticated browser to the portal home; the session cookie we
      // just set is valid for the whole host, so the portal opens.
      const hasOAuthClient = (() => { try { return new URLSearchParams(qs).has('client_id'); } catch { return false; } })();
      // Enrol intent (?enroll=1, plain web sign-in): the session is now set, so carry
      // the browser to the add-a-passkey step (the credential binds to this origin's
      // rpID = <handle>.mycelium.id). Otherwise open the vault.
      const target = hasOAuthClient ? `/api/auth/mcp/authorize?${qs}`
        : (wantsEnroll(qs) ? '/login?enroll=1&step=passkey' : '/');
      res.redirect(302, target);
    } catch {
      res.status(401).type('html').send(loginPage(qs, 'Invalid password', issueLoginCsrf(req, res), currentHandle()));
    }
  });

  // JSON parsing for the MCP + federation routes (after the auth handler). The
  // `verify` hook stashes the exact received bytes on req.rawBody so the federation
  // handlers can verify a peer's ed25519 signature over the RAW request body (the
  // bytes the sender actually signed) instead of a re-canonicalized parse — see
  // src/federation/handlers.js verify(). Stashing the buffer does not alter parsing.
  // limit 10mb (default is 100kb): /ingest/import bulk-syncs Claude Code history
  // in batches that routinely exceed 100kb (~117kb for 50 coding turns) — the
  // default silently 413'd them, which the bridge mis-read as "app down" and
  // retried forever, stalling the whole sync. Loopback single-user, so a generous
  // body cap is safe.
  app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Shared vault handle for the authenticated ingestion routes (one per app,
  // not per request — unlike /mcp which isolates per session). Reuses the SAME
  // captureMessage/importMessages handlers as the stdio + REST surfaces.
  const ingest = await boot(opts.bootOpts);
  // Enrichment nudge for upload-created messages (same best-effort seam as MCP).
  ingest.enqueueEnrichment = createEnqueueEnrichment({ userId: ingest.userId });

  // Federation (Tier-0): did:web + WebFinger + signed inbound /federation/connect.
  // Mounted AFTER express.json() so the connect handler sees the parsed payload
  // (for ts/nonce/$type checks) AND req.rawBody (the signature is verified over the
  // raw received bytes — the bytes the sender signed). The /.well-known
  // GETs inherit the CORS middleware above and are public by design. getHost/
  // getHandle re-read remote config per request so a handle claimed after boot
  // is picked up without a restart. Fail closed when no public host is set.
  app.use(createFederationRouter({
    db: ingest.db,
    userId: ingest.userId,
    identity: ingest.identity,
    getHost: () => readRemoteConfig().publicHost || '',
    getHandle: () => firstLabel(readRemoteConfig().publicHost),
    // Phase B: advertise the box MXID as a #matrix service so connected peers can
    // discover where to invite us for shared-space Megolm rooms. Read per-request
    // (like getHost/getHandle); null until a homeserver is configured.
    getMatrixId: () => readRemoteConfig().matrixUserId || null,
    // Store-and-forward relay inbox (federation transport P4): advertise WHERE peers
    // enqueue sealed envelopes for us — our OWN configured relay (managed control plane
    // or an own-relay URL; custom relays work because each box advertises its own).
    // Null in direct/off modes (no relay). Read per-request.
    getRelayInbox: () => { const rc = readRemoteConfig(); return (rc.remoteMode === 'managed' || rc.remoteMode === 'own-relay') ? (rc.controlPlaneUrl || null) : null; },
    // Presence (online/offline dot): config + the owner activity heartbeat. Read
    // per-request; the heartbeat is written by the :8787 auth chokepoint to the
    // shared DB (cross-process), read here to answer online/offline for connections.
    getPresenceConfig: () => readRemoteConfig().presence || {},
    getLastActiveAt: () => ingest.db.peerPresence.lastActiveAt(ingest.userId),
  }));

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
      console.error('[myc-auth]', req.method, '/mcp — no/non-bearer header:', authHeader ? '(non-bearer)' : '(none)');
      return null;
    }
    // §3b opt-in static bearer (fail-closed: only when MYCELIUM_MCP_BEARER is set,
    // length-floored, constant-time compared — see gateway/static-bearer.js).
    // Accepted IN ADDITION to OAuth so a local harness / 2.0-only client connects
    // with a copy-paste token. Covers /mcp AND the /v1 gateway (both authenticate
    // through here). The token itself is never logged.
    if (matchStaticBearer(authHeader, process.env, staticBearer)) {
      console.error('[myc-auth]', req.method, '— static bearer accepted');
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

  // POST /context — the pull half of the memory bridge. Returns the getContext
  // preamble (+ an optional searchMindscape slice) as plain JSON so a connected
  // harness can inject vault context per turn WITHOUT speaking MCP JSON-RPC (a
  // shell hook just curls this). Reuses the SAME getContext/searchMindscape
  // handlers the MCP surface exposes. Bearer-guarded like /ingest/* and /v1/*.
  //   body: { query?: string, maxChars?: number }  →  { ok, text }
  // SECURITY: the returned text is vault plaintext; the caller decides whether to
  // feed it to an external model (documented egress surface). maxChars caps bloat.
  app.post('/context', async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const maxChars = Math.min(Number(body.maxChars) > 0 ? Number(body.maxChars) : 4000, 16000);
    try {
      // getContext returns a bare STRING (not an MCP {content:[…]} envelope). It
      // is the fast, always-available per-turn orientation — fetch + return it
      // FIRST so a slow/failing search can never drop the base context.
      let text = await ingest.handlers.getContext({});
      text = typeof text === 'string' ? text : '';
      // Optional relevance slice — BEST-EFFORT and TIME-BOUNDED. searchMindscape
      // can be slow on a large vault (BM25 fallback + per-row decrypt), and a
      // per-turn hook is latency-sensitive, so we race it against a short budget
      // and skip it on timeout/throw rather than blocking or 500-ing the call.
      if (typeof body.query === 'string' && body.query.trim()) {
        try {
          const s = await Promise.race([
            ingest.handlers.searchMindscape({ query: body.query, limit: 5 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('search-timeout')), 1500)),
          ]);
          if (typeof s === 'string' && s.trim()) text += `\n\n---\n# RELEVANT TO THIS TURN\n\n${s}`;
        } catch { /* skip the slice; base context already set */ }
      }
      res.json({ ok: true, text: text.slice(0, maxChars) });
    } catch {
      // Fail-soft: a context failure must never block the harness's turn. The
      // caller treats a non-2xx / empty text as "no context" and proceeds.
      res.status(500).json({ ok: false, error: 'context failed' });
    }
  });

  // ── OpenAI-compatible outbound gateway (S8), Bearer-guarded like /ingest/* ──
  // A user's harness points its model base-URL at <handle>.mycelium.id/v1 → it
  // gets sovereign, jurisdiction-gated, AUDITED inference through the operator's
  // own BYOK keys (no provider key of its own). Uses the SAME shared `ingest`
  // vault handle (db + userId) as the ingest routes; NEVER on the no-auth :8787.
  // getContext + captureMessage wired in so the gateway can act as the universal
  // memory bridge when a harness opts in via `X-Mycelium-Capture` (reuses the SAME
  // handlers the MCP + /ingest surfaces expose; absent the header → pure proxy).
  const gateway = createGatewayHandlers({
    db: ingest.db,
    userId: ingest.userId,
    fetch: globalThis.fetch,
    getContext: ingest.handlers.getContext,
    captureMessage: ingest.handlers.captureMessage,
  });
  // /v1/embeddings — fronts the LOCAL Nomic embed-service ONLY (never cloud); see
  // src/gateway/embeddings.js for the §7 rationale (vectors are sensitive).
  const embeddings = createEmbeddingsHandler();
  const setGatewayCors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Mycelium-Sensitive, X-Mycelium-Embed-Task, X-Mycelium-Capture, X-Mycelium-Conversation');
  };
  app.options('/v1/*splat', (req, res) => { setGatewayCors(res); res.status(204).end(); });
  app.post('/v1/chat/completions', async (req, res) => {
    setGatewayCors(res);
    if (!(await requireAuth(req, res))) return;
    return gateway.chatCompletions(req, res);
  });
  app.post('/v1/embeddings', async (req, res) => {
    setGatewayCors(res);
    if (!(await requireAuth(req, res))) return;
    return embeddings.embeddings(req, res);
  });
  app.get('/v1/models', async (req, res) => {
    setGatewayCors(res);
    if (!(await requireAuth(req, res))) return;
    return gateway.listModels(req, res);
  });

  return { app, auth, baseURL, transports, close: ingest.close };
}

// Hosts that keep :4711 private to the box. Anything else is a deliberate
// (and loudly warned) exposure of the OAuth/MCP/gateway surface.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Build the app and start listening. Resolves with the http.Server. */
export async function startHttpServer(opts = {}) {
  const { app, baseURL } = await createHttpApp(opts);
  const port =
    opts.port || Number(process.env.MYCELIUM_PORT) || urlPort(baseURL) || 4711;
  // Bind loopback by DEFAULT. The remote transport reaches :4711 via localhost
  // (Caddy/frpc run on the same box); a 0.0.0.0 bind would expose the OAuth +
  // gateway surface to the LAN. MYCELIUM_HTTP_HOST is an explicit opt-out for an
  // operator who fronts :4711 with their own TLS proxy — mirrors the
  // MYCELIUM_REST_HOST / MYCELIUM_PUBLIC_HOST knobs on the other servers.
  const host = opts.host || process.env.MYCELIUM_HTTP_HOST || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    console.error(
      `[mycelium] ⚠️ HTTP+OAuth+gateway binding to ${host} (non-loopback) — this exposes the OAuth/MCP/gateway surface beyond localhost. ` +
      `Only do this behind a TLS reverse proxy + firewall; the relay reaches :4711 via loopback and does NOT need this.`,
    );
  }
  return new Promise((resolve) => {
    const httpServer = app.listen(port, host, () => {
      // stderr so it never pollutes a stdio MCP stream.
      console.error(`[mycelium] HTTP+OAuth listening on ${baseURL} (port ${port}, host ${host})`);
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
