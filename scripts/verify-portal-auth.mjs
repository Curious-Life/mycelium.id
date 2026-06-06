// scripts/verify-portal-auth.mjs — the portal/REST auth gate (Phase 1, step 1.2).
//
// Boots a REAL vault (injected ephemeral keys) so the gated vault sub-app exists,
// and points the gate's session validator at a STUB better-auth get-session
// endpoint (via MYCELIUM_AUTH_URL) so we exercise the real defaultValidateSession
// HTTP-forward without a live :4711. Asserts: loopback bypass, networked deny,
// cookie/Bearer allow, CSRF on cookie-authed writes, /auth/session gating, and
// that SPA navigation (non-data paths) is NOT gated.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── Stub better-auth /api/auth/get-session: authorized iff the cookie carries
//    our sentinel session token; mirrors better-auth (200 + JSON, or 200 null). ──
const authStub = http.createServer((req, res) => {
  if (req.url.startsWith('/api/auth/get-session')) {
    const cookie = req.headers.cookie || '';
    res.setHeader('content-type', 'application/json');
    if (cookie.includes('session_token=GOOD')) res.end(JSON.stringify({ user: { id: 'owner-1' } }));
    else res.end('null');
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => authStub.listen(0, '127.0.0.1', r));
const STUB_PORT = authStub.address().port;

const STATIC_BEARER = crypto.randomBytes(24).toString('hex');
process.env.MYCELIUM_DISABLE_EMBED = '1';
process.env.MYCELIUM_AUTH_URL = `http://127.0.0.1:${STUB_PORT}`;
process.env.MYCELIUM_MCP_BEARER = STATIC_BEARER;

const DATA = mkdtempSync(join(tmpdir(), 'myc-pauth-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const hex = () => crypto.randomBytes(32).toString('hex');

const GET_DATA = '/api/v1/portal/onboarding/status'; // benign 200 on an empty vault
const POST_DATA = '/api/v1/portal/__csrf_probe';     // no handler → gate decides, then 404
const NONDATA = '/library';                          // SPA nav — must NOT be gated

let server = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');
  server = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const base = server.url;

  const call = (path, { xff = null, cookie = null, bearer = null, csrf = null, method = 'GET' } = {}) => {
    const headers = {};
    if (xff) headers['x-forwarded-for'] = xff;
    if (cookie) headers['cookie'] = cookie;
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    if (csrf) headers['x-csrf-token'] = csrf;
    return fetch(`${base}${path}`, { method, headers }).then((r) => r.status);
  };
  const NET = '9.9.9.9';
  const GOOD = 'better-auth.session_token=GOOD';
  const BAD = 'better-auth.session_token=BAD';

  // A. desktop (loopback, no XFF) bypasses the gate
  ok(await call(GET_DATA) === 200, 'A. loopback GET data → 200 (desktop bypass)');

  // B–D. networked requests must authenticate
  ok(await call(GET_DATA, { xff: NET }) === 401, 'B. networked, no cookie → 401');
  ok(await call(GET_DATA, { xff: NET, cookie: BAD }) === 401, 'C. networked, bad cookie → 401');
  ok(await call(GET_DATA, { xff: NET, cookie: GOOD }) === 200, 'D. networked, valid cookie → 200');

  // E. static Bearer (future native client) authenticates without a cookie
  ok(await call(GET_DATA, { xff: NET, bearer: STATIC_BEARER }) === 200, 'E. networked, static Bearer → 200');
  ok(await call(GET_DATA, { xff: NET, bearer: 'wrong-but-long-enough-bearer-xxxx' }) === 401, 'E2. networked, bad Bearer → 401');

  // F. /auth/session gating drives the login bounce
  ok(await call('/auth/session') === 200, 'F1. /auth/session loopback → 200');
  ok(await call('/auth/session', { xff: NET }) === 401, 'F2. /auth/session networked, no cookie → 401');
  ok(await call('/auth/session', { xff: NET, cookie: GOOD }) === 200, 'F3. /auth/session networked, valid cookie → 200');

  // G. CSRF double-submit on cookie-authed UNSAFE methods
  const g1 = await call(POST_DATA, { xff: NET, cookie: GOOD, method: 'POST' });
  ok(g1 === 403, 'G1. networked cookie POST without CSRF → 403', `(${g1})`);
  const g2 = await call(POST_DATA, { xff: NET, cookie: `${GOOD}; mycelium_csrf=tok`, csrf: 'tok', method: 'POST' });
  ok(g2 !== 403 && g2 !== 401, 'G2. networked cookie POST WITH matching CSRF → gate passes (404, not 403)', `(${g2})`);
  // Bearer is exempt from CSRF (no ambient credential)
  const g3 = await call(POST_DATA, { xff: NET, bearer: STATIC_BEARER, method: 'POST' });
  ok(g3 !== 403 && g3 !== 401, 'G3. networked Bearer POST (no CSRF) → gate passes', `(${g3})`);

  // H. SPA navigation (non-data path) is NOT gated even when networked
  const h = await call(NONDATA, { xff: NET });
  ok(h !== 401 && h !== 403, 'H. networked GET /library (SPA nav) → not gated', `(${h})`);

  // I. normalization safety: a networked, no-cookie request to a double-slashed
  //    data path must NEVER return data ungated (gate+router agree via Express
  //    /api mount). Acceptable: 401 (gated) or 404 (no match) — never 200.
  const i = await call('//api/v1/portal/onboarding/status', { xff: NET });
  ok(i !== 200, 'I. networked //api/... (no cookie) → never 200 (no normalization bypass)', `(${i})`);
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 160)}`);
} finally {
  try { await server?.close?.(); } catch { /* */ }
  try { authStub.close(); } catch { /* */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
