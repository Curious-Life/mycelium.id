// scripts/verify-auth-hardening.mjs — security hardening from the gap review
// (relay-exposed auth). One app serves the better-auth handler (/api/auth/*),
// the global sign-in throttle (the SAME middleware server-http.js mounts), and
// the portal /auth shim. Validates:
//   A. brute-force throttle: rapid /sign-in/email attempts get 429 (global,
//      un-evadable) — and it is actually mounted in server-http.js.
//   B. networked logout REVOKES the better-auth session (no false logout): the
//      shim forwards cookie+Origin to /api/auth/sign-out; the old cookie dies.
import { readFileSync } from 'node:fs';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { createAuth, migrateAuth, ensureOperatorUser } from '../src/auth.js';
import { authShimRouter } from '../src/auth-shim.js';
import { createPathThrottle } from '../src/http/rate-limit.js';
import { resolveRequester } from '../src/http/require-vault-auth.js';
import { issueLoginCsrf, verifyLoginCsrf, LOGIN_CSRF_COOKIE } from '../src/http/login-csrf.js';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

// 0. the throttle is actually wired into the real server (not just this test)
const srvHttp = readFileSync(new URL('../src/server-http.js', import.meta.url), 'utf8');
ok(/createPathThrottle\([^)]*\/api\/auth\/sign-in\/email/.test(srvHttp), '0. sign-in throttle mounted in server-http.js');
ok(/startsWith\('\/api\/auth\/sign-up'\)/.test(srvHttp) && /res\.status\(404\)/.test(srvHttp), '0b. relay HTTP sign-up BLOCKED in server-http.js (audit)');

// ── H6: POST /login CSRF guard + scoped credentialed CORS (source + unit) ──
ok(/verifyLoginCsrf\(req\)/.test(srvHttp) && /issueLoginCsrf\(req, res\)/.test(srvHttp), 'H6a. POST /login enforces CSRF; GET issues a token (server-http.js)');
ok(/p\.endsWith\('\/mcp\/register'\)\s*\|\|\s*p\.endsWith\('\/mcp\/token'\)/.test(srvHttp), 'H6b. credentialed CORS scoped to /mcp/register + /mcp/token only');
{
  const fakeRes = () => { const c = []; return { append: (_k, v) => c.push(v), cookies: c }; };
  const r1 = fakeRes();
  const tok = issueLoginCsrf({ headers: {} }, r1);
  const sc = r1.cookies[0] || '';
  ok(/^myc_login_csrf=/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && tok.length >= 32, 'H6c. GET mints a high-entropy HttpOnly SameSite=Strict CSRF cookie');
  const r2 = fakeRes(); issueLoginCsrf({ headers: { 'x-forwarded-proto': 'https' } }, r2);
  ok(/Secure/.test(r2.cookies[0] || ''), 'H6c2. Secure flag set when the request arrived over https (relay)');
  const reqOk = { headers: { cookie: `${LOGIN_CSRF_COOKIE}=${tok}`, host: 'vault', origin: 'http://vault' }, body: { _csrf: tok } };
  ok(verifyLoginCsrf(reqOk).ok, 'H6d. matching token + same-origin → accepted');
  ok(!verifyLoginCsrf({ headers: { host: 'vault' }, body: {} }).ok, 'H6e. cross-site post (no cookie, no field) → rejected');
  ok(!verifyLoginCsrf({ headers: { cookie: `${LOGIN_CSRF_COOKIE}=${tok}`, host: 'vault' }, body: { _csrf: 'wrong' } }).ok, 'H6f. mismatched token → rejected');
  ok(!verifyLoginCsrf({ headers: { cookie: `${LOGIN_CSRF_COOKIE}=${tok}`, host: 'vault', origin: 'http://evil.example' }, body: { _csrf: tok } }).ok, 'H6g. cross-origin Origin header → rejected even with a token');
}

process.env.MYCELIUM_AUTH_SECRET = 'auth-hardening-secret-'.padEnd(48, 'x');
process.env.MYCELIUM_USER_EMAIL = 'operator@mycelium.local'; // deterministic owner email for the pin
const app = express();
// SAME throttle config as server-http.js (max 5 / 60s on sign-in)
app.use(createPathThrottle({ method: 'POST', path: '/api/auth/sign-in/email', max: 5, windowMs: 60_000 }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.MYCELIUM_AUTH_URL = base; // the shim's logout forwards here

const email = 'operator@mycelium.local', password = 'correct-horse-battery-staple';
try {
  const { auth } = createAuth({ baseURL: base, dbPath: ':memory:' });
  await migrateAuth(auth);
  await ensureOperatorUser(auth, { email, password });
  // mirror server-http.js: block relay HTTP sign-up
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.toLowerCase().startsWith('/api/auth/sign-up')) return res.status(404).json({ error: 'not_found' });
    return next();
  });
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use('/auth', authShimRouter({ userId: 'operator' }));

  // ── C. CRITICAL audit fixes: no open sign-up + owner-pinned gate ──
  const su = await fetch(`${base}/api/auth/sign-in/email`.replace('/sign-in/', '/sign-up/'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'attacker@evil.com', password: 'attacker-pw-123', name: 'M' }) });
  ok(su.status === 404, 'C1. relay HTTP /sign-up/email BLOCKED → 404 (attacker cannot mint an account)', `(${su.status})`);
  // Simulate a non-owner session existing anyway (created via the INTERNAL api,
  // which provisioning uses): the owner-pinned gate must still reject it.
  await auth.api.signUpEmail({ body: { email: 'attacker@evil.com', password: 'attacker-pw-123', name: 'M' } });
  const evil = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'attacker@evil.com', password: 'attacker-pw-123' }) });
  const evilCookie = (evil.headers.get('set-cookie') || '').split(';')[0];
  const evilReq = { socket: { remoteAddress: '203.0.113.5' }, headers: { cookie: evilCookie } };
  ok(await resolveRequester(evilReq, { userId: 'operator' }) === null, 'C2. owner-pin: a valid NON-OWNER session is rejected by the gate');
  const ownerSi = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email, password }) });
  const ownerReq = { socket: { remoteAddress: '203.0.113.5' }, headers: { cookie: (ownerSi.headers.get('set-cookie') || '').split(';')[0] } };
  ok((await resolveRequester(ownerReq, { userId: 'operator' }))?.via === 'cookie', 'C3. owner-pin: the owner session is still accepted');

  const signIn = (pw) => fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email, password: pw }) });
  const getSession = (cookie) => fetch(`${base}/api/auth/get-session`, { headers: { cookie } });

  // ── B (first, before the throttle is exhausted): logout actually revokes ──
  const si = await signIn(password);
  const cookie = (si.headers.get('set-cookie') || '').split(';')[0];
  ok(si.status === 200 && cookie.startsWith('better-auth'), 'B1. operator sign-in → 200 + session cookie', `(${si.status})`);
  const s1 = await getSession(cookie);
  ok(s1.status === 200 && !!(await s1.json().catch(() => null))?.user, 'B2. session valid before logout');
  // networked logout (XFF → non-loopback) with the browser Origin → shim revokes
  const lo = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie, origin: base, 'x-forwarded-for': '9.9.9.9' } });
  ok(lo.status === 200, 'B3. POST /auth/logout (networked) → 200');
  const u2 = await (await getSession(cookie)).json().catch(() => null);
  ok(!u2?.user, 'B4. SESSION REVOKED — old cookie no longer validates (no false logout)', `(user=${u2?.user ? 'STILL VALID!' : 'null'})`);
  // loopback logout stays a no-op (desktop unaffected)
  ok((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } })).status === 200, 'B5. loopback logout → 200 (no-op, desktop unchanged)');

  // ── A: brute-force throttle on /sign-in/email (global) ──
  let got429 = false;
  for (let i = 0; i < 7; i++) { if ((await signIn('wrong-password')).status === 429) got429 = true; }
  ok(got429, 'A1. rapid /sign-in/email attempts get throttled (429)');
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 160)}`);
} finally {
  try { server.close(); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
