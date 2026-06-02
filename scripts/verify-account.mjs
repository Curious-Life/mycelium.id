// scripts/verify-account.mjs — setup-mode boot + the /api/v1/account ceremony.
//
// Fully ISOLATED from the real vault/app: ephemeral data dir (explicit dbPath +
// kcvPath, so ensureDataDir never runs), ephemeral Keychain service names, and
// an OS-assigned port. Exercises: status, the 503 guard before setup, POST
// /setup (one recovery key), re-setup 409, recovery-key view, then a new-machine
// RESTORE (Keychain cleared, vault files remain) with wrong/malformed/right keys.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUF = `acct-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_KEY_SOURCE = 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;
process.env.MYCELIUM_DISABLE_EMBED = '1'; // no embed-service dependency for these tests

const DATA = mkdtempSync(join(tmpdir(), 'myc-acct-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');

const { startRestServer } = await import('../src/server-rest.js');
const { keychainAvailable, deleteKeychain, keychainHasKeys } = await import('../src/account/keystore.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

if (!keychainAvailable()) {
  console.log('SKIP  account ceremony — macOS Keychain unavailable on this platform');
  console.log('VERDICT: GO — skipped (no Keychain)');
  rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
}

const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (u) => fetch(u).then(J);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(J);

let recoveryKey = null;
let s1, s2;
try {
  // ── A. fresh setup ────────────────────────────────────────────────────────
  s1 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.status === 200 && st.body.initialized === false, 'A1. fresh start → status initialized:false', `(${st.body.initialized})`);
  ok(st.body.keychainAvailable === true, 'A2. status reports keychainAvailable:true');

  const guard = await get(`${s1.url}/api/v1/portal/mindscape/structure`);
  ok(guard.status === 503, 'A3. vault data path → 503 before setup', `(${guard.status})`);

  const setup = await post(`${s1.url}/api/v1/account/setup`);
  recoveryKey = setup.body.recoveryKey;
  ok(setup.status === 200 && /^[0-9a-f]{64}$/.test(recoveryKey || ''), 'A4. POST /setup → 64-hex recoveryKey', `(len ${recoveryKey?.length})`);
  ok(keychainHasKeys(), 'A5. both keys now in the (ephemeral) Keychain');

  st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.initialized === true, 'A6. status flips to initialized:true after setup');

  const again = await post(`${s1.url}/api/v1/account/setup`);
  ok(again.status === 409, 'A7. second /setup → 409 already_initialized', `(${again.status})`);

  const rk = await get(`${s1.url}/api/v1/account/recovery-key`);
  ok(rk.status === 200 && rk.body.recoveryKey === recoveryKey, 'A8. GET /recovery-key returns the same key');

  const served = await get(`${s1.url}/api/v1/portal/mindscape/structure`);
  ok(served.status !== 503, 'A9. vault data path no longer 503 after setup', `(${served.status})`);

  await new Promise((r) => s1.server.close(r)); s1.close?.();

  // ── B. restore on a "new machine" (Keychain cleared, vault files remain) ───
  deleteKeychain();
  ok(!keychainHasKeys(), 'B1. Keychain cleared (simulating a new machine)');
  ok(existsSync(DB) && existsSync(KCV), 'B2. vault db + kcv still present on disk');

  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.initialized === false, 'B3. start with no keys → setup mode again');

  const wrong = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey: 'a'.repeat(64) });
  ok(wrong.status === 400 && wrong.body.error === 'wrong_key', 'B4. restore WRONG key → 400 wrong_key', `(${wrong.body.error})`);
  ok(!keychainHasKeys(), 'B5. a wrong key is NOT written to the Keychain');

  const bad = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey: 'not-hex' });
  ok(bad.status === 400 && bad.body.error === 'invalid_key', 'B6. restore malformed key → 400 invalid_key');

  const good = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey });
  ok(good.status === 200 && good.body.ok === true, 'B7. restore CORRECT key → 200 ok');
  ok(keychainHasKeys(), 'B8. correct key written to the Keychain on restore');

  st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.initialized === true, 'B9. status initialized:true after restore');

  await new Promise((r) => s2.server.close(r)); s2.close?.();
} catch (err) {
  fail++; console.log('FAIL  unexpected error:', err?.message || err);
} finally {
  try { if (s1?.server?.listening) s1.server.close(); } catch { /* noop */ }
  try { if (s2?.server?.listening) s2.server.close(); } catch { /* noop */ }
  try { deleteKeychain(); } catch { /* noop */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — setup-mode boot + account ceremony (status, 503 guard, setup, restore wrong/right, recovery-key)');
process.exit(fail ? 1 : 0);
