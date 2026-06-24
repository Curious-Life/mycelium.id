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
import { existsSync, openSync, readSync, closeSync, copyFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

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

  // 5. atomic swap — keep the plaintext original aside (NEVER auto-deleted)
  const preCipherPath = `${dbPath}.pre-cipher-${Date.now()}`;
  renameSync(dbPath, preCipherPath);
  for (const sfx of ['-wal', '-shm']) { try { rmSync(dbPath + sfx); } catch {} } // stale (checkpointed) sidecars
  renameSync(tmpPath, dbPath);

  log(`[mycelium] vault encrypted at rest (${tableN} tables, parity OK). Plaintext copy kept at ${preCipherPath} — it is removed automatically once the keyed vault is confirmed to open.`);
  return { migrated: true, preCipherPath, tables: tableN };
}

/**
 * Remove the plaintext `<db>.pre-cipher-<ts>` backup(s) ensureVaultEncrypted left
 * behind — but ONLY after PROVING the live vault is a working, keyed ciphertext
 * file. This closes the at-rest hole where a full plaintext copy of the vault
 * persists on disk after migration (an attacker with file access could read it
 * even though the live vault is encrypted).
 *
 * Self-verifying + fail-safe: on ANY doubt it KEEPS every backup and logs — it
 * can never destroy the only good copy. Never throws on a normal skip (boot must
 * not fail because a stale backup can't be removed).
 *
 * Erasure caveat: on SSD/APFS a plain unlink does not guarantee block-level
 * erasure (copy-on-write + wear-leveling). True at-rest erasure of the removed
 * bytes relies on whole-disk FileVault (a different key, *underneath* SQLCipher).
 * We unlink and do NOT claim shred-grade deletion.
 *
 * @param {{ dbPath: string, dbKeyHex: string|null, log?: (m:string)=>void }} opts
 * @returns {{ purged: string[], skipped: {path:string, reason:string}[] }}
 */
export function purgePlaintextBackup({ dbPath, dbKeyHex, log = () => {} }) {
  const purged = [];
  const skipped = [];
  const keepAll = (reason) => {
    log(`[mycelium] at-rest: KEEPING plaintext backup(s) — ${reason}`);
    return { purged, skipped: [{ path: '*', reason }] };
  };

  // ── Pre-checks: every one must pass before we touch a single backup ──────────
  if (!dbKeyHex) return keepAll('no DB key (vault not keyed)');
  if (!existsSync(dbPath)) return keepAll('no live vault');
  if (isPlaintextSqlite(dbPath)) return keepAll('live vault is still PLAINTEXT (migration incomplete)');

  // Prove the live vault opens with the key AND reads — i.e. the ciphertext is
  // intact and recoverable. sqlite_master is only readable once the key is right,
  // so a successful read is proof the encrypted copy is not corrupt. Only then is
  // the plaintext copy truly redundant.
  try {
    const live = new Database(dbPath, { fileMustExist: true });
    try {
      live.pragma(`cipher='sqlcipher'`);
      live.pragma(`key="x'${dbKeyHex}'"`);
      live.prepare(`SELECT count(*) c FROM sqlite_master`).get();
    } finally { live.close(); }
  } catch (err) {
    return keepAll(`live vault did not open keyed (${err.message})`);
  }

  // ── Remove the plaintext siblings (+ any -wal/-shm fragments) ────────────────
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.pre-cipher-`;
  let entries = [];
  try { entries = readdirSync(dir).filter((f) => f.startsWith(prefix) && !f.endsWith('-wal') && !f.endsWith('-shm')); } catch { /* dir unreadable → nothing to purge */ }
  for (const name of entries) {
    const p = join(dir, name);
    // Sanity: only ever delete a file we can confirm is a plaintext sqlite db.
    if (!isPlaintextSqlite(p)) { skipped.push({ path: p, reason: 'not a plaintext sqlite db (unexpected) — kept' }); continue; }
    let ok = true;
    for (const sfx of ['', '-wal', '-shm']) {
      try { rmSync(p + sfx, { force: true }); } catch (err) { ok = false; skipped.push({ path: p + sfx, reason: err.message }); }
    }
    if (ok) purged.push(p);
  }
  if (purged.length) log(`[mycelium] at-rest: purged ${purged.length} plaintext backup(s) after verified keyed reopen.`);
  return { purged, skipped };
}
