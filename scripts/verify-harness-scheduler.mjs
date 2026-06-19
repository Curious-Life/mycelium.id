// verify:harness-scheduler — the autonomous wake-cycle RUNTIME (src/agent/scheduler.js
// + src/agent/lane.js) over a REAL booted vault, with a STUBBED turn-executor + deliver
// spy so it proves orchestration, not inference. Spec §5.5/§5.6.
//   G1 a due task fires once → run recorded 'done', next_run advanced, run_count bumped
//   G2 single-flight: two overlapping ticks fire a (slow) task exactly once
//   G3 dedup: a task completed within the window is skipped (skipped-dup), no re-fire
//   G4 'once' with a past scheduledAt → completed (no lingering active/null next_run)
//   G5 output_target 'chat' → deliver sink receives the text; 'none' does not
//   G6 a throwing turn → finishRun 'error' with a CODE only (no plaintext leak)
//   G7 skipped 'no-model' → run 'skipped-no-model', task advanced, no delivery
//   G8 reconcileOnBoot flips a stranded running run → aborted (boot recovery)
//   G9 future + paused tasks are never fired
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createScheduler } from '../src/agent/scheduler.js';
import { createLane } from '../src/agent/lane.js';

const DB = 'data/verify-harness-scheduler.db', KCV = 'data/verify-harness-scheduler-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const H = db.harness;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
const rawRead = (sql, params = []) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).get(...params); } finally { d.close(); } };

// Mutable turn-executor stub + delivery spy. The scheduler calls runTurn(task) instead
// of building a real inference turn, so this gate exercises pure orchestration.
let stub = async () => ({ text: 'STUB-OK' });
const calls = [];
const delivered = [];
const s = createScheduler({
  db, userId: U, tools: [], handlers: {},
  runTurn: async (task) => { calls.push(task.id); return stub(task); },
  deliver: async (task, text) => { delivered.push({ id: task.id, text }); },
  logger: () => {},
});
const drain = () => s._lane.enqueue(() => Promise.resolve()); // resolves after all queued tasks settle
const callsFor = (id) => calls.filter((x) => x === id).length;

// ── lane unit check (the single-flight primitive) ──
{
  const lane = createLane();
  const order = [];
  const a = lane.enqueue(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); return 1; });
  const b = lane.enqueue(async () => { order.push('b'); return 2; });
  const [ra, rb] = await Promise.all([a, b]);
  rec('L0 lane runs serially (a before b) + returns each result', order.join('') === 'ab' && ra === 1 && rb === 2, order.join(''));
  let threw = false;
  const bad = lane.enqueue(async () => { throw Object.assign(new Error('x'), { code: 'EBAD' }); }).catch((e) => { threw = e?.code === 'EBAD'; });
  const after = lane.enqueue(async () => 'still-runs');
  await Promise.all([bad, after]);
  rec('L0 a throwing thunk is isolated — the next still runs', threw && (await after) === 'still-runs');
}

// ── G1 due task fires once → recorded + advanced ──
{
  const id = await H.createTask(U, { name: 'g1', prompt: 'morning brief', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  stub = async () => ({ text: 'BRIEF' });
  await s.tickOnce();
  const t = await H.getTask(U, id);
  const runs = await H.recentRuns(U, 10);
  const run = runs.find((r) => r.task_id === id);
  rec('G1 the due task fired exactly once', callsFor(id) === 1, `calls=${callsFor(id)}`);
  rec('G1 run recorded done; next_run advanced; run_count bumped', run?.status === 'done' && t.next_run > iso() && t.run_count === 1, JSON.stringify({ st: run?.status, rc: t.run_count }));
}

// ── G2 single-flight across overlapping ticks ──
{
  const id = await H.createTask(U, { name: 'g2', prompt: 'slow', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  stub = async () => { await new Promise((r) => setTimeout(r, 40)); return { text: 'SLOW-DONE' }; };
  const before = callsFor(id);
  const p1 = s.tick(); const p2 = s.tick();      // two overlapping cycles, not awaited individually
  await Promise.all([p1, p2]);
  await drain();
  rec('G2 overlapping ticks fired the slow task exactly once', callsFor(id) - before === 1, `delta=${callsFor(id) - before}`);
}

// ── G3 dedup window ──
{
  const id = await H.createTask(U, { name: 'g3', prompt: 'dedup-me', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  stub = async () => ({ text: 'FIRST' });
  await s.tickOnce();                              // first run completes 'done' (within 30s window)
  const firstCalls = callsFor(id);
  await H.updateTask(U, id, { next_run: iso(-1000) }); // force it due again immediately
  await s.tickOnce();                              // second tick: wasRecentlyCompleted → skip
  const t = await H.getTask(U, id);
  rec('G3 a within-window re-fire is deduped (not run again)', callsFor(id) === firstCalls, `calls=${callsFor(id)}`);
  rec('G3 deduped task marked skipped-dup', t.last_status === 'skipped-dup', `last=${t.last_status}`);
}

// ── G4 'once' completes ──
{
  const id = await H.createTask(U, { name: 'g4', prompt: 'one-shot', schedule: 'once', scheduledAt: iso(-5000), nextRun: iso(-1000), outputTarget: 'none' });
  stub = async () => ({ text: 'ONCE' });
  await s.tickOnce();
  const t = await H.getTask(U, id);
  rec("G4 'once' (past) → status completed, next_run cleared", t.status === 'completed' && !t.next_run, JSON.stringify({ st: t.status, nr: t.next_run }));
}

// ── G5 delivery to the output sink ──
{
  const id = await H.createTask(U, { name: 'g5', prompt: 'deliver', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'chat' });
  const idNone = await H.createTask(U, { name: 'g5-none', prompt: 'no-deliver', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  stub = async (task) => ({ text: task.name === 'g5' ? 'DELIVER-ME' : 'SILENT' });
  await s.tickOnce();
  rec("G5 output_target 'chat' delivered the text", delivered.some((d) => d.id === id && d.text === 'DELIVER-ME'));
  rec("G5 output_target 'none' did NOT deliver", !delivered.some((d) => d.id === idNone));
}

// ── G6 throwing turn → error CODE only, no plaintext leak ──
{
  const id = await H.createTask(U, { name: 'g6', prompt: 'will-throw', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  stub = async () => { throw Object.assign(new Error('SENSITIVE-ERROR-LEAK-9000'), { code: 'ETESTFAIL' }); };
  await s.tickOnce();
  const runs = await H.recentRuns(U, 30);
  const run = runs.find((r) => r.task_id === id);
  const t = await H.getTask(U, id);
  rec('G6 errored run finished with status error + CODE', run?.status === 'error' && run?.error === 'ETESTFAIL', JSON.stringify({ st: run?.status, err: run?.error }));
  rec('G6 NO plaintext leak in run/error/task (only the code)', !JSON.stringify(run).includes('SENSITIVE-ERROR-LEAK') && t.last_status === 'error' && t.next_run > iso());
}

// ── G7 skipped 'no-model' ──
{
  const id = await H.createTask(U, { name: 'g7', prompt: 'no-model', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'chat' });
  const beforeDeliver = delivered.length;
  stub = async () => ({ skipped: 'no-model' });
  await s.tickOnce();
  const runs = await H.recentRuns(U, 40);
  const run = runs.find((r) => r.task_id === id);
  const t = await H.getTask(U, id);
  rec("G7 no model → run 'skipped-no-model', task advanced, nothing delivered", run?.status === 'skipped-no-model' && t.next_run > iso() && delivered.length === beforeDeliver, JSON.stringify({ st: run?.status }));
}

// ── G8 reconcileOnBoot (restart sentinel used by boot wiring) ──
{
  const orphan = await H.openRun({ userId: U, trigger: 'schedule', taskId: 'x', promptHash: 'orphan-h' });
  const n = await H.reconcileOnBoot();
  const runs = await H.recentRuns(U, 50);
  const row = runs.find((r) => r.id === orphan);
  rec('G8 reconcileOnBoot aborts a stranded running run', n >= 1 && row?.status === 'aborted', `aborted=${n}`);
}

// ── G9 future + paused never fire ──
{
  const fut = await H.createTask(U, { name: 'g9-future', prompt: 'later', schedule: 'interval:30m', nextRun: iso(60 * 60 * 1000), outputTarget: 'none' });
  const paused = await H.createTask(U, { name: 'g9-paused', prompt: 'paused', schedule: 'interval:30m', nextRun: iso(-1000), status: 'paused', outputTarget: 'none' });
  await s.tickOnce();
  rec('G9 future + paused tasks were not fired', callsFor(fut) === 0 && callsFor(paused) === 0);
}

s.stop();
await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — scheduler runtime: serial lane · due-dispatch · single-flight · dedup · once-complete · delivery · fail-closed error-codes · no-model skip · boot-reconcile · future/paused guard' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
