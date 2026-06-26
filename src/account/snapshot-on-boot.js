// src/account/snapshot-on-boot.js — opt-in, fail-closed pre-migration vault snapshot.
//
// When MYCELIUM_SNAPSHOT_ON_BOOT is set, ensureVaultSchema (which runs UNDER the
// cross-process init lock, so this is race-safe) calls this BEFORE applyMigrations.
// It writes a consistent, still-ENCRYPTED `VACUUM INTO` snapshot of the vault to
// <dataDir>/snapshots/ — but ONLY when the migration SET changed since the last
// snapshot (a fingerprint of the migrations/*.sql files). So normal relaunches are
// free, and a snapshot lands exactly when a build introduces new migrations — the
// one moment a bad schema change could corrupt the vault.
//
// FAIL CLOSED: if the snapshot can't be written, we THROW — refusing to migrate an
// un-backed-up vault is safer than risking an unrecoverable migration. The dev app
// (which runs against the real production vault) sets this flag; the production app
// leaves it unset, so its boot path is byte-for-byte unchanged.
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const KEEP = Number(process.env.MYCELIUM_SNAPSHOT_KEEP) || 15;

/**
 * Synchronous, consistent single-file snapshot via `VACUUM INTO` — the sync twin of
 * backup.js::snapshotDb's keyed branch (kept sync so it slots into the synchronous
 * ensureVaultSchema boot path under the init lock). Keyed → still-encrypted snapshot;
 * null key → plaintext. VACUUM INTO uses a read txn, so it's safe even under writes.
 */
function snapshotSync(srcDbPath, destPath, dbKeyHex) {
  for (const sfx of ['', '-wal', '-shm']) { try { rmSync(destPath + sfx); } catch { /* */ } }
  const db = new Database(srcDbPath, { fileMustExist: true });
  try {
    if (dbKeyHex) {
      if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new Error('dbKeyHex must be 64-char hex');
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
    }
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally { try { db.close(); } catch { /* */ } }
  try { chmodSync(destPath, 0o600); } catch { /* best-effort: never fail a backup on chmod */ }
}

/** Stable fingerprint of the migration set (filenames + sizes). null if no dir. */
function migrationsFingerprint(dir) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort(); }
  catch { return null; }
  const h = createHash('sha256');
  for (const f of files) {
    let size = 0;
    try { size = statSync(path.join(dir, f)).size; } catch { /* */ }
    h.update(`${f}:${size}\n`);
  }
  return `${files.length}:${h.digest('hex').slice(0, 16)}`;
}

/** Keep only the newest `keep` pre-migrate snapshots (lexical = chronological). */
function pruneSnapshots(dir, keep, log) {
  let snaps;
  try { snaps = readdirSync(dir).filter((f) => f.startsWith('pre-migrate-') && f.endsWith('.db')).sort(); }
  catch { return; }
  while (snaps.length > keep) {
    const victim = snaps.shift();
    try { rmSync(path.join(dir, victim)); log?.(`[snapshot] pruned old ${victim}`); } catch { /* best-effort */ }
  }
}

/**
 * Snapshot the vault before migrating — opt-in (MYCELIUM_SNAPSHOT_ON_BOOT), and
 * only when the migration set changed since the last snapshot. Fail-closed: throws
 * if the snapshot write fails, so the caller never migrates an un-backed-up vault.
 *
 * @param {{ dbFile:string, dbKeyHex:string|null, migrationsDir?:string, log?:Function }} o
 * @returns {string|null} the snapshot path written, or null if skipped.
 */
export function maybeSnapshotBeforeMigrate({ dbFile, dbKeyHex, migrationsDir = 'migrations', log } = {}) {
  if (!process.env.MYCELIUM_SNAPSHOT_ON_BOOT) return null;
  if (!dbFile || !existsSync(dbFile)) return null;       // fresh vault — nothing to back up
  const fp = migrationsFingerprint(migrationsDir);
  if (!fp) return null;                                   // no migrations dir — nothing to gate on

  const snapDir = path.join(path.dirname(dbFile), 'snapshots');
  const fpFile = path.join(snapDir, '.last-migrations-fp');
  let last = '';
  try { last = readFileSync(fpFile, 'utf8').trim(); } catch { /* none yet */ }
  if (fp === last) return null;                           // migrations unchanged → skip (fast path)

  mkdirSync(snapDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(snapDir, `pre-migrate-${stamp}.db`);
  try {
    snapshotSync(dbFile, dest, dbKeyHex);                 // keyed → still-encrypted; null → plaintext
  } catch (e) {
    throw new Error(
      `[snapshot] pre-migration snapshot FAILED (${e?.message || e}). Refusing to migrate an ` +
      `un-backed-up vault. Unset MYCELIUM_SNAPSHOT_ON_BOOT to bypass (not recommended).`,
    );
  }
  // Only record the fingerprint AFTER a successful snapshot, so a failed snapshot
  // doesn't poison the gate and skip the next attempt.
  writeFileSync(fpFile, fp);
  pruneSnapshots(snapDir, KEEP, log);
  log?.(`[snapshot] pre-migration snapshot → ${dest}`);
  return dest;
}

export default maybeSnapshotBeforeMigrate;
