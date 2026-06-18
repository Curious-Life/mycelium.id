// src/account/db-cipher-migrate.js — one-time, idempotent, NON-DESTRUCTIVE
// encryption of a plaintext vault into whole-file SQLCipher (at-rest blindness, A′).
//
// Runs at boot AFTER unlock (needs USER_MASTER → deriveDbKey) and BEFORE the keyed
// schema apply / getDb open. Mirrors the safety posture of ensureDataDir
// (src/server-rest.js): a boot file op that preserves the original bytes and never
// runs twice. @see docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md §7.
//
// Recipe (spike-verified — sqlcipher_export() is NOT available in
// better-sqlite3-multiple-ciphers; in-place rekey works but mutates the original,
// so we COPY then rekey the copy then atomic-swap — a mid-run crash leaves the
// original plaintext vault intact):
//   1. checkpoint the plaintext WAL so all data is in the main file
//   2. copy main file → <db>.cipher-tmp
//   3. rekey the copy in place (cipher='sqlcipher' + rekey x'<key>')
//   4. per-table COUNT(*) parity: plaintext vs encrypted (fail closed on mismatch)
//   5. atomic swap: rename original → <db>.pre-cipher-<ts> (KEPT, never auto-deleted),
//      rename the encrypted copy → <db>
import Database from 'better-sqlite3';
import { existsSync, openSync, readSync, closeSync, copyFileSync, renameSync, rmSync } from 'node:fs';

const PLAINTEXT_MAGIC = Buffer.from('SQLite format 3\0', 'latin1'); // first 16 bytes of any plaintext sqlite db

/** Read the first 16 bytes of a file (its sqlite header slot). */
function header16(path) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0); return b; }
  finally { closeSync(fd); }
}

/** True iff the file at `path` is an UNENCRYPTED sqlite db (magic header present). */
export function isPlaintextSqlite(path) {
  if (!existsSync(path)) return false;
  try { return header16(path).equals(PLAINTEXT_MAGIC); } catch { return false; }
}

function tableCounts(db) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map((r) => r.name);
  const counts = {};
  for (const t of tables) counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  return counts;
}

/**
 * Encrypt a plaintext vault in place (idempotent). No-op if the file is absent,
 * already encrypted, or no dbKeyHex is supplied (opt-in). Returns a result object.
 * Fail-closed: any parity mismatch aborts, deletes the temp, and throws — the
 * original plaintext vault is left untouched.
 *
 * @param {{ dbPath: string, dbKeyHex: string|null, log?: (m:string)=>void }} opts
 * @returns {{ migrated: boolean, reason?: string, preCipherPath?: string, tables?: number }}
 */
export function ensureVaultEncrypted({ dbPath, dbKeyHex, log = () => {} }) {
  if (!dbKeyHex) return { migrated: false, reason: 'no key (opt-out)' };
  if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new Error('dbKeyHex must be 64-char hex');
  if (!existsSync(dbPath)) return { migrated: false, reason: 'no vault yet' };
  if (!isPlaintextSqlite(dbPath)) return { migrated: false, reason: 'already encrypted' };

  const tmpPath = `${dbPath}.cipher-tmp`;
  for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmpPath + sfx); } catch {} } // clear any stale temp from a crashed run

  // 1. fold the plaintext WAL into the main file + snapshot the source counts
  let srcCounts;
  {
    const src = new Database(dbPath);
    try {
      src.pragma('journal_mode = WAL');
      src.pragma('wal_checkpoint(TRUNCATE)');
      srcCounts = tableCounts(src);
    } finally { src.close(); }
  }

  // 2. copy → 3. rekey the copy in place
  copyFileSync(dbPath, tmpPath);
  {
    const cp = new Database(tmpPath);
    try {
      cp.pragma('journal_mode = DELETE'); // no -wal/-shm sidecars on the temp copy
      cp.pragma(`cipher='sqlcipher'`);
      cp.pragma(`rekey="x'${dbKeyHex}'"`);
    } finally { cp.close(); }
  }

  // 4. parity check on the encrypted copy (fail closed)
  {
    const enc = new Database(tmpPath);
    try {
      enc.pragma(`cipher='sqlcipher'`);
      enc.pragma(`key="x'${dbKeyHex}'"`);
      const encCounts = tableCounts(enc);
      const srcKeys = Object.keys(srcCounts);
      const mismatch = srcKeys.find((t) => srcCounts[t] !== encCounts[t]) ||
        (Object.keys(encCounts).length !== srcKeys.length ? '<table-set>' : null);
      if (mismatch) {
        throw new Error(`row-count parity failed for "${mismatch}" (plaintext ${srcCounts[mismatch]} vs encrypted ${encCounts[mismatch]})`);
      }
      var tableN = srcKeys.length;
    } catch (err) {
      enc.close();
      for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmpPath + sfx); } catch {} }
      throw new Error(`vault encryption aborted (original left intact): ${err.message}`);
    }
    enc.close();
  }

  // 5. atomic swap — keep the plaintext original aside as a crash-safety net for
  //    THIS boot only; the caller (boot) calls purgePlaintextBackup() once the
  //    encrypted vault has opened keyed, so no cleartext copy lingers at rest.
  const preCipherPath = `${dbPath}.pre-cipher-${Date.now()}`;
  renameSync(dbPath, preCipherPath);
  for (const sfx of ['-wal', '-shm']) { try { rmSync(dbPath + sfx); } catch {} } // stale (checkpointed) sidecars
  renameSync(tmpPath, dbPath);

  log(`[mycelium] vault encrypted at rest (${tableN} tables, parity OK). Plaintext copy kept at ${preCipherPath} until the keyed open is confirmed, then removed.`);
  return { migrated: true, preCipherPath, tables: tableN };
}

/**
 * Securely retire the plaintext pre-cipher backup left by ensureVaultEncrypted,
 * so no cleartext copy of the vault survives at rest (the whole point of A′).
 *
 * SELF-VERIFYING + FAIL-SAFE: refuses to delete the plaintext backup unless the
 * LIVE vault at dbPath is (a) present, (b) NOT a plaintext sqlite file, and
 * (c) actually opens + reads with the key. Only once the encrypted vault is
 * proven usable do we remove the plaintext — never the other way round.
 *
 * NOTE on "secure": on APFS/SSD this is an unlink, not a cryptographic erase —
 * copy-on-write + wear-levelling mean freed blocks may persist until overwritten.
 * The device-level protection for those blocks is full-disk encryption (FileVault,
 * on by default on modern Macs); this app-level layer is defense-in-depth on top.
 *
 * @param {{ dbPath: string, preCipherPath: string, dbKeyHex: string|null, log?: (m:string)=>void }} opts
 * @returns {{ purged: boolean, reason?: string }}
 */
export function purgePlaintextBackup({ dbPath, preCipherPath, dbKeyHex, log = () => {} }) {
  if (!preCipherPath || !existsSync(preCipherPath)) return { purged: false, reason: 'no backup to purge' };
  if (!dbKeyHex || !/^[0-9a-f]{64}$/i.test(dbKeyHex)) return { purged: false, reason: 'no/invalid key — refusing' };
  if (!existsSync(dbPath)) return { purged: false, reason: 'live vault missing — refusing' };
  // Never delete the plaintext while the live vault is still plaintext (a
  // half/failed migration) — that backup is the only intact copy.
  if (isPlaintextSqlite(dbPath)) return { purged: false, reason: 'live vault still plaintext — refusing' };
  // Prove the encrypted vault opens + reads with the key before discarding plaintext.
  try {
    const v = new Database(dbPath);
    try {
      v.pragma(`cipher='sqlcipher'`);
      v.pragma(`key="x'${dbKeyHex}'"`);
      v.prepare(`SELECT count(*) AS c FROM sqlite_master`).get();
    } finally { v.close(); }
  } catch (err) {
    return { purged: false, reason: `keyed open failed — refusing: ${err.message}` };
  }
  // Encrypted vault is proven good → retire the plaintext backup (+ any sidecars).
  for (const sfx of ['', '-wal', '-shm']) { try { rmSync(preCipherPath + sfx, { force: true }); } catch {} }
  log(`[mycelium] at-rest: removed plaintext pre-cipher backup (encrypted vault confirmed) ${preCipherPath}`);
  return { purged: true };
}
