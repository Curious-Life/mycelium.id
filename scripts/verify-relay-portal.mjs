// scripts/verify-relay-portal.mjs — the edge routing table (Phase 1, step 1.3).
//
// The on-Mac Caddy fans the one public host out to the two local servers. This
// gate asserts the routing SECURITY PROPERTIES on the single source of truth
// (edgeRouteFor) AND on the rendered Caddyfile: the control surfaces 404 at the
// edge (V-1 layer a), OAuth/MCP/gateway/ingest → :4711, and everything else
// (incl. the now-authenticated portal) → :8787. Pure functions — no server boot.
import { edgeRouteFor, renderCaddyfile } from '../src/remote/runtime.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// route(path) → { name, upstream|deny }
const route = (p) => {
  const r = edgeRouteFor(p);
  return r ? { name: r.name, deny: r.action.type === 'deny', upstream: r.action.upstream } : null;
};
const isDeny = (p) => { const r = route(p); return !!(r && r.deny); };
const goesTo = (p, port) => { const r = route(p); return !!(r && !r.deny && r.upstream.endsWith(`:${port}`)); };

// ── A. control surfaces 404 at the edge (V-1 layer a) ──────────────────────
ok(isDeny('/api/v1/account'), 'A1. /api/v1/account → deny (404 at edge)');
ok(isDeny('/api/v1/account/status'), 'A2. /api/v1/account/status → deny');
ok(isDeny('/api/v1/account/setup'), 'A3. /api/v1/account/setup → deny (recovery-key minter)');
ok(isDeny('/api/v1/remote'), 'A4. /api/v1/remote → deny');
ok(isDeny('/api/v1/remote/password'), 'A5. /api/v1/remote/password → deny (operator-password setter)');

// ── B. OAuth / MCP / gateway / ingest → :4711 ──────────────────────────────
ok(goesTo('/mcp', 4711), 'B1. /mcp → :4711');
ok(goesTo('/mcp/messages', 4711), 'B2. /mcp/* → :4711');
ok(goesTo('/api/auth/get-session', 4711), 'B3. /api/auth/get-session → :4711 (the gate forwards here)');
ok(goesTo('/api/auth/sign-in/email', 4711), 'B4. /api/auth/sign-in/email → :4711 (operator login)');
ok(goesTo('/v1/chat/completions', 4711), 'B5. /v1/* gateway → :4711');
ok(goesTo('/.well-known/oauth-authorization-server', 4711), 'B6. /.well-known/* → :4711');
ok(goesTo('/.well-known/oauth-authorization-server/mcp', 4711), 'B7. /.well-known/*/mcp → :4711');
ok(goesTo('/login', 4711), 'B8. /login → :4711');
ok(goesTo('/ingest/message', 4711), 'B9. /ingest/* → :4711');

// ── C. everything else → :8787 (authenticated portal + /auth shim + UI) ────
ok(goesTo('/api/v1/portal/onboarding/status', 8787), 'C1. /api/v1/portal/* → :8787 (gated data)');
ok(goesTo('/api/v1/tools', 8787), 'C2. /api/v1/tools → :8787');
ok(goesTo('/auth/session', 8787), 'C3. /auth/session (shim) → :8787 (NOT /api/auth)');
ok(goesTo('/', 8787), 'C4. / (SPA) → :8787');
ok(goesTo('/library', 8787), 'C5. /library (SPA nav) → :8787');
ok(goesTo('/favicon.svg', 8787), 'C6. static asset → :8787');

// negative: control paths must NOT be proxied to either backend
ok(!goesTo('/api/v1/account', 8787) && !goesTo('/api/v1/account', 4711), 'C7. /api/v1/account proxied NOWHERE');
ok(!goesTo('/api/v1/remote/password', 8787) && !goesTo('/api/v1/remote/password', 4711), 'C8. /api/v1/remote/password proxied NOWHERE');

// ── D. rendered Caddyfile structure + ordering ─────────────────────────────
const cfg = renderCaddyfile({ publicHost: 'alice.mycelium.id', dataDir: '/tmp/x', acmeDns: { username: 'u', password: 'p', subdomain: 's', serverUrl: 'https://acme' } });
ok(cfg.includes('respond 404'), 'D1. rendered Caddyfile denies (respond 404)');
ok(cfg.includes('reverse_proxy 127.0.0.1:4711'), 'D2. rendered routes to :4711');
ok(cfg.includes('reverse_proxy 127.0.0.1:8787'), 'D3. rendered routes to :8787');
ok(/@control path .*\/api\/v1\/account.*\/api\/v1\/remote/.test(cfg), 'D4. @control matcher covers account + remote');
const ctrlIdx = cfg.indexOf('@control');
const portalIdx = cfg.lastIndexOf('handle {'); // the catch-all (no matcher)
ok(ctrlIdx >= 0 && portalIdx >= 0 && ctrlIdx < portalIdx, 'D5. control handle precedes the catch-all (first-match-wins → 404 before portal)');
ok(cfg.includes('tls {') && cfg.includes('dns acmedns'), 'D6. TLS (ACME DNS-01) block preserved');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
