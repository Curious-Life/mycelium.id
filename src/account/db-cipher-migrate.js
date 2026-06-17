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
import { existsSync, openSync, readSync, closeSync, copyFileSync, renameSync, rmSync, readdirSync, statSync, writeSync, fsyncSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

  log(`[mycelium] vault encrypted at rest (${tableN} tables, parity OK). Plaintext copy kept at ${preCipherPath} — removed automatically on the next verified keyed reopen.`);
  return { migrated: true, preCipherPath, tables: tableN };
}

/**
 * Best-effort, single-pass zero-overwrite of a file's bytes, then fsync.
 *
 * SECURE-ERASE LIMITATION (read before relying on this): on a modern SSD with
 * wear-leveling, and especially on a copy-on-write filesystem (APFS — the macOS
 * default, which is the PRIMARY deployment here), overwriting a file's bytes in
 * place does NOT reliably scrub the physical blocks that held the original data:
 * the filesystem writes the overwrite to fresh blocks and leaves the old blocks
 * live until they are garbage-collected / TRIM'd. So this overwrite is
 * best-effort only — it can help on the rare non-CoW / spinning-disk case and is
 * cheap, but it is NOT a guarantee. The real at-rest defense for residue is
 * full-disk encryption (FileVault). The `unlink` in reapPreCipherBackups() is the
 * practical floor; this pass is belt-and-suspenders, never a substitute.
 */
function bestEffortOverwrite(path) {
  let size;
  try { size = statSync(path).size; } catch { return; }
  if (!size) return;
  let fd;
  try {
    fd = openSync(path, 'r+');
    const chunk = Buffer.alloc(Math.min(size, 1 << 20)); // up to 1 MiB of zeros
    let off = 0;
    while (off < size) {
      const n = Math.min(chunk.length, size - off);
      writeSync(fd, chunk, 0, n, off);
      off += n;
    }
    fsyncSync(fd);
  } catch { /* best-effort: swallow and let the caller's unlink do the real work */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

/**
 * Remove any lingering plaintext `.pre-cipher-<ts>` backup(s) left beside the
 * vault by ensureVaultEncrypted() (the renamed pre-migration plaintext copy, plus
 * any stray -wal/-shm sidecars for it).
 *
 * SAFETY CONTRACT — the caller MUST have already proven the *encrypted* vault
 * opens with the derived key (a keyed probe read) BEFORE calling this. This
 * function does NOT re-verify the encrypted copy; it only deletes the plaintext
 * safety net, which is irreversible. Removing the backup before the encrypted copy
 * is confirmed readable would risk total data loss — see src/index.js boot() for
 * the gating (at-rest enabled + migration did NOT run this boot + keyed probe
 * read OK). On its own this function is a no-op when no backup is present.
 *
 * Each backup is run through bestEffortOverwrite() (see its LIMITATION note —
 * unlink is the real floor, not the overwrite) and then unlinked. Failures are
 * logged and skipped, never thrown: a backup we cannot remove must not crash boot.
 *
 * @param {{ dbPath: string, log?: (m:string)=>void }} opts
 * @returns {{ reaped: string[] }} absolute paths removed (empty if none lingering)
 */
export function reapPreCipherBackups({ dbPath, log = () => {} }) {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.pre-cipher-`; // matches <db>.pre-cipher-<ts>[ -wal | -shm ]
  let names;
  try { names = readdirSync(dir); } catch { return { reaped: [] }; }
  const reaped = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue; // never matches the live <db> (no .pre-cipher-) or <db>.cipher-tmp
    const p = join(dir, name);
    try {
      bestEffortOverwrite(p);
      rmSync(p, { force: true });
      reaped.push(p);
    } catch (e) {
      log(`[mycelium] at-rest: could not remove plaintext backup ${p}: ${e.message}`);
    }
  }
  if (reaped.length) {
    log(`[mycelium] at-rest: removed ${reaped.length} plaintext pre-cipher backup(s) after verified keyed reopen`);
  }
  return { reaped };
}
