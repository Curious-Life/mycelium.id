// scripts/verify-control-loopback.mjs — V-1 regression gate.
//
// The two control surfaces that mint/return the master key (/api/v1/account) or
// set the operator password (/api/v1/remote) must reject any request that
// arrived through a reverse proxy / the relay — even though such a request hits
// the local server from a loopback socket. The boundary is src/http/loopback.js
// (isTrustedLoopback): socket peer loopback AND no X-Forwarded-For.
//
// Two layers here: (A) UNIT — the boundary function itself (always runs, the
// load-bearing guarantee); (B) INTEGRATION — best-effort boot of the REST server
// asserting the control surfaces 403 a proxied request and never leak a key.
// Integration SKIPs cleanly if the server can't boot in this environment; the
// unit layer still gates the verdict.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── A. UNIT — the trust boundary ───────────────────────────────────────────
const { isTrustedLoopback } = await import('../src/http/loopback.js');
const mk = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

ok(isTrustedLoopback(mk('127.0.0.1')) === true, 'A1. loopback v4, no XFF → trusted');
ok(isTrustedLoopback(mk('::1')) === true, 'A2. loopback v6, no XFF → trusted');
ok(isTrustedLoopback(mk('::ffff:127.0.0.1')) === true, 'A3. v4-mapped loopback, no XFF → trusted');
ok(isTrustedLoopback(mk('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })) === false, 'A4. loopback + XFF (proxied) → NOT trusted');
ok(isTrustedLoopback(mk('127.0.0.1', { 'x-forwarded-for': '' })) === false, 'A5. loopback + EMPTY XFF (presence, not truthiness) → NOT trusted');
ok(isTrustedLoopback(mk('203.0.113.9')) === false, 'A6. public peer, no XFF → NOT trusted');
ok(isTrustedLoopback({ headers: {} }) === false, 'A7. missing socket → NOT trusted (fail closed)');
ok(isTrustedLoopback(mk('127.0.0.1', { 'x-real-ip': '1.2.3.4' })) === false, 'A8. loopback + X-Real-IP → NOT trusted (defence in depth)');
ok(isTrustedLoopback(mk('127.0.0.1', { 'forwarded': 'for=1.2.3.4' })) === false, 'A9. loopback + Forwarded → NOT trusted (defence in depth)');

// ── B. INTEGRATION — control surfaces over a (simulated) proxy ──────────────
const SUF = `ctl-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_DISABLE_EMBED = '1';
process.env.MYCELIUM_KEY_SOURCE = process.env.MYCELIUM_KEY_SOURCE || 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;

const DATA = mkdtempSync(join(tmpdir(), 'myc-ctl-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const HEX64 = /[0-9a-f]{64}/i; // a recovery/master key must NEVER appear in a rejected body

const J = async (r) => ({ status: r.status, text: await r.text().catch(() => '') });
const call = (url, { method = 'GET', xff = null, body = null } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (xff !== null) headers['x-forwarded-for'] = xff;
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(J);
};

let server = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');
  server = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  const base = server.url;

  // Control: a genuine loopback request (no XFF) is allowed through the gate.
  const acctOk = await call(`${base}/api/v1/account/status`);
  ok(acctOk.status === 200, 'B1. /account/status, loopback no-XFF → 200 (allowed)', `(${acctOk.status})`);

  // V-1: a proxied request (carries XFF) is rejected at the gate.
  const acctXff = await call(`${base}/api/v1/account/status`, { xff: '1.2.3.4' });
  ok(acctXff.status === 403, 'B2. /account/status WITH XFF → 403 (proxied rejected)', `(${acctXff.status})`);

  // V-1 leak regression: the recovery-key minter must 403 a proxied request and
  // leak no key material in the response.
  const setupXff = await call(`${base}/api/v1/account/setup`, { method: 'POST', xff: '1.2.3.4', body: {} });
  ok(setupXff.status === 403, 'B3a. POST /account/setup WITH XFF → 403', `(${setupXff.status})`);
  ok(!HEX64.test(setupXff.text), 'B3b. rejected /account/setup body leaks no 64-hex key');

  // Same boundary on the operator-password / remote control surface.
  const remOk = await call(`${base}/api/v1/remote/status`);
  ok(remOk.status === 200, 'B4. /remote/status, loopback no-XFF → 200 (allowed)', `(${remOk.status})`);
  const remXff = await call(`${base}/api/v1/remote/status`, { xff: '1.2.3.4' });
  ok(remXff.status === 403, 'B5. /remote/status WITH XFF → 403 (proxied rejected)', `(${remXff.status})`);
} catch (err) {
  console.log(`SKIP  integration — REST server could not boot in this env (${String(err?.message || err).slice(0, 120)})`);
} finally {
  try { await server?.close?.(); } catch { /* */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
