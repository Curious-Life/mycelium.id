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
import { openSync, closeSync, writeSync, existsSync, readFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from './migrate.js';
import { resolveDbKeyHex, atRestEnabled, vaultIsEncrypted } from './open.js';
import { deriveDbKey } from '../account/keystore.js';
import { ensureVaultEncrypted, isPlaintextSqlite } from '../account/db-cipher-migrate.js';
import { maybeSnapshotBeforeMigrate } from '../account/snapshot-on-boot.js';

// A migration of a multi-GB vault can take minutes; only steal a lock older than
// this AND whose holder process is dead.
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MAX_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } // signal 0 = liveness probe
  catch (e) { return e.code === 'EPERM'; }    // alive but not ours
}

/** Acquire an exclusive cross-process lock via O_EXCL create. Blocks (async-poll)
 *  until acquired; steals a lock whose holder is dead or that is stale. */
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MAX_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // wx = O_CREAT | O_EXCL — atomic create
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Held. Steal only if the holder is provably gone (dead pid) or clearly stale.
      let steal = false;
      try {
        const st = statSync(lockPath);
        const pid = parseInt(String(readFileSync(lockPath, 'utf8')).trim(), 10);
        const alive = pidAlive(pid);
        const ageMs = Date.now() - st.mtimeMs;
        steal = !alive || (ageMs > LOCK_STALE_MS);
      } catch {
        steal = true; // unreadable/vanished lock → take it
      }
      if (steal) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) throw new Error('vault-init: timed out waiting for the init lock');
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
    return resolveDbKeyHex(userHex, dbPath);
  } finally {
    releaseLock(lockPath);
  }
}
