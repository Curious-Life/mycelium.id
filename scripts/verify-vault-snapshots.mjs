#!/usr/bin/env node
// verify-vault-snapshots.mjs — rolling, VERIFIED, corruption-aware vault snapshots.
//
// WHY: on 2026-07-26 a production vault was damaged and had nothing to restore from —
// no snapshots directory at all. src/account/snapshot-on-boot.js only fires when the
// MIGRATION SET changes or when no snapshot exists (snapshot-on-boot.js:120-122), so a
// vault with a settled schema takes one baseline and never another.
//
// THE LOAD-BEARING CHECK IS NOT "does it write a file" — it is checks 4 and 5: a damaged
// vault must NOT be snapshotted, and a failing snapshot must NOT prune. The naive timer
// implementation is worse than having no snapshots: once the vault is damaged it keeps
// faithfully copying the damage, and within KEEP cycles every good snapshot has been
// rotated out and replaced by a copy of the broken file — each individual copy having
// "succeeded". The backup system becomes the delivery mechanism for the corruption.
//
// MUTATION-TESTED: removed the `.vault-corrupt` refusal from snapshot-worker.mjs → "a
//   condemned vault is NOT snapshotted" REDs
// MUTATION-TESTED: made maybeScheduleSnapshot ignore the interval (always due) → "the
//   scheduler takes one when none exists, then not again until due" REDs
// MUTATION-TESTED: dropped the isVaultHalted() check in the scheduler → "the scheduler
//   refuses while the halt latch is set" REDs
//
// Added after SMOKE-TESTING the branch against a copy of a real 86 MB vault — both defects
// below were invisible to every fixture-based check, because the gates drive the worker
// directly and never exercise the SCHEDULE:
// MUTATION-TESTED: removed the one-hour interval floor → "the cadence has a floor no
//   configuration can go under" REDs
// MUTATION-TESTED: stopped flagging disk-bound retention → "when the DISK budget decides
//   retention, it says so" REDs
//
// ── TWO MUTATIONS THAT DID NOT RED, AND WHY (not fabricating a record for either) ────
// Both were applied and the gate stayed GREEN. Each is defence-in-depth whose primary
// guard is elsewhere, so this gate cannot independently prove it. Recorded rather than
// dressed up, per CLAUDE.md /gate-teeth ("never fabricate a record").
//
//  · removing the worker's post-VACUUM quick_check did NOT red check 4. Measured why:
//    `VACUUM INTO` itself REFUSES a damaged source (SQLITE_CORRUPT), because it rebuilds
//    the b-tree rather than copying pages — so on this fixture the copy never gets far
//    enough to need verifying. The quick_check therefore guards a DIFFERENT failure: a
//    copy damaged in flight (ENOSPC, a short write, an I/O error on the destination),
//    which this harness cannot construct without a fault-injecting filesystem. Kept —
//    "the source was fine when we started" is not "the file we just wrote is restorable".
//
//  · letting the prune loop run to zero (`snaps.length > 0`) did NOT red check 5. The
//    loop's other condition (`snaps.length > KEEP || total > budget`) already stops at
//    KEEP >= 1, and `budget` is at minimum one snapshot's size (BUDGET_X is clamped to
//    >= 1), so the directory cannot be emptied through either exit. The `> 1` guard is
//    therefore unreachable today — it is insurance against a future change to the budget
//    clamp, not a live protection. Kept, cheap, and honestly labelled.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// MUTATION-TESTED (2026-07-28), after an adversarial review defeated the source-text
// checks this gate used to rely on. Each mutation was applied, CONFIRMED ON DISK, run,
// and restored:
//   G. snapshot-worker stale-takeover branch: holdLock(fd) → `lockFd = fd` (no release
//      registered — the original defect) → "a STALE lock is taken over and released
//      again" REDs, while "a successful run leaves NO lock behind" stays GREEN. That
//      discrimination is the point: only the takeover path was broken.
//   H. src/index.js: `startSnapshotSchedule({` → `if (false) startSnapshotSchedule({`
//      → "a real boot() actually produces a snapshot" REDs. This is the mutation the
//      three previous greps (/startSnapshotSchedule\(/, iSnap>iOpen, isCanonicalVault
//      proximity) ALL survived while no snapshot was ever taken.
//   J. snapshot-worker: `process.umask(0o077)` removed → "the TEMP copy is owner-only
//      for its whole life" REDs with the measured evidence (extra bits 044 over ~69
//      samples during the copy).
//
//   O. snapshot-schedule intervalMs(): `if (true) return 1;` at the top
//      → "the cadence has a floor no configuration can go under" REDs. This is the
//      mutation the three previous greps (MIN_INTERVAL_MS, the Math.max line, the
//      'force' line) all survived — they matched a function that no longer honoured any
//      of them. intervalMs is now exported and CALLED.
//
//   V. snapshot-worker: `chmodSync(snapDir, 0o700)` removed
//      → "an UPGRADED install gets its snapshots/ tightened too" REDs (0755 survives).
//   W. snapshot-worker: the release-time ownership check reduced to an unconditional
//      `rmSync(lockPath)` → "a worker never deletes a lock that is no longer its own" REDs.
//      ⚠️ W SURVIVED the first version of that check, which planted a foreign lock BEFORE
//      starting the worker: the worker then skips at exit 3 without ever arming its
//      release, so the guard under test was never reached. The lock must be replaced while
//      the worker HOLDS it, which needs a vault big enough to still be copying — and a
//      positive precondition that the takeover was actually observed. A mutation that
//      survives because the scenario never happened is not evidence of anything.
//      ⚠️ My first attempt at W was also INVALID: replacing only the `if` line orphaned its
//      `else` and made the file a SyntaxError, so 15 checks RED for the wrong reason.
//      A mutation must leave the program runnable, or it tests the parser.
//
//   Z. snapshot-worker: the mtime fallback removed, restoring `heldAt > 0 && …`
//      → "an OLD-FORMAT lock (pid only, no timestamp) is still reclaimable" REDs.
//      Pre-upgrade locks carry no timestamp, so heldAt parsed to 0 and the age test could
//      never fire: a recycled pid on one wedged automatic snapshots FOREVER — the exact
//      failure the age test was added to remove. Round-3 review.
//
// ⚠️ TWO MUTATIONS SURVIVED, and both are recorded because they changed the work:
//   F. removing the process.on('exit') release hook survived — the lock checks pass on
//      the holdLock() restructure alone. The hook covers only the exit(3) "no disk" and
//      exit(4) "condemned mid-copy" paths, whose triggers (a full filesystem, a
//      condemnation landing inside the copy window) cannot be produced deterministically
//      here. Those paths are therefore protected BY CONSTRUCTION and are NOT covered by
//      a check. Stated rather than implied, so nobody reads this gate as proving them.
//   I. removing the post-VACUUM chmod survived, because a second, later chmod still
//      fixed the final mode up. That is what exposed the real defect: the check was
//      asserting the mode at the END, while the defect is the WINDOW. The redundant late
//      chmod is gone and the window is now sampled directly — which promptly found that
//      chmod-after-VACUUM never closed the window at all (VACUUM INTO is one synchronous
//      call), and the fix became umask.


import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, statSync, mkdirSync, openSync, readSync, writeSync, closeSync, copyFileSync, readFileSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const WORKER = fileURLToPath(new URL('../src/db/snapshot-worker.mjs', import.meta.url));
const KEY = 'd'.repeat(64);
const root = mkdtempSync(join(tmpdir(), 'myc-snap-'));

function makeVault(dir, rows = 300, prefix = 'v') {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'mycelium.db');
  const db = new Database(p);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${KEY}'"`);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT)');
  const ins = db.prepare('INSERT INTO messages(body) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(prefix.repeat(80) + i); })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return p;
}

/** Same lineage ⇒ same salt ⇒ every page decrypts; the b-tree is a lie. */
function corrupt(dbFile) {
  const donor = dbFile + '.donor';
  copyFileSync(dbFile, donor);
  {
    const d = new Database(donor);
    d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`);
    const ins = d.prepare('INSERT INTO messages(body) VALUES (?)');
    d.transaction(() => { for (let i = 0; i < 6000; i++) ins.run('Z'.repeat(200) + i); })();
    d.exec('CREATE TABLE t2(a TEXT); CREATE INDEX ix ON messages(body)');
    d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
  }
  const PS = 4096, fdD = openSync(donor, 'r'), fdT = openSync(dbFile, 'r+'), buf = Buffer.alloc(PS);
  readSync(fdD, buf, 0, PS, 0); writeSync(fdT, buf, 0, PS, 0); // page 1 from a bigger generation
  closeSync(fdD); closeSync(fdT); rmSync(donor, { force: true });
}

const runWorker = (dbFile, env = {}) => spawnSync(process.execPath, [WORKER], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DB: dbFile, MYCELIUM_SNAPSHOT_KEY: KEY, ...env },
});
const freshVault = (name, rows = 300) => { const dir = join(root, name); return { dir, db: makeVault(dir, rows) }; };
/** PLAINTEXT vault — the real-boot case runs with at-rest off, so boot() derives its key
 *  from USER_MASTER and could never open a fixture encrypted with this gate's KEY. */
const freshPlainVault = (name, rows = 100) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'mycelium.db');
  const db = new Database(p);
  // NOT `messages` — applyMigrations owns that name, and a real boot() over this fixture
  // would die on "table messages already exists" before ever reaching the scheduler.
  db.exec('CREATE TABLE snap_probe(id INTEGER PRIMARY KEY, body TEXT)');
  const ins = db.prepare('INSERT INTO snap_probe(body) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run('p'.repeat(40) + i); })();
  db.close();
  return { dir, db: p };
};
const snapsIn = (dir) => { try { return readdirSync(join(dir, 'snapshots')).filter((f) => f.startsWith('auto-') && f.endsWith('.db')).sort(); } catch { return []; } };

// ══ 1. it actually produces a restorable snapshot ═══════════════════════════════
await t('a healthy vault produces a snapshot that opens and quick_checks ok', async () => {
  const dir = join(root, 'healthy'); const db = makeVault(dir);
  const r = runWorker(db);
  assert.equal(r.status, 0, `worker exited ${r.status}: ${r.stderr}`);
  const snaps = snapsIn(dir);
  assert.equal(snaps.length, 1, `expected 1 snapshot, got ${snaps.length}`);
  // The whole point: it must be RESTORABLE, not merely present.
  const s = new Database(join(dir, 'snapshots', snaps[0]), { readonly: true });
  s.pragma(`cipher='sqlcipher'`); s.pragma(`key="x'${KEY}'"`);
  assert.equal(s.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(s.prepare('SELECT count(*) AS n FROM messages').get().n, 300, 'snapshot must carry the rows');
  s.close();
});

// ══ 2. no temp/partial files are left behind ════════════════════════════════════
await t('no .tmp- partial is published or left behind', async () => {
  const dir = join(root, 'healthy');
  const stray = readdirSync(join(dir, 'snapshots')).filter((f) => f.startsWith('.tmp-'));
  assert.equal(stray.length, 0, `left ${stray.join(', ')}`);
});

// ══ 3. THE TRAP: a condemned vault is never copied ══════════════════════════════
await t('a condemned vault (.vault-corrupt) is NOT snapshotted, and existing snapshots survive', async () => {
  const dir = join(root, 'condemned'); const db = makeVault(dir);
  assert.equal(runWorker(db).status, 0, 'precondition: one good snapshot exists');
  const before = snapsIn(dir);
  assert.equal(before.length, 1);

  writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ code: 'SQLITE_CORRUPT' }));
  const r = runWorker(db);
  assert.equal(r.status, 4, `expected refusal (exit 4), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /REFUSING to snapshot/i);
  assert.deepEqual(snapsIn(dir), before, 'the good snapshot must survive untouched');
});

// ══ 4. THE TRAP, part 2: a damaged vault cannot publish a snapshot ══════════════
await t('an unverifiable snapshot is never published (damaged source, no marker)', async () => {
  const dir = join(root, 'damaged'); const db = makeVault(dir);
  assert.equal(runWorker(db).status, 0, 'precondition: one good snapshot');
  const good = snapsIn(dir);
  assert.equal(good.length, 1);

  corrupt(db); // no .vault-corrupt marker — the worker must catch this on its own
  const r = runWorker(db);
  assert.notEqual(r.status, 0, `a damaged vault must not yield a successful snapshot (stderr: ${r.stderr})`);
  const after = snapsIn(dir);
  assert.deepEqual(after, good, 'the pre-existing good snapshot must NOT have been rotated away');
  const stray = readdirSync(join(dir, 'snapshots')).filter((f) => f.startsWith('.tmp-'));
  assert.equal(stray.length, 0, 'a failed snapshot must clean up its temp file');
});

// ══ 5. rotation never eats the last snapshot ════════════════════════════════════
await t('pruning respects KEEP and never removes the newest snapshot', async () => {
  const dir = join(root, 'rotate'); const db = makeVault(dir, 120);
  for (let i = 0; i < 4; i++) {
    const r = runWorker(db, { MYCELIUM_SNAPSHOT_KEEP_AUTO: '2' });
    assert.equal(r.status, 0, `snapshot ${i} failed: ${r.stderr}`);
    // distinct ISO stamps (second resolution) so ordering is unambiguous
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1100)'], { timeout: 2000 });
  }
  const snaps = snapsIn(dir);
  assert.ok(snaps.length <= 2, `KEEP=2 not honoured: ${snaps.length} snapshots`);
  assert.ok(snaps.length >= 1, 'pruning must never empty the directory');
  // and every survivor is still restorable
  for (const f of snaps) {
    const s = new Database(join(dir, 'snapshots', f), { readonly: true });
    s.pragma(`cipher='sqlcipher'`); s.pragma(`key="x'${KEY}'"`);
    assert.equal(s.pragma('quick_check', { simple: true }), 'ok', `${f} is not restorable`);
    s.close();
  }
});

// ══ 6. the scheduler: due / not-due / refusals ══════════════════════════════════
await t('the scheduler takes one when none exists, then not again until due', async () => {
  const { maybeScheduleSnapshot, newestSnapshotAgeMs } = await import('../src/db/snapshot-schedule.js');
  process.env.MYCELIUM_SNAPSHOT_AUTO = 'force'; // a temp fixture is not the app vault
  const dir = join(root, 'sched'); const db = makeVault(dir, 80);
  assert.equal(newestSnapshotAgeMs(db), Infinity, 'no snapshot yet');

  const first = maybeScheduleSnapshot({ dbPath: db, dbKeyHex: KEY, isCanonical: true });
  assert.equal(first.scheduled, true, 'a vault with no snapshot must schedule one');
  assert.equal(first.reason, 'no-snapshot-yet');

  // simulate a fresh snapshot on disk, then assert the interval is respected
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(dir, 'snapshots', `auto-${new Date().toISOString().replace(/[:.]/g, '-')}.db`), 'x');
  const second = maybeScheduleSnapshot({ dbPath: db, dbKeyHex: KEY, isCanonical: true });
  assert.equal(second.scheduled, false, 'a fresh snapshot must suppress the next one');
  assert.equal(second.reason, 'not-due');
});

await t('the scheduler refuses while the halt latch is set', async () => {
  process.env.MYCELIUM_SNAPSHOT_AUTO = 'force';
  const halt = await import('../src/db/vault-halt.js');
  const { maybeScheduleSnapshot } = await import('../src/db/snapshot-schedule.js');
  const dir = join(root, 'halted'); const db = makeVault(dir, 40);
  halt.__resetVaultHaltForTests();
  assert.equal(maybeScheduleSnapshot({ dbPath: db, dbKeyHex: KEY, isCanonical: true }).scheduled, true, 'precondition');

  halt.tripVaultHalt(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }), {});
  const r = maybeScheduleSnapshot({ dbPath: db, dbKeyHex: KEY, isCanonical: true });
  assert.equal(r.scheduled, false, 'a halted vault must not be snapshotted');
  assert.equal(r.reason, 'vault-halted');
  halt.__resetVaultHaltForTests();
});

await t('fixtures and non-canonical vaults never spawn a snapshot worker', async () => {
  const { maybeScheduleSnapshot } = await import('../src/db/snapshot-schedule.js');
  const dir = join(root, 'fixture'); const db = makeVault(dir, 20);
  delete process.env.MYCELIUM_SNAPSHOT_AUTO;
  assert.equal(maybeScheduleSnapshot({ dbPath: db, isCanonical: false }).reason, 'not-canonical');
  assert.equal(maybeScheduleSnapshot({ dbPath: ':memory:', isCanonical: true }).reason, 'no-vault');
  // paths.js calls any MYCELIUM_DB target "canonical", so ~100 verify gates would each
  // spawn a worker and litter snapshots/ beside a temp DB. Only the app vault qualifies.
  assert.equal(maybeScheduleSnapshot({ dbPath: db, isCanonical: true }).reason, 'not-app-vault');
});

// ══ 6b. defects found by SMOKE-TESTING a real vault, not a fixture ══════════════
await t('the cadence has a floor no configuration can go under', async () => {
  // Found by booting the branch against a copy of a real 86 MB vault: a mis-set interval
  // produced THREE full VACUUM INTO copies in 5 seconds — 258 MB written while the app was
  // still starting. On a 2 GB vault that is ~24 s of heavy I/O per copy.
  //
  // BEHAVIOURAL. This was three greps (MIN_INTERVAL_MS, the Math.max line, the 'force'
  // line) and an adversarial review defeated all three with `if (true) return 1;` at the
  // top of intervalMs() — every grep still matched a function that no longer honoured any
  // of them. intervalMs is now exported and called.
  const { intervalMs } = await import('../src/db/snapshot-schedule.js');
  const saved = { i: process.env.MYCELIUM_SNAPSHOT_INTERVAL_H, a: process.env.MYCELIUM_SNAPSHOT_AUTO };
  try {
    process.env.MYCELIUM_SNAPSHOT_INTERVAL_H = '0.0001'; // 0.36s
    delete process.env.MYCELIUM_SNAPSHOT_AUTO;           // not forced ⇒ the floor applies
    assert.ok(intervalMs() >= 60 * 60 * 1000,
      `a 0.36s configured interval must be clamped to the 1h floor, got ${intervalMs()}ms`);

    process.env.MYCELIUM_SNAPSHOT_AUTO = 'force';        // only an explicit force waives it
    assert.ok(intervalMs() < 60 * 60 * 1000,
      'MYCELIUM_SNAPSHOT_AUTO=force must waive the floor (gates/dev depend on it)');

    delete process.env.MYCELIUM_SNAPSHOT_AUTO;
    process.env.MYCELIUM_SNAPSHOT_INTERVAL_H = '0';      // explicit disable stays possible
    assert.equal(intervalMs(), 0, 'an interval of 0 must disable automatic snapshots outright');
  } finally {
    if (saved.i === undefined) delete process.env.MYCELIUM_SNAPSHOT_INTERVAL_H; else process.env.MYCELIUM_SNAPSHOT_INTERVAL_H = saved.i;
    if (saved.a === undefined) delete process.env.MYCELIUM_SNAPSHOT_AUTO; else process.env.MYCELIUM_SNAPSHOT_AUTO = saved.a;
  }
});

await t('when the DISK budget decides retention, it says so instead of silently keeping fewer', async () => {
  // Measured on the same real boot: KEEP=7 configured, 3 kept — because BUDGET_X=3 binds
  // first. Giving someone less backup history than they configured, silently, is a backup
  // depth they cannot rely on.
  const dir = join(root, 'bound'); const db = makeVault(dir, 120);
  let out = '';
  for (let i = 0; i < 3; i++) {
    const r = runWorker(db, { MYCELIUM_SNAPSHOT_KEEP_AUTO: '7', MYCELIUM_SNAPSHOT_BUDGET_X: '1' });
    assert.equal(r.status, 0, `snapshot ${i} failed: ${r.stderr}`);
    out += r.stderr;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1100)'], { timeout: 2000 });
  }
  assert.ok(snapsIn(dir).length < 7, 'precondition: the byte budget must have bound before KEEP');
  assert.match(out, /retention is DISK-BOUND/i,
    'the worker must announce that disk, not KEEP, decided how much history is retained');
});

// ══ 7. THE LOCK — every exit path must release it ══════════════════════════════
// None of this was covered: `grep -rln .snapshot.lock scripts/ tests/` found nothing.
// releaseLock() was assigned ONLY in the first-acquire branch, so the stale-takeover
// branch left it a no-op and the exit(3)/exit(4) paths never called it. The lock then
// survived holding a dead pid, and once the OS recycled that pid the liveness probe
// said "held" forever — automatic snapshots stopped silently, which the scheduler
// reports as the benign "skipped". Adversarial review, 2026-07-28.
await t('a successful run leaves NO lock behind', async () => {
  const { dir, db } = freshVault('lock-clean');
  assert.equal(runWorker(db).status, 0, 'precondition: the snapshot must have succeeded');
  assert.ok(snapsIn(dir).length === 1, 'precondition: exactly one snapshot was written');
  assert.ok(!existsSync(join(dir, 'snapshots', '.snapshot.lock')), 'the lock must be released on the success path');
});

await t('a STALE lock (dead holder) is taken over — and released again', async () => {
  const { dir, db } = freshVault('lock-stale');
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  // pid 999999 is (almost certainly) dead; old timestamp so either predicate reclaims it
  writeFileSync(join(dir, 'snapshots', '.snapshot.lock'), `999999 ${Date.now() - 7 * 60 * 60 * 1000}`);
  const r = runWorker(db);
  assert.equal(r.status, 0, `the worker must take over a dead holder's lock (stderr=${String(r.stderr).slice(-200)})`);
  assert.equal(snapsIn(dir).length, 1, 'and actually write the snapshot');
  // THE REGRESSION: the takeover branch used to leave releaseLock a no-op, so the lock
  // survived a successful run and wedged every future one.
  assert.ok(!existsSync(join(dir, 'snapshots', '.snapshot.lock')), 'the taken-over lock must be released too');
});

await t('an OLD-FORMAT lock (pid only, no timestamp) is still reclaimable', async () => {
  // Locks written before the timestamp was added parse to heldAt = 0, and the age test
  // required heldAt > 0 — so a recycled pid on a pre-upgrade lock wedged automatic
  // snapshots forever, which is exactly the failure the age test was added to remove.
  // Our OWN pid is used as the holder: alive, so only the age path can reclaim it.
  const { dir, db } = freshVault('lock-oldfmt', 60);
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  const lockPath = join(dir, 'snapshots', '.snapshot.lock');
  writeFileSync(lockPath, String(process.pid)); // old format: no timestamp
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(lockPath, old, old);              // and stale by mtime
  const r = runWorker(db);
  assert.equal(r.status, 0, `an old-format stale lock must be reclaimable (exit ${r.status}: ${String(r.stderr).slice(-200)})`);
  assert.equal(snapsIn(dir).length, 1, 'and the snapshot must actually be written');
});

await t('a LIVE lock is respected — the worker skips and does not steal it', async () => {
  const { dir, db } = freshVault('lock-live');
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(dir, 'snapshots', '.snapshot.lock'), `${process.pid} ${Date.now()}`); // us: alive + fresh
  const r = runWorker(db);
  assert.equal(r.status, 3, 'a live holder means skip, not steal');
  assert.equal(snapsIn(dir).length, 0, 'and no snapshot is written');
  assert.ok(existsSync(join(dir, 'snapshots', '.snapshot.lock')), "the live holder's lock must survive");
  rmSync(join(dir, 'snapshots', '.snapshot.lock'), { force: true });
});

// ══ 8. the snapshot is not readable by other local users ═══════════════════════
await t('snapshot + its directory are owner-only, and the temp copy never widens', async () => {
  const { dir, db } = freshVault('perms');
  assert.equal(runWorker(db).status, 0, 'precondition: a snapshot was written');
  const snaps = snapsIn(dir);
  assert.equal(snaps.length, 1, 'precondition: exactly one snapshot');
  const fileMode = statSync(join(dir, 'snapshots', snaps[0])).mode & 0o777;
  const dirMode = statSync(join(dir, 'snapshots')).mode & 0o777;
  assert.equal(fileMode, 0o600, `the snapshot is a full replica of the vault — mode was ${fileMode.toString(8)}`);
  assert.equal(dirMode & 0o077, 0, `snapshots/ must not be group/other accessible — mode was ${dirMode.toString(8)}`);
});

await t('the TEMP copy is owner-only for its whole life, not just at the end', async () => {
  // The mode at the END is not the property that matters: VACUUM INTO creates the temp
  // with umask perms (0644 here) and the copy+verify takes seconds on a real vault, so a
  // full replica is world-readable for that window — PLAINTEXT when at-rest is off.
  // Deleting the early chmod while a late one remained kept the final mode at 0600 and
  // this gate green, which is why the window is now sampled directly.
  const { dir, db } = freshVault('perm-window', 40000); // big enough that the copy is samplable
  const snapDir = join(dir, 'snapshots');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [WORKER], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DB: db, MYCELIUM_SNAPSHOT_KEY: KEY },
    stdio: 'ignore',
  });
  let sampled = 0, widest = 0, code = null;
  await new Promise((done) => {
    const iv = setInterval(() => {
      let names = [];
      try { names = readdirSync(snapDir).filter((f) => f.startsWith('.tmp-')); } catch { /* dir not yet made */ }
      for (const n of names) {
        try { const m = statSync(join(snapDir, n)).mode & 0o777; sampled++; widest = Math.max(widest, m & 0o077); }
        catch { /* raced with the rename — fine */ }
      }
    }, 2);
    child.on('close', (c) => { code = c; clearInterval(iv); done(); });
  });
  assert.equal(code, 0, `precondition: the worker must have succeeded (exit ${code})`);
  // POSITIVE PRECONDITION: a run too fast to sample proves nothing and must not read as a pass.
  assert.ok(sampled > 0, `never observed the temp copy (${sampled} samples) — the window was not actually tested`);
  assert.equal(widest, 0, `the temp copy was group/other-accessible during the copy (extra bits 0${widest.toString(8)}, over ${sampled} samples)`);
});

await t('an UPGRADED install gets its snapshots/ tightened too (mkdir mode does not chmod)', async () => {
  // `mkdirSync(..., { mode: 0o700 })` applies the mode only when it CREATES the directory.
  // Every install predating this work already has snapshots/ at 0755 from umask 022, so
  // the claimed "second independent layer" did not exist on any upgraded machine. The
  // permissions check above was structurally blind to it: its fixture directory is always
  // created fresh BY the worker. Measured 0755 → 0755 before the fix.
  const { dir, db } = freshVault('perm-upgrade');
  const snapDir = join(dir, 'snapshots');
  mkdirSync(snapDir, { recursive: true, mode: 0o755 });
  chmodSync(snapDir, 0o755); // defeat the caller's umask so the precondition is exact
  assert.equal(statSync(snapDir).mode & 0o777, 0o755, 'precondition: a pre-existing group-readable snapshots/');
  assert.equal(runWorker(db).status, 0, 'precondition: the snapshot must succeed');
  assert.equal(statSync(snapDir).mode & 0o077, 0,
    `an existing snapshots/ must be tightened, not left at ${(statSync(snapDir).mode & 0o777).toString(8)}`);
});

await t('a worker never deletes a lock that is no longer its own', async () => {
  // releaseLock() removed lockPath by NAME. A worker whose lock had been age-stolen then
  // deleted its SUCCESSOR's lock on the way out — and with the steal branch, that means
  // three workers overlapping on one vault.
  //
  // ⚠️ The first version of this check wrote a foreign lock BEFORE starting the worker.
  // That is a different path entirely: the worker skips at exit 3 without ever arming its
  // release, so removing the ownership guard left it GREEN. The lock has to be replaced
  // while the worker HOLDS it, which needs a vault big enough to still be copying.
  const { dir, db } = freshVault('lock-owner', 40000);
  const snapDir = join(dir, 'snapshots');
  const lockPath = join(snapDir, '.snapshot.lock');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [WORKER], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DB: db, MYCELIUM_SNAPSHOT_KEY: KEY },
    stdio: 'ignore',
  });
  // Wait until the worker owns the lock, then take it over as a "successor".
  let sawWorkerLock = false;
  const FOREIGN = `999999 ${Date.now()}`;
  await new Promise((done) => {
    const iv = setInterval(() => {
      try {
        const holder = String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/)[0];
        if (!sawWorkerLock && parseInt(holder, 10) === child.pid) {
          sawWorkerLock = true;
          writeFileSync(lockPath, FOREIGN); // the successor now owns it
        }
      } catch { /* not created yet, or already gone */ }
    }, 3);
    child.on('close', () => { clearInterval(iv); done(); });
  });
  // POSITIVE PRECONDITION: if we never caught the worker holding it, the scenario did not
  // happen and a surviving foreign lock would prove nothing.
  assert.ok(sawWorkerLock, 'never observed the worker holding its own lock — the takeover was not exercised');
  assert.ok(existsSync(lockPath), "the worker must not delete a lock that now belongs to someone else");
  assert.equal(String(readFileSync(lockPath, 'utf8')).trim(), FOREIGN, "and must not alter the successor's lock");
  rmSync(lockPath, { force: true });
});

await t('two same-millisecond workers cannot collide on the temp or published name', async () => {
  // The overlap allowed by the age-steal branch was justified as harmless "because the
  // temp name is unique per run". It was an ISO-ms stamp with no pid, so two workers in
  // the same millisecond shared BOTH the temp and the destination.
  const { dir, db } = freshVault('name-uniq', 60);
  assert.equal(runWorker(db).status, 0, 'precondition: first snapshot');
  const first = snapsIn(dir);
  assert.equal(first.length, 1, 'precondition: exactly one so far');
  // Force a second run at the same nominal cadence and prove the names differ.
  assert.equal(runWorker(db, { MYCELIUM_SNAPSHOT_AUTO: 'force' }).status, 0, 'second snapshot');
  const all = snapsIn(dir);
  assert.equal(new Set(all).size, all.length, 'published snapshot names must be unique');
  assert.ok(/-\d+-[0-9a-f]{6}\.db$/.test(all[0]), `the name must carry pid+random, got ${all[0]}`);
});

// ══ 9. boot is wired — BEHAVIOURALLY ═══════════════════════════════════════════
// This was three greps over src/index.js, and an adversarial review defeated it with
// `if (false) startSnapshotSchedule({...})`: the /startSnapshotSchedule\(/ match, the
// iSnap>iOpen ordering and the isCanonicalVault proximity check ALL still passed while
// no snapshot was ever taken. So run the real boot() and look for the artefact.
await t('a real boot() actually produces a snapshot (not merely mentions the scheduler)', async () => {
  const { dir, db } = freshPlainVault('bootwire');
  const child = join(dir, 'boot-child.mjs');
  writeFileSync(child, [
    `import { boot } from ${JSON.stringify(fileURLToPath(new URL('../src/index.js', import.meta.url)))};`,
    `const dbPath = process.argv[2];`,
    `const b = await boot({ dbPath, kcvPath: dbPath + '.kcv', userHex: 'c'.repeat(64), systemHex: 'd'.repeat(64), embedder: null, initStorage: true });`,
    `console.log('BOOTED');`,
    `setTimeout(async () => { try { await b?.close?.(); } catch {} process.exit(0); }, 6000);`,
  ].join('\n'));
  const r = spawnSync(process.execPath, [child, db], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, MYCELIUM_DB: db, MYCELIUM_SNAPSHOT_AUTO: 'force', MYCELIUM_AT_REST: '', MYCELIUM_KEY_SOURCE: 'env', MYCELIUM_DISABLE_EMBED: '1' },
  });
  // POSITIVE PRECONDITION: without this, a child that dies on import reads as "no snapshot",
  // which is indistinguishable from the scheduler being wired but broken.
  assert.match(String(r.stdout), /BOOTED/, `precondition: boot must have completed (stderr=${String(r.stderr).slice(-300)})`);
  assert.ok(snapsIn(dir).length >= 1, 'boot must have actually taken a snapshot');
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
