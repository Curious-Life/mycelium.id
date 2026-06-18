// scripts/verify-vault-transparency.mjs — boot-state TRANSPARENCY (UX).
// Proves the vault communicates WHY it isn't open instead of a generic "not set up":
//   T1 no vault yet → vault-data path 503 with reason 'not_created'
//   T2 setup → vault opens (status open:true, bootError null)
//   T3 restart with a WRONG key (env source) → /account/status.bootError = 'key_mismatch'
//   T4 mis-keyed vault → vault-data path 503 error 'vault_locked' reason 'key_mismatch'
//      with an ACTIONABLE message (enter recovery key / restore from backup)
// Isolated: ephemeral data dir + Keychain names + OS-assigned port.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

const SUF = `vtx-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_KEY_SOURCE = 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;
process.env.MYCELIUM_DISABLE_EMBED = '1';

const DATA = mkdtempSync(join(tmpdir(), 'myc-vtx-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');

const { startRestServer } = await import('../src/server-rest.js');
const { keychainAvailable } = await import('../src/account/keystore.js');

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? (pass++, console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)) : (fail++, console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)); };
const cleanup = () => { try { rmSync(DATA, { recursive: true, force: true }); } catch {} };

if (!keychainAvailable()) {
  console.log('SKIP  vault transparency — macOS Keychain unavailable');
  console.log('VERDICT: GO — skipped (no Keychain)'); cleanup(); process.exit(0);
}

const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (u) => fetch(u).then(J);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(J);

let s1, s2;
try {
  // ── T1: no vault yet → reason 'not_created' ──
  s1 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let guard = await get(`${s1.url}/api/v1/portal/mindscape/structure`);
  ok(guard.status === 503 && guard.body.reason === 'not_created',
    "T1. no vault → 503 reason 'not_created'", `(${guard.status}/${guard.body.reason})`);
  let st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.bootError == null, 'T1b. status.bootError null before any vault', `(${st.body.bootError})`);

  // ── T2: setup → opens, no bootError ──
  const setup = await post(`${s1.url}/api/v1/account/setup`);
  ok(setup.status === 200 && /^[0-9a-f]{64}$/.test(setup.body.recoveryKey || ''), 'T2. setup → recovery key minted');
  st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.open === true && st.body.bootError == null, 'T2b. after setup → open:true, bootError null',
    `(open=${st.body.open} bootError=${st.body.bootError})`);
  await s1.close(); s1 = null;

  // ── T3/T4: restart with a WRONG key (env source) → key_mismatch ──
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = crypto.randomBytes(32).toString('hex'); // wrong key
  process.env.SYSTEM_KEY = crypto.randomBytes(32).toString('hex');
  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });

  st = await get(`${s2.url}/api/v1/account/status`);
  ok(st.body.open === false && st.body.bootError === 'key_mismatch',
    "T3. wrong key → status.bootError 'key_mismatch'", `(open=${st.body.open} bootError=${st.body.bootError})`);

  guard = await get(`${s2.url}/api/v1/portal/mindscape/structure`);
  const actionable = /recovery key|restore/i.test(guard.body.message || '');
  ok(guard.status === 503 && guard.body.error === 'vault_locked' && guard.body.reason === 'key_mismatch' && actionable,
    "T4. mis-keyed → 503 'vault_locked' reason 'key_mismatch' + actionable message",
    `(${guard.status}/${guard.body.error}/${guard.body.reason} actionable=${actionable})`);
  console.log(`      message: "${guard.body.message}"`);
} catch (e) {
  fail++; console.log(`FAIL  threw: ${e.message}`);
} finally {
  try { await s1?.close(); } catch {}
  try { await s2?.close(); } catch {}
  cleanup();
}

console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — vault transparency: distinguishes not-created vs key-mismatch, actionable recovery message (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
