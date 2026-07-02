// src/db/init.js — the SINGLE, cross-process-serialized vault storage init.
//
// Why this exists: the Tauri app spawns several node processes (server-rest.js,
// index.js --http, the stdio MCP server, clustering/enrich children) that ALL
// call boot(). On first launch with at-rest on, more than one raced on the
// encrypt-in-place migration and corrupted the vault. And the old schema step
// (`ensureVaultSchema`) opened the vault UNKEYED before the keyed open, which
// throws "file is not a database" on any encrypted vault and breaks new-user
// "born encrypted" (the SQLCipher `key` pragma can't encrypt an existing
// plaintext file — only `rekey` can; spike-verified).
//
// initVaultStorage() fixes both: it holds a cross-process file lock around the
// WHOLE critical section (schema + migrate), so exactly ONE process initializes
// the vault while the others block then no-op; and ensureVaultSchema is now
// key-aware. @see docs/AT-REST-MIGRATION-HARDENING-DESIGN-2026-06-18.md.
import { openSync, closeSync, writeSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from './migrate.js';
import { resolveDbKeyHex, atRestEnabled, vaultIsEncrypted } from './open.js';
import { deriveDbKey } from '../account/keystore.js';
import { ensureVaultEncrypted, isPlaintextSqlite } from '../account/db-cipher-migrate.js';
import { maybeSnapshotBeforeMigrate } from '../account/snapshot-on-boot.js';
import { ensureSidecarHealthy, dropLegacyVaultIndex } from '../search/sqlite/sidecar.js';

// Cross-process init lock. A LIVE holder is NEVER stolen — even a multi-minute
// migration of a multi-GB vault — because stealing a mid-migration holder lets a
// second process migrate the SAME file, which is precisely the concurrent-writer
// corruption this lock exists to prevent (the recurring malformed-on-VACUUM
// b-tree damage). We reclaim a lock only when its holder is PROVABLY gone: the
// pid is dead, or the pid number was recycled by a different process (detected
// via the process start time recorded alongside the pid).
//
// History: the lock previously also stole on `age > LOCK_STALE_MS` regardless of
// liveness — so a legitimate >10-minute migration got its lock stolen and a
// second process migrated concurrently → corruption. That age-based steal is
// removed; liveness (pid + start time) is the sole authority.
const LOCK_WAIT_MAX_MS = 15 * 60 * 1000;
const LOCK_START_TOLERANCE_MS = 5000; // clock-resolution slack when matching a pid's start time
// This process's start time (epoch ms), recorded in the lock so a waiter can
// tell "same holder still alive" from "pid reused after the holder died".
const SELF_START_MS = Math.round(Date.now() - process.uptime() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } // signal 0 = liveness probe
  catch (e) { return e.code === 'EPERM'; }    // alive but not ours
}

// Start time (epoch ms) of a running pid via `ps` (macOS + Linux). null if the
// process isn't running / can't be read. Used to detect pid reuse.
function procStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Is the lock's recorded holder STILL the same live process? Dead pid → no.
// Live pid whose start time differs from the recorded one → the number was
// reused by an unrelated process (the real holder is gone) → no, safe to steal.
// Live pid with a matching start time → yes; NEVER steal it. A lock from an older
// build (pid only, no recorded start) falls back to bare pid-liveness.
function holderStillLive(pid, recordedStartMs) {
  if (!pidAlive(pid)) return false;
  if (recordedStartMs == null) return true;
  const nowStart = procStartMs(pid);
  if (nowStart == null) return false;
  return Math.abs(nowStart - recordedStartMs) <= LOCK_START_TOLERANCE_MS;
}

/** Acquire an exclusive cross-process lock via O_EXCL create. Blocks (async-poll)
 *  until acquired; reclaims a lock ONLY when its holder is provably gone (dead pid
 *  or reused pid). A live holder is never stolen. */
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MAX_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // wx = O_CREAT | O_EXCL — atomic create
      // Record pid + start time so a waiter can distinguish a still-running
      // holder from a reused pid.
      try { writeSync(fd, `${process.pid} ${SELF_START_MS}`); } finally { closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Held. Reclaim ONLY a lock whose holder is provably gone — never a live
      // holder, which may be legitimately mid-migration (see the const comment).
      let steal = false;
      try {
        const [pidStr, startStr] = String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/);
        const pid = parseInt(pidStr, 10);
        const recordedStartMs = startStr != null && /^\d+$/.test(startStr) ? parseInt(startStr, 10) : null;
        steal = !holderStillLive(pid, recordedStartMs);
      } catch {
        steal = true; // unreadable/garbage lock → abandoned, take it
      }
      if (steal) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) {
        throw new Error('vault-init: timed out waiting for the init lock — another instance is still initializing this vault. Quit any second copy of the app (dev + production share one vault) and retry.');
      }
      await sleep(500);
    }
  }
}

function releaseLock(lockPath) { try { unlinkSync(lockPath); } catch { /* already gone */ } }

/**
 * Apply the schema (idempotent migrations) to the vault, KEY-AWARE:
 *   - vault already encrypted        → keyed open (apply schema to the cipher db)
 *   - fresh file AND at-rest enabled  → keyed open of an empty file → BORN ENCRYPTED,
 *                                       then applyMigrations writes encrypted schema
 *   - existing plaintext / at-rest off → plaintext open (the migration rekeys it after)
 * The `key` pragma CANNOT encrypt an existing plaintext file (spike: "file is not a
 * database"); only the fresh-empty + rekey paths produce ciphertext — hence the split.
 */
export function ensureVaultSchema(dbFile, userHex) {
  mkdirSync(dirname(dbFile), { recursive: true });
  const fresh = !existsSync(dbFile);
  const keyed = vaultIsEncrypted(dbFile) || (atRestEnabled() && fresh);
  let dbKeyHex = null;
  if (keyed) {
    if (!/^[0-9a-f]{64}$/i.test(userHex || '')) throw new Error('ensureVaultSchema: a 64-char USER_MASTER hex is required to open the keyed vault');
    dbKeyHex = deriveDbKey(userHex);
  }
  // Opt-in, fail-closed pre-migration snapshot (dev app → real vault). No-op in
  // production (flag unset). Runs here — before any handle opens — so the snapshot
  // takes a clean read with no concurrent connection, and under the init lock.
  maybeSnapshotBeforeMigrate({ dbFile, dbKeyHex, log: (m) => console.error(m) });
  const db = new Database(dbFile);
  try {
    if (dbKeyHex) {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
      db.pragma('temp_store = MEMORY');
    }
    applyMigrations(db);
  } finally {
    db.close();
  }
}

/**
 * Initialize the vault storage ONCE, serialized across processes:
 *   schema (key-aware) → migrate an existing plaintext vault if at-rest is opted in.
 * Returns the dbKeyHex the caller passes to getDb (null = plaintext open).
 *
 * @param {{ dbPath: string, userHex: string, log?: (m:string)=>void }} p
 */
export async function initVaultStorage({ dbPath, userHex, log = (m) => console.error(m) }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const lockPath = join(dirname(dbPath), '.vault-init.lock');
  await acquireLock(lockPath);
  try {
    // 1. Schema (key-aware: born-encrypted for a fresh at-rest vault; keyed for an
    //    already-encrypted one; plaintext otherwise).
    ensureVaultSchema(dbPath, userHex);

    // 2. Migrate an EXISTING plaintext vault to whole-file cipher — ONLY when at-rest
    //    is explicitly opted in. Idempotent (no-op once encrypted / on a born-encrypted
    //    fresh vault). FAIL CLOSED: a migration error refuses a plaintext fallback.
    if (atRestEnabled() && isPlaintextSqlite(dbPath)) {
      const dbKeyHex = resolveDbKeyHex(userHex, dbPath);
      const r = ensureVaultEncrypted({ dbPath, dbKeyHex, log });
      if (r.migrated) log(`[mycelium] at-rest: encrypted ${r.tables} tables; plaintext backup kept at ${r.preCipherPath}`);
    }

    // Guard (Stage 0, SQLCipher-mandatory): if at-rest is opted in but the vault is
    // STILL plaintext after the migration attempt, the encryption silently did not
    // happen. Fail closed rather than serve the real vault unencrypted — this is the
    // tripwire that makes "encrypted at rest" non-negotiable once at-rest is on.
    // Scoped to atRestEnabled() so plaintext test fixtures (flag off) are unaffected.
    if (atRestEnabled() && existsSync(dbPath) && isPlaintextSqlite(dbPath)) {
      throw new Error('at-rest is enabled but the vault is still plaintext after init — refusing to open it unencrypted');
    }

    // 3. The key getDb opens with: set iff the vault is now encrypted (self-detected)
    //    or at-rest is opted in. Null → plaintext open, unchanged.
    const outKey = resolveDbKeyHex(userHex, dbPath);

    // 4. Search-index sidecar (docs/SEARCH-SIDECAR-DESIGN-2026-07-02.md). Under THIS
    //    cross-process lock (race-safe across the MCP + REST processes): detect + reset
    //    a corrupt regenerable index (mycelium.search.db) ONCE, before any process opens
    //    it — and DROP the stale in-vault index tables left by pre-sidecar builds. Both
    //    best-effort + gated on the sqlite backend, so plaintext test fixtures (flag
    //    unset) are untouched and never spawn a search.db.
    if ((process.env.MYCELIUM_SEARCH_BACKEND ?? '').toLowerCase() === 'sqlite' && dbPath !== ':memory:') {
      const r = ensureSidecarHealthy({ dbPath, dbKeyHex: outKey });
      if (r.wasReset) log('[mycelium] search sidecar was corrupt → reset (rebuilds from content on next warm)');
      if (r.error) log(`[mycelium] search sidecar health check skipped (${r.error})`);
      dropLegacyVaultIndex({ dbPath, dbKeyHex: outKey });
    }

    return outKey;
  } finally {
    releaseLock(lockPath);
  }
}
