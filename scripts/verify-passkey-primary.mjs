// scripts/verify-passkey-primary.mjs — passkey-as-PRIMARY emphasis on the relay /login.
//
// The operator decision (QA3): passkey LEADS as the primary web credential, the
// operator PASSWORD stays a fully-working FALLBACK behind a disclosure. This gate
// locks that emphasis on the SERVER-RENDERED /login relay page (the :4711 hand-built
// shell, not the portal SPA — that's covered by the portal build). It also proves the
// flip did NOT enable passkey-ONLY: password must remain present + reachable, and
// requirePasskeyForWeb stays OFF (no requirePasskey source-flip here).
//
// Boots the REAL createHttpApp() (same harness as verify:passkey-enroll) so we assert
// the actual bytes the browser receives, not a paper claim.
import Database from 'better-sqlite3';
import { rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHttpApp } from '../src/server-http.js';
import { applyMigrations } from '../src/db/migrate.js';

const hex = () => crypto.randomBytes(32).toString('hex');
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

const HANDLE = 'alice';
const PW = 'correct horse battery staple';

const dir = mkdtempSync(join(tmpdir(), 'pkprimary-'));
const DB = join(dir, 'mycelium.db'), KCV = join(dir, 'kcv.json');
applyMigrations(new Database(DB));

process.env.MYCELIUM_DATA_DIR = dir;
process.env.MYCELIUM_PUBLIC_HOST = `${HANDLE}.mycelium.id`;
process.env.MYCELIUM_AUTH_SECRET = 'pkprimary-secret-'.padEnd(48, 'x');
delete process.env.MYCELIUM_USER_PASSWORD;

let server;
try {
  const { app } = await createHttpApp({
    operator: { password: PW },
    bootOpts: { dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: null },
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const getText = async (p) => { const r = await fetch(`${base}${p}`); return { r, body: await r.text() }; };

  // P1 — plain /login: passkey button is PRIMARY (rendered BEFORE the password field),
  //      and the password lives behind the "Use your password instead" disclosure.
  {
    const { r, body } = await getText('/login');
    ok(r.status === 200, 'P1a. GET /login → 200');
    const iPk = body.indexOf('id="pk"');
    const iPw = body.indexOf('name="password"');
    ok(iPk !== -1, 'P1b. passkey button (#pk) is rendered');
    ok(iPw !== -1, 'P1c. password field is STILL present (fallback reachable, not passkey-only)', `(idx ${iPw})`);
    ok(iPk !== -1 && iPw !== -1 && iPk < iPw, 'P1d. passkey button precedes the password field (passkey is PRIMARY)', `pk@${iPk} < pw@${iPw}`);
    // Passkey is no longer the demoted `.alt` button.
    ok(!/id="pk"[^>]*class="alt"/.test(body), 'P1e. passkey button is NOT the demoted .alt variant');
    // Password is behind a disclosure block, hidden by default, with a reveal affordance.
    ok(/id="pwblock"[^>]*style="display:none"/.test(body), 'P1f. password block hidden by default (behind disclosure)');
    ok(/id="pwtoggle"[^>]*class="link"/.test(body) && /Use your password instead/.test(body), 'P1g. "Use your password instead" disclosure affordance present');
  }

  // P2 — a password error (bad password POST re-render) AUTO-REVEALS the password block
  //      so the rejection reason is never hidden behind the disclosure.
  {
    // GET a CSRF cookie+token, then POST a wrong password → 401 re-render.
    const g = await fetch(`${base}/login`);
    const sc = g.headers.getSetCookie ? g.headers.getSetCookie() : [g.headers.get('set-cookie')].filter(Boolean);
    const cookie = (sc.find((c) => /myc_login_csrf=/.test(c)) || '').split(';')[0];
    const tok = (await g.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const r = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ password: 'wrong-password-xxxx', _csrf: tok }).toString(),
    });
    const body = await r.text();
    ok(r.status === 401, 'P2a. POST /login wrong password → 401 re-render', `(${r.status})`);
    ok(/id="pwblock"(?![^>]*display:none)/.test(body), 'P2b. password block auto-revealed on error (no display:none)');
    ok(/Invalid password/.test(body), 'P2c. the rejection reason is shown');
  }

  // P3 — login.js drives the disclosure reveal (CSP-safe, from 'self'), and the
  //      passkey sign-in path is intact (verify-authentication still wired).
  {
    const { body } = await getText('/login.js');
    ok(/getElementById\('pwtoggle'\)/.test(body) && /pwb\.style\.display='block'/.test(body), 'P3a. login.js reveals the password block on toggle');
    ok(/verify-authentication/.test(body), 'P3b. passkey sign-in path still wired');
  }

  // P4 — the flip did NOT enable passkey-ONLY: requirePasskeyForWeb source is untouched
  //      (no new requirePasskey force-on), and the plain page is not passkey-required.
  {
    const src = readFileSync(fileURLToPath(new URL('../src/server-http.js', import.meta.url)), 'utf8');
    ok(!/requirePasskeyForWeb\s*[:=]\s*true/.test(src), 'P4a. server-http.js never hard-sets requirePasskeyForWeb=true');
    const { body } = await getText('/login');
    ok(!/This vault requires a passkey\./.test(body), 'P4b. plain /login is NOT in passkey-required mode (password remains a valid credential)');
  }
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 160)}`);
} finally {
  try { await new Promise((r) => server?.close?.(r) ?? r()); } catch { /* */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — passkey is PRIMARY on relay /login; password fallback present + reachable; requirePasskeyForWeb NOT enabled');
process.exit(0);
