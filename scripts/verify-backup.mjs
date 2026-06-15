// scripts/verify-backup.mjs — vault backup (.myvault) + restore-from-backup, and
// the data-loss footgun fix (a bare /restore with no vault must NOT create an
// empty one). Design: docs/VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md.
//
// Fully ISOLATED: ephemeral data dirs (explicit dbPath/kcvPath so ensureDataDir
// never runs), ephemeral Keychain service names, OS-assigned ports. The keychain
// namespace is process-global, so "new machine" is simulated with deleteKeychain()
// (same trick as verify-account).
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeUploadDest } from '../src/account/backup.js';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

const SUF = `bk-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_KEY_SOURCE = 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;
process.env.MYCELIUM_DISABLE_EMBED = '1';

const DATA = mkdtempSync(join(tmpdir(), 'myc-bk-src-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const DATA2 = mkdtempSync(join(tmpdir(), 'myc-bk-dst-'));
const DB2 = join(DATA2, 'mycelium.db');
const KCV2 = join(DATA2, 'kcv.json');

const { startRestServer } = await import('../src/server-rest.js');
const { keychainAvailable, deleteKeychain, keychainHasKeys } = await import('../src/account/keystore.js');
const { importMasterKey, encrypt, decrypt } = await import('../src/crypto/crypto-local.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

if (!keychainAvailable()) {
  console.log('SKIP  vault backup — macOS Keychain unavailable on this platform');
  console.log('VERDICT: GO — skipped (no Keychain)');
  rmSync(DATA, { recursive: true, force: true });
  rmSync(DATA2, { recursive: true, force: true });
  process.exit(0);
}

const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (u) => fetch(u).then(J);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(J);
const upload = (u, buffer, fields = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), 'vault.myvault');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(u, { method: 'POST', body: fd }).then(J);
};

const MARKER = `SECRET_MARKER_${SUF}_do_not_leak`;
let recoveryKey = null, archive = null;
let s1, s2;
try {
  // ── A. set up a source vault + seed one ENCRYPTED marker row ────────────────
  s1 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  const setup = await post(`${s1.url}/api/v1/account/setup`);
  recoveryKey = setup.body.recoveryKey;
  ok(/^[0-9a-f]{64}$/.test(recoveryKey || ''), 'A1. source vault created (64-hex recovery key)');

  const userKey = await importMasterKey(recoveryKey);
  const envelope = await encrypt(MARKER, 'personal', userKey);
  {
    const raw = new Database(DB);
    raw.pragma('journal_mode = WAL');
    raw.exec('CREATE TABLE IF NOT EXISTS verify_backup_marker (id INTEGER PRIMARY KEY, blob TEXT)');
    raw.prepare('INSERT INTO verify_backup_marker (blob) VALUES (?)').run(envelope);
    raw.close();
  }
  ok(true, 'A2. seeded an encrypted marker row into the source vault');

  // ── B. GET /backup → a .myvault archive ─────────────────────────────────────
  const res = await fetch(`${s1.url}/api/v1/account/backup`);
  ok(res.status === 200, 'B1. GET /backup → 200', `(${res.status})`);
  ok(/attachment; filename=.*\.myvault/.test(res.headers.get('content-disposition') || ''), 'B2. Content-Disposition is a .myvault attachment');
  archive = Buffer.from(await res.arrayBuffer());
  ok(archive.length > 0, 'B3. archive has bytes', `(${archive.length}B)`);

  const zip = await JSZip.loadAsync(archive);
  ok(Boolean(zip.file('manifest.json') && zip.file('mycelium.db') && zip.file('kcv.json')), 'B4. archive contains manifest + db + kcv');
  ok(!zip.file('auth.db'), 'B5. auth.db is NOT in the archive (no operator hash / signing secret shipped)');
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  ok(manifest.v === 1, 'B6. manifest version 1', `(v${manifest.v})`);

  // ── C. zero-knowledge: the plaintext marker must NOT appear in the archive ──
  ok(archive.indexOf(Buffer.from(MARKER)) === -1, 'C1. plaintext marker absent from the archive (ciphertext only)');

  await new Promise((r) => s1.server.close(r)); s1.close?.();

  // ── D. data-loss footgun: bare /restore with NO vault must fail closed ──────
  deleteKeychain(); // new machine
  ok(!keychainHasKeys(), 'D0. Keychain cleared (new machine)');
  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB2, kcvPath: KCV2 });
  let st = await get(`${s2.url}/api/v1/account/status`);
  ok(st.body.needsSetup === true && st.body.needsRecoveryKey === false, 'D1. empty dir → needsSetup, not needsRecoveryKey');

  const bare = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey });
  ok(bare.status === 409 && bare.body.error === 'no_vault', 'D2. /restore with no vault → 409 no_vault (was: silent empty vault)', `(${bare.body.error})`);
  ok(!existsSync(DB2), 'D3. NO empty mycelium.db was created by the refused restore');

  // ── E. restore-from-backup, then paste the key → REAL data, not empty ───────
  const rb = await upload(`${s2.url}/api/v1/account/restore-backup`, archive);
  ok(rb.status === 200 && rb.body.needsKey === true, 'E1. POST /restore-backup → 200 needsKey', `(${rb.status})`);
  ok(existsSync(DB2) && existsSync(KCV2), 'E2. backup landed db + kcv on disk');

  st = await get(`${s2.url}/api/v1/account/status`);
  ok(st.body.needsRecoveryKey === true && st.body.needsSetup === false, 'E3. status now needsRecoveryKey (files present, not open)');

  const wrong = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey: 'a'.repeat(64) });
  ok(wrong.status === 400 && wrong.body.error === 'wrong_key', 'E4. wrong key against restored kcv → 400 wrong_key');

  const good = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey });
  ok(good.status === 200 && good.body.ok === true, 'E5. correct key → 200 ok (vault opens)');

  st = await get(`${s2.url}/api/v1/account/status`);
  ok(st.body.initialized === true, 'E6. status initialized:true after restore');

  // the decisive regression assertion: the seeded row survived + decrypts
  const raw2 = new Database(DB2, { readonly: true });
  const row = raw2.prepare('SELECT blob FROM verify_backup_marker LIMIT 1').get();
  raw2.close();
  const restoredKey = await importMasterKey(recoveryKey);
  const decrypted = row ? await decrypt(row.blob, restoredKey) : null;
  ok(decrypted === MARKER, 'E7. restored vault holds the REAL data (marker decrypts, not an empty vault)', `(${decrypted === MARKER ? 'match' : 'MISMATCH'})`);

  // ── F. restore over an existing vault is refused without overwrite ──────────
  const clash = await post(`${s2.url}/api/v1/account/restore-backup`, {}); // already_initialized guard
  ok(clash.status === 409 && clash.body.error === 'already_initialized', 'F1. restore-backup while vault open → 409 already_initialized');

  await new Promise((r) => s2.server.close(r)); s2.close?.();
  // reopen against the same dir but as a "new machine" so the vault is not auto-open
  deleteKeychain();
  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB2, kcvPath: KCV2 });
  const noOverwrite = await upload(`${s2.url}/api/v1/account/restore-backup`, archive);
  ok(noOverwrite.status === 409 && noOverwrite.body.error === 'vault_exists', 'F2. restore over existing vault (no overwrite) → 409 vault_exists');
  const overwrite = await upload(`${s2.url}/api/v1/account/restore-backup`, archive, { overwrite: 'true' });
  ok(overwrite.status === 200 && overwrite.body.replaced === true, 'F3. overwrite=true → 200 replaced');
  ok(readdirSync(DATA2).some((n) => n.includes('.pre-restore.')), 'F4. prior vault moved aside (.pre-restore.*), not destroyed');

  // ── G. a non-archive upload is rejected ─────────────────────────────────────
  const garbage = await upload(`${s2.url}/api/v1/account/restore-backup`, Buffer.from('not a zip at all'), { overwrite: 'true' });
  ok(garbage.status === 400 && garbage.body.error === 'invalid_archive', 'G1. garbage upload → 400 invalid_archive');

  // ── G2. restore zip-slip containment: an uploads/../escape entry must resolve
  //        to null (skipped); legit entries resolve under uploadsRoot. ──
  const upRoot = '/tmp/myc-uploads-root';
  ok(safeUploadDest(upRoot, 'uploads/legit.txt') === resolve(upRoot, 'legit.txt'), 'G2. legit uploads entry → contained dest');
  ok(safeUploadDest(upRoot, 'uploads/sub/a.bin') === resolve(upRoot, 'sub/a.bin'), 'G2b. nested uploads entry → contained dest');
  ok(safeUploadDest(upRoot, 'uploads/../escape.txt') === null, 'G2c. uploads/../escape → null (containment blocks escape)');
  ok(safeUploadDest(upRoot, 'uploads/a/../../escape') === null, 'G2d. deep ../.. escape → null');
  ok(safeUploadDest(upRoot, 'uploads/') === null, 'G2e. empty rel → null');

  await new Promise((r) => s2.server.close(r)); s2.close?.();
} catch (err) {
  fail++; console.log('FAIL  unexpected error:', err?.stack || err?.message || err);
} finally {
  try { if (s1?.server?.listening) s1.server.close(); } catch { /* */ }
  try { if (s2?.server?.listening) s2.server.close(); } catch { /* */ }
  try { deleteKeychain(); } catch { /* */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(DATA2, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — vault backup (.myvault), restore-from-backup, zero-knowledge archive, and the no-empty-vault footgun fix');
process.exit(fail ? 1 : 0);
