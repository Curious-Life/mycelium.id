// src/db/backup.js — consistent, concurrency-safe snapshot of a LIVE keyed vault.
//
// WHY: copying a live SQLite/SQLCipher file byte-for-byte (fs.copyFileSync) while
// ANY other connection is writing it produces a TORN copy — pages captured across a
// concurrent checkpoint, `-wal` frames omitted — which reads back as
// "database disk image is malformed". When such a torn copy is later promoted to the
// live vault (recovery / migration / restore-a-snapshot) the vault is corrupt. This
// was the reproduced root cause of the 2026-06/07 vault corruptions (6/6 malformed
// via the copy-race repro). @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
//
// HOW: `VACUUM INTO` runs inside a read transaction on the source connection, so it
// snapshots a transactionally-consistent view even while other connections write
// (proven torn-proof 6/6). On a keyed (SQLCipher) connection the output is encrypted
// with the SAME key (verified: same-key reads ok; wrong-key + unkeyed both fail →
// no plaintext leak, CLAUDE.md §1/§7). This is NOT fs.copyFileSync (tears) and NOT
// better-sqlite3's .backup() (opens an unencrypted target → SQLITE_ERROR on the
// cipher vault); `sqlcipher_export` is absent in this driver (SQLite3-Multiple-Ciphers).
import fs from 'node:fs';

/**
 * Consistent snapshot of the vault behind `rawDb` into `destPath`. Synchronous.
 * `rawDb` must be the raw better-sqlite3 handle (adapter `db._sqlite`, or a Database
 * opened + keyed by the caller). VACUUM INTO refuses to overwrite, so any stale
 * destination (+ its sidecars) is removed first.
 * @param {import('better-sqlite3').Database} rawDb
 * @param {string} destPath
 * @returns {string} destPath
 */
export function safeVaultCopy(rawDb, destPath) {
  if (!rawDb || typeof rawDb.exec !== 'function') throw new Error('safeVaultCopy: rawDb must be a better-sqlite3 handle');
  if (!destPath || typeof destPath !== 'string') throw new Error('safeVaultCopy: destPath required');
  for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(destPath + sfx); } catch { /* absent */ } }
  // Single-quote the SQL string literal; escape any embedded quote. destPath is
  // caller-controlled (never request input), but escape defensively regardless.
  rawDb.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  return destPath;
}
