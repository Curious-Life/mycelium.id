// verify:narration-job — the UI-controlled narration walk lifecycle (src/jobs.js +
// narration_runs, Phase 3). With an injected stub walk (no model):
//   J1 start → narration_runs row (running) + runId; single-flight (2nd start = already)
//   J2 onProgress persists counts + done_ids checkpoint into narration_runs
//   J3 pause → status 'paused'; the walk's shouldStop() sees it and stops AFTER the
//      current entity (never mid-write) — done_ids holds the completed entity
//   J4 resume → status 'running', re-invokes the walk with skipIds = the checkpoint,
//      runs to completion → status 'done'
//   J5 cancel → status 'canceled'
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  startNarrationWalkJob, pauseNarration, resumeNarration, cancelNarration, getNarrationStatus, _resetNarration,
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

const { runId, status } = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'local:test', runWalk: stubWalk });
await settle();

// J1 — row created, running, runId returned
const row1 = await getNarrationStatus({ db, runId, userId: U });
rec('J1. start → runId + narration_runs row (running)', status === 'running' && row1 && row1.status === 'running' && row1.provider === 'local:test',
  `runId=${runId?.slice(0, 8)} status=${row1?.status} provider=${row1?.provider}`);

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

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration job: start · single-flight · checkpoint · pause(stop-after-entity) · resume(skip-done) · cancel' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
