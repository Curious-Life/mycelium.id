// scripts/verify-backup.mjs — vault backup (.myvault) + restore-from-backup, and
// the data-loss footgun fix (a bare /restore with no vault must NOT create an
// empty one). Design: docs/VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md.
//
// Fully ISOLATED: ephemeral data dirs (explicit dbPath/kcvPath so ensureDataDir
// never runs), ephemeral Keychain service names, OS-assigned ports. The keychain
// namespace is process-global, so "new machine" is simulated with deleteKeychain()
// (same trick as verify-account).
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  safeUploadDest, safeMindDest, safeVoiceDest,
  buildVaultArchive, restoreVaultArchive, validateArchive,
  entryExceedsCap, readEntryCapped, MAX_DB_BYTES, MAX_ENTRY_BYTES,
} from '../src/account/backup.js';
import { mindDir, voiceSamplesRoot as resolveVoiceSamplesRoot, dataDir as resolveDataDir } from '../src/paths.js';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Craft a decompression-bomb fixture: overwrite ONLY the uncompressed-size field of
// a named STORE member in its local + central-directory headers, leaving the real
// stored bytes (and compressed-size) untouched. The result is a tiny archive that
// LIES about how large `targetName` inflates to — exactly the DEFLATE-bomb shape the
// mandatory-member cap must reject BEFORE calling `.async()`.
const patchDeclaredSize = (buf, targetName, newSize) => {
  const name = Buffer.from(targetName, 'latin1');
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const nlen = buf.readUInt16LE(i + 26);
      if (buf.slice(i + 30, i + 30 + nlen).equals(name)) buf.writeUInt32LE(newSize >>> 0, i + 22);
    }
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) {
      const nlen = buf.readUInt16LE(i + 28);
      if (buf.slice(i + 46, i + 46 + nlen).equals(name)) buf.writeUInt32LE(newSize >>> 0, i + 24);
    }
  }
  return buf;
};

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

  // ── H. Unit P0: mind/ + voice-samples/ are carried + restored byte-verbatim ──
  //    Direct build/restore against isolated temp roots (no live data dir touched).
  {
    const H = mkdtempSync(join(tmpdir(), 'myc-bk-p0-'));
    try {
      // Source vault: a plaintext sqlite db + a kcv verifier + a populated mind
      // dir (nested snapshots/) + a voice-samples dir.
      const srcDb = join(H, 'src-mycelium.db');
      const srcKcv = join(H, 'src-kcv.json');
      { const d = new Database(srcDb); d.exec('CREATE TABLE t(x)'); d.close(); }
      writeFileSync(srcKcv, '{}');
      const srcMind = join(H, 'mind');
      const srcVoice = join(H, 'voice-samples');
      mkdirSync(join(srcMind, 'snapshots'), { recursive: true });
      mkdirSync(srcVoice, { recursive: true });
      const selfBuf = Buffer.concat([Buffer.from('MIND'), randomBytes(500)]); // MIND-magic ciphertext-shaped
      const snapBuf = Buffer.concat([Buffer.from('MIND'), randomBytes(300)]);
      const mvsBuf  = Buffer.concat([Buffer.from('MVS1'), randomBytes(700)]); // MVS1-magic voice sample
      writeFileSync(join(srcMind, 'self.md'), selfBuf);
      writeFileSync(join(srcMind, 'snapshots', 'snap1.md'), snapBuf);
      writeFileSync(join(srcVoice, 'personal-agent.mvs'), mvsBuf);

      const built = await buildVaultArchive({ dbPath: srcDb, kcvPath: srcKcv, mindRoot: srcMind, voiceSamplesRoot: srcVoice });
      const zH = await JSZip.loadAsync(built.buffer);
      ok(built.manifest.mindCount === 2, 'H1. manifest.mindCount === 2', `(${built.manifest.mindCount})`);
      ok(built.manifest.voiceCount === 1, 'H2. manifest.voiceCount === 1', `(${built.manifest.voiceCount})`);
      ok(Boolean(zH.file('mind/self.md') && zH.file('mind/snapshots/snap1.md') && zH.file('voice-samples/personal-agent.mvs')),
        'H3. archive carries mind/self.md + nested snapshot + voice-samples/*.mvs');
      // No re-encryption: the archived bytes are byte-identical to source on disk.
      ok(sha(Buffer.from(await zH.file('mind/self.md').async('uint8array'))) === sha(selfBuf),
        'H4. archived mind/self.md is byte-verbatim (sha256 match)');

      // Restore into a fresh dest, then prove byte-identity end-to-end.
      const dDb = join(H, 'dst-mycelium.db'), dKcv = join(H, 'dst-kcv.json');
      const dMind = join(H, 'dst-mind'), dVoice = join(H, 'dst-voice');
      const r1 = await restoreVaultArchive({ buffer: built.buffer, dbPath: dDb, kcvPath: dKcv, mindRoot: dMind, voiceSamplesRoot: dVoice });
      ok(r1.ok === true, 'H5. restore ok');
      ok(sha(readFileSync(join(dMind, 'self.md'))) === sha(selfBuf), 'H6. restored mind/self.md byte-identical');
      ok(sha(readFileSync(join(dMind, 'snapshots', 'snap1.md'))) === sha(snapBuf), 'H7. restored nested snapshot byte-identical');
      ok(sha(readFileSync(join(dVoice, 'personal-agent.mvs'))) === sha(mvsBuf), 'H8. restored voice sample byte-identical');

      // H9. safe-dest zip-slip: both new guards reject traversal/absolute/backslash/empty → null.
      const mRoot = '/tmp/myc-mind-root', vRoot = '/tmp/myc-voice-root';
      ok(safeMindDest(mRoot, 'mind/self.md') === resolve(mRoot, 'self.md'), 'H9a. legit mind entry → contained dest');
      ok(safeMindDest(mRoot, 'mind/snapshots/x.md') === resolve(mRoot, 'snapshots/x.md'), 'H9b. nested mind entry → contained dest');
      ok(safeMindDest(mRoot, 'mind/../x') === null, 'H9c. mind/../x → null');
      ok(safeMindDest(mRoot, 'mind/../../etc/passwd') === null, 'H9d. mind/../../etc/passwd → null');
      ok(safeMindDest(mRoot, 'mind//etc/passwd') === null || safeMindDest(mRoot, 'mind//etc/passwd').startsWith(resolve(mRoot) + sep), 'H9e. mind//abs-ish stays contained or null');
      // Backslash is a valid filename char on posix (not a separator), so it stays
      // CONTAINED rather than resolving to null — the invariant that matters is that
      // it never ESCAPES the root (on Windows path.resolve would treat it as a sep
      // and the containment check would still catch an escape → null).
      { const d = safeMindDest(mRoot, 'mind/..\\..\\escape'); ok(d === null || d.startsWith(resolve(mRoot) + sep), 'H9f. backslash entry never escapes the root'); }
      ok(safeMindDest(mRoot, 'mind/') === null, 'H9g. empty mind rel → null');
      ok(safeVoiceDest(vRoot, 'voice-samples/a.mvs') === resolve(vRoot, 'a.mvs'), 'H9h. legit voice entry → contained dest');
      ok(safeVoiceDest(vRoot, 'voice-samples/../../escape') === null, 'H9i. voice ../../escape → null');
      ok(safeVoiceDest(vRoot, 'voice-samples/') === null, 'H9j. empty voice rel → null');
      // dest === root rejection (poison `<prefix>/.` → root dir → EISDIR on write).
      // These are the TEETH of the dest===root guard: neuter it and they go RED.
      ok(safeUploadDest(upRoot, 'uploads/.') === null, 'H9k. uploads/. (dest===root) → null');
      ok(safeMindDest(mRoot, 'mind/.') === null, 'H9l. mind/. (dest===root) → null');
      ok(safeVoiceDest(vRoot, 'voice-samples/.') === null, 'H9m. voice-samples/. (dest===root) → null');

      // H10. absolute-path entry cannot escape (path.resolve(root, '/etc/passwd') === '/etc/passwd').
      ok(safeMindDest(mRoot, 'mind//etc/shadow') === null || !safeMindDest(mRoot, 'mind//etc/shadow') || safeMindDest(mRoot, 'mind//etc/shadow').startsWith(resolve(mRoot) + sep),
        'H10. absolute-looking mind entry stays contained or null');

      // H11. crafted zip-slip archive: a mind/../ escape entry writes NOTHING outside the root.
      {
        const slipZip = new JSZip();
        // reuse the valid db+kcv so validateArchive passes, then plant the escape.
        slipZip.file('mycelium.db', await zH.file('mycelium.db').async('uint8array'));
        slipZip.file('kcv.json', await zH.file('kcv.json').async('uint8array'));
        slipZip.file('manifest.json', await zH.file('manifest.json').async('string'));
        const escapeTarget = join(H, 'ESCAPED_MIND');
        slipZip.file('mind/../ESCAPED_MIND', Buffer.from('pwned'));
        slipZip.file('voice-samples/../ESCAPED_VOICE', Buffer.from('pwned'));
        const slipBuf = await slipZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        const dMind2 = join(H, 'slip-mind'), dVoice2 = join(H, 'slip-voice');
        await restoreVaultArchive({ buffer: slipBuf, dbPath: join(H, 'slip.db'), kcvPath: join(H, 'slip-kcv.json'), mindRoot: dMind2, voiceSamplesRoot: dVoice2 });
        ok(!existsSync(escapeTarget) && !existsSync(join(H, 'ESCAPED_VOICE')), 'H11. crafted mind/voice ../ escape wrote nothing outside the root');
      }

      // H12. back-compat: an archive WITHOUT mind/voice restores fine, and mindCount
      //      is NEVER required (a manifest lacking it still validates + restores).
      {
        const plainDb = join(H, 'bc.db'); { const d = new Database(plainDb); d.exec('CREATE TABLE t(x)'); d.close(); }
        const plainKcv = join(H, 'bc-kcv.json'); writeFileSync(plainKcv, '{}');
        const b2 = await buildVaultArchive({ dbPath: plainDb, kcvPath: plainKcv }); // no mind/voice roots
        ok(!(await JSZip.loadAsync(b2.buffer)).file('mind/self.md'), 'H12a. archive built without roots carries no mind/');
        // strip mindCount/voiceCount from the manifest to model a pre-P0 archive.
        const z2 = await JSZip.loadAsync(b2.buffer);
        const m2 = JSON.parse(await z2.file('manifest.json').async('string'));
        delete m2.mindCount; delete m2.voiceCount;
        z2.file('manifest.json', JSON.stringify(m2, null, 2));
        const legacyBuf = await z2.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        const rc = await restoreVaultArchive({ buffer: legacyBuf, dbPath: join(H, 'bc-dst.db'), kcvPath: join(H, 'bc-dst-kcv.json'), mindRoot: join(H, 'bc-dst-mind'), voiceSamplesRoot: join(H, 'bc-dst-voice') });
        ok(rc.ok === true, 'H12b. legacy archive (no mindCount) restores fine — mindCount never required');
      }

      // H13. fail-loud, never silent: a mind-bearing archive restored with a FALSY
      //      mindRoot warns + skips (does not throw, does not write).
      {
        let warned = false;
        const origWarn = console.warn;
        console.warn = (...a) => { if (String(a[0] || '').includes('mind/')) warned = true; origWarn(...a); };
        let threw = false, res13 = null;
        try {
          res13 = await restoreVaultArchive({ buffer: built.buffer, dbPath: join(H, 'nr.db'), kcvPath: join(H, 'nr-kcv.json'), mindRoot: undefined, voiceSamplesRoot: undefined });
        } catch { threw = true; } finally { console.warn = origWarn; }
        ok(!threw && res13?.ok === true, 'H13a. falsy mindRoot restore does NOT throw (db+kcv still land)');
        ok(warned === true, 'H13b. falsy mindRoot restore WARNS (fail-loud, never silent)');
      }

      // H14. overwrite moves the existing mind + voice aside (recoverable, not destroyed).
      {
        const oDb = join(H, 'ov.db'), oKcv = join(H, 'ov-kcv.json');
        const oMind = join(H, 'ov-mind'), oVoice = join(H, 'ov-voice');
        // seed a pre-existing vault + interior at the dest
        { const d = new Database(oDb); d.exec('CREATE TABLE t(x)'); d.close(); }
        writeFileSync(oKcv, '{}');
        mkdirSync(oMind, { recursive: true }); writeFileSync(join(oMind, 'old.md'), Buffer.from('OLD-MIND'));
        mkdirSync(oVoice, { recursive: true }); writeFileSync(join(oVoice, 'old.mvs'), Buffer.from('OLD-VOICE'));
        const ro = await restoreVaultArchive({ buffer: built.buffer, dbPath: oDb, kcvPath: oKcv, mindRoot: oMind, voiceSamplesRoot: oVoice, overwrite: true });
        ok(ro.movedAside.some((p) => p.includes('ov-mind.pre-restore.')), 'H14a. prior mind moved aside (recoverable)');
        ok(ro.movedAside.some((p) => p.includes('ov-voice.pre-restore.')), 'H14b. prior voice moved aside (recoverable)');
        ok(ro.movedAside.some((p) => existsSync(join(p, 'old.md')) || existsSync(join(p, 'old.mvs'))), 'H14c. moved-aside dirs still hold the old files (not destroyed)');
        ok(sha(readFileSync(join(oMind, 'self.md'))) === sha(selfBuf), 'H14d. new mind landed after overwrite');
      }

      // H15. symlink is NOT slurped + *.tmp is skipped.
      {
        const hDb = join(H, 'hy.db'); { const d = new Database(hDb); d.exec('CREATE TABLE t(x)'); d.close(); }
        const hKcv = join(H, 'hy-kcv.json'); writeFileSync(hKcv, '{}');
        const hMind = join(H, 'hy-mind'); mkdirSync(hMind, { recursive: true });
        writeFileSync(join(hMind, 'real.md'), Buffer.concat([Buffer.from('MIND'), Buffer.from('REAL')]));
        writeFileSync(join(hMind, 'inflight.tmp'), Buffer.concat([Buffer.from('MIND'), Buffer.from('HALF-WRITTEN')]));
        const secret = join(H, 'SECRET-OUTSIDE'); writeFileSync(secret, Buffer.from('do-not-exfil'));
        let linked = true;
        try { symlinkSync(secret, join(hMind, 'link.md')); } catch { linked = false; }
        const bh = await buildVaultArchive({ dbPath: hDb, kcvPath: hKcv, mindRoot: hMind });
        const zh = await JSZip.loadAsync(bh.buffer);
        ok(Boolean(zh.file('mind/real.md')), 'H15a. real mind file IS archived');
        ok(!zh.file('mind/inflight.tmp'), 'H15b. *.tmp in-flight file is SKIPPED');
        if (linked) ok(!zh.file('mind/link.md'), 'H15c. symlink is NOT followed/slurped (no exfil)');
        else ok(true, 'H15c. symlink case skipped (symlink() unavailable on this platform)');
        ok(bh.manifest.mindCount === 1, 'H15d. mindCount counts only the real file', `(${bh.manifest.mindCount})`);
      }

      // H16. resolver centralization is VALUE-PRESERVING: mindDir() equals the
      //      pre-refactor inline expressions (compared with path.resolve).
      {
        // env-unset: old mcp.js root 'data/mind' and old rest/portal join(cwd,'data','mind')
        // both meant <cwd>/data/mind; the mind subdir is <that>/mind.
        const cwd = '/some/fake/cwd';
        const oldMcp = resolve(join(resolve(cwd, 'data/mind'), 'mind'));
        const oldRest = resolve(join(join(cwd, 'data', 'mind'), 'mind'));
        const now = resolve(mindDir({ env: {}, cwd }));
        ok(now === oldRest && now === oldMcp, 'H16a. env-unset: mindDir() == old inline expressions', `(${now})`);
        // env-set: MYCELIUM_AGENT_ROOT wins; old subdir was join(root,'mind').
        const absRoot = '/opt/agent-root';
        const oldSet = resolve(join(absRoot, 'mind'));
        const nowSet = resolve(mindDir({ env: { MYCELIUM_AGENT_ROOT: absRoot }, cwd }));
        ok(nowSet === oldSet, 'H16b. env-set: mindDir() == old inline expression', `(${nowSet})`);
        // voice: the old inline expression was literally join(dataDir(opts),'voice-samples').
        // (voiceSamplesRoot/under thread only `env`, not `cwd`, so compare against the
        // same dataDir the old expression used — this is the exact value-preservation.)
        const oldVoice = resolve(join(resolveDataDir({ env: {} }), 'voice-samples'));
        const nowVoice = resolve(resolveVoiceSamplesRoot({ env: {} }));
        ok(nowVoice === oldVoice, 'H16c. env-unset: voiceSamplesRoot() == old join(dataDir(),"voice-samples")', `(${nowVoice})`);
      }

      // ── H17. REAL decrypt-after-restore (the headline continuity invariant) ──
      //   Not fake `MIND`+randomBytes envelopes: write via the LIVE mind writer
      //   (encrypts with getMasterKey), back up, restore into a FRESH root, read
      //   via the LIVE reader → the ORIGINAL PLAINTEXT must survive. Same for a
      //   real encrypted `.mvs` via the live voice store.
      {
        const { createMindFiles } = await import('../src/mindfiles/mind-files.js');
        const { createVoiceSampleStore } = await import('../src/tts/voice-sample-store.js');
        const { getMasterKey } = await import('../src/crypto/crypto-local.js');
        const fspMod = (await import('node:fs/promises')).default;
        const npMod = (await import('node:path')).default;
        // Ensure a usable master key even if boot didn't pin one in this process.
        if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
        const mkey = await getMasterKey();
        if (!mkey) {
          ok(true, 'H17. real decrypt round-trip SKIPPED (no master key available in this process)');
        } else {
          const srcRoot = join(H, 'r17-agent'); const srcMindDir = join(srcRoot, 'mind');
          const mkSrc = createMindFiles({ agentRoot: srcRoot, agentId: 'personal-agent', fs: fspMod, path: npMod });
          await mkSrc.writeMindFile('self.md', 'secret-continuity-XYZ');
          const rdb = join(H, 'r17.db'); { const d = new Database(rdb); d.exec('CREATE TABLE t(x)'); d.close(); }
          const rkcv = join(H, 'r17-kcv.json'); writeFileSync(rkcv, '{}');
          const srcVoiceDir = join(H, 'r17-voice');
          const vSrc = createVoiceSampleStore({ baseDir: srcVoiceDir });
          const wav = Buffer.concat([Buffer.from('RIFF'), randomBytes(2048)]);
          await vSrc.saveSample('personal-agent', { wav, sampleText: 'hello world sample' });

          const built17 = await buildVaultArchive({ dbPath: rdb, kcvPath: rkcv, mindRoot: srcMindDir, voiceSamplesRoot: srcVoiceDir });
          ok(built17.manifest.mindCount === 1 && built17.manifest.voiceCount === 1, 'H17a. live-written mind + voice were carried (magic-valid)', `(m${built17.manifest.mindCount}/v${built17.manifest.voiceCount})`);

          const dstRoot = join(H, 'r17-dst-agent'); const dstMindDir = join(dstRoot, 'mind');
          const dstVoiceDir = join(H, 'r17-dst-voice');
          await restoreVaultArchive({ buffer: built17.buffer, dbPath: join(H, 'r17-dst.db'), kcvPath: join(H, 'r17-dst-kcv.json'), mindRoot: dstMindDir, voiceSamplesRoot: dstVoiceDir });
          const mkDst = createMindFiles({ agentRoot: dstRoot, agentId: 'personal-agent', fs: fspMod, path: npMod });
          const got = await mkDst.readMindFile('self.md');
          ok(got === 'secret-continuity-XYZ', 'H17b. restored mind/self.md DECRYPTS to the original plaintext (real continuity, not byte-transport)', `(${got})`);
          const vDst = createVoiceSampleStore({ baseDir: dstVoiceDir });
          const sample = await vDst.getSample('personal-agent');
          ok(Boolean(sample) && Buffer.isBuffer(sample?.wav) && sha(sample.wav) === sha(wav), 'H17c. restored voice .mvs DECRYPTS to the original wav bytes (real continuity)');
        }
      }

      // ── H18. magic enforcement at BUILD: a non-MIND-magic (plaintext) file in
      //   the mind dir is NOT shipped — it would otherwise leak in the clear inside
      //   the unencrypted .myvault zip. ──
      {
        const eDb = join(H, 'e18.db'); { const d = new Database(eDb); d.exec('CREATE TABLE t(x)'); d.close(); }
        const eKcv = join(H, 'e18-kcv.json'); writeFileSync(eKcv, '{}');
        const eMind = join(H, 'e18-mind'); mkdirSync(eMind, { recursive: true });
        writeFileSync(join(eMind, 'good.md'), Buffer.concat([Buffer.from('MIND'), randomBytes(10)]));
        writeFileSync(join(eMind, 'plain.md'), Buffer.from('PLAINTEXT-NO-MAGIC-LEAK'));
        const b18 = await buildVaultArchive({ dbPath: eDb, kcvPath: eKcv, mindRoot: eMind });
        const z18 = await JSZip.loadAsync(b18.buffer);
        ok(Boolean(z18.file('mind/good.md')) && !z18.file('mind/plain.md'), 'H18a. non-MIND-magic mind file is NOT shipped (no plaintext leak)');
        ok(b18.manifest.mindCount === 1, 'H18b. mindCount excludes the skipped non-magic file', `(${b18.manifest.mindCount})`);
        // and the plaintext bytes are provably absent from the whole archive
        ok(b18.buffer.indexOf(Buffer.from('PLAINTEXT-NO-MAGIC-LEAK')) === -1, 'H18c. the plaintext bytes are absent from the archive');
      }

      // ── H19. poison archive: mind/. (dest===root/EISDIR), NUL-in-name, and a
      //   file-then-dir collision (mind/a + mind/a/b) → restore does NOT throw,
      //   still returns the movedAside receipt, commits db+kcv, writes nothing
      //   outside the root. ──
      {
        const pz = new JSZip();
        pz.file('mycelium.db', await zH.file('mycelium.db').async('uint8array'));
        pz.file('kcv.json', await zH.file('kcv.json').async('uint8array'));
        pz.file('manifest.json', await zH.file('manifest.json').async('string'));
        pz.file('mind/.', Buffer.from('dot'));              // dest === root → guard nulls it
        const nulName = "mind/a" + String.fromCharCode(0) + "evil"; // NUL in name
        pz.file(nulName, Buffer.from("nul"));               // NUL name -> write throws -> caught
        pz.file('mind/a', Buffer.from('AAA'));              // file 'a'
        pz.file('mind/a/b', Buffer.from('BBB'));            // then dir 'a' → EISDIR/ENOTDIR → caught
        const pzBuf = await pz.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        const pDb = join(H, 'p19.db'); { const d = new Database(pDb); d.exec('CREATE TABLE t(x)'); d.close(); }
        const pKcv = join(H, 'p19-kcv.json'); writeFileSync(pKcv, '{}');
        const pMind = join(H, 'p19-mind'); mkdirSync(pMind, { recursive: true }); writeFileSync(join(pMind, 'old.md'), Buffer.from('OLD'));
        let threw19 = false, res19 = null;
        try {
          res19 = await restoreVaultArchive({ buffer: pzBuf, dbPath: pDb, kcvPath: pKcv, mindRoot: pMind, voiceSamplesRoot: join(H, 'p19-voice'), overwrite: true });
        } catch { threw19 = true; }
        ok(!threw19, 'H19a. poison archive restore does NOT throw');
        ok(res19?.ok === true && Array.isArray(res19.movedAside) && res19.movedAside.length > 0, 'H19b. restore still returns the movedAside receipt (not stranded mid-write)');
        ok(existsSync(pDb) && existsSync(pKcv), 'H19c. db + kcv still committed despite the poison entries');
      }

      // ── H20. decompression-bomb guard on the MANDATORY members (mycelium.db,
      //   kcv.json, manifest.json, remote.json) — read via readEntryCapped, not
      //   writeEntrySafe. TWO layers: (1) a declared-size fast-reject (entryExceedsCap)
      //   and (2) a STREAMING byte ceiling that aborts inflation even when the header
      //   LIES about its size — the shape a declared-size-only check cannot stop. ──
      {
        // -- Layer 1: entryExceedsCap primitive (the cheap declared-size fast-reject). --
        ok(entryExceedsCap({ _data: { uncompressedSize: MAX_DB_BYTES + 1 } }, MAX_DB_BYTES) === true, 'H20a. over-cap declared size → exceeds (true)');
        ok(entryExceedsCap({ _data: { uncompressedSize: 1234 } }, MAX_DB_BYTES) === false, 'H20b. small declared size → within cap (false)');
        // 0xD0000000 (~3.49 GiB) is read signed-negative by JSZip; the guard must still catch it.
        ok(entryExceedsCap({ _data: { uncompressedSize: 0xD0000000 | 0 } }, MAX_DB_BYTES) === true, 'H20c. >2GiB declared (signed-negative) still caught (unsigned recovery)');
        ok(entryExceedsCap({ _data: {} }, MAX_DB_BYTES) === false && entryExceedsCap(null, MAX_DB_BYTES) === false, 'H20d. absent/undeclared size → fail-open on the advisory field (layer 2 still bounds it)');
        ok(entryExceedsCap({ _data: { uncompressedSize: MAX_DB_BYTES } }, MAX_DB_BYTES) === false, 'H20e. db exactly at the cap is allowed (boundary: only strictly-over is a bomb)');
        ok(MAX_DB_BYTES > MAX_ENTRY_BYTES, 'H20f. db cap is roomier than the per-entry cap (whole vault dwarfs a single blob)');

        // -- Layer 2: readEntryCapped's STREAMING ceiling. The headline case the
        //    declared-size check alone MISSES: a member that DECLARES small but whose
        //    stream inflates far past the cap. The DECISIVE property is that the inflate
        //    is aborted MID-STREAM (memory bounded), not merely that it eventually
        //    errors — JSZip throws a size-mismatch AFTER buffering the whole payload, so
        //    an error-code assertion alone is MASKED (a muted layer 2 still rejects, just
        //    after OOMing). So we drive readEntryCapped with a synthetic entry that emits
        //    8 MiB in 64 KiB chunks and RECORDS how many bytes were pulled before the
        //    stream was destroyed — and assert that count stayed near the cap. --
        {
          const TOTAL = 8 * 1024 * 1024, CHUNK = 64 * 1024, CAP = 256 * 1024;
          let emitted = 0, destroyedAt = null;
          const fakeEntry = {
            _data: { uncompressedSize: 500 },            // LIE: layer 1 (entryExceedsCap) waves it through
            nodeStream() {
              const r = new Readable({
                read() {
                  if (emitted >= TOTAL) { this.push(null); return; }
                  const n = Math.min(CHUNK, TOTAL - emitted);
                  emitted += n;
                  this.push(Buffer.alloc(n, 1));
                },
              });
              const origDestroy = r.destroy.bind(r);
              r.destroy = (...a) => { if (destroyedAt === null) destroyedAt = emitted; return origDestroy(...a); };
              return r;
            },
          };
          ok(entryExceedsCap(fakeEntry, CAP) === false, 'H20g. layer 1 is FOOLED by the lie (declared 500 < 256KiB cap → false)');
          let lThrew = false, lCode = null;
          try { await readEntryCapped(fakeEntry, CAP, 'database'); }
          catch (e) { lThrew = true; lCode = e?.code; }
          ok(lThrew && lCode === 'invalid_archive', 'H20h. layer 2 REJECTS the lying stream → invalid_archive', `(${lCode})`);
          // The teeth: destroyed shortly after CAP (flowing-mode read-ahead pulls a few
          // chunks past it), NOT after the full 8 MiB. 2 MiB is 8x the cap yet a quarter
          // of TOTAL — decisive. Mute the `if (total > cap)` abort and this goes RED:
          // destroyedAt stays null and emitted reaches TOTAL (8 MiB) with no throw.
          ok(destroyedAt !== null && destroyedAt <= 2 * 1024 * 1024 && emitted < TOTAL,
            'H20i. inflate ABORTED mid-stream — memory bounded to ~cap, not the full 8 MiB', `(destroyedAt=${destroyedAt}B, emitted=${emitted}B of ${TOTAL}B)`);

          // Real-JSZip integration smoke: a DEFLATE member that lies small is refused
          // fail-closed end-to-end (streaming cap or jszip mismatch — either way no data).
          const lz = new JSZip();
          lz.file('mycelium.db', Buffer.alloc(4 * 1024 * 1024, 0), { compression: 'DEFLATE' });
          const lyingBuf = patchDeclaredSize(Buffer.from(await lz.generateAsync({ type: 'nodebuffer' })), 'mycelium.db', 500);
          const lEntry = (await JSZip.loadAsync(lyingBuf)).file('mycelium.db');
          let rThrew = false;
          try { await readEntryCapped(lEntry, 256 * 1024, 'database'); } catch { rThrew = true; }
          ok(rThrew, 'H20j. real DEFLATE lying-bomb is refused fail-closed (integration)');

          // honest DEFLATE member under the cap round-trips to exact bytes (no false-positive).
          const okZip = new JSZip();
          const payload = randomBytes(120 * 1024);
          okZip.file('m', payload, { compression: 'DEFLATE' });
          const okEntry = (await JSZip.loadAsync(await okZip.generateAsync({ type: 'nodebuffer' }))).file('m');
          ok(sha(await readEntryCapped(okEntry, MAX_ENTRY_BYTES, 'm')) === sha(payload), 'H20k. honest under-cap member round-trips byte-exact through readEntryCapped');

          // null entry → clean invalid_archive (never a TypeError/500).
          let nThrew = false, nCode = null;
          try { await readEntryCapped(null, MAX_DB_BYTES, 'database'); } catch (e) { nThrew = true; nCode = e?.code; }
          ok(nThrew && nCode === 'invalid_archive', 'H20l. missing entry → invalid_archive (no null.async() TypeError)');

          // A stream that 'close's WITHOUT 'end'/'error' (aborted/truncated) must
          // still settle — restore would otherwise HANG forever. Race against a 2s
          // timer: if readEntryCapped never settles, the timer wins → RED.
          {
            const closer = { _data: { uncompressedSize: 10 }, nodeStream() {
              const r = new Readable({ read() {} });         // emits nothing
              queueMicrotask(() => r.emit('close'));          // close, no end/error
              return r;
            } };
            let timer;
            const guard = new Promise((res) => { timer = setTimeout(() => res('HANG'), 2000); });
            const outcome = await Promise.race([
              readEntryCapped(closer, MAX_DB_BYTES, 'database').then(() => 'resolved', (e) => e?.code || 'rejected'),
              guard,
            ]);
            clearTimeout(timer);   // settle → drop the guard so success isn't delayed; a HANG still wins the race
            ok(outcome === 'invalid_archive', 'H20m. stream close-without-end SETTLES (no hang) → invalid_archive', `(${outcome})`);
          }
        }

        // -- End-to-end through validateArchive + restoreVaultArchive: a real, tiny
        //    archive whose mycelium.db header DECLARES ~3.49 GiB (layer-1 territory). --
        {
          const bz = new JSZip();
          bz.file('mycelium.db', await zH.file('mycelium.db').async('uint8array'));
          bz.file('kcv.json', await zH.file('kcv.json').async('uint8array'));
          bz.file('manifest.json', await zH.file('manifest.json').async('string'));
          const bombBuf = patchDeclaredSize(Buffer.from(await bz.generateAsync({ type: 'nodebuffer', compression: 'STORE' })), 'mycelium.db', 0xD0000000);
          ok(bombBuf.length < 100 * 1024, 'H20n. declares-huge fixture is tiny on disk', `(${bombBuf.length}B)`);

          const val = await validateArchive(bombBuf);
          ok(val.ok === false && /decompression bomb|size cap/i.test(val.error || ''), 'H20o. validateArchive rejects the over-cap db (fail-closed)', `(${val.error || ''})`);

          // Reorder invariant: with an EXISTING vault + overwrite, the bomb must be
          // refused with ZERO disk mutation — the prior vault is NOT moved aside.
          const rDir = mkdtempSync(join(tmpdir(), 'myc-bomb-dst-'));
          const rDb = join(rDir, 'mycelium.db'), rKcv = join(rDir, 'kcv.json');
          { const d = new Database(rDb); d.exec('CREATE TABLE keep(x)'); d.close(); }
          writeFileSync(rKcv, '{"keep":true}');
          let threw20 = false, code20 = null;
          try { await restoreVaultArchive({ buffer: bombBuf, dbPath: rDb, kcvPath: rKcv, overwrite: true }); }
          catch (e) { threw20 = true; code20 = e?.code; }
          ok(threw20 && code20 === 'invalid_archive', 'H20p. restore refuses the bomb (throws invalid_archive)', `(${code20})`);
          ok(existsSync(rDb) && existsSync(rKcv) && !readdirSync(rDir).some((n) => n.includes('.pre-restore.')), 'H20q. prior vault UNTOUCHED — nothing moved aside (bomb caught before any disk mutation)');
          rmSync(rDir, { recursive: true, force: true });
        }
      }
    } finally {
      try { rmSync(H, { recursive: true, force: true }); } catch { /* */ }
    }
  }
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
