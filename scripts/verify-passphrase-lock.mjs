// scripts/verify-passphrase-lock.mjs — the OPTIONAL app passphrase lock.
//
// Fully ISOLATED from the real vault/app: ephemeral data dir (explicit dbPath +
// kcvPath, so ensureDataDir never runs and the seal co-locates in the temp dir),
// ephemeral Keychain service names, OS-assigned port. Exercises:
//   A. unit — sealKeys/unsealKeys round-trip; wrong passphrase + tamper reject.
//   B. e2e — setup → enable (Keychain emptied, seal written, jobs keys in memory)
//      → RESTART (locked) → unlock wrong/right → disable (Keychain restored) →
//      RESTART (auto-opens again). Mirrors the real launch/relaunch lifecycle.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUF = `lock-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_KEY_SOURCE = 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;
process.env.MYCELIUM_DISABLE_EMBED = '1';

const DATA = mkdtempSync(join(tmpdir(), 'myc-lock-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const LOCK = join(DATA, 'vault-lock.json'); // co-located with the KCV (server-rest)
const PASS = 'correct horse battery staple';

const { startRestServer } = await import('../src/server-rest.js');
const { keychainAvailable, deleteKeychain, keychainHasKeys } = await import('../src/account/keystore.js');
const { sealKeys, unsealKeys } = await import('../src/account/passphrase-lock.js');
const { getSessionKeys } = await import('../src/account/session-keys.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

if (!keychainAvailable()) {
  console.log('SKIP  passphrase lock — macOS Keychain unavailable on this platform');
  console.log('VERDICT: GO — skipped (no Keychain)');
  rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
}

const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (u) => fetch(u).then(J);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(J);

let s1, s2, s3;
try {
  // ── A. unit: seal/unseal round-trip + rejection ───────────────────────────
  const U = 'a'.repeat(64), S = 'b'.repeat(64);
  const lock = await sealKeys(U, S, PASS);
  const round = await unsealKeys(lock, PASS);
  ok(round.userHex === U && round.systemHex === S, 'A1. sealKeys→unsealKeys round-trips both keys');
  let threw = false; try { await unsealKeys(lock, 'wrong-passphrase'); } catch (e) { threw = e.message === 'wrong_passphrase'; }
  ok(threw, 'A2. wrong passphrase → throws wrong_passphrase');
  const tampered = { ...lock, sealU: lock.sealU.slice(0, -4) + 'AAAA' };
  let threw2 = false; try { await unsealKeys(tampered, PASS); } catch { threw2 = true; }
  ok(threw2, 'A3. tampered seal → throws (fail-closed)');
  ok(typeof lock.salt === 'string' && lock.kdf === 'scrypt' && lock.sealU && lock.sealS, 'A4. lock shape: scrypt + salt + sealU + sealS');

  // ── B. e2e setup → enable ─────────────────────────────────────────────────
  s1 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  const setup = await post(`${s1.url}/api/v1/account/setup`);
  const recoveryKey = setup.body.recoveryKey;
  ok(setup.status === 200 && /^[0-9a-f]{64}$/.test(recoveryKey || ''), 'B1. setup → vault created + recovery key');

  let st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.open === true && st.body.needsSetup === false && st.body.locked === false && st.body.passphraseEnabled === false,
    'B2. status: open, not needsSetup, not locked, no passphrase', JSON.stringify(st.body));
  ok(getSessionKeys()?.userHex === recoveryKey, 'B3. session keys pinned in memory (jobs.js seam source)');

  const weak = await post(`${s1.url}/api/v1/account/passphrase/enable`, { passphrase: 'short' });
  ok(weak.status === 400 && weak.body.error === 'weak_passphrase', 'B4. enable rejects a too-short passphrase');

  const en = await post(`${s1.url}/api/v1/account/passphrase/enable`, { passphrase: PASS });
  ok(en.status === 200 && en.body.ok === true, 'B5. enable → ok', JSON.stringify(en.body));
  ok(existsSync(LOCK), 'B6. seal written to vault-lock.json (co-located with KCV)');
  ok(!keychainHasKeys(), 'B7. plaintext keys REMOVED from the Keychain (real lock)');

  st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.passphraseEnabled === true && st.body.open === true, 'B8. status now passphraseEnabled (still open this session)');

  const en2 = await post(`${s1.url}/api/v1/account/passphrase/enable`, { passphrase: PASS });
  ok(en2.status === 409 && en2.body.error === 'already_enabled', 'B9. second enable → 409 already_enabled');

  await new Promise((r) => s1.server.close(r)); s1.close?.();

  // ── C. RELAUNCH → locked → unlock ─────────────────────────────────────────
  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.open === false && st2.body.locked === true && st2.body.needsSetup === false,
    'C1. relaunch with no Keychain keys → locked (not setup)', JSON.stringify(st2.body));

  const guard = await get(`${s2.url}/api/v1/portal/mindscape/structure`);
  ok(guard.status === 503, 'C2. vault data path → 503 while locked', `(${guard.status})`);

  const wrong = await post(`${s2.url}/api/v1/account/unlock`, { passphrase: 'nope nope nope' });
  ok(wrong.status === 400 && wrong.body.error === 'wrong_passphrase', 'C3. unlock wrong passphrase → 400 wrong_passphrase');
  ok(!keychainHasKeys(), 'C4. a wrong unlock writes NOTHING to the Keychain');

  const right = await post(`${s2.url}/api/v1/account/unlock`, { passphrase: PASS });
  ok(right.status === 200 && right.body.ok === true, 'C5. unlock correct passphrase → ok');
  ok(getSessionKeys()?.userHex === recoveryKey, 'C6. session keys pinned after unlock (generate would work)');
  ok(!keychainHasKeys(), 'C7. unlock does NOT re-populate the Keychain (lock stays real)');

  st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.open === true && st2.body.locked === false, 'C8. status open after unlock');

  const served = await get(`${s2.url}/api/v1/portal/mindscape/structure`);
  ok(served.status !== 503, 'C9. vault data path no longer 503 after unlock', `(${served.status})`);

  // ── D. disable → relaunch auto-opens ──────────────────────────────────────
  const disWrong = await post(`${s2.url}/api/v1/account/passphrase/disable`, { passphrase: 'wrong' });
  ok(disWrong.status === 400 && disWrong.body.error === 'wrong_passphrase', 'D1. disable wrong passphrase → 400');

  const dis = await post(`${s2.url}/api/v1/account/passphrase/disable`, { passphrase: PASS });
  ok(dis.status === 200 && dis.body.ok === true, 'D2. disable correct passphrase → ok');
  ok(keychainHasKeys(), 'D3. keys restored to the Keychain on disable');
  ok(!existsSync(LOCK), 'D4. seal removed on disable');

  await new Promise((r) => s2.server.close(r)); s2.close?.();

  s3 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  const st3 = await get(`${s3.url}/api/v1/account/status`);
  ok(st3.body.open === true && st3.body.locked === false && st3.body.passphraseEnabled === false,
    'D5. relaunch after disable → auto-opens from the Keychain again', JSON.stringify(st3.body));
  await new Promise((r) => s3.server.close(r)); s3.close?.();
} catch (err) {
  fail++; console.log('FAIL  unexpected error:', err?.stack || err?.message || err);
} finally {
  for (const s of [s1, s2, s3]) { try { if (s?.server?.listening) s.server.close(); } catch { /* */ } }
  try { deleteKeychain(); } catch { /* */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — passphrase lock (seal/unseal, enable strips Keychain, relaunch→locked, unlock wrong/right, disable restores)');
process.exit(fail ? 1 : 0);
