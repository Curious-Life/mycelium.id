// verify:narration-job — the UI-controlled narration walk lifecycle (src/jobs.js +
// narration_runs, Phase 3). With an injected stub walk (no model):
//   J1 start → narration_runs row (running) + runId; single-flight (2nd start = already)
//   J2 onProgress persists counts + done_ids checkpoint into narration_runs
//   J3 pause → status 'paused'; the walk's shouldStop() sees it and stops AFTER the
//      current entity (never mid-write) — done_ids holds the completed entity
//   J4 resume → status 'running', re-invokes the walk with skipIds = the checkpoint,
//      runs to completion → status 'done'
//   J5 cancel → status 'canceled'
//   J12 the CHRONICLE wrapper (startChronicleNarrationJob) spawns its child with
//       MYCELIUM_DESCRIBE_PRESERVE=1 by default — observed in the env the child
//       actually received, not grepped from the source line
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { setSessionKeys } from '../src/account/session-keys.js';
import {
  startNarrationWalkJob, startChronicleNarrationJob, pauseNarration, resumeNarration, cancelNarration, getNarrationStatus, _resetNarration,
} from '../src/jobs.js';

const DB = 'data/verify-narration-job.db', KCV = 'data/verify-narration-job-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
_resetNarration();

// ── Stub walk: process entity 1, HOLD at a gate, then honor shouldStop (pause) ──
let release; const gate = new Promise((r) => { release = r; });
let stopSeenAfterRelease = null;
const ENT = (k, id) => ({ kind: k, id });
const stubWalk = async ({ onProgress, shouldStop }) => {
  await onProgress({ doneKey: 'territory:1', described: 1, reflected: 0, skipped: 0, total: 3, item: ENT('territory', 1) });
  await gate;                              // gate lets the test pause between entities
  stopSeenAfterRelease = await shouldStop();
  if (stopSeenAfterRelease) return;        // paused/canceled → stop cleanly (checkpoint kept)
  await onProgress({ doneKey: 'territory:2', described: 2, reflected: 0, skipped: 0, total: 3, item: ENT('territory', 2) });
};

// `provider: 'local:test'` is passed DELIBERATELY and must be IGNORED — see J1.
const { runId, status } = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: stubWalk });
await settle();

// J1 — row created, running, runId returned
//
// ⚠️ THIS CHECK USED TO ASSERT `row1.provider === 'local:test'` — i.e. that a caller's label
// lands on the row verbatim. That was the DEFECT, not the contract: NarrateControl regex-matched
// that name to tell the user whether narration content left their machine, so a provider labelled
// "localai" rendered as "on-box" while its content went to an internet host — and the string was
// never a fact about the run anyway (the walk resolves its provider server-side, per turn). The
// job no longer accepts the label; the destination is OBSERVED as the walk runs. Inverted here
// rather than deleted, so the echo cannot come back unnoticed.
// @see scripts/verify-narrate-device-claim.mjs (the fact it was replaced with)
const row1 = await getNarrationStatus({ db, runId, userId: U });
rec('J1. start → runId + narration_runs row (running); a caller-supplied provider label is IGNORED',
  status === 'running' && row1 && row1.status === 'running' && row1.provider == null,
  `runId=${runId?.slice(0, 8)} status=${row1?.status} provider=${JSON.stringify(row1?.provider)} (must be null — the client does not author the sovereignty claim)`);

// J1b — single-flight: a second start while running returns the same run (already)
const second = await startNarrationWalkJob({ db, userId: U, scope: 'all', runWalk: stubWalk });
rec('J1b. single-flight: 2nd start while running is rejected (already)', second.already === true && second.runId === runId,
  `already=${second.already} sameRun=${second.runId === runId}`);

// J2 — onProgress persisted entity-1 into the checkpoint
const row2 = await getNarrationStatus({ db, runId, userId: U });
rec('J2. onProgress persists counts + done_ids checkpoint', row2.described === 1 && row2.total === 3 && JSON.parse(row2.done_ids).includes('territory:1'),
  `described=${row2.described} total=${row2.total} done_ids=${row2.done_ids}`);

// J3 — pause (running → paused)
const paused = await pauseNarration({ db, runId });
rec('J3. pause flips running → paused', paused.ok === true && paused.status === 'paused', `resp=${JSON.stringify(paused)}`);

// release the gate → the walk checks shouldStop (now paused) and stops after entity 1
release(); await settle();
const row3 = await getNarrationStatus({ db, runId, userId: U });
rec('J3b. walk honored shouldStop: stopped after current entity, status stays paused, checkpoint kept',
  stopSeenAfterRelease === true && row3.status === 'paused' && JSON.parse(row3.done_ids).join(',') === 'territory:1' && row3.described === 1,
  `stopSeen=${stopSeenAfterRelease} status=${row3.status} done=${row3.done_ids}`);

// J4 — resume from checkpoint: stub2 must receive skipIds = ['territory:1'] and complete
let resumeSkipIds = null;
const stubWalk2 = async ({ skipIds, onProgress }) => {
  resumeSkipIds = skipIds.slice();
  await onProgress({ doneKey: 'realm:5', described: 2, reflected: 1, skipped: 0, total: 3, item: ENT('realm', 5) });
  // ⚠️ RETURNS A REAL SHAPE. It used to return undefined, so J4 asserted 'done' for a walk that
  // reported NOTHING — i.e. the bug J8 pins, encoded as the expectation (independent review,
  // 2026-07-16). A stub that doesn't answer like the real thing tests the stub.
  return { described: 2, reflected: 1, skipped: 0, failed: 0, total: 3, ledger: [], doneKeys: ['realm:5'] };
};
const resumed = await resumeNarration({ db, userId: U, runId, runWalk: stubWalk2 });
await settle();
const row4 = await getNarrationStatus({ db, runId, userId: U });
rec('J4. resume → running with skipIds=checkpoint, runs to completion → done',
  resumed.ok === true && Array.isArray(resumeSkipIds) && resumeSkipIds.join(',') === 'territory:1' && row4.status === 'done' && JSON.parse(row4.done_ids).includes('realm:5'),
  `skipIds=${JSON.stringify(resumeSkipIds)} status=${row4.status} done=${row4.done_ids}`);

// J5 — cancel a fresh run (held at gate)
_resetNarration();
let release2; const gate2 = new Promise((r) => { release2 = r; });
const stubWalk3 = async ({ onProgress, shouldStop }) => {
  await onProgress({ doneKey: 'territory:9', described: 1, total: 2, item: ENT('territory', 9) });
  await gate2; if (await shouldStop()) return;
};
const run2 = await startNarrationWalkJob({ db, userId: U, scope: { realm_id: 5 }, runWalk: stubWalk3 });
await settle();
const cancelled = await cancelNarration({ db, runId: run2.runId });
release2(); await settle();
const row5 = await getNarrationStatus({ db, runId: run2.runId, userId: U });
rec('J5. cancel flips → canceled; the walk stops (checkpoint preserved)',
  cancelled.ok === true && cancelled.status === 'canceled' && row5.status === 'canceled' && JSON.parse(row5.done_ids).includes('territory:9'),
  `resp=${JSON.stringify(cancelled)} status=${row5.status} done=${row5.done_ids}`);

// ── J6/J7 ⭐ "done" IS A CLAIM, AND IT WAS MADE UNCONDITIONALLY ───────────────
// A run in which EVERY turn failed — a dead Ollama, or a §4g refusal with nothing safe to run
// on — reported exactly the same 'done' as a run that described everything. The walk's counters
// were honest; the STATUS was not, and the status is what the UI reads. This branch shipped
// ungated (independent review, 2026-07-16 — the review found it, no gate did).
{
  const deadWalk = async ({ onProgress }) => {
    await onProgress({ doneKey: null, described: 0, reflected: 0, skipped: 0, failed: 2, total: 2, item: ENT('territory', 9) });
    return { described: 0, reflected: 0, skipped: 0, failed: 2, total: 2, ledger: [], doneKeys: [] };
  };
  const r = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: deadWalk });
  await settle();
  const row = await getNarrationStatus({ db, runId: r.runId, userId: U });
  rec('J6. ⭐ every turn failed + nothing described ⇒ status ERROR, not "done"',
    row?.status === 'error' && /produced nothing/i.test(row?.error || ''),
    `status=${row?.status} error=${row?.error}`);
}
{
  // …but a PARTIAL failure is still a real run: it described things. Reporting `error` there
  // would be the mirror mistake — a false failure over a run that did work.
  const partialWalk = async ({ onProgress }) => {
    await onProgress({ doneKey: 'territory:7', described: 5, reflected: 0, skipped: 0, failed: 50, total: 55, item: ENT('territory', 7) });
    return { described: 5, reflected: 0, skipped: 0, failed: 50, total: 55, ledger: [], doneKeys: ['territory:7'] };
  };
  const r = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: partialWalk });
  await settle();
  const row = await getNarrationStatus({ db, runId: r.runId, userId: U });
  rec('J7. a PARTIAL failure (5 described, 50 failed) still reports done — it DID work',
    row?.status === 'done', `status=${row?.status}`);
}

// ── J8/J9 ⭐ RESUME IS THE RETRY PATH, AND IT CLAIMED `done` TOO ──────────────
// The first fix landed on START only. Resume is exactly where this bites: the user pauses a
// stalling walk, resumes with Ollama STILL dead, every turn fails — and the UI said "done".
// Two copies of one rule is how a rule drifts, so both paths now call finishNarrationRun
// (independent review, 2026-07-16 — J6/J7 only ever drove startNarrationWalkJob).
// resumeNarration requires status==='paused' (jobs.js), so the run must be HELD open long
// enough to pause it — a walk that returns immediately is 'done' before pause can land, and
// then resume is rejected and asserts nothing.
async function pausedRun() {
  let release; const hold = new Promise((r) => { release = r; });
  const holdWalk = async () => { await hold; return { described: 0, reflected: 0, skipped: 0, failed: 0, total: 0, ledger: [], doneKeys: [] }; };
  const started = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: holdWalk });
  await settle();
  await pauseNarration({ db, userId: U, runId: started.runId });
  release();
  await settle();   // the held walk returns; finishNarrationRun bails (status !== 'running')
  return started.runId;
}
{
  const deadResume = async ({ onProgress }) => {
    await onProgress({ doneKey: null, described: 0, reflected: 0, skipped: 0, failed: 3, total: 3, item: ENT('territory', 4) });
    return { described: 0, reflected: 0, skipped: 0, failed: 3, total: 3, ledger: [], doneKeys: [] };
  };
  const runId8 = await pausedRun();
  const resumed8 = await resumeNarration({ db, userId: U, runId: runId8, runWalk: deadResume });
  await settle();
  const row = await getNarrationStatus({ db, runId: runId8, userId: U });
  rec('J8. ⭐ RESUME with an all-failed walk ⇒ status ERROR, not "done" (resume is the RETRY path)',
    row?.status === 'error' && /produced nothing/i.test(row?.error || ''),
    `resumed=${JSON.stringify(resumed8)} status=${row?.status} error=${row?.error}`);
}
{
  const partialResume = async ({ onProgress }) => {
    await onProgress({ doneKey: 'territory:8', described: 3, reflected: 0, skipped: 0, failed: 9, total: 12, item: ENT('territory', 8) });
    return { described: 3, reflected: 0, skipped: 0, failed: 9, total: 12, ledger: [], doneKeys: ['territory:8'] };
  };
  const runId9 = await pausedRun();
  await resumeNarration({ db, userId: U, runId: runId9, runWalk: partialResume });
  await settle();
  const row = await getNarrationStatus({ db, runId: runId9, userId: U });
  rec('J9. …and a PARTIAL failure on resume still reports done — same rule, both paths',
    row?.status === 'done', `status=${row?.status}`);
}

{
  // J7b — a re-run of an already-narrated vault (everything coverage-skipped) with a couple of
  // transient turn failures is NOT an error: the mind is fully narrated, nothing needed doing.
  const skipHeavy = async ({ onProgress }) => {
    await onProgress({ doneKey: 'territory:30', described: 0, reflected: 0, skipped: 18, failed: 2, total: 20, item: ENT('territory', 30) });
    return { described: 0, reflected: 0, skipped: 18, failed: 2, total: 20, ledger: [], doneKeys: [] };
  };
  const rid = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: skipHeavy });
  await settle();
  const row = await getNarrationStatus({ db, runId: rid.runId, userId: U });
  rec('J7b. skip-heavy re-run with a few transient fails (wrote 0, skipped 18) ⇒ done, NOT a false error',
    row?.status === 'done', `status=${row?.status} error=${row?.error}`);
}

// ── J10/J11: the GLOBAL activity feed reaches a TERMINAL status on RESUME too ──
// The review's MED-1: resume's finally never called activityFeed.finish, so a RESUMED run
// (the retry path) that completed showed 'abandoned' in the header feed forever, and one that
// errored never surfaced 'error' there — the pause had already flipped the row terminal and
// heartbeat() is `WHERE status='running'`. The dedicated NarrateControl reads narration_runs
// directly (always correct); this pins the GLOBAL feed row, which start already got right.
const feedRow = (runId) => db.rawQuery(
  `SELECT status FROM background_jobs WHERE id = ?`, [runId],
).then((r) => (Array.isArray(r) ? r : r.results || [])[0] || null);
{
  const okResume = async ({ onProgress }) => {
    await onProgress({ doneKey: 'territory:20', described: 4, reflected: 0, skipped: 0, failed: 0, total: 4, item: ENT('territory', 20) });
    return { described: 4, reflected: 0, skipped: 0, failed: 0, total: 4, ledger: [], doneKeys: ['territory:20'] };
  };
  const runId10 = await pausedRun();
  await resumeNarration({ db, userId: U, runId: runId10, runWalk: okResume });
  await settle();
  const feed = await feedRow(runId10);
  rec('J10. ⭐ resume that COMPLETES ⇒ the global feed row is `done`, not stuck `abandoned`',
    feed?.status === 'done', `feed=${JSON.stringify(feed)}`);
}
{
  const deadResume = async () => ({ described: 0, reflected: 0, skipped: 0, failed: 3, total: 3, ledger: [], doneKeys: [] });
  const runId11 = await pausedRun();
  await resumeNarration({ db, userId: U, runId: runId11, runWalk: deadResume });
  await settle();
  const feed = await feedRow(runId11);
  rec('J11. …and a resume where every turn FAILS ⇒ the global feed row is `error`, not `abandoned`',
    feed?.status === 'error', `feed=${JSON.stringify(feed)}`);
}

// ── J12/J12b ⭐ THE CHRONICLE WRAPPER'S PRESERVE DEFAULT IS PART OF THE CONTRACT ──
// PR #213 review F4: mutating jobs.js's chronicle childEnv `MYCELIUM_DESCRIBE_PRESERVE:
// … ?? '1'` to `?? '0'` left this suite AND verify:describe-preserve green — the pipeline's
// preserve BEHAVIOR was gated (P1-P3) but nothing pinned that the production spawn actually
// ASKS for it. A flipped default silently rewrites existing/imported chronicles with the
// local model on every background pass. So: drive the REAL spawn and read the env the child
// RECEIVED — a PATH-shimmed `node` records it — because asserting the source line would be
// satisfied by the form, not the usage.
{
  // The wrapper re-resolves master keys at spawn (getSessionKeys ?? resolveKeys); pin the
  // gate's injected keys the way completeBoot does so no key source is consulted.
  setSessionKeys({ userHex, systemHex });
  const SHIMDIR = path.resolve('data/verify-narration-job-shim');
  mkdirSync(SHIMDIR, { recursive: true });
  const ENVOUT = path.join(SHIMDIR, 'child-env.json');
  // Fake `node`: dump the two env vars under test, write-then-rename so the reader
  // never sees a partial file, exit 0 (the wrapper treats 0 as a clean pass).
  writeFileSync(path.join(SHIMDIR, 'node'),
    `#!/bin/sh\nprintf '{"preserve":%s,"territory":%s}' "\${MYCELIUM_DESCRIBE_PRESERVE+\\"$MYCELIUM_DESCRIBE_PRESERVE\\"}" "\${MYCELIUM_DESCRIBE_TERRITORY+\\"$MYCELIUM_DESCRIBE_TERRITORY\\"}" > "${ENVOUT}.$$"\nmv "${ENVOUT}.$$" "${ENVOUT}"\n`);
  chmodSync(path.join(SHIMDIR, 'node'), 0o755);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFile = async (f, ms = 8000) => {
    const t0 = Date.now();
    while (!existsSync(f)) { if (Date.now() - t0 > ms) return false; await sleep(25); }
    return true;
  };
  // Empty printf args JSON-encode as nothing → patch to null so a MISSING var is
  // distinguishable from a set-but-empty one.
  const readEnvOut = (f) => JSON.parse(readFileSync(f, 'utf8').replace(/:\s*([,}])/g, ':null$1'));

  const realPath = process.env.PATH;
  const hadPreserve = Object.prototype.hasOwnProperty.call(process.env, 'MYCELIUM_DESCRIBE_PRESERVE');
  const savedPreserve = process.env.MYCELIUM_DESCRIBE_PRESERVE;
  try {
    delete process.env.MYCELIUM_DESCRIBE_PRESERVE;      // the DEFAULT path is the one under test
    process.env.PATH = `${SHIMDIR}:${realPath}`;        // childEnv.PATH copies process.env.PATH

    const r1 = startChronicleNarrationJob({ dbPath: DB, userId: U });
    const got1 = r1.pid != null && await waitFile(ENVOUT);
    const env1 = got1 ? readEnvOut(ENVOUT) : null;
    rec('J12. ⭐ chronicle wrapper spawns with MYCELIUM_DESCRIBE_PRESERVE=1 by DEFAULT (observed in the child env)',
      env1?.preserve === '1' && env1?.territory == null,
      `pid=${r1.pid} childEnv=${JSON.stringify(env1)} (a flipped default rewrites existing chronicles on every background pass)`);

    // …and the default must stay an OVERRIDABLE default, not a hardcode: the documented
    // MYCELIUM_DESCRIBE_PRESERVE=0 escape hatch has to reach the child verbatim.
    rmSync(ENVOUT, { force: true });
    process.env.MYCELIUM_DESCRIBE_PRESERVE = '0';
    let r2 = { pid: null };
    { // single-flight: wait for run 1's close handler to clear the running flag
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { r2 = startChronicleNarrationJob({ dbPath: DB, userId: U }); if (r2.pid != null) break; await sleep(25); }
    }
    const got2 = r2.pid != null && await waitFile(ENVOUT);
    const env2 = got2 ? readEnvOut(ENVOUT) : null;
    rec('J12b. …and an explicit MYCELIUM_DESCRIBE_PRESERVE=0 override reaches the child (default, not hardcode)',
      env2?.preserve === '0', `pid=${r2.pid} childEnv=${JSON.stringify(env2)}`);
    await sleep(150);                                   // let run 2's close handler fire before teardown
  } finally {
    process.env.PATH = realPath;
    if (hadPreserve) process.env.MYCELIUM_DESCRIBE_PRESERVE = savedPreserve;
    else delete process.env.MYCELIUM_DESCRIBE_PRESERVE;
    rmSync(SHIMDIR, { recursive: true, force: true });
  }
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration job: start · single-flight · checkpoint · pause(stop-after-entity) · resume(skip-done) · cancel · chronicle-spawn PRESERVE default' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
