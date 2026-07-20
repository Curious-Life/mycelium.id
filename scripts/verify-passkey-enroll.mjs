// verify:passkey-enroll — the RELAY /login "add a passkey" flow (U1.6 / Option A).
//
// Over the relay, /login is served by the :4711 hand-built page (remote/runtime.js
// routes /login → oauth upstream), NOT the portal SPA. So the desktop Settings
// "Set up a passkey" action opens https://<handle>.mycelium.id/login?enroll=1 in the
// system browser, where the WebAuthn ceremony runs on the RELAY origin (rpID =
// <handle>.mycelium.id) — the only origin that can mint a relay-usable credential.
//
// This gate boots the REAL createHttpApp and asserts the DETERMINISTIC routing:
//   - /login.js drives BOTH sign-in (verify-authentication) AND enrolment
//     (generate-register-options?name=… → create → verify-registration).
//   - GET /login?enroll=1&step=passkey renders the post-sign-in enrol view
//     (add-a-passkey, no password field, handle-labelled).
//   - GET /login?enroll=1 keeps the password bootstrap (Option A: password NOT
//     dropped) and is enrol-aware.
//   - POST /login?enroll=1 (correct password + CSRF) redirects to the enrol step;
//     plain POST /login is unaffected (→ '/').
//   - the enrol endpoint the button calls stays session-gated (no unauth enrol).
// The actual biometric ceremony (navigator.credentials.create) is the operator
// device smoke — not deterministically scriptable (same as verify:passkey).
import Database from 'better-sqlite3';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createHttpApp } from '../src/server-http.js';
import { applyMigrations } from '../src/db/migrate.js';

const hex = () => crypto.randomBytes(32).toString('hex');
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

const HANDLE = 'alice';
const PKNAME = `${HANDLE}.mycelium.id`;
const PW = 'correct horse battery staple'; // ≥12, not weak

const dir = mkdtempSync(join(tmpdir(), 'pkenrol-'));
const DB = join(dir, 'mycelium.db'), KCV = join(dir, 'kcv.json');
applyMigrations(new Database(DB));

const prev = {
  dataDir: process.env.MYCELIUM_DATA_DIR,
  host: process.env.MYCELIUM_PUBLIC_HOST,
  secret: process.env.MYCELIUM_AUTH_SECRET,
  pw: process.env.MYCELIUM_USER_PASSWORD,
};
process.env.MYCELIUM_DATA_DIR = dir;                       // isolate auth.db + remote.json
process.env.MYCELIUM_PUBLIC_HOST = `${HANDLE}.mycelium.id`; // → baseURL/rpID + currentHandle()
process.env.MYCELIUM_AUTH_SECRET = 'pkenrol-secret-'.padEnd(48, 'x');
delete process.env.MYCELIUM_USER_PASSWORD;

let server;
try {
  const { app } = await createHttpApp({
    operator: { password: PW },                            // seed the bootstrap operator account
    bootOpts: { dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: null },
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const getText = async (p) => { const r = await fetch(`${base}${p}`); return { r, body: await r.text() }; };

  // E1 — /login.js drives BOTH sign-in and the new enrolment ceremony.
  {
    const { r, body } = await getText('/login.js');
    ok(r.status === 200 && /javascript/.test(r.headers.get('content-type') || ''), 'E1a. GET /login.js → 200 js');
    ok(/generate-register-options\?name='\+encodeURIComponent\(pkname\)/.test(body), 'E1b. enrol calls generate-register-options?name=<handle>');
    ok(/navigator\.credentials\.create/.test(body), 'E1c. enrol runs a registration ceremony (credentials.create)');
    ok(/verify-registration/.test(body), 'E1d. enrol posts verify-registration');
    ok(/verify-authentication/.test(body), 'E1e. sign-in path still wired (verify-authentication) — password NOT the only web credential');
  }

  // E2 — post-sign-in enrol view: add-a-passkey, no password, handle-labelled.
  {
    const { r, body } = await getText('/login?enroll=1&step=passkey');
    ok(r.status === 200, 'E2a. GET /login?enroll=1&step=passkey → 200');
    ok(/id="pkreg"/.test(body) && /Add a passkey/.test(body), 'E2b. renders the add-a-passkey button');
    ok(!/name="password"/.test(body), 'E2c. no password field on the enrol step');
    ok(body.includes('data-enroll="1"') && body.includes(`data-pkname="${PKNAME}"`), 'E2d. carries enrol intent + handle label', PKNAME);
    ok(/\/login\.js/.test(body), 'E2e. loads /login.js');
  }

  // E3 — enrol entry still keeps the password bootstrap (Option A: NOT passwordless).
  {
    const { r, body } = await getText('/login?enroll=1');
    ok(r.status === 200 && /name="password"/.test(body), 'E3a. GET /login?enroll=1 keeps the operator-password field (bootstrap intact)');
    ok(/Sign in to add a passkey/.test(body), 'E3b. subtitle reflects the enrol intent');
    ok(body.includes('data-enroll="1"') && body.includes(`data-pkname="${PKNAME}"`), 'E3c. enrol intent + label present');
  }

  // E4 — a plain sign-in is untouched (no enrol leakage).
  {
    const { body } = await getText('/login');
    ok(!/data-enroll="1"/.test(body) && /Sign in to open your vault/.test(body), 'E4. plain /login unchanged (no enrol intent)');
  }

  // Helper: GET a fresh CSRF cookie+token from /login.
  async function csrf(qs) {
    const r = await fetch(`${base}/login${qs}`);
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    const cookie = (setCookie.find((c) => /myc_login_csrf=/.test(c)) || '').split(';')[0];
    const body = await r.text();
    const tok = (body.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1] || '';
    return { cookie, tok };
  }
  const postLogin = async (qs, cookie, tok) => fetch(`${base}/login${qs}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, // NO Origin → same-origin check skipped
    body: new URLSearchParams({ password: PW, _csrf: tok }).toString(),
  });

  // E5 — enrol sign-in redirects to the enrol step (session now established).
  {
    const { cookie, tok } = await csrf('?enroll=1');
    const r = await postLogin('?enroll=1', cookie, tok);
    ok(r.status === 302 && r.headers.get('location') === '/login?enroll=1&step=passkey', 'E5. POST /login?enroll=1 (valid pw+csrf) → 302 enrol step', r.headers.get('location') || `(${r.status})`);
  }

  // E6 — regression: a plain sign-in still opens the vault, not the enrol step.
  {
    const { cookie, tok } = await csrf('');
    const r = await postLogin('', cookie, tok);
    ok(r.status === 302 && r.headers.get('location') === '/', 'E6. POST /login (no enrol) → 302 /', r.headers.get('location') || `(${r.status})`);
  }

  // E7 — no new unauthenticated enrol surface: the endpoint the button calls is
  // session-gated (a fresh caller with no session must not get options).
  {
    const r = await fetch(`${base}/api/auth/passkey/generate-register-options?name=${encodeURIComponent(PKNAME)}`);
    ok(r.status !== 200, 'E7. generate-register-options stays auth-gated (unauth not 200)', `(${r.status})`);
  }
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.stack || err?.message || err).slice(0, 300)}`);
} finally {
  try { server?.close(); } catch { /* */ }
  for (const [k, v] of Object.entries({ MYCELIUM_DATA_DIR: prev.dataDir, MYCELIUM_PUBLIC_HOST: prev.host, MYCELIUM_AUTH_SECRET: prev.secret, MYCELIUM_USER_PASSWORD: prev.pw })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — relay /login enrol routing: handle-labelled, session-gated, password bootstrap intact'); process.exit(0);
