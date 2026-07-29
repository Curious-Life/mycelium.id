#!/usr/bin/env node
// src/db/snapshot-worker.mjs — take ONE verified, rotating vault snapshot.
//
// Runs DETACHED (spawned by snapshot-schedule.js) because VACUUM INTO on a multi-GB
// vault takes tens of seconds and better-sqlite3 is synchronous — in-process it would
// stall the event loop. Same pattern as vault-integrity-check.mjs.
//
// ── THE TRAP THIS IS DESIGNED AGAINST ───────────────────────────────────────────────
// The naive version of "snapshot on a timer" is worse than no snapshots at all. Once the
// vault is damaged, a timer keeps faithfully copying the damage; after `KEEP` cycles every
// good snapshot has been rotated out and replaced by a copy of the broken vault. The
// backup system becomes the delivery mechanism for the corruption — and it does so
// silently, because each individual copy "succeeded".
//
// So a snapshot is only allowed to EXIST, and only allowed to EVICT anything, if it has
// been proven restorable:
//   1. refuse outright if this box has already condemned the vault (.vault-corrupt) or
//      the halt latch is set — never copy a file we know is damaged;
//   2. VACUUM INTO a TEMP name (VACUUM INTO itself fails on most structural damage —
//      free verification);
//   3. open the RESULT keyed and run quick_check + a real read; a snapshot that cannot be
//      opened is not a backup, it is a file;
//   4. only then rename it into place (atomic) and only then prune;
//   5. NEVER prune the newest verified snapshot, whatever the retention math says.
//
// Exit codes: 0 wrote one · 3 skipped (not due) · 4 refused (vault condemned) · 1 failed.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, chmodSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DB = process.env.MYCELIUM_DB;
const KEY = process.env.MYCELIUM_SNAPSHOT_KEY || null; // 64-hex db-file key, or null (plaintext)
const KEEP = Math.max(1, Number(process.env.MYCELIUM_SNAPSHOT_KEEP_AUTO) || 7);
// Total bytes the auto-snapshots may occupy, as a MULTIPLE of the vault size. 7 copies of
// a 2 GB vault is 14 GB — a retention count alone is not a disk budget.
const BUDGET_X = Math.max(1, Number(process.env.MYCELIUM_SNAPSHOT_BUDGET_X) || 3);
const PREFIX = 'auto-';
// No snapshot legitimately runs for hours; past this a lock is stale even if its pid
// probes alive (pid reuse). Well above the ~24 s a 2 GB VACUUM INTO takes.
const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

// EVERY file this process creates is a full replica of the vault, so none of them may be
// group/other readable — not even transiently. A chmod AFTER the copy does NOT do this:
// `VACUUM INTO` is one synchronous call that creates the file and then writes it for
// seconds, so the fix-up only lands once the whole replica is already on disk. Measured:
// 69 consecutive samples at 0644 during the copy, with the post-VACUUM chmod in place.
// umask is the only thing that applies at CREATE time. (snapshots/ is also 0700, so this
// is the second of two independent layers — CLAUDE.md §2.)
try { process.umask(0o077); } catch { /* not available on some platforms */ }

const log = (m) => console.error(`[snapshot] ${m}`);
let releaseLock = () => {};
if (!DB || !existsSync(DB)) { log('no vault to snapshot'); process.exit(3); }

const dir = path.dirname(DB);
const snapDir = path.join(dir, 'snapshots');

// 1. REFUSE on a condemned vault. Copying a file we already know is damaged both wastes
//    the slot and, through rotation, destroys the good copies that are still there.
if (existsSync(path.join(dir, '.vault-corrupt'))) {
  log('REFUSING to snapshot: this vault is marked corrupt (.vault-corrupt). The existing snapshots are your recovery path and will NOT be rotated.');
  process.exit(4);
}

// READ-ONLY, unconditionally. It was `readonly: !!ro` with every call passing true — which
// is read-only in practice and write-capable by SIGNATURE, so one future caller passing
// false would silently hand this worker the ability to write to a vault it is copying
// because that vault is suspect. verify:vault-open-chokepoint refuses the ambiguity: a
// handle that CANNOT write needs no guard, which is why read-only is the cheapest way to
// be safe here. VACUUM INTO does not need write access (measured 2026-07-28).
const keyed = (p) => {
  const d = new Database(p, { readonly: true, fileMustExist: true });
  if (KEY) {
    if (!/^[0-9a-f]{64}$/i.test(KEY)) throw new Error('snapshot key must be 64-char hex');
    d.pragma(`cipher='sqlcipher'`);
    d.pragma(`key="x'${KEY}'"`);
  }
  // Measured: a READ-ONLY VACUUM INTO succeeds against a vault with an open write
  // transaction, because WAL readers do not block on writers. But a checkpoint can hold a
  // brief exclusive lock, and losing a whole backup because we would not wait 50 ms would
  // be an absurd trade. Costs nothing when uncontended.
  d.pragma('busy_timeout = 10000');
  return d;
};

/** Auto-snapshots on disk, oldest first (ISO stamp ⇒ lexical == chronological). */
const listAuto = () => {
  try { return readdirSync(snapDir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.db')).sort(); }
  catch { return []; }
};

function haveRoom(bytesNeeded) {
  try {
    const st = statfsSync(snapDir);
    return Number(st.bavail) * Number(st.bsize) >= bytesNeeded * 1.1;
  } catch { return null; } // can't tell → don't block; the write itself will ENOSPC loudly
}

let tmp = null;
let lockFd = null;
const lockPath = path.join(snapDir, '.snapshot.lock');
try {
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies ONLY when it CREATES the directory. Every install predating this
  // change already has snapshots/ at 0755 (umask 022), so the "second independent layer"
  // did not exist on any upgraded machine — measured 0755 before and after a full run.
  try { chmodSync(snapDir, 0o700); } catch { /* best-effort on platforms without POSIX modes */ }
  // ONE worker at a time. Nothing prevented two schedulers (or two processes) from both
  // seeing "due" and both spawning — two concurrent VACUUM INTOs on one vault, doubling
  // the read load and the disk churn for no benefit. O_EXCL + a pid, with a stale-lock
  // takeover so a killed worker cannot wedge snapshots forever.
  //
  // RELEASE IS AN EXIT HOOK, NOT A CALL SITE. The first version assigned releaseLock()
  // only in the first-acquire branch below: the stale-TAKEOVER branch re-acquired the
  // lock but left releaseLock as the no-op, and the `process.exit(3)` (no disk) and
  // `process.exit(4)` (condemned mid-copy) paths never called it at all. Any of those
  // left the lock on disk holding a dead pid — and once the OS recycled that pid onto
  // any live process, the liveness probe below said "held" forever and automatic
  // snapshots stopped SILENTLY (the scheduler classifies exit 3 as benign). A machine
  // whose owner believes they have backups and has none is the exact failure this whole
  // change set exists to prevent. Adversarial review, 2026-07-28.
  const holdLock = (fd) => {
    lockFd = fd;
    releaseLock = () => {
      if (lockFd === null) return;
      try { closeSync(lockFd); } catch { /* */ }
      // ONLY delete a lock we still OWN. Release used to remove lockPath by NAME, so a
      // worker whose lock had been age-stolen deleted its SUCCESSOR's lock on the way out
      // — proven by replacing the file mid-copy and watching the exit hook unlink it.
      // Chained with the steal branch that lets three workers overlap.
      try {
        const [holder] = String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/);
        if (parseInt(holder, 10) === process.pid) rmSync(lockPath, { force: true });
        else log('not releasing the snapshot lock — it now belongs to another worker');
      } catch { /* already gone, or unreadable → leave it for the stale path */ }
      lockFd = null;
    };
    process.on('exit', () => releaseLock()); // covers exit(0/1/3/4) and a thrown error
  };
  const stamp2 = () => `${process.pid} ${Date.now()}`;
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, stamp2());
    holdLock(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = 0, heldAt = 0;
    try {
      const [p, t] = String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/);
      holder = parseInt(p, 10) || 0;
      heldAt = parseInt(t, 10) || 0;
    } catch { /* unreadable → treat as stale below */ }
    let alive = false;
    if (holder > 0) { try { process.kill(holder, 0); alive = true; } catch { alive = false; } }
    // A pid can be RECYCLED onto an unrelated process, which would make a dead holder
    // look alive forever. Age breaks that tie. Age-stealing is safe HERE and is NOT the
    // mistake src/db/init.js documents: this critical section is a READ-ONLY copy with a
    // unique per-run temp name, so two overlapping workers waste I/O but cannot corrupt
    // anything — whereas there, a stolen lock meant two processes REWRITING one vault.
    // An OLD-FORMAT lock (pid only, written before the timestamp was added) parses to
    // heldAt = 0. Requiring heldAt > 0 made those permanently un-stealable: a recycled pid
    // on a pre-upgrade lock wedged snapshots forever, which is the very failure this
    // branch exists to remove. Fall back to the file's mtime when the payload has no
    // timestamp of its own. Round-3 review, 2026-07-28.
    let age = heldAt > 0 ? Date.now() - heldAt : null;
    if (age === null) { try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { age = null; } }
    const tooOld = age !== null && age > MAX_LOCK_AGE_MS;
    if (alive && !tooOld) { log(`another snapshot is already running (pid ${holder}) — skipping`); process.exit(3); }
    if (alive && tooOld) log(`stealing a ${Math.round((Date.now() - heldAt) / 60000)} min old snapshot lock (pid ${holder} looks alive, but no snapshot runs that long — pid reuse)`);
    try {
      rmSync(lockPath, { force: true });
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, stamp2());
      holdLock(fd);
    } catch { log('could not take the snapshot lock — skipping'); process.exit(3); }
  }
  const srcBytes = statSync(DB).size;
  if (haveRoom(srcBytes) === false) {
    log(`NOT ENOUGH DISK for a ${(srcBytes / 1e6).toFixed(0)} MB snapshot — skipping. Existing snapshots are untouched.`);
    process.exit(3);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // UNIQUE PER PROCESS. An ISO-ms stamp alone collides: the comment above justifies
  // overlapping workers as harmless "because the temp name is unique per run", and it was
  // not — same-millisecond workers shared both the temp AND the published destination.
  const uniq = `${process.pid}-${randomBytes(3).toString('hex')}`;
  tmp = path.join(snapDir, `.tmp-${PREFIX}${stamp}-${uniq}.db`);
  for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmp + sfx, { force: true }); } catch { /* */ } }

  // 2. VACUUM INTO — a consistent copy under a READ transaction (safe under concurrent
  //    writers) that also, usefully, refuses to complete on most structural damage.
  {
    // READ-ONLY. `VACUUM INTO` only reads the source (measured: it succeeds on a readonly
    // connection), so this worker never needed write access — and taking it made the
    // RECOVERY tier add an unguarded Nth writer to the very file the rest of this design
    // is trying to reduce writers on (adversarial review, finding 2). A read-only handle
    // also cannot checkpoint on close, which removes the finding-11 hazard entirely: no
    // close of ours can fold WAL frames into a vault that went bad while we were copying.
    const src = keyed(DB);
    try { src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); }
    finally { try { src.close(); } catch { /* */ } }
    // TIGHTEN IMMEDIATELY, not after the verify. VACUUM INTO creates the file with
    // umask perms (measured 0644 here) and the verify below takes seconds on a large
    // vault — a window in which a full replica of the vault is world-readable, and a
    // PLAINTEXT one when at-rest is off. db-cipher-migrate.js:86 already does it in the
    // right order for the same reason. Adversarial review, 2026-07-28.
    try { chmodSync(tmp, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
  }

  // Re-check the condemnation marker AFTER the copy. The startup check (above) cannot see
  // a vault that was condemned DURING our VACUUM — a window of tens of seconds on a large
  // vault. Publishing then rotating on that copy is exactly the trap this worker exists to
  // avoid, so the late check is the one that protects the existing snapshots.
  if (existsSync(path.join(dir, '.vault-corrupt'))) {
    for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmp + sfx, { force: true }); } catch { /* */ } }
    log('vault was condemned DURING the snapshot — discarding the copy, rotating nothing');
    process.exit(4);
  }

  // 3. PROVE IT RESTORES. An unverified copy is a file, not a backup — and the whole
  //    reason this worker exists is that the machine which lost its vault had nothing
  //    it could actually restore.
  {
    const chk = keyed(tmp);
    try {
      // AN EMPTY FILE PASSES BOTH OF THESE. A 0-byte SQLite file answers quick_check 'ok'
      // and has a readable, empty sqlite_master — measured, keyed and plaintext. So a copy
      // that produced nothing would be "verified", published, and would prune a real
      // snapshot away. Require actual pages and actual schema first.
      const pages = Number(chk.pragma('page_count', { simple: true }) ?? 0);
      if (!Number.isFinite(pages) || pages === 0) throw new Error('the copy is empty (0 pages) — not a backup');
      const qc = chk.prepare('PRAGMA quick_check').all().map((r) => r.quick_check);
      if (!(qc.length === 1 && qc[0] === 'ok')) throw new Error(`quick_check: ${qc.join(' | ').slice(0, 100)}`);
      const tables = chk.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n ?? 0;
      if (tables === 0) throw new Error('the copy has no schema at all — not a backup');
    } finally { try { chk.close(); } catch { /* */ } }
  }
  // (perms were tightened immediately after VACUUM INTO — see above. A second chmod here
  //  would be redundant, and while it existed it masked the window it was meant to close:
  //  deleting the early chmod left this one to fix the mode up, so the gate stayed green.)

  // 4. Publish atomically. Until this rename the snapshot does not exist to anyone.
  const dest = path.join(snapDir, `${PREFIX}${stamp}-${uniq}.db`);
  renameSync(tmp, dest);
  tmp = null;
  writeFileSync(path.join(snapDir, '.last-auto-snapshot'), String(Date.now()));
  log(`wrote ${path.basename(dest)} (${(statSync(dest).size / 1e6).toFixed(0)} MB, verified)`);

  // 5. Prune — count AND byte budget, but NEVER the newest. Every survivor here was
  //    verified at the moment it was written.
  const budget = statSync(dest).size * BUDGET_X;
  let snaps = listAuto();
  const sizeOf = (f) => { try { return statSync(path.join(snapDir, f)).size; } catch { return 0; } };
  let total = snaps.reduce((a, f) => a + sizeOf(f), 0);
  let budgetBound = false;
  while (snaps.length > 1 && (snaps.length > KEEP || total > budget)) {
    if (snaps.length <= KEEP) budgetBound = true; // pruning below KEEP purely on bytes
    const victim = snaps.shift(); // oldest; the newest can never be reached (length > 1)
    const b = sizeOf(victim);
    try { rmSync(path.join(snapDir, victim), { force: true }); total -= b; log(`pruned ${victim}`); }
    catch { break; }
  }
  // SAY SO when the byte budget, not KEEP, decided the retention. Measured on a real boot:
  // KEEP=7 configured, BUDGET_X=3 → 3 snapshots kept. Silently giving someone less history
  // than they asked for is the "surface was correct and unreadable" defect class this repo
  // keeps hitting; a backup depth you cannot see is one you cannot rely on.
  if (budgetBound) {
    log(`retention is DISK-BOUND, not count-bound: keeping ${snaps.length} snapshot(s), not KEEP=${KEEP} — `
      + `${BUDGET_X}x the vault size is the cap. Raise MYCELIUM_SNAPSHOT_BUDGET_X for deeper history.`);
  }
  releaseLock();
  process.exit(0);
} catch (e) {
  if (tmp) for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmp + sfx, { force: true }); } catch { /* */ } }
  // A failed snapshot NEVER prunes and NEVER blocks anything. Loud, then out of the way.
  log(`FAILED (${e?.code || ''} ${e?.message || e}) — existing snapshots are untouched.`);
  releaseLock();
  process.exit(1);
}
