// verify:measurement-health — proves the pipeline_state per-stage health ledger
// (src/db/pipeline-state.js) records success/failure/streak/quarantine correctly on
// a real booted vault, that the recorded failure reason is bounded + content-free,
// and that pipeline/lib/stage-result.js finalize() drives the recorder on both the
// clean and the incomplete path. PASS/FAIL ledger; exits 0 only if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createStageResult, StageIncompleteError } from '../pipeline/lib/stage-result.js';

const DB = 'data/verify-measurement-health.db', KCV = 'data/verify-measurement-health-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const PS = db.pipelineState;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

try {
  // 1. recordSuccess stamps success, zeroes streak/quarantine, stores details + duration.
  await PS.recordSuccess(U, 'stageA', { durationMs: 1234, details: { attempted: 10, written: 10, failed: 0 } });
  let a = await PS.get(U, 'stageA');
  rec('1. recordSuccess: last_success_at set, streak=0, quarantined=0, details + duration stored',
    !!a?.last_success_at && Number(a.consecutive_failures) === 0 && Number(a.quarantined) === 0
      && Number(a.last_duration_ms) === 1234 && JSON.parse(a.last_details_json).written === 10);

  // 2. recordFailure x1 → streak=1, not quarantined, reason stored.
  await PS.recordFailure(U, 'stageB', { reason: 'stageB: incomplete — 0/5 written, 5 failed (e.g. SQLITE_ERROR)' });
  let b = await PS.get(U, 'stageB');
  rec('2. recordFailure ×1: last_failure_at set, streak=1, quarantined=0, reason stored',
    !!b?.last_failure_at && Number(b.consecutive_failures) === 1 && Number(b.quarantined) === 0
      && /incomplete/.test(b.last_failure_reason));

  // 3. Two more failures → streak=3, quarantined=1 (the 3rd strike).
  await PS.recordFailure(U, 'stageB', { reason: 'again' });
  await PS.recordFailure(U, 'stageB', { reason: 'again2' });
  b = await PS.get(U, 'stageB');
  rec('3. recordFailure ×3 total → streak=3, quarantined=1', Number(b.consecutive_failures) === 3 && Number(b.quarantined) === 1,
    `streak=${b.consecutive_failures} quarantined=${b.quarantined}`);

  // 4. A success after failures clears the streak + quarantine.
  await PS.recordSuccess(U, 'stageB', { durationMs: 50 });
  b = await PS.get(U, 'stageB');
  rec('4. recordSuccess after failures → streak=0, quarantined=0', Number(b.consecutive_failures) === 0 && Number(b.quarantined) === 0);

  // 5. Reason is bounded ≤300 (content-free guarantee: even a huge message is truncated).
  await PS.recordFailure(U, 'stageC', { reason: 'X'.repeat(1000) });
  const c = await PS.get(U, 'stageC');
  rec('5. last_failure_reason bounded ≤300', (c.last_failure_reason || '').length <= 300, `len=${(c.last_failure_reason || '').length}`);

  // 6. all() returns every stage row.
  const all = await PS.all(U);
  rec('6. all() returns all stage rows', all.length === 3 && all.every((r) => r.stage_name && 'consecutive_failures' in r));

  // 7. finalize() INCOMPLETE path → throws + writes a failure row.
  {
    const r = createStageResult('stageD', { record: PS.recorderFor(U, 'stageD') });
    r.fail(new Error('SQLITE_CONSTRAINT')); r.fail(new Error('SQLITE_CONSTRAINT'));
    let threw = false;
    try { await r.finalize(); } catch (e) { threw = e instanceof StageIncompleteError; }
    const d = await PS.get(U, 'stageD');
    rec('7. finalize() incomplete → throws + pipeline_state failure row written',
      threw && !!d?.last_failure_at && Number(d.consecutive_failures) === 1);
  }

  // 8. finalize() CLEAN path → no throw + writes a success row with details.
  {
    const r = createStageResult('stageE', { record: PS.recorderFor(U, 'stageE') });
    r.ok(); r.ok(); r.ok();
    let threw = false;
    try { await r.finalize(); } catch { threw = true; }
    const e = await PS.get(U, 'stageE');
    rec('8. finalize() clean → no throw + pipeline_state success row with details',
      !threw && !!e?.last_success_at && JSON.parse(e.last_details_json).written === 3);
  }
} finally {
  close();
}

const passed = ledger.filter(Boolean).length;
const ok = passed === ledger.length;
console.log(`\n${ok ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${passed}/${ledger.length} passed`);
process.exit(ok ? 0 : 1);
