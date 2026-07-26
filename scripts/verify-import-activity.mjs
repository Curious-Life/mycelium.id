// verify:import-activity — imports publish to the ONE progress surface (design §3.4, §7 A1/A2).
//
// A1  an import publishes begin → heartbeat → finish, under the `import` kind
// A2  the feed rows stay CONTENT-FREE with an import in flight — this is the one that
//     matters: background_jobs is content-free BY CONTRACT (db/activity-feed.js §SECURITY),
//     and recent() already SELECTs `error` — only portal-activity.js's shape() drops it
//     today. Publishing content-free is what lets that projection widen without
//     re-auditing every publisher (defense in depth, CLAUDE.md §2 — not a live leak).
//     An import error routinely names a file path or quotes the row it choked on.
//     (NOT the reason: that d1QueryAdmin is "non-encrypting" — ENCRYPTED_FIELDS covers
//     only `secrets`, and at-rest is whole-file SQLCipher. Verified false 2026-07-16.)
// A3  publishing can NEVER break the import — the feed is a mirror, not a dependency
// A4  two sequential imports are two rows, not one reopened (begin() upserts ON CONFLICT)
// A5  ⚠️ THE REAL ROUTE publishes — not just an injected double. The first draft of this
//     gate constructed the runner by hand in every check, so deleting the production
//     wiring (`activityFeed: db?.activityFeed`) left it printing GO on a dead feature
//     (independent review, 2026-07-16). A5/A6 boot the actual REST server.
//
// The KEEP-ALIVE (A1b) is the load-bearing one: activity-feed.js reaps a 'running' row
// after STALE_MS (45s) and its heartbeat() is `WHERE status='running'`, so a reaped row can
// never be revived — while finish() has no such guard and resurrects it at the end. Beats
// must therefore come from a TIMER, not from onProgress, or every quiet importer dies
// mid-run and comes back at completion.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createImportJobRunner } from '../src/ingest/import-job.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 5000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return false;
}

// Records every call the runner makes, so the assertions read the real published payload.
function mkFeed() {
  const calls = { begin: [], heartbeat: [], finish: [] };
  return {
    calls,
    async begin(a) { calls.begin.push(a); return a.id; },
    async heartbeat(id, a) { calls.heartbeat.push({ id, ...a }); },
    async finish(id, a) { calls.finish.push({ id, ...a }); },
  };
}
// A hand-driven stand-in for setInterval, so the keep-alive is exercised deterministically
// instead of by sleeping past a real 1s tick.
function mkSchedule() {
  let fn = null, cancelled = false;
  const install = (f) => { fn = f; return () => { cancelled = true; fn = null; }; };
  return { install, tick: () => fn?.(), armed: () => !!fn, cancelled: () => cancelled };
}

await t('A1. an import publishes begin → finish under the `import` kind', async () => {
  const feed = mkFeed();
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u' });
  jobs.start({ key: 'recent-export', label: 'Importing Mycelium recent export', run: async () => ({ imported: 3 }) });
  await waitFor(() => feed.calls.finish.length > 0);
  assert.equal(feed.calls.begin.length, 1, 'begin must fire once');
  assert.equal(feed.calls.begin[0].kind, 'import', 'under the `import` kind — the gap §3.4 names');
  assert.equal(feed.calls.begin[0].userId, 'u');
  assert.equal(feed.calls.finish.length, 1, 'finish must fire once');
  assert.equal(feed.calls.finish[0].status, 'done');
});

// ── A1b) THE KEEP-ALIVE — the reap bug ───────────────────────────────────────
await t('A1b. an importer that goes QUIET is still kept alive (the reap bug)', async () => {
  const feed = mkFeed(); const sched = mkSchedule();
  let release; const gate = new Promise((r) => { release = r; });
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u', schedule: sched.install });
  // The degenerate case of a REAL gap: recent-export reads two JSON arrays + every
  // attachment's bytes before its first emit(), and the sweep walks every file before its
  // own — either can exceed 45s on a real bundle. An onProgress-driven beat gives those
  // stretches ZERO heartbeats: reaped at 45s, gone from the feed, then resurrected 'done' by
  // finish(). (full-export omits onProgress ENTIRELY — registry.js — but nothing routes it
  // through this runner, so it is not the live example; see import-job.js's header.)
  jobs.start({ key: 'recent-export', label: 'Importing Mycelium recent export', run: async () => { await gate; return { imported: 1 }; } });
  await waitFor(() => sched.armed());
  sched.tick(); sched.tick(); sched.tick();
  assert.equal(feed.calls.heartbeat.length, 3,
    'the beat MUST come from the timer, not from onProgress — this importer never reports any');
  release();
  await waitFor(() => feed.calls.finish.length > 0);
  assert.ok(sched.cancelled(), 'and the timer must be cleared when the job ends — otherwise it leaks forever');
});

await t('A1c. beats carry the CURRENT counters, and are per-TICK not per-ROW', async () => {
  const feed = mkFeed(); const sched = mkSchedule();
  let release; const gate = new Promise((r) => { release = r; });
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u', schedule: sched.install });
  jobs.start({
    key: 'recent-export',
    run: async ({ onProgress }) => {
      for (let i = 1; i <= 50; i++) onProgress({ processed: i, total: 50 });
      await gate; return { imported: 50 };
    },
  });
  await waitFor(() => sched.armed());
  sched.tick();
  assert.equal(feed.calls.heartbeat.length, 1, '50 rows must NOT be 50 DB writes — the tick owns publishing');
  assert.equal(feed.calls.heartbeat[0].step, 50, 'and the tick must publish the LATEST counters');
  assert.equal(feed.calls.heartbeat[0].totalSteps, 50);
  release(); await waitFor(() => feed.calls.finish.length > 0);
});

await t('A1d. the FINAL counters are published before the terminal transition', async () => {
  const feed = mkFeed(); const sched = mkSchedule();
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u', schedule: sched.install });
  // No ticks at all: every count lands between beats. finish() carries only {status,error} —
  // no step — so without an explicit final beat this row reads "9,800/10,000 · Done" forever.
  jobs.start({
    key: 'recent-export',
    run: async ({ onProgress }) => { onProgress({ processed: 9800, total: 10000 }); onProgress({ processed: 10000, total: 10000 }); return { imported: 10000 }; },
  });
  await waitFor(() => feed.calls.finish.length > 0);
  const last = feed.calls.heartbeat.at(-1);
  assert.ok(last, 'a final beat MUST fire even when no tick ever did');
  assert.equal(last.step, 10000, 'the history row must read 10,000/10,000 — not 9,800/10,000 · Done, permanently');
  assert.equal(last.totalSteps, 10000);
});

// ── A2) THE LEAK CHECK ────────────────────────────────────────────────────────
await t('A2. an import FAILURE never publishes the reason (it names file paths / row content)', async () => {
  const feed = mkFeed();
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u' });
  const SECRET = '/Users/owner/Desktop/therapy-journal-2019.md: unexpected token in "I told her I was afraid"';
  jobs.start({ key: 'recent-export', run: async () => { throw new Error(SECRET); } });
  await waitFor(() => feed.calls.finish.length > 0);
  const published = JSON.stringify(feed.calls);
  assert.equal(feed.calls.finish[0].status, 'error', 'the FACT of failure is publishable');
  assert.ok(!published.includes('therapy-journal'), 'a FILE PATH must never reach background_jobs — the table is content-free by contract');
  assert.ok(!published.includes('I told her'), 'nor a quoted line of the user\'s content');
  assert.equal(feed.calls.finish[0].error, 'import failed', 'the feed gets a CONSTANT');
  // …and the real reason is still available to the owner over the authed route.
  assert.ok(jobs.progress().error.includes('therapy-journal'),
    'the detail must survive in the job envelope — in-memory, behind /import/run/progress');
});

// ── A3) the feed must never break the import ─────────────────────────────────
await t('A3. a THROWING feed does not break the import (mirror, not dependency)', async () => {
  const brokenFeed = {
    async begin() { throw new Error('feed down'); },
    async heartbeat() { throw new Error('feed down'); },
    async finish() { throw new Error('feed down'); },
  };
  const jobs = createImportJobRunner({ activityFeed: brokenFeed, userId: 'u' });
  jobs.start({ key: 'recent-export', run: async ({ onProgress }) => { onProgress({ processed: 1, total: 1 }); return { imported: 1 }; } });
  const done = await waitFor(() => jobs.progress().status === 'done');
  assert.ok(done, 'a broken activity feed MUST NOT fail the import — the work outranks the mirror');
  assert.equal(jobs.progress().imported, 1);
});

await t('A3b. NO feed at all ⇒ the import behaves exactly as before', async () => {
  const jobs = createImportJobRunner();   // no activityFeed — the pre-D construction
  jobs.start({ key: 'recent-export', run: async () => ({ imported: 2 }) });
  const done = await waitFor(() => jobs.progress().status === 'done');
  assert.ok(done, 'publishing is optional; its absence changes nothing');
});

// ── A4) two runs = two rows ───────────────────────────────────────────────────
// ⚠️ A4 CAN NO LONGER FAIL, and that is a property of the fix, not of this check. feedId now
// carries `++runSeq` (import-job.js), so two ids differ by construction — A4's assertion is
// true whatever the clock does. It is kept because the PROPERTY it names is the reason the seq
// exists, and a reader deleting the seq should meet a red check; but the teeth are now A7c's
// (it constructs the same-millisecond case A4's advancing clock can't reach). Recorded rather
// than left for someone to discover: an unfailable check is exactly the defect the A7 block
// below exists to retire, and this one is unfailable ON PURPOSE (2026-07-16).
await t('A4. two sequential imports are TWO feed rows (begin() upserts ON CONFLICT(id))', async () => {
  const feed = mkFeed();
  let clock = 1000;
  const jobs = createImportJobRunner({ activityFeed: feed, userId: 'u', now: () => (clock += 5) });
  jobs.start({ key: 'recent-export', run: async () => ({}) });
  await waitFor(() => feed.calls.finish.length === 1);
  jobs.start({ key: 'full-export', run: async () => ({}) });
  await waitFor(() => feed.calls.finish.length === 2);
  const [a, b] = feed.calls.begin;
  assert.notEqual(a.id, b.id,
    'a shared id would REOPEN the first row (ON CONFLICT DO UPDATE) and erase the first run from history');
});

// ── A7) WHAT SINGLE-FLIGHT ACTUALLY GUARANTEES ───────────────────────────────
// import-job.js's header claimed "one import at a time. Two concurrent vault writers
// corrupted the live vault once (2026-06-30)". Both halves were false: portal-import.js
// runs TWO runner instances (each single-flight only on itself), and the concurrency root
// cause was REFUTED by scripts/vault-repair/repro-corruption.mjs. These checks pin the
// comment's replacement, so it cannot quietly drift back into overstating the guarantee.
await t('A7b. single-flight is per-INSTANCE: a re-start while running re-attaches (idempotent re-click)', async () => {
  // The clock is INJECTED and advances on every read (the A4 pattern) — that is what gives the
  // startedAt assertion below its teeth. Under a real clock both starts land in the same
  // millisecond whether single-flight works or not, so the equality passed either way; a first
  // pass at this check "fixed" that by asserting `second.status === 'running'` and
  // `first.key === second.key` instead, which a FRESH job satisfies just as well (start() sets
  // status:'running' on every job, and both calls pass the same spec). That was the same
  // decorative-assertion defect this A7 block exists to retire, so it is repaired rather than
  // deleted — second review, 2026-07-16.
  let clock = 1000;
  const jobs = createImportJobRunner({ now: () => (clock += 5) });
  let release; const gate = new Promise((r) => { release = r; });
  let runs = 0;
  const spec = { key: 'recent-export', run: async () => { runs++; await gate; return { imported: 1 }; } };
  const first = jobs.start(spec);
  const second = jobs.start(spec);   // the re-click
  assert.equal(runs, 1, 'a second start on the SAME runner must NOT spawn a second importer — it would double-scan the source');
  // A ticking clock means a NEW job would necessarily carry a LATER startedAt. Identical
  // startedAt therefore proves the re-click was handed back the RUNNING job.
  assert.equal(second.startedAt, first.startedAt,
    'the re-click must re-attach to the RUNNING job, not report a fresh one');
  release(); await waitFor(() => jobs.progress().status === 'done');
});

await t('A7b2. …and it does NOT extend across instances (the two portal-import.js builds)', async () => {
  const a = createImportJobRunner(); const b = createImportJobRunner();
  let release; const gate = new Promise((r) => { release = r; });
  a.start({ key: 'recent-export', run: async () => { await gate; return {}; } });
  let bRan = false;
  b.start({ key: 'local-files', run: async () => { bRan = true; return {}; } });
  await waitFor(() => b.progress().status === 'done');
  assert.ok(bRan, 'a second RUNNER must be free to run while the first is busy — this is deliberate, and the header must say so');
  assert.equal(a.progress().status, 'running', 'and it must not disturb the first');
  release(); await waitFor(() => a.progress().status === 'done');
});

await t('A7c. two runners starting in the SAME millisecond get DISTINCT feed ids', async () => {
  // The collision the two-instance design costs, and the reason feedId carries a seq.
  // Same frozen clock = same startedAt = what `import-${startedAt}` alone produced.
  const feed = mkFeed();
  const now = () => 1234567890;   // frozen: both runners start in the same ms
  const a = createImportJobRunner({ activityFeed: feed, userId: 'u', now });
  const b = createImportJobRunner({ activityFeed: feed, userId: 'u', now });
  a.start({ key: 'recent-export', label: 'Importing Mycelium recent export', run: async () => ({}) });
  b.start({ key: 'local-files', label: 'Importing files from this Mac', run: async () => ({}) });
  await waitFor(() => feed.calls.finish.length === 2);
  const [x, y] = feed.calls.begin;
  assert.notEqual(x.id, y.id,
    'a shared id makes begin() (ON CONFLICT(id) DO UPDATE) fold two live imports into ONE row: one vanishes from the feed, the other reads as the wrong import');
});

// ── A5/A6) THE REAL ROUTES — no doubles, no hand-built runner ────────────────
// Everything above would still pass if `activityFeed: db?.activityFeed` were deleted from
// portal-import.js. These two would not: they boot the server and read the feed back over
// the same /activity route the Header polls.
const DB = 'data/verify-import-activity.db';
const KCV = 'data/verify-import-activity-kcv.json';
const HOME = path.join(os.tmpdir(), `mycelium-import-activity-${process.pid}`);
const hex = () => crypto.randomBytes(32).toString('hex');
let srv = null;
try {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  try { rmSync(HOME, { recursive: true }); } catch {}
  mkdirSync('data', { recursive: true });
  // A fake HOME so the import path allowlist (detect-sources.js importAllowedRoots, derived
  // from os.homedir()) permits a scratch folder — never the operator's real ~/Documents.
  mkdirSync(path.join(HOME, 'Documents'), { recursive: true });
  process.env.HOME = HOME;

  const Database = (await import('better-sqlite3')).default;
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { startRestServer } = await import('../src/server-rest.js');
  const raw = new Database(DB); applyMigrations(raw); raw.close();
  srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const url = srv.url;
  const j = async (p, opts) => { const r = await fetch(`${url}${p}`, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const feedRows = async () => { const a = await j('/api/v1/portal/activity'); return [...(a.body?.active || []), ...(a.body?.recent || [])]; };

  await t('A5. POST /import/run — the REAL route publishes an `import` row (wiring is not theatre)', async () => {
    // An empty dir under the allowlisted fake HOME: the import fails, and its real reason
    // is an ENOENT that NAMES THE PATH — exactly the leak A2 pins, now end-to-end.
    const dirPath = path.join(HOME, 'Documents', 'not-an-export');
    mkdirSync(dirPath, { recursive: true });
    const r = await post('/api/v1/portal/import/run', { key: 'recent-export', dirPath });
    assert.equal(r.status, 200, `the route must accept the key — got ${r.status} ${JSON.stringify(r.body)}`);
    const got = await waitFor(async () => (await feedRows()).some((x) => x.kind === 'import'));
    assert.ok(got, 'a row with kind `import` MUST appear over /activity — if this fails, the feed is not wired to the route');
    const row = (await feedRows()).find((x) => x.kind === 'import');
    assert.equal(row.stage, 'Importing Mycelium recent export', 'the stage label is the registry CONSTANT, resolved by the route');
  });

  await t('A5b. …and the REAL route never leaks the failure reason into the content-free row', async () => {
    const prog = await j('/api/v1/portal/import/run/progress');
    const real = String(prog.body?.error || '');
    assert.ok(real, `the import must actually have failed for this check to mean anything — got ${JSON.stringify(prog.body)}`);
    const rows = await feedRows();
    const row = rows.find((x) => x.kind === 'import');
    assert.ok(row, 'the row must exist');
    // Whatever the real reason is, none of it may appear in the feed.
    assert.ok(!JSON.stringify(rows).includes(HOME),
      `the scratch path leaked into the feed: ${JSON.stringify(rows).slice(0, 200)}`);
    // (A trailing 4th assertion lived here and was DEAD — `!real.includes('import failed')
    //  || real === 'import failed'` is a tautology for any real ENOENT, and it asserted the
    //  opposite of its own message. Removed on re-review, 2026-07-16. This check's teeth are
    //  the two assertions above: the row exists, and the scratch path is nowhere in the feed.)
  });

  await t('A6. POST /import/local-files — the SWEEP publishes too (it was the one left off)', async () => {
    // The sweep is the longest import a new user runs ("10k+ files … indistinguishable from
    // 'hung' — the reported bug", portal-import.js) and it ran on a hand-rolled twin of the
    // runner, so it published NOTHING — while /import/run's comment already claimed the
    // envelope was "now shared" (independent review, 2026-07-16).
    writeFileSync(path.join(HOME, 'Documents', 'note.md'), '# a note\nsome text\n');
    // `categories` is now REQUIRED (D-070 consent gate — a missing selection is a 400, never
    // an implied "import everything"), so this feed check states the selection explicitly.
    const r = await post('/api/v1/portal/import/local-files', { folderPath: path.join(HOME, 'Documents'), categories: ['document', 'image', 'audio', 'video'] });
    assert.equal(r.status, 200, `sweep must start — got ${r.status} ${JSON.stringify(r.body)}`);
    const got = await waitFor(async () => (await feedRows()).some((x) => x.stage === 'Importing files from this Mac'));
    assert.ok(got, 'the local-files sweep MUST appear in the feed — this is the QA item 3 import');
    const rows = await feedRows();
    assert.ok(!JSON.stringify(rows).includes(HOME), 'and it must never publish a scanned PATH — the roots are the user\'s own filesystem layout');
  });

  await t('A6b. the sweep keeps its public shape across the migration (UI: SweepProgress)', async () => {
    await waitFor(async () => (await j('/api/v1/portal/import/local-files/progress')).body?.status !== 'running');
    const p = (await j('/api/v1/portal/import/local-files/progress')).body;
    for (const k of ['status', 'total', 'processed', 'imported', 'deduped', 'skipped', 'failed']) {
      assert.ok(k in p, `SweepProgress.${k} must survive the migration onto the shared runner (import/detect.ts)`);
    }
    assert.equal(typeof p.truncated, 'boolean', 'truncated is read by the UI and is NOT part of the generic envelope');
    assert.ok(['done', 'cancelled', 'error'].includes(p.status), `the sweep must reach a terminal status — got ${p.status}`);
  });
  // (There is deliberately NO "two concurrent in-process writers don't corrupt the vault" check
  //  here. A draft of this gate had one — 300 interleaved writes + quick_check — and independent
  //  review proved it VACUOUS: it passed unchanged with `Promise.all([write(1), write(2)])`
  //  serialized to `await write(1); await write(2)`, i.e. with the concurrency removed. It could
  //  not do otherwise. In-process simultaneous writers do not exist in this runtime (Node is
  //  single-threaded, better-sqlite3 is synchronous), so such a check asserts a tautology and
  //  labels it a falsifier — the same false-green this gate's A5 was written to kill, and a
  //  bigger one than the dead A5b assertion removed above.
  //  The claim it pretended to pin is CROSS-process, which is where the 2026-06-30 incident
  //  actually lived. The STANDING gate there is verify:writer-lock. (scripts/vault-repair/
  //  repro-corruption.mjs is where the refutation was PROVEN — it spawns real child writers,
  //  precisely because in-process proves nothing — but it is a one-shot harness, in no npm
  //  script; cite it as evidence, not as a gate.) Not re-implemented here; see import-job.js.)
} finally {
  try { srv?.server?.close(); srv?.close?.(); } catch {}
  try { rmSync(HOME, { recursive: true }); } catch {}
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — every async import publishes: kept alive by a timer, content-free, and never load-bearing' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
