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
// key-aware. @see the at-rest migration-hardening design.
import { openSync, closeSync, writeSync, existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, linkSync, statSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, migrationsWouldWrite } from './migrate.js';
import { resolveDbKeyHex, atRestEnabled, vaultIsEncrypted } from './open.js';
import { deriveDbKey } from '../account/keystore.js';
import { ensureVaultEncrypted, isPlaintextSqlite } from '../account/db-cipher-migrate.js';
import { maybeSnapshotBeforeMigrate, maybeSnapshotBeforeMigrateOffloop } from '../account/snapshot-on-boot.js';
import { guardAgainstForeignWal, recordVaultBinding } from './wal-guard.js';
import { vaultLooksStructurallySane, verifyVaultIntegritySync } from './vault-halt.js';
import { writeVaultCorruptMarker } from './integrity.js';
import { recordDurabilityEvent } from './durability-log.js';
import { ensureSidecarHealthy, dropLegacyVaultIndex } from '../search/sqlite/sidecar.js';
import { migrateMindRootIfLegacy } from '../mindfiles/migrate-root.js';

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
// How long an UNPARSEABLE lock is presumed to belong to a holder that is still
// writing it, rather than to a crash. See publishLock() for why that state exists
// at all and why it must fail closed.
const LOCK_GRACE_MS = 10_000;
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

/** Is the lock file older than `ms`? false when it cannot be read — never steal on a guess. */
function lockOlderThan(lockPath, ms) {
  try { return Date.now() - statSync(lockPath).mtimeMs > ms; }
  catch { return false; }
}

/**
 * Publish a FULLY-FORMED lock file, or throw EEXIST if one is already held.
 *
 * O_EXCL alone is not enough. `openSync(lockPath,'wx')` makes the NAME visible
 * before `writeSync` puts the pid inside it, so a waiter reading in that window
 * sees `""` → unparseable → "abandoned" → and steals a lock whose holder is
 * about to enter the critical section. Both processes then run applyMigrations
 * and ensureVaultEncrypted against the same vault, sharing one `.cipher-tmp`.
 *
 * MEASURED, not theoretical: 3 of 10 four-way racing-migration rounds failed
 * with `duplicate column name: pac_theta_delta`, `disk I/O error` inside the
 * rekey, and `row-count parity failed … encrypted undefined` — and the stolen
 * lock's raw content logged as `""`. The app spawns two vault-opening siblings
 * by design (src-tauri/src/main.rs:146), so this is reachable in production.
 *
 * link() publishes the name only once the content is already on disk, so the
 * empty window cannot be observed at all. Filesystems that refuse hard links
 * fall back to O_EXCL, where the LOCK_GRACE_MS window in acquireLock covers it.
 */
function publishLock(lockPath) {
  const payload = `${process.pid} ${SELF_START_MS}`;
  const openExcl = () => {
    const fd = openSync(lockPath, 'wx'); // wx = O_CREAT | O_EXCL — atomic create
    try { writeSync(fd, payload); } finally { closeSync(fd); }
  };
  let staged = null;
  try {
    staged = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(staged, payload, { flag: 'wx' });
  } catch {
    staged = null;    // cannot stage (read-only dir, exotic fs) → O_EXCL path
  }
  if (!staged) { openExcl(); return; }
  try {
    linkSync(staged, lockPath); // atomic publish of an already-complete file
  } catch (e) {
    if (e.code === 'EEXIST') throw e;          // held — the caller's wait path
    openExcl();                                // link unsupported here
  } finally {
    try { unlinkSync(staged); } catch { /* best effort */ }
  }
}

/** Acquire an exclusive cross-process lock. Blocks (async-poll) until acquired;
 *  reclaims a lock ONLY when its holder is provably gone (dead pid or reused pid).
 *  A live holder is never stolen, and neither is one that is still being written. */
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MAX_MS;
  for (;;) {
    try {
      publishLock(lockPath);
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
        if (!Number.isInteger(pid) || pid <= 0) {
          // Empty or garbage. Two very different causes, and guessing wrong
          // costs a corrupted vault: a holder mid-create on the O_EXCL fallback
          // (publishLock's window — FAIL CLOSED, wait), or a crash between
          // create and write (genuinely abandoned). Only the second is OLD.
          steal = lockOlderThan(lockPath, LOCK_GRACE_MS);
        } else {
          steal = !holderStillLive(pid, recordedStartMs);
        }
      } catch (e) {
        if (e.code === 'ENOENT') continue;  // released under us → race to take it
        steal = false;                      // unreadable for any other reason → wait, never guess
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
/**
 * D-117 — THE FIRST-ENCOUNTER GATE.
 *
 * Every fail-stop path built on 2026-07-28 requires a `.vault-corrupt` marker to ALREADY
 * exist, and that marker is only written when THIS box observes damage at runtime. A vault
 * damaged while the app was closed — a disk error, an interrupted copy, a restore, a sync
 * client, or damage predating the release — arrives at boot with no marker at all.
 * markerKind() correctly answers `none`, the decision table correctly says BOOT, and boot
 * then rewrote the header from plaintext to cipher and wrote 2.74 MB into the damaged file,
 * leaving no marker and no snapshot. Measured, and byte-identical against a detached `main`
 * worktree, so this is pre-existing rather than a regression.
 *
 * The gate is TIERED because the honest check is not free:
 *
 *   Tier 1 — EVERY boot, O(1). Page count + a header parse. Catches truncation and a
 *            shredded page 1, the two shapes that actually turn up.
 *   Tier 2 — ONLY when the at-rest migration is about to REWRITE the file, i.e. once per
 *            vault in its whole lifetime. Full `quick_check`.
 *
 * THE TWO TIERS TREAT "COULD NOT TELL" DIFFERENTLY, ON PURPOSE. Tier 1 continues: it runs
 * on every boot, a sibling process legitimately holds the vault open (the app spawns two by
 * design), and refusing a boot because a read was momentarily unavailable would be a new
 * permanent-brick vector — this repo has shipped three. Tier 2 refuses: we are one statement
 * away from rewriting the file in place, and "we could not look" has never been a licence to
 * write. The asymmetry is the point, not an oversight.
 *
 * ⚠️ What this does NOT do, and why. The ledger's fix direction also said "do not skip the
 * pre-migration snapshot merely because at-rest is on". Reading the migration proves that
 * unnecessary and actively harmful: ensureVaultEncrypted is non-destructive until its atomic
 * swap, and that swap PRESERVES the original by rename as `<db>.pre-cipher-<ts>`, which
 * purgePlaintextBackup removes only after re-opening the keyed vault and reading from it
 * (db-cipher-migrate.js:120-127, index.js:246). The original is therefore already backed up
 * by the migration itself. Un-skipping the snapshot would instead write a full PLAINTEXT
 * copy of the vault into snapshots/ and leave it there long after the live file is
 * ciphertext — a CLAUDE.md §1 leak, which is precisely why the skip exists
 * (snapshot-on-boot.js:133-142). The real 2.74 MB write is applyMigrations inside
 * ensureVaultSchema, BEFORE any of that, which is why this gate runs where it does.
 *
 * @param {{ dbPath: string, userHex: string, log?: (m:string)=>void }} p
 * @returns {{ tier1: string, tier2: string|null }} what actually ran (for the gate to assert)
 */
export function assertVaultSafeToRewrite({ dbPath, userHex, log = () => {} }) {
  // Set when the escape hatch swallows a refusal, so the caller stops instead of falling
  // through to the NEXT refuse() and printing two contradictory verdicts for one vault.
  let bypassed = false;
  const refuse = (why, detail) => {
    // THE ESCAPE HATCH MUST ACTUALLY OPEN. The message below names
    // MYCELIUM_IGNORE_VAULT_HALT=1, and for one revision this function never read it — so
    // the only documented way out of a condemnation did nothing, which an adversarial
    // review demonstrated by setting it and getting the identical refusal. A refusal whose
    // stated remedy is fiction is not a guard, it is a brick with instructions.
    if (process.env.MYCELIUM_IGNORE_VAULT_HALT === '1') {
      log(`[mycelium] vault first-encounter check FAILED (${why}) — continuing anyway because MYCELIUM_IGNORE_VAULT_HALT=1. This is recovery tooling's override; writes may damage the file further.`);
      // LEAVE A DURABLE TRACE, exactly as the sibling hatch does (vault-halt.js:70-78):
      // "so a durability log never shows a quiet vault where the hatch was simply left set
      // in someone's shell." A bypass that is only ever a log line is invisible in the
      // forensics that matter afterwards (CLAUDE.md §8).
      try { recordDurabilityEvent('vault-first-encounter-bypassed', { detail, why }); } catch { /* never take the plane down */ }
      bypassed = true;
      return;
    }
    // Condemn durably, so the NEXT boot refuses through the marker gate — the path with
    // the real UI — instead of re-deriving this from scratch.
    writeVaultCorruptMarker(dbPath, { detail, source: 'first-encounter' });
    const err = new Error(
      `REFUSING to open the vault: ${why}. Nothing has been written to it. `
      + `A snapshot may be restorable from the snapshots/ directory beside it. `
      + `Set MYCELIUM_IGNORE_VAULT_HALT=1 only for recovery tooling that knowingly owns the box.`,
    );
    err.code = 'vault_corrupt';
    err.firstEncounter = true;
    throw err;
  };

  if (!existsSync(dbPath)) return { tier1: 'skipped-fresh', tier2: null };
  // Mirrors the marker gate at index.js: a key ONLY for a vault that is already
  // ciphertext, or a still-plaintext vault answers NOTADB and reads as damaged.
  const keyForCheck = vaultIsEncrypted(dbPath) ? resolveDbKeyHex(userHex, dbPath) : null;

  const shallow = vaultLooksStructurallySane(dbPath, keyForCheck);
  if (shallow.sane === false) {
    // AN EMPTY FILE IS NOT AUTOMATICALLY DAMAGE, and treating it as such was a brick of my
    // own making — found by adversarial review. ensureVaultSchema CREATES the file and only
    // then applies migrations, so a crash, a force-quit or an ENOSPC in that window leaves a
    // brand-new user with a 0-byte mycelium.db. On `main` that re-initialises cleanly; the
    // first draft condemned it permanently and told the owner to restore a snapshot that
    // cannot exist, for a vault that never held a byte. Three of this repo's shipped bricks
    // are this exact shape: a guard refusing a state that was never a problem.
    //
    // So an empty vault is condemned only on EVIDENCE it once held data. Each signal below
    // is a thing only a used vault leaves behind, and any of them means the emptiness is a
    // truncation — the case the `empty` verdict was written for (an interrupted install-vault
    // copy, ENOSPC, a failed restore), where re-creating the schema would destroy the -wal
    // remnants a repair tool would use.
    if (shallow.reason.includes('0 pages')) {
      const priors = evidenceVaultHadData(dbPath);
      if (!priors.length) {
        log('[mycelium] the vault file is empty and nothing indicates it ever held data (no -wal, no snapshots, no migration history) — treating it as a fresh vault');
        return { tier1: 'empty-but-fresh', tier2: null };
      }
      refuse(`the vault file is empty but it previously held data (${priors.join(', ')}) — this is a truncation, not a fresh start`, priors.join(', '));
      if (bypassed) return { tier1: 'bypassed', tier2: null };
    } else {
      refuse(`the vault file is structurally damaged (${shallow.reason})`, shallow.reason);
      if (bypassed) return { tier1: 'bypassed', tier2: null };
    }
  }
  if (shallow.sane === null) log(`[mycelium] vault sanity check inconclusive (${shallow.reason}) — continuing; the boot integrity check still applies`);

  // Tier 2 — scoped to THE MOMENT SOMETHING IS ABOUT TO BE WRITTEN, not to a file format.
  //
  // ⚠️ THIS SCOPING IS THE SECOND ATTEMPT, AND THE FIRST ONE SHIPPED THE DEFECT IT CLAIMED
  // TO FIX. That draft ran tier 2 only for PLAINTEXT vaults, on my reasoning that an
  // already-encrypted vault was covered by the runtime halt latch. An adversarial review
  // refuted it by running it: an encrypted chimera passed tier 1, passed the absent tier 2,
  // and boot wrote 2,273,280 bytes into it — D-117's own number — with no `vault_corrupt`
  // code and no marker, so the portal then routed the owner to the recovery-key screen. The
  // latch lives in adapter/d1.js; ensureVaultSchema's applyMigrations runs on a RAW handle
  // before the adapter exists, so for that window there is no latch at all, in either format.
  //
  // The right axis is migrationsWouldWrite(): a read-only ledger + sqlite_master check that
  // asks the actual question. It is cheap (no page walk), so the expensive quick_check is
  // gated on a real signal instead of on a guess about which vaults matter — and a settled
  // vault on an unchanged build pays nothing.
  const willWrite = migrationsWouldWrite2(dbPath, keyForCheck);
  if (isPlaintextSqlite(dbPath) || willWrite) {
    // A plaintext vault must be verified UNKEYED even when the app is at-rest ON.
    const verdict = verifyVaultIntegritySync(dbPath, isPlaintextSqlite(dbPath) ? null : keyForCheck);
    if (!verdict.ok && !verdict.absent) {
      refuse(
        verdict.verified
          ? `the vault failed an integrity check before its schema would be rewritten (${verdict.reason})`
          : `the vault could not be verified before its schema would be rewritten (${verdict.reason}) — refusing to write to a file we cannot read`,
        verdict.reason,
      );
      // THE MOST SEVERE SITE WAS THE ONE THE BYPASS FLAG DID NOT COVER. Without this, a
      // full quick_check FAILURE under MYCELIUM_IGNORE_VAULT_HALT=1 fell through and
      // returned `tier2: 'ok'` — byte-identical to the shape a healthy, verified vault
      // returns. The flag was applied at two of three refuse() sites and missed the worst.
      // Nothing reads the return today, but the JSDoc promises "what actually ran (for the
      // gate to assert)", so the contract was poisoned for its first real consumer — which
      // is this repo's named recurring defect, inside the commit that added the flag.
      if (bypassed) return { tier1: shallow.sane === true ? 'ok' : 'inconclusive', tier2: 'bypassed' };
    }
    return { tier1: shallow.sane === true ? 'ok' : 'inconclusive', tier2: 'ok' };
  }
  return { tier1: shallow.sane === true ? 'ok' : 'inconclusive', tier2: 'skipped-no-write-pending' };
}

/**
 * Traces that this vault once held data. Each is something only a USED vault leaves behind,
 * so their absence beside a 0-byte file means "never written", not "wiped".
 * @returns {string[]} the signals found (empty ⇒ no evidence)
 */
function evidenceVaultHadData(dbPath) {
  const dir = dirname(dbPath);
  const found = [];
  // A -wal beside a 0-byte main file is the loudest signal there is: it holds committed
  // pages that a repair tool can still recover, and it is the exact case the `empty`
  // verdict was written for after 3,000 uncheckpointed rows were measured in one.
  // -wal ONLY. A -shm is derived index state, recreated on every open, and holds ZERO
  // recoverable pages — so a 0-byte vault with a fat -shm and an EMPTY -wal has nothing to
  // preserve, and condemning it contradicts this function's own principle. Counting it was
  // measured to permanently condemn exactly that shape.
  try { if (statSync(`${dbPath}-wal`).size > 0) found.push('a non-empty -wal file'); } catch { /* absent */ }
  try { if (statSync(join(dir, 'snapshots', '.last-migrations-fp')).size >= 0) found.push('a migration fingerprint'); } catch { /* */ }
  try {
    const snaps = readdirSync(join(dir, 'snapshots')).filter((f) => f.endsWith('.db'));
    if (snaps.length) found.push(`${snaps.length} snapshot(s)`);
  } catch { /* no snapshots dir */ }
  // NOT `.vault-binding.json`. The foreign-WAL guard writes it on the way past — and now
  // runs BEFORE this check, since it has to (see initVaultStorage step 0b) — so it is
  // evidence that BOOT happened, not that DATA existed. Counting it condemned the
  // interrupted-first-launch vault this function exists to protect, which is how the
  // ordering fix and the evidence list turned out to be coupled.
  return found;
}

/** migrationsWouldWrite() against a READ-ONLY handle on the real vault. Fails toward checking. */
function migrationsWouldWrite2(dbPath, dbKeyHex) {
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (dbKeyHex) {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
    }
    db.pragma('query_only = true');
    try { db.pragma('busy_timeout = 10000'); } catch { /* */ }
    return migrationsWouldWrite(db);
  } catch {
    return true;   // could not tell ⇒ check
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

export function ensureVaultSchema(dbFile, userHex) {
  mkdirSync(dirname(dbFile), { recursive: true });
  // FOREIGN-WAL GUARD — must run BEFORE anything opens this file, including the
  // pre-migrate snapshot below (its VACUUM INTO open would replay the WAL). If the vault
  // file was replaced (repair/restore/swap) while a stale -wal from the previous file
  // generation remained, SQLite would silently splice old-generation pages into the new
  // file on first open — the demonstrated mechanism behind the 2026-07 corruption series.
  // We are under the cross-process init lock here, so the check-and-quarantine is atomic
  // with respect to the sibling process.
  guardAgainstForeignWal(dbFile, {
    log: (m) => console.error(m),
    onEvent: (e) => recordDurabilityEvent(e.kind, e),
  });
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
export async function initVaultStorage({ dbPath, userHex, log = (m) => console.error(m), onPhase = null }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const lockPath = join(dirname(dbPath), '.vault-init.lock');
  await acquireLock(lockPath);
  try {
    // 0. Durable mind-root relocation (the mind-root durability-migration design).
    //    Move any pre-existing legacy mind tree (<cwd>/data/mind/mind, historically
    //    INSIDE the update-replaceable app bundle) to the durable <dataDir>/mind.
    //    Byte-only (no key needed); runs here because this is the one exclusive
    //    cross-process point that precedes every writer's first mind touch. Best-
    //    effort: a failure leaves the legacy tree intact and boot proceeds.
    try {
      migrateMindRootIfLegacy({ log }); // logs its own richer summary (moved + skipped)
    } catch (e) {
      log(`[mycelium] mind: relocation skipped (${e && (e.code || e.name) || 'error'})`);
    }

    // 0b. FOREIGN-WAL GUARD FIRST — BEFORE ANY INTEGRITY OPINION IS FORMED.
    //
    // ⚠️ ORDER IS THE WHOLE POINT, AND GETTING IT WRONG BRICKED A HEALTHY VAULT.
    // A vault swapped in by a restore, a rebuild or install-vault.mjs can arrive beside a
    // stale -wal from the PREVIOUS file generation — this repo's own documented #1
    // corruption vector (wal-guard.js:4-14). SQLite then reads the good file THROUGH that
    // foreign WAL and answers SQLITE_NOTADB. The D-117 gate below cannot open it, cannot
    // verify it, and — because "could not verify" must refuse before a rewrite — CONDEMNS
    // IT, durably. An adversarial review reproduced that 3/3 on a provably healthy vault
    // (671 pages, 159 tables, quick_check ok) which `main` boots cleanly, and every
    // subsequent boot then refused with "the condemnation could not be re-checked", because
    // the -wal was never quarantined so it never could be. A permanent brick, on the exact
    // recovery path the refusal message tells the user to take.
    //
    // The guard was already there — inside ensureVaultSchema, one step too late. Hoisting it
    // costs nothing (it is a stat plus a 16-byte read, and idempotent: after quarantine the
    // second call inside ensureVaultSchema sees nothing to do).
    guardAgainstForeignWal(dbPath, {
      log: (m) => console.error(m),
      onEvent: (e) => recordDurabilityEvent(e.kind, e),
    });

    // 0c. D-117 — REFUSE BEFORE WE REWRITE. This must precede ensureVaultSchema, because
    //     the 2.74 MB written into a damaged vault is applyMigrations inside it, and that
    //     runs before the at-rest migration's own backup exists. Under the init lock, so
    //     the check and the decision are atomic with respect to the sibling process.
    assertVaultSafeToRewrite({ dbPath, userHex, log });

    // 0d. D-130 — the pre-migration snapshot, OFF the event loop. The copy runs
    //     in an awaited child (src/db/vault-copy.js) while we hold the init lock,
    //     so /account/status can answer during a multi-minute copy of a large
    //     vault (the operator's 788 MB restore pegged a core 15+ min here when
    //     the copy was synchronous). Key derivation mirrors ensureVaultSchema
    //     exactly; on success the fingerprint is recorded, so ensureVaultSchema's
    //     internal sync snapshot call NO-OPS (and stays as the unchanged path for
    //     its direct callers, e.g. the at-rest gates). Fail-closed split
    //     unchanged: a failed copy with a migration pending refuses the boot.
    onPhase?.('snapshot');
    {
      const snapKeyed = vaultIsEncrypted(dbPath) || (atRestEnabled() && !existsSync(dbPath));
      await maybeSnapshotBeforeMigrateOffloop({
        dbFile: dbPath,
        dbKeyHex: snapKeyed ? deriveDbKey(userHex) : null,
        log,
      });
    }

    // 1. Schema (key-aware: born-encrypted for a fresh at-rest vault; keyed for an
    //    already-encrypted one; plaintext otherwise).
    onPhase?.('migrating');
    ensureVaultSchema(dbPath, userHex);

    // 2. Migrate an EXISTING plaintext vault to whole-file cipher — ONLY when at-rest
    //    is explicitly opted in. Idempotent (no-op once encrypted / on a born-encrypted
    //    fresh vault). FAIL CLOSED: a migration error refuses a plaintext fallback.
    if (atRestEnabled() && isPlaintextSqlite(dbPath)) {
      const dbKeyHex = resolveDbKeyHex(userHex, dbPath);
      const r = ensureVaultEncrypted({ dbPath, dbKeyHex, log });
      if (r.migrated) log(`[mycelium] at-rest: encrypted ${r.tables} tables; plaintext backup kept at ${r.preCipherPath}`);
      // The migration just SWAPPED the file (new inode, new cipher salt). Re-record the
      // wal-guard binding NOW, or the app's own next crash-WAL — written on the new
      // file — would read as foreign at the following boot and be quarantined: a
      // PoC-proven false positive from the independent review (committed-data loss).
      if (r.migrated) recordVaultBinding(dbPath);
    }

    // Guard (Stage 0, SQLCipher-mandatory): if at-rest is opted in but the vault is
    // STILL plaintext after the migration attempt, the encryption silently did not
    // happen. Fail closed rather than serve the real vault unencrypted — this is the
    // tripwire that makes "encrypted at rest" non-negotiable once at-rest is on.
    // Scoped to atRestEnabled() so plaintext test fixtures (flag off) are unaffected.
    if (atRestEnabled() && existsSync(dbPath) && isPlaintextSqlite(dbPath)) {
      throw new Error('at-rest is enabled but the vault is still plaintext after init — refusing to open it unencrypted');
    }

    // 2b. RECORD THE BINDING ON EVERY SUCCESSFUL INIT, not only after a migration.
    //
    // recordVaultBinding had exactly ONE caller, gated on `r.migrated` (see the at-rest
    // step below) — so a vault BORN ENCRYPTED got no binding from that path, and
    // guardAgainstForeignWal compares against the binding to decide whether the file was
    // replaced underneath a stale sidecar.
    //
    // ⚠️ CORRECTION TO THIS COMMIT'S OWN FIRST MESSAGE, which claimed the guard was
    // therefore inert for "EVERY NEW USER … NO defence". THAT WAS OVERSTATED, and an
    // adversarial review measured the real scope. wal-guard SELF-ESTABLISHES the binding on
    // any later boot: the no-WAL branch and the no-binding branch both call
    // recordVaultBinding (wal-guard.js:137-146). So a born-encrypted vault was unprotected
    // for exactly ONE BOOT — the launch that creates the file, where the guard returns early
    // because the file does not exist yet — and protected from the second boot onward.
    //
    // The fix still earns its place: it closes that one boot, which is the launch during
    // which a first-run crash is most likely. But "one boot wide" is the true claim, and the
    // wrong one is recorded here rather than quietly dropped, because a confident overstated
    // fact hardening into repo lore is this codebase's documented recurring defect.
    //
    // Ordering matters: the guard above compares against the PREVIOUS generation's binding,
    // then this writes the current one.
    recordVaultBinding(dbPath);

    // 3. The key getDb opens with: set iff the vault is now encrypted (self-detected)
    //    or at-rest is opted in. Null → plaintext open, unchanged.
    const outKey = resolveDbKeyHex(userHex, dbPath);

    // 4. Search-index sidecar (the search-sidecar design). Under THIS
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
