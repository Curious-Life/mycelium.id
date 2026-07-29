// src/account/snapshot-on-boot.js — DEFAULT-ON, fail-closed pre-boot vault snapshot.
//
// ensureVaultSchema (which runs UNDER the cross-process init lock, so this is
// race-safe) calls this BEFORE applyMigrations. It writes a consistent, still-
// ENCRYPTED `VACUUM INTO` snapshot of the vault to <dataDir>/snapshots/.
//
// D-081 (2026-07-27): this used to return null unless MYCELIUM_SNAPSHOT_ON_BOOT was
// set, and only the DEV build set it — so the production app, the one users actually
// run, had no automatic local backup at all. When an operator's vault was lost there
// was no <dataDir>/snapshots/ to recover from. It is now ON by default and OFF only
// on an explicit MYCELIUM_SNAPSHOT_ON_BOOT=0/false/no/off.
//
// TWO TRIGGERS, deliberately (the old one was too narrow to have fired here):
//   · the migration SET changed — a build is about to alter the schema, the one
//     moment a bad migration can corrupt the vault. This is the DESTRUCTIVE case.
//   · no snapshot exists yet — a vault that has never been backed up gets a
//     baseline on the next launch. This is the BASELINE case.
// Normal relaunches with a baseline already present stay free (a stat, no copy).
//
// FAIL CLOSED, BUT ONLY WHERE IT PROTECTS SOMETHING: in the destructive case a
// snapshot failure THROWS — refusing to migrate an un-backed-up vault. In the
// baseline case (nothing is about to change) a failure is logged LOUDLY and boot
// continues: a full disk must not turn a healthy vault into an unbootable app,
// which would be a self-inflicted outage protecting nothing. Defaulting this on
// is what finally puts the refusal in front of a production vault.
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { atRestEnabled } from '../db/open.js';
import { isPlaintextSqlite } from './db-cipher-migrate.js';

const KEEP = Number(process.env.MYCELIUM_SNAPSHOT_KEEP) || 15;

/**
 * Synchronous, consistent single-file snapshot via `VACUUM INTO` — the sync twin of
 * backup.js::snapshotDb's keyed branch (kept sync so it slots into the synchronous
 * ensureVaultSchema boot path under the init lock). Keyed → still-encrypted snapshot;
 * null key → plaintext. VACUUM INTO uses a read txn, so it's safe even under writes.
 */
function snapshotSync(srcDbPath, destPath, dbKeyHex) {
  for (const sfx of ['', '-wal', '-shm']) { try { rmSync(destPath + sfx); } catch { /* */ } }
  // WRITE-CAPABLE, deliberately — and this was measured, not assumed. Opening read-only here
  // looks strictly safer (VACUUM INTO only reads) and it is what verify:vault-open-chokepoint
  // wants, but it BREAKS the concurrent-migration path: verify:at-rest-migration's
  // "N=4 racing migrations" case goes from 11-pass to a hard failure, because this snapshot
  // runs under the init lock against a vault other processes are actively migrating and a
  // read-only handle cannot get the consistent view it needs there. Reverted 2026-07-28 after
  // the full verify chain caught the regression. If this is ever reduced to read-only, that
  // gate is the one that must stay green.
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

/** The pre-migrate snapshots already on disk, oldest first (lexical = chronological). */
function existingSnapshots(dir) {
  try { return readdirSync(dir).filter((f) => f.startsWith('pre-migrate-') && f.endsWith('.db')).sort(); }
  catch { return []; }
}

/** Keep only the newest `keep` pre-migrate snapshots (lexical = chronological). */
function pruneSnapshots(dir, keep, log) {
  const snaps = existingSnapshots(dir);
  if (!snaps.length) return;
  while (snaps.length > keep) {
    const victim = snaps.shift();
    try { rmSync(path.join(dir, victim)); log?.(`[snapshot] pruned old ${victim}`); } catch { /* best-effort */ }
  }
}

/** OFF only on an explicit opt-out. Default ON — see D-081 in the header. */
function snapshotEnabled() {
  const v = String(process.env.MYCELIUM_SNAPSHOT_ON_BOOT ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

/** Is there room for a copy of the vault (plus 10% headroom)? null = can't tell. */
function hasRoomFor(dbFile, dir) {
  try {
    const need = statSync(dbFile).size * 1.1;
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize) >= need;
  } catch { return null; }
}

/**
 * Snapshot the vault before migrating. Default ON (D-081). Triggers when the
 * migration set changed (destructive → fail closed) or when no snapshot exists
 * yet (baseline → best-effort, never blocks a boot).
 *
 * @param {{ dbFile:string, dbKeyHex:string|null, migrationsDir?:string, log?:Function }} o
 * @returns {string|null} the snapshot path written, or null if skipped.
 */
export function maybeSnapshotBeforeMigrate({ dbFile, dbKeyHex, migrationsDir = 'migrations', log } = {}) {
  if (!snapshotEnabled()) return null;
  if (!dbFile || !existsSync(dbFile)) return null;       // fresh vault — nothing to back up
  const fp = migrationsFingerprint(migrationsDir);
  if (!fp) return null;                                   // no migrations dir — nothing to gate on

  const snapDir = path.join(path.dirname(dbFile), 'snapshots');
  const fpFile = path.join(snapDir, '.last-migrations-fp');
  let last = '';
  try { last = readFileSync(fpFile, 'utf8').trim(); } catch { /* none yet */ }
  // A schema change is about to be applied → this snapshot is the safety net and
  // its failure must stop the migration. Otherwise we are only taking a baseline.
  const migrating = fp !== last;
  const haveBaseline = existingSnapshots(snapDir).length > 0;
  if (!migrating && haveBaseline) return null;            // nothing pending, already covered

  // NEVER write a PLAINTEXT replica of a vault that is about to become encrypted
  // (CLAUDE.md §1/§7). ensureVaultSchema opens an existing plaintext vault UNKEYED,
  // so dbKeyHex is null here — a snapshot would be a full plaintext copy of the
  // user's vault, retained in snapshots/ long after the live file is ciphertext.
  // Defaulting this on made that every upgrader's disk, so it is gated, not risked.
  // Nothing is lost by skipping: the at-rest migration keeps its own pre-cipher
  // backup and only purges it after the encrypted vault verifies.
  if (!dbKeyHex && atRestEnabled() && isPlaintextSqlite(dbFile)) {
    log?.('[snapshot] skipped: the vault is plaintext and at-rest is about to encrypt it — a snapshot here would be a plaintext copy (the migration keeps its own pre-cipher backup)');
    return null;
  }

  // Everything below can hit ENOSPC / EPERM / a read-only data dir. In the
  // BASELINE case that must not block a boot that protects nothing — which the
  // header promises and the first draft broke, because mkdirSync and the
  // fingerprint write sat outside the try.
  let dest = null;
  try {
    mkdirSync(snapDir, { recursive: true });
    // Check for room BEFORE writing: a half-written multi-GB snapshot that then
    // throws is strictly worse than a clean, loud skip.
    if (hasRoomFor(dbFile, snapDir) === false) {
      const msg = '[snapshot] NOT ENOUGH DISK SPACE to snapshot the vault before boot — your vault has NO local backup right now. Free some space and relaunch.';
      if (migrating) throw new Error(`${msg} Refusing to migrate an un-backed-up vault.`);
      log?.(msg);
      return null;
    }
    // UNIQUE PER PROCESS. An ISO timestamp alone collides: two processes booting in the same
    // millisecond pick the SAME destination, and the second one VACUUMs INTO a file the first
    // is already writing — "output file already exists", or a half-written dest that then
    // reports "table <x> already exists" depending on the interleaving. Because this runs
    // under the init lock only for the process that WINS it, the losers still reach here
    // during a concurrent boot; the app spawns two vault-opening siblings by design
    // (main.rs:146), so this is reachable in production, not just in the gate.
    // It was the cause of verify:at-rest-migration's flaky "N=4 racing migrations" case,
    // which failed ~4 runs in 5 at baseline and cost an hour of misattributed blame.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dest = path.join(snapDir, `pre-migrate-${stamp}-${process.pid}-${randomBytes(3).toString('hex')}.db`);
    snapshotSync(dbFile, dest, dbKeyHex);                 // keyed → still-encrypted; null → plaintext
    // Only record the fingerprint AFTER a successful snapshot, so a failed one
    // doesn't poison the gate and skip the next attempt.
    writeFileSync(fpFile, fp);
  } catch (e) {
    if (dest) for (const sfx of ['', '-wal', '-shm']) { try { rmSync(dest + sfx, { force: true }); } catch { /* */ } }
    if (migrating) {
      throw new Error(
        `[snapshot] pre-migration snapshot FAILED (${e?.message || e}). Refusing to migrate an `
        + 'un-backed-up vault. Set MYCELIUM_SNAPSHOT_ON_BOOT=0 to bypass (not recommended).',
      );
    }
    // Baseline only, nothing destructive pending: say so loudly, never block boot.
    log?.(`[snapshot] baseline snapshot FAILED (${e?.message || e}) — the vault has no local backup. Boot continues; no schema change is pending.`);
    return null;
  }
  pruneSnapshots(snapDir, KEEP, log);
  log?.(`[snapshot] pre-boot snapshot → ${dest}`);
  return dest;
}

export default maybeSnapshotBeforeMigrate;
