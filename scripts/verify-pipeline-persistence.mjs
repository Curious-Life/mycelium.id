// verify:pipeline-persistence — a pipeline run survives the process that started it, and a run
// that died is never reported as running or done.
//
// THE GAP (the pipeline-sprint design Part 1). Per-STAGE health was persisted
// (pipeline_state, written by 17 of 21 stages), but the RUN lived only in a plain Map in
// src/jobs.js — evicted at 50 entries, gone on exit. A crash left NO record a run had started;
// after a restart "which run failed, where, why" was unanswerable; and nothing could resume,
// because nothing recorded what completed.
//
//   R1  a run is durable the moment it opens — before any stage work, so a crash is diagnosable
//   R2  stage rows accumulate, and a new stage closes the previous one as 'ok'
//   R3  a clean finish is 'ok' with the stage tally reconciled
//   R4  ⭐ CRASH RECOVERY. A run left 'running' by a dead process reconciles to 'aborted' — never
//       'running' (a claim about a process that no longer exists), never 'ok'. Its open stage
//       becomes 'interrupted', so the failure still has a STAGE NAME.
//   R5  the tables are CONTENT-FREE: no column accepts vault text by design, and the writer
//       bounds what it stores
//   R6  the boot reconcile is actually WIRED into server-rest.js — a recovery nothing calls is
//       not a recovery
//
// Drives the REAL namespace against a REAL sqlite vault built by the REAL migrations. No mocks:
// the whole defect class here is "the record was not actually written".
//
// MUTATION-TESTED: dropped the reconcileOnBoot UPDATE on pipeline_runs → R4 REDs, the dead run
//   still reads 'running'.
// MUTATION-TESTED: made reconcileOnBoot close dead runs as 'ok' instead of 'aborted' → R4 REDs.
//   (This is the tempting shortcut — "the child probably finished" — and it is the exact
//   inference-as-evidence lie the table exists to prevent.)
// MUTATION-TESTED: removed the stage-interrupt half of reconcileOnBoot → R4 REDs, the stage is
//   left 'running' so the failure has no stage name.
// MUTATION-TESTED: removed the pipelineRuns.close() call from jobs.js publishTerminal → R6 REDs.
// MUTATION-TESTED: removed db.pipelineRuns.reconcileOnBoot() from server-rest.js → R6 REDs.
// MUTATION-TESTED: persisted state.stageLabel (raw child stdout) instead of stageNameFor(m[1])
//   → R7 REDs. This is the one the REVIEW of this commit's own diff found: the column was
//   content-free only by coincidence of what the script prints, not by construction.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { applyMigrations } from '../src/db/migrate.js';
import { createPipelineRunsNamespace } from '../src/db/pipeline-runs.js';
import { stageNameFor } from '../src/jobs.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const DB = 'data/verify-pipeline-persistence.db';
if (existsSync(DB)) unlinkSync(DB);
try { mkdirSync('data', { recursive: true }); } catch { /* exists */ }
const raw = new Database(DB);
applyMigrations(raw);

// The REAL namespace over a REAL better-sqlite3 handle, shaped like the d1 adapter it gets in
// production (a `meta.changes` count is what reconcileOnBoot returns).
const d1QueryAdmin = async (sql, params = []) => {
  const st = raw.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: st.all(...params) };
  const info = st.run(...params);
  return { meta: { changes: info.changes } };
};
const runs = createPipelineRunsNamespace({ d1QueryAdmin });
const one = (sql, p = []) => raw.prepare(sql).get(...p);
const all = (sql, p = []) => raw.prepare(sql).all(...p);

const USER = 'local-user';
const RUN = 'gen_abc123';

// ── R1: durable at open ──────────────────────────────────────────────────────
await runs.open(RUN, { userId: USER, kind: 'generate', trigger: 'user' });
{
  const r = one('SELECT * FROM pipeline_runs WHERE run_id = ?', [RUN]);
  rec('R1. a run is durable the moment it opens (before any stage work)',
    !!r && r.status === 'running' && r.user_id === USER && r.kind === 'generate' && !!r.started_at && !!r.heartbeat_at,
    r ? `status=${r.status} kind=${r.kind} started=${!!r.started_at}` : 'NO ROW — a crash now would leave no trace');
}

// ── R2: stages accumulate; a new stage closes the previous as ok ─────────────
await runs.stageStarted(RUN, 'Syncing content…', 1);
await runs.stageStarted(RUN, 'Clustering…', 2);
await runs.stageStarted(RUN, 'Describing…', 3);
{
  const s = all('SELECT stage_name, status, ord FROM pipeline_run_stages WHERE run_id = ? ORDER BY ord', [RUN]);
  const ok = s.filter((x) => x.status === 'ok').length;
  const running = s.filter((x) => x.status === 'running').length;
  rec('R2. stage rows accumulate; starting a stage closes the previous one as ok',
    s.length === 3 && ok === 2 && running === 1 && s[2].status === 'running',
    `${s.length} stages · ${ok} ok · ${running} running · last=${s[2]?.stage_name}/${s[2]?.status}`);
}

// ── R4 (set up BEFORE R3 closes it): simulate a crash — the row stays 'running' ──
// No close() is called: exactly what a SIGKILL / power loss leaves behind.
const CRASHED = 'gen_crashed';
await runs.open(CRASHED, { userId: USER, kind: 'generate' });
await runs.stageStarted(CRASHED, 'Computing Fisher trajectory…', 7);

// ── R3: a clean finish ───────────────────────────────────────────────────────
await runs.close(RUN, { status: 'ok' });
{
  const r = one('SELECT * FROM pipeline_runs WHERE run_id = ?', [RUN]);
  const s = all('SELECT status FROM pipeline_run_stages WHERE run_id = ?', [RUN]);
  rec('R3. a clean finish is ok, with the stage tally reconciled',
    r?.status === 'ok' && !!r.finished_at && r.stages_ok === 3 && r.stages_failed === 0
      && s.every((x) => x.status === 'ok'),
    `status=${r?.status} ok=${r?.stages_ok} failed=${r?.stages_failed} finished=${!!r?.finished_at}`);
}

// ── R4: ⭐ crash recovery ────────────────────────────────────────────────────
{
  const before = one('SELECT status FROM pipeline_runs WHERE run_id = ?', [CRASHED]);
  const changed = await runs.reconcileOnBoot();
  const after = one('SELECT * FROM pipeline_runs WHERE run_id = ?', [CRASHED]);
  const stage = one('SELECT * FROM pipeline_run_stages WHERE run_id = ? AND stage_name = ?', [CRASHED, 'Computing Fisher trajectory…']);
  const finished = one('SELECT status FROM pipeline_runs WHERE run_id = ?', [RUN]);   // must NOT be touched
  rec('R4. ⭐ a run left running by a dead process reconciles to ABORTED — never running, never ok',
    before?.status === 'running' && after?.status === 'aborted' && !!after.finished_at
      && stage?.status === 'interrupted' && changed === 1 && finished?.status === 'ok',
    `before=${before?.status} → after=${after?.status} · stage=${stage?.status} · reconciled=${changed} · finished-run untouched=${finished?.status === 'ok'}`);
}

// ── R5: content-free by construction ─────────────────────────────────────────
// The columns must not be able to hold vault text, and the writer must bound what it does store.
{
  const cols = all('PRAGMA table_info(pipeline_runs)').map((c) => c.name)
    .concat(all('PRAGMA table_info(pipeline_run_stages)').map((c) => c.name));
  const FORBIDDEN = /(content|message|essence|name_text|chronicle|body|text|title|prompt|response)$/i;
  // `stage_name` is an allowlisted label from STAGE_LABELS, not vault text — exempt by name.
  const suspicious = cols.filter((c) => FORBIDDEN.test(c) && c !== 'stage_name');
  const LONG = 'X'.repeat(5000);
  await runs.close(CRASHED, { status: 'failed', errorClass: LONG });
  const stored = one('SELECT error_class FROM pipeline_runs WHERE run_id = ?', [CRASHED])?.error_class ?? '';
  rec('R5. the tables are content-free, and the writer bounds what it stores',
    suspicious.length === 0 && stored.length <= 300,
    `suspicious columns: ${suspicious.length ? suspicious.join(',') : 'none'} · 5000-char class stored as ${stored.length}`);
}

// ── R7: the persisted stage name is content-free BY CONSTRUCTION ─────────────
// ⚠️ FOUND BY REVIEWING THIS COMMIT'S OWN DIFF. `state.stageLabel` falls back to RAW CHILD
// STDOUT for a token outside STAGE_LABELS — harmless in the in-memory job (behind the authed
// status route), but pipeline_run_stages.stage_name is content-free BY CONTRACT. It was
// content-free only by coincidence of what run-clustering.sh happens to print, which is the
// "assumed, not enforced" pattern this sprint exists to remove. stageNameFor() derives the name
// from the allowlist, so no string the child chose can reach the column.
{
  const known = stageNameFor('7b');
  const numeric = stageNameFor('99');
  const LEAK = 'A private realm name from the vault';
  const leaked = stageNameFor(LEAK);
  const proto = stageNameFor('__proto__');
  const jobsSrc = readFileSync('src/jobs.js', 'utf8');
  // and the CALL SITE must use it — a safe helper the writer bypasses is decoration.
  const wired = /stageStarted\?\.\(jobId, stageNameFor\(m\[1\]\)/.test(jobsSrc);
  rec('R7. the PERSISTED stage name is allowlist-derived — no child stdout reaches the column',
    known.includes('embedding-trajectory') && numeric === 'Step 99'
      && !leaked.includes('realm') && leaked === 'Unknown stage' && proto === 'Unknown stage' && wired,
    `known=ok numeric=${numeric} leak→${JSON.stringify(leaked)} __proto__→${JSON.stringify(proto)} wired=${wired}`);
}

// ── R6: the recovery is actually WIRED ───────────────────────────────────────
// A reconcile nothing calls is not a reconcile; a close nothing calls leaves every run 'running'.
{
  const boot = readFileSync('src/server-rest.js', 'utf8');
  const jobs = readFileSync('src/jobs.js', 'utf8');
  const bootWired = /db\.pipelineRuns\.reconcileOnBoot\(\)/.test(boot);
  const openWired = /pipelineRuns\?\.open\?\.\(jobId/.test(jobs);
  const closeWired = /pipelineRuns\?\.close\?\.\(jobId/.test(jobs);
  // The close MUST sit in publishTerminal — the one chokepoint every exit path funnels through.
  const pt = jobs.indexOf('const publishTerminal =');
  const cr = jobs.indexOf('const closeRun =');
  const inChokepoint = cr > 0 && pt > cr && /closeRun\(status === 'done'/.test(jobs);
  rec('R6. open/close/reconcile are wired, and close rides the ONE terminal chokepoint',
    bootWired && openWired && closeWired && inChokepoint,
    `boot=${bootWired} open=${openWired} close=${closeWired} viaPublishTerminal=${inChokepoint}`);
}

raw.close();
if (existsSync(DB)) unlinkSync(DB);

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — a pipeline run is durable from the moment it opens, its stages are recorded,\n'
    + '        and a run killed with its process reconciles to ABORTED with its dying stage named.\n'
    + '        NOT PROVEN: that a run can be RESUMED from the record (P4), or that the stage\n'
    + '        outcomes are correct once the P2 driver replaces the `set -e` inference.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);
