// verify:activity — the unified activity feed over background_jobs (db.activityFeed).
// Boots a temp vault, round-trips begin/heartbeat/finish/active/recent, proves the
// fail-closed reaper flips a stale 'running' row → 'abandoned', and asserts the rows
// are CONTENT-FREE (kind/status/step/stage only — never message text or names, §1).
//
//   A6 is THE LEAK CHECK — end-to-end, against the real startClusteringJob spawn
//   path: a pipeline child that dies naming a therapy-journal file must publish a
//   CLASSIFIED reason to background_jobs (content-free by contract) while the REAL
//   reason stays on the authed getJob surface. Modelled on verify:import-activity's
//   A2. Not an at-rest check — the vault is whole-file SQLCipher'd; this pins the
//   CONTRACT, since recent() already SELECTs `error` and only shape() withholds it.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { startClusteringJob, getJob, classifyPipelineFailure } from '../src/jobs.js';

const DB = 'data/verify-activity.db', KCV = 'data/verify-activity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const U_HEX = crypto.randomBytes(32).toString('hex'), S_HEX = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: U_HEX, systemHex: S_HEX, embedder: null });
const U = 'local-user';
const af = db.activityFeed;
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// A raw connection for direct inspection / backdating (bypasses the adapter).
const raw = new Database(DB);
const rowOf = (id) => raw.prepare('SELECT id,kind,status,step,total_steps,stage_label FROM background_jobs WHERE id = ?').get(id);

// A1. begin → active shows a running row
const id = await af.begin({ userId: U, kind: 'describe:name', totalSteps: 5, stageLabel: 'Naming areas' });
let active = await af.active(U);
rec('A1. begin → active shows the running job', active.length === 1 && active[0].kind === 'describe:name' && Number(active[0].total_steps) === 5, JSON.stringify(active[0] || {}));

// A1b. model-in-feed: begin({model}) records WHICH model is working; active() + recent()
// surface it (drives the header "Replying on a channel · <model>" indicator). Name only (§1).
{
  const mId = await af.begin({ userId: U, kind: 'inference:channel', stageLabel: 'Replying…', model: 'claude-opus-4-8' });
  const act = await af.active(U);
  const row = act.find((r) => r.id === mId);
  rec('A1b. begin({model}) → active surfaces the model', row?.model === 'claude-opus-4-8', `model=${row?.model}`);
  await af.finish(mId, { status: 'done' });
  const rec2 = await af.recent(U, 10);
  rec('A1c. finished job keeps the model in recent', rec2.some((r) => r.id === mId && r.model === 'claude-opus-4-8'), `models=${JSON.stringify(rec2.map((r) => r.model))}`);
}

// A2. heartbeat → step advances + total updates
await af.heartbeat(id, { step: 3, totalSteps: 6 });
active = await af.active(U);
rec('A2. heartbeat advances step + total', Number(active[0]?.step) === 3 && Number(active[0]?.total_steps) === 6, `step=${active[0]?.step} total=${active[0]?.total_steps}`);

// A2b. stalled flag round-trips via the keep-alive heartbeat (Gap #4)
await af.heartbeat(id, { stalled: true });
active = await af.active(U);
const stalledOn = Number(active[0]?.stalled) === 1;
await af.heartbeat(id, { stalled: false });
active = await af.active(U);
const stalledOff = Number(active[0]?.stalled) === 0;
rec('A2b. heartbeat carries stalled (true→1, false→0)', stalledOn && stalledOff, `on=${stalledOn} off=${stalledOff}`);

// A2c. a keep-alive heartbeat refreshes last_heartbeat → a slow-but-alive job is NOT
// false-reaped (the Gap #4 regression: the feed reaped quiet-but-running jobs because
// heartbeats only fired on Step lines). The watchdog's stalled-tick keeps it fresh.
raw.prepare("UPDATE background_jobs SET last_heartbeat = datetime('now','-120 seconds') WHERE id = ?").run(id);
await af.heartbeat(id, { stalled: true });
await af.reap(U);
rec('A2c. stalled keep-alive prevents false-reap', rowOf(id)?.status === 'running', JSON.stringify(rowOf(id) || {}));

// A3. finish → leaves active, enters recent (done)
await af.finish(id, { status: 'done' });
active = await af.active(U);
const recent = await af.recent(U, 5);
rec('A3. finish → not active; appears in recent as done', active.length === 0 && recent.some((r) => r.id === id && r.status === 'done'), `active=${active.length} recent=${recent.length}`);

// A4. reaper is fail-closed: a stale 'running' row (dead child) → 'abandoned'
const stale = await af.begin({ userId: U, kind: 'mycelium_generate', totalSteps: 16, stageLabel: 'Mapping your mind' });
raw.prepare("UPDATE background_jobs SET last_heartbeat = datetime('now','-120 seconds') WHERE id = ?").run(stale);
await af.reap(U);
rec('A4. reap flips a stale running row → abandoned (fail-closed)', rowOf(stale)?.status === 'abandoned', JSON.stringify(rowOf(stale)));
active = await af.active(U);
rec('A4b. reaped row is not active', !active.some((r) => r.id === stale), `active=${active.length}`);

// A5. content-free: kind is a known token, stage_label is a constant phrase — no
// names, no message text ever lands in a row (§1 zero-plaintext-leakage).
const c = rowOf(id);
const cleanStage = /^[A-Za-z][A-Za-z ]*$/.test(c?.stage_label || '');
const knownKind = /^(describe:name|describe:chronicle|mycelium_generate|embed)$/.test(c?.kind || '');
rec('A5. rows are content-free (constant stage label + known kind, no names)', cleanStage && knownKind, JSON.stringify(c));

// ── A6) THE LEAK CHECK — a pipeline FAILURE never publishes its reason ────────
// The reason is the child's last stderr line: a path, a traceback, a quoted row.
// background_jobs is content-free by contract, so only a CLASSIFIED reason may
// land there. End-to-end against the real spawn path (MYCELIUM_CLUSTER_SCRIPT
// seam), not a stubbed feed.
{
  const SCRIPT = path.resolve('data/activity-leak-fail.sh');
  // The exact shape of a real failure: the stage line, then a stderr reason naming
  // a file on disk and quoting a line of the user's own writing.
  const SECRET_PATH = '/Users/owner/Desktop/therapy-journal-2019.md';
  const SECRET_TEXT = 'I told her I was afraid';
  writeFileSync(SCRIPT, `#!/usr/bin/env bash
echo "Step 7/16: Computing Fisher trajectory (movement)…"
echo 'RuntimeError: ${SECRET_PATH}: unparseable near "${SECRET_TEXT}"' >&2
exit 1
`);
  // The child re-resolves keys from the source; env source lets it.
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = U_HEX;
  process.env.SYSTEM_KEY = S_HEX;
  process.env.MYCELIUM_CLUSTER_SCRIPT = SCRIPT;

  const { jobId } = startClusteringJob({ dbPath: DB, userId: U, db });
  let job = null;
  for (let i = 0; i < 60; i++) {
    job = getJob(jobId);
    if (job && job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Give the fire-and-forget feed write a beat to land. Wait for a row that is
  // ABSENT too, not just one still 'running' — `undefined?.status === 'running'`
  // is false, which would exit this loop instantly and assert against {} (A6b/A6e
  // still catch that, but as a confusing false RED rather than a real one).
  for (let i = 0; i < 20 && (!rowOf(jobId) || rowOf(jobId).status === 'running'); i++) await new Promise((r) => setTimeout(r, 50));

  const errRow = raw.prepare('SELECT id,kind,status,stage_label,error FROM background_jobs WHERE id = ?').get(jobId);
  const published = JSON.stringify(errRow || {});

  // The check only means something if the run ACTUALLY failed with the real reason
  // in hand — otherwise "no secret in the row" is vacuously true.
  rec('A6a. the pipeline failed AND the real reason reached the authed getJob surface',
    job?.status === 'error' && !!job?.error && job.error.includes(SECRET_PATH),
    `status=${job?.status} error=${JSON.stringify(job?.error)}`);
  rec('A6b. the feed row exists and is terminal', errRow?.status === 'error', published);
  rec('A6c. the FILE PATH never reaches background_jobs (content-free by contract, §1)',
    !published.includes('therapy-journal'), published);
  rec('A6d. nor a quoted line of the user\'s content', !published.includes(SECRET_TEXT), published);
  rec('A6e. the feed gets a CLASSIFIED reason — the step, built from integers only',
    errRow?.error === 'failed at step 7/16', `error=${JSON.stringify(errRow?.error)}`);

  // The classifier is content-free BY CONSTRUCTION: an unknown step (or a stage
  // label smuggled in) can only ever produce the constant.
  rec('A6f. classifier falls back to a constant for an unknown/absent step',
    classifyPipelineFailure({ failedStep: 999, totalSteps: 16 }) === 'pipeline failed'
    && classifyPipelineFailure({ failedStep: null }) === 'pipeline failed'
    && classifyPipelineFailure({}) === 'pipeline failed'
    && classifyPipelineFailure({ failedStep: SECRET_PATH, totalSteps: 16 }) === 'pipeline failed',
    'unknown step / null / empty / non-numeric → "pipeline failed"');

  // Leave no global state behind: a block appended after this one must not
  // silently inherit key_source=env + these keys.
  delete process.env.MYCELIUM_CLUSTER_SCRIPT;
  delete process.env.MYCELIUM_KEY_SOURCE;
  delete process.env.USER_MASTER_KEY;
  delete process.env.SYSTEM_KEY;
  try { rmSync(SCRIPT); } catch {}
}

// ── A7) A JOB THAT NEVER STARTS still reaches a terminal row — no reaper wait ─
// begin() writes 'running' before the spawn, so a spawn that throws leaves a phantom
// running job in the header until the 45s reaper flips it to 'abandoned' — mislabelling
// a startup failure as a crashed child.
//
// The seam is the REAL production trigger, not an injected one: startClusteringJob
// passes `cwd: process.cwd()` to spawn, and process.cwd() throws ENOENT once the app's
// working directory is deleted/unmounted underneath it. (A non-existent SCRIPT path
// does NOT reach this path — bash starts fine and exits 127, which is A6's close-handler
// route.) Everything before the spawn tolerates a dead cwd: readGenerateStats catches,
// and the disk guard takes an absolute path.
{
  // Own the key env rather than inheriting A6's — startClusteringJob re-resolves the
  // master keys at spawn, so this block must stand alone (and clean up after itself).
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = U_HEX;
  process.env.SYSTEM_KEY = S_HEX;

  const ABS_DB = path.resolve(DB);
  const doomed = mkdtempSync(`${tmpdir()}/verify-activity-cwd-`);
  const home = process.cwd();
  let jobId = null, threw = null;
  try {
    process.chdir(doomed);
    rmSync(doomed, { recursive: true, force: true });
    ({ jobId } = startClusteringJob({ dbPath: ABS_DB, userId: U, db }));
  } catch (e) {
    threw = e; // must not escape — the caller maps a start failure to a job, not a 500
  } finally {
    process.chdir(home);
  }
  // begin()+finish() are fire-and-forget through the async adapter, so wait for the row
  // to LAND and settle — a t=0 read would pass 'not running' vacuously (no row at all).
  const readRow = () => (jobId ? raw.prepare('SELECT id,status,error,finished_at FROM background_jobs WHERE id = ?').get(jobId) : null);
  for (let i = 0; i < 40; i++) {
    const r = readRow();
    if (r && r.status !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  const startRow = readRow();

  rec('A7a. a spawn that cannot start still returns a job (no throw to the caller)', !threw && !!jobId,
    threw ? `threw ${threw.code || threw.message}` : `jobId=${jobId}`);
  rec('A7b. getJob reports the failure', getJob(jobId)?.status === 'error', JSON.stringify(getJob(jobId)?.error));
  // The point of the whole block: TERMINAL now, not 'running' awaiting the reaper.
  rec('A7c. the feed row is terminal ERROR immediately — not left running for the reaper',
    startRow?.status === 'error', JSON.stringify(startRow));
  // NB: this does NOT exercise the reaper (STALE_MS is 45s; we read within ~2s). It
  // asserts the row is closed out on its own — finished_at set — which is what denies
  // the reaper the chance to relabel it 'abandoned' later. Named for what it drives.
  rec('A7d. …the row closes itself out (finished_at set), leaving nothing for the reaper',
    !!startRow?.finished_at && startRow?.status !== 'abandoned', JSON.stringify(startRow));
  rec('A7e. the published reason is the constant (content-free, §1)',
    startRow?.error === 'failed to start clustering', `error=${JSON.stringify(startRow?.error)}`);

  // ── A7f) FIRST-WINS: 'close' must not overwrite the reason 'error' already gave ──
  // A real spawn ENOENT emits 'error' AND THEN 'close' (code -2). Both publish, so
  // without the first-wins guard in publishTerminal the trailing close would relabel
  // the row 'pipeline failed' — vaguer, and wrong about what happened (no step ever
  // ran). The seam is a PATH with no bash in it: the executable itself is unresolvable.
  const REAL_PATH = process.env.PATH;
  process.env.PATH = '/nonexistent-bin';
  const { jobId: enoentId } = startClusteringJob({ dbPath: path.resolve(DB), userId: U, db });
  process.env.PATH = REAL_PATH;
  for (let i = 0; i < 40; i++) {
    const r = enoentId ? raw.prepare('SELECT status FROM background_jobs WHERE id = ?').get(enoentId) : null;
    if (r && r.status !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  // Let any trailing 'close' land — that is the write this guard is defending against.
  await new Promise((r) => setTimeout(r, 300));
  const enoentRow = enoentId ? raw.prepare('SELECT status,error FROM background_jobs WHERE id = ?').get(enoentId) : null;
  rec('A7f. a trailing close cannot overwrite the specific reason (first-wins)',
    enoentRow?.status === 'error' && enoentRow?.error === 'failed to start clustering',
    JSON.stringify(enoentRow));

  // Same discipline as A6: leave no global state behind.
  delete process.env.MYCELIUM_KEY_SOURCE;
  delete process.env.USER_MASTER_KEY;
  delete process.env.SYSTEM_KEY;
}

// ── A8) DEFERRED CONTINUOUS ROWS reach the feed HONEST (QA6) ──────────────────
// The unified feed aggregates the CONTINUOUS projections (embed/categorize/enrich) alongside the
// discrete background_jobs rows above — a surface this gate did not exercise at all until now. While
// embedding still drains, the drainer serializes the on-box stages and DEFERS categorize + enrich
// (drainer.js waitOnEmbed). Those rows must reach active[] as a SCHEDULING state — never `running`,
// no "on device" process, no ETA — or the always-on indicator ticks a frozen, plausible, WRONG
// countdown while PipelineStatus on the same screen says "Waiting for embedding to finish" (QA6).
// Drive the REAL router (portalActivityRouter) with a REAL drainer forced into the deferred state via
// an inexhaustible embed backlog (the loop caps out every cycle while still progressing).
{
  const { startEnrichDrainer, resumeEnrichProcessing } = await import('../src/enrich/drainer.js');
  const { portalActivityRouter } = await import('../src/portal-activity.js');
  const MODEL = 'qwen3.5:4b';
  let embN = 0;
  const memDb = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: MODEL }, enrich: { model: MODEL } } }) },
    async rawQuery() { return { rows: [] }; },
    activityFeed: { async reap() {}, async active() { return []; }, async recent() { return []; } },
    messages: {
      // inexhaustible embed backlog ⇒ the embed loop hits its 200-batch/cycle cap while STILL
      // progressing (embedded > 0, never drains, never stalls) ⇒ deferCategorizeForEmbed defers L1+L2.
      async selectPendingEnrichment(_u, { limit = 50 } = {}) { return Array.from({ length: limit }, () => ({ id: `e${embN++}`, content: 'row about minds', scope: null, nlp_error: null })); },
      async updateEnrichment() {},
      async selectPendingCategories() { return []; },   // deferred ⇒ the L1 loop never reaches this
      async updateCategories() {},
      async selectPendingNlp() { return []; },
      async updateNlp() {},
      async embedBacklogCached() { return { embedded: 0, total: 100000, pending: 100000 }; },
      async categoriesBacklogCached() { return { tagged: 100, total: 1000, pending: 900 }; },   // pending>0 ⇒ the row renders
      async nlpBacklogCached() { return { done: 50, total: 1000, pending: 950 }; },
    },
  };
  resumeEnrichProcessing();
  const d = startEnrichDrainer({
    db: memDb, userId: U, intervalMs: 10_000_000, log: () => {},
    classify: async () => ({ domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' }),
    enrich: async () => ({ entities: ['x'], tags: ['y'], entitySummary: 'z' }),
    daemon: { calls: 0, async ensureUp() { this.calls++; return { ok: true, running: true }; } },
    ollama: { async listInstalled() { return [MODEL]; }, async pullModel() { return true; } },
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  // The deferral arms only AFTER the embed loop caps out this cycle; the huge interval means cycle 2
  // never starts, so once true it stays true while the router reads the projections.
  let deferred = false;
  for (let i = 0; i < 800; i++) { if (d.status()?.categorizeWaitingOnEmbed === true) { deferred = true; break; } await new Promise((r) => setTimeout(r, 25)); }

  const router = portalActivityRouter({ db: memDb, userId: U, authenticatePortalRequest: () => U });
  const call = (url) => new Promise((resolve) => {
    const req = { method: 'GET', url, headers: {} };
    const res = { statusCode: 200, status(cc) { this.statusCode = cc; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); } };
    router(req, res, (e) => resolve({ status: 500, body: { e: String(e) } }));
  });
  const r = await call('/activity');
  d.stop();
  const catRow = (r.body?.active || []).find((x) => x.kind === 'categorize');
  const enrRow = (r.body?.active || []).find((x) => x.kind === 'enrich');
  rec('A8. a DEFERRED categorize row reaches the feed as a scheduling state — not "running", no "on device", no ETA',
    deferred && !!catRow && catRow.status === 'waiting' && catRow.status !== 'running'
      && catRow.process === null && catRow.etaSeconds === null && / waiting for embedding$/.test(catRow.stage),
    `deferred=${deferred} · categorize row=${JSON.stringify(catRow)}`);
  rec('A8b. a DEFERRED enrich row reaches the feed the same honest way',
    !!enrRow && enrRow.status === 'waiting' && enrRow.process === null && enrRow.etaSeconds === null
      && / waiting for embedding$/.test(enrRow.stage),
    `enrich row=${JSON.stringify(enrRow)}`);
  // CONTROL: prove the deferred shape is NOT the trivial "no model / paused" one — the model IS
  // approved and processing is resumed, so a bare `running` would have rendered without the arm.
  rec('A8c. control: the deferral is the ONLY reason the row is not running (model approved, not paused)',
    !!catRow && catRow.model === MODEL && catRow.remaining > 0,
    `model=${catRow?.model} remaining=${catRow?.remaining}`);
}

raw.close();
close();
const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — activity feed: begin/heartbeat/finish/active/recent + fail-closed reap + content-free + failure-reason leak (A6) + terminal-on-spawn-failure (A7) + deferred continuous rows honest in the feed (A8)  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);
