// src/jobs.js — minimal in-memory job registry for the clustering pipeline
// (Phase G: the in-app "generate mindscape" trigger). One job at a time.
//
// SECURITY (the load-bearing part): boot() does NOT keep the system key in the
// server's long-lived scope, so we RE-RESOLVE both master keys from the key
// source AT SPAWN and hand them to the child only via its env OBJECT — never as
// process args (→ not visible in `ps`), never logged. The child env is an
// explicit ALLOWLIST (PATH/HOME/USER/LANG + the two keys + DB/user id) so no
// ambient server secret leaks down. The script path is hardcoded (env-overridable
// only for tests), never built from request input. Mirrors the canonical
// the canonical portal route.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveKeys } from './crypto/key-source.js';
import { getSessionKeys } from './account/session-keys.js';
import { dbPath as resolveDbPath } from './paths.js';
import { readGenerateStats, writeGenerateStats } from './generate-stats.js';
import { bustMindscape, bustMindscapePoints } from './mindscape-cache.js';
import { backfillColumn, countRemainingEnvelopes } from './account/backfill.js';
import { safeVaultCopy } from './db/backup.js';
import { assertVaultDiskHeadroom } from './db/disk-guard.js';
import { getMasterKey } from './crypto/crypto-local.js';
import { identityEnv } from './spawn-env.js';
import { isDeleteRunning } from './core/delete-lane.js';
import { evaluateFreshness } from './mindscape-freshness.js';
import { admit, CLASS, queueForResident } from './core/compute-governor.js';

// ── Compute-governor seam (D-001 / QA7 U1) ──────────────────────────────────────────────────
// Every child spawner below is a heavy lane in the governor's inventory (design §1). Each admits
// a ticket BEFORE spawning and releases it when the child exits — so an embed drain, a describe
// pass and a clustering run can never all peg the box at once (the crash). `spawn` is indirected
// through `_spawn` for ONE reason: verify:compute-lanes C3 injects a counting stub to prove that
// NO child is spawned while a resident ticket is held — the check that catches the #329-class
// narrowness (a fixture assertion on the module would not). Production always uses the real spawn.
let _spawn = spawn;
export function _setSpawnForTests(fn) { _spawn = fn || spawn; }

/**
 * Kill-switch for the destructive re-cluster. Generate (auto OR manual) rebuilds
 * the whole mindscape — dissolving territories and, on an interrupted run, blanking
 * chronicles. After a vault-recovery/import we must protect the restored map until
 * the narration pipeline makes re-clustering safe. Returns true when generation is
 * locked, via EITHER env (MYCELIUM_DISABLE_GENERATE=1) or a sentinel file
 * `.generate-disabled` next to the DB (survives restarts; `rm` it to re-enable).
 * Default OFF — no behavior change unless the operator explicitly locks it.
 */
export function generateLocked() {
  if (process.env.MYCELIUM_DISABLE_GENERATE === '1') return true;
  try { return fs.existsSync(path.join(path.dirname(resolveDbPath()), '.generate-disabled')); }
  catch { return false; }
}

const MAX_MS = Number(process.env.MYCELIUM_GEN_MAX_MS) || 45 * 60 * 1000; // 45 min hard cap
// If the child emits NO stdout for this long, flag the job `stalled` so the UI can
// say "still working on <stage> — taking longer than usual" + offer Cancel (instead
// of a frozen bar). Flag only — the MAX_MS cap still backstops a true runaway.
const STALL_MS = Number(process.env.MYCELIUM_GEN_STALL_MS) || 5 * 60 * 1000;

// Governor lease TTLs are BACKSTOPS, not the primary crash-release. For a spawned child the
// reliable mechanism is child-binding (the governor binds close+error, first wins — design §3.5.2);
// the lease only frees a ticket whose child somehow detached without emitting either. So the lease
// is deliberately GENEROUS — a per-territory-sized lease would reclaim mid-run and re-open the slot
// while the child still runs (the double-admission window the red-team flagged, design §5).
const CLUSTERING_LEASE_MS = 2 * MAX_MS;          // 90 min — bounds a truly wedged clustering child
const DESCRIBE_LEASE_MS = 60 * 60 * 1000;        // 60 min — chronicles/naming gap-fill passes
const CLAIM_LEASE_MS = 30 * 60 * 1000;           // 30 min — claim discovery cadence
const STAGE_LABELS = {
  1: 'Syncing content…',
  2: 'Clustering (k-means + Ward HAC)…',
  3: 'Describing realms + territories…',
  4: 'Computing co-firing…',
  5: 'Mapping semantic neighbors…',
  6: 'Computing information harmonics…',
  7: 'Computing Fisher trajectory (movement)…',
  8: 'Auditing mindscape topology (health)…',
  9: 'Scoring territory vitality (phases)…',
  10: 'Measuring thinking complexity…',
  11: 'Computing frequency metrics…',
  12: 'Computing cross-scale coupling (rhythms)…',
  13: 'Detecting criticality (early-warning signals)…',
  14: 'Computing semantic coherence…',
  15: 'Computing behavioral-temporal patterns…',
  16: 'Computing embedding-anchor metrics (Tier-1, CVP-pending)…',
};

// SECURITY (§1 zero-plaintext-leakage): the reason a pipeline run failed is the
// child's last stderr line — routinely a file path, a python traceback quoting a
// row, or model output. `background_jobs` is content-free BY CONTRACT (see the
// db/activity-feed.js header: "NEVER a realm/territory name, message content, or
// model output"), so the raw reason must never be published there. The feed gets
// a CLASSIFIED reason built only from integers + fixed literals (content-free by
// construction); the REAL reason stays in `state.error`, behind the authed
// getJob/status route. Mirrors the import path ('import failed', ingest/import-job.js).
//
// What this is NOT: an at-rest fix. Post SQLCipher-collapse, ENCRYPTED_FIELDS
// (crypto-local.js) field-encrypts ONLY `secrets` — background_jobs would be
// equally unencrypted through d1Query, and the whole file is SQLCipher'd anyway.
// The point is the CONTRACT: activityFeed.recent() already SELECTs `error`, and
// only portal-activity.js's shape() — which drops it today — stands between this
// column and the feed UI. Keeping the row content-free is what lets that
// projection widen without re-auditing every publisher. Defense in depth (§2),
// not a live exfiltration path.
//
// `state.stageLabel` is deliberately NOT used here: it falls back to raw child
// stdout (`m[3].trim()`) for a step outside STAGE_LABELS, so it is not a constant.
export function classifyPipelineFailure({ failedStep, totalSteps } = {}) {
  const n = Number(failedStep);
  const t = Number(totalSteps);
  if (!Number.isInteger(n) || n <= 0 || !STAGE_LABELS[n]) return 'pipeline failed';
  return Number.isInteger(t) && t > 0 ? `failed at step ${n}/${t}` : `failed at step ${n}`;
}

const jobs = new Map();   // jobId → state (kept for status polling)
let runningJobId = null;  // single-flight: at most one clustering run at a time

/**
 * Start a clustering run. Single-flight: a second call while one is in flight
 * returns the in-flight job. Returns { jobId, status: 'running' | 'already_running' }.
 * @param {{ dbPath?: string, userId?: string }} opts
 */
export function startClusteringJob({ dbPath, userId, db, measureOnly = false } = {}) {
  // Kill-switch (see generateLocked): refuse to spawn the destructive re-cluster
  // while the mindscape is protected post-recovery. No child, no DB writes.
  // MEASURE-ONLY is exempt: it never calls cluster.py (no re-cluster) — it only
  // refreshes the metric tables on the existing mindscape, so it is non-destructive
  // and safe while Generate is locked.
  if (!measureOnly && generateLocked()) {
    console.error('[mycelium] Generate is LOCKED (.generate-disabled / MYCELIUM_DISABLE_GENERATE) — refusing to re-cluster.');
    return { jobId: null, status: 'disabled' };
  }
  // REVERSE WRITER-GUARD (the missing half). portal-data.js already refuses to
  // START a delete while a Generate runs; nothing stopped a Generate from starting
  // DURING a delete. cluster.py builds its old→new stabilization diff by reading
  // clustering_points — read it mid-delete and it sees a TORN membership, so ids
  // mis-stabilize and a new cluster's stats land in a half-dead profile row. Both
  // real and measure-only runs are refused: measure-only still reads the same
  // half-emptied tables. Fail-closed: no child, no DB writes.
  if (isDeleteRunning()) {
    console.error('[mycelium] a bulk delete is in flight — refusing to start a clustering run.');
    return { jobId: null, status: 'delete_running' };
  }
  // Single-flight: block while a child is still ALIVE — `running`, or `canceled`
  // but not yet reaped (cur.child set). Prevents two clustering children racing on
  // the same SQLite during a cancel→restart.
  const cur = runningJobId ? jobs.get(runningJobId) : null;
  if (cur && (cur.status === 'running' || cur.child)) {
    return { jobId: runningJobId, status: 'already_running' };
  }

  // Fail-closed disk guard: a re-cluster + its children write heavily; on a near-full
  // disk the write storm hits ENOSPC (WAL bloat + torn state — a corruption co-factor).
  // Refuse rather than risk the vault. Measure-only is exempt (small metric-table writes,
  // no cluster.py). @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
  if (!measureOnly) {
    try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
    catch (e) {
      if (e.code === 'DISK_LOW') { console.error(`[mycelium] Generate refused — ${e.message}`); return { jobId: null, status: 'disk_low', detail: e.detail }; }
      throw e;
    }
  }

  // Bound memory: evict old finished jobs (status polling only needs recent ones).
  if (jobs.size > 50) {
    for (const [id, j] of jobs) {
      if (j.status !== 'running') jobs.delete(id);
      if (jobs.size <= 25) break;
    }
  }

  // Resolve both master keys at REQUEST time (before any job/feed row exists), to hand to the child
  // via env. In passphrase-lock mode the keys aren't in the Keychain, so prefer the in-memory
  // session keys (pinned at boot); otherwise re-resolve from the key source. THROWS if unavailable —
  // the caller maps that to a 503. Kept BEFORE the job is created (as the original did) so a key
  // failure propagates cleanly with NO phantom job/feed row — and so the spawn's OWN failure (a
  // dead cwd → ENOENT) is the ONLY thing launch() has to handle internally, never re-thrown (the
  // activity-feed contract A7: a spawn that cannot start still returns a job, no throw to the caller).
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();

  // Create the job id + state UP FRONT, so a QUEUED job (refused for capacity) still has a pollable
  // id and a feed row. `state.status` stays 'running' throughout the queued sub-state (the request
  // is accepted + in-flight — the user will get their map); `stageLabel` tells the finer story.
  const jobId = `${measureOnly ? 'measure' : 'gen'}_${crypto.randomBytes(6).toString('hex')}`;
  const state = {
    id: jobId, status: 'running', step: 0, totalSteps: 5,
    stageLabel: 'Starting…', startedAt: Date.now(), finishedAt: null, error: null,
    stalled: false,            // set by the inactivity watchdog; cleared on new output
    child: null,               // live handle (internal — never returned by getJob)
    lastOutputAt: Date.now(),  // last stdout activity (drives the stall watchdog)
    // Last successful run's wall-clock, so the UI can show an ETA from t=0.
    priorDurationMs: readGenerateStats()?.lastDurationMs ?? null,
  };
  jobs.set(jobId, state);
  runningJobId = jobId;
  // Mirror into the unified activity feed (header dot + chip) — content-free.
  const feedLabel = measureOnly ? 'Refreshing analysis' : 'Mapping your mind';
  const feedBegun = db?.activityFeed
    ? db.activityFeed.begin({ userId, kind: measureOnly ? 'mycelium_measure' : 'mycelium_generate', id: jobId, totalSteps: 16, stageLabel: feedLabel }).catch(() => {})
    : Promise.resolve();

  // begin() has now written a 'running' row, so EVERY exit path below owes the feed a
  // terminal row. Miss one and the reaper (activity-feed.js STALE_MS) flips it to
  // 'abandoned' 45s later. See classifyPipelineFailure — `error` here is only ever a CONSTANT.
  let feedPublished = false;
  const publishTerminal = (status, error = null) => {
    if (feedPublished || !db?.activityFeed) return;
    feedPublished = true;
    feedBegun.then(() => db.activityFeed.finish(jobId, { status, error })).catch(() => {});
  };

  // LAUNCH — spawn the child with an ALREADY-ADMITTED governor ticket, using the keys resolved
  // above. Called immediately when admit succeeds, or later from the queue waiter when the resident
  // slot frees. A spawn failure (dead cwd → ENOENT) is handled INTERNALLY here (job → error, feed →
  // constant, ticket released) and NEVER re-thrown — the caller already got its job id (A7 contract).
  const launch = (genAdm) => {
    if (state.status !== 'running') { genAdm.release(); return; }   // canceled while queued
    try {
      const scriptPath = process.env.MYCELIUM_CLUSTER_SCRIPT || 'pipeline/run-clustering.sh';
      const childEnv = {
        PATH: process.env.PATH,
        ...identityEnv(),  // USER/LOGNAME/HOME, filled when a Finder/launchd launch omits them
        LANG: process.env.LANG,
        USER_MASTER: userHex,
        SYSTEM_KEY: systemHex,
        MYCELIUM_DB: dbPath || resolveDbPath(),
        MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
        ...(process.env.MYCELIUM_VAULT_FAMILY ? { MYCELIUM_VAULT_FAMILY: process.env.MYCELIUM_VAULT_FAMILY } : {}),
        ...(process.env.MYCELIUM_PYTHON ? { PYTHON: process.env.MYCELIUM_PYTHON } : {}),
        ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
        ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
        ...(measureOnly ? { MYCELIUM_MEASURE_ONLY: '1' } : {}),
      };

      state.startedAt = Date.now();
      state.stageLabel = 'Starting…';
      const child = _spawn('bash', [scriptPath], {
        cwd: process.cwd(),
        env: childEnv,                       // allowlist only — no ambient secrets
        stdio: ['ignore', 'pipe', 'pipe'], // stdout parsed for progress; stderr captured (bounded)
      });
      state.child = child; // expose for cancelJob (never surfaced via getJob)
      genAdm.bindChild(child);              // governor releases on close/error (first wins) — crash-release #2

      let buf = '';
      child.stdout.on('data', (d) => {
        state.lastOutputAt = Date.now();
        if (state.stalled) state.stalled = false; // output resumed → no longer stalled
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || ''; // keep the partial last line
        for (const line of lines) {
          const m = line.match(/^Step\s+(\d+)\/(\d+):\s*(.*)$/);
          if (m) {
            state.step = parseInt(m[1], 10);
            state.totalSteps = parseInt(m[2], 10);
            state.stageLabel = STAGE_LABELS[state.step] || m[3].trim();
            if (db?.activityFeed) db.activityFeed.heartbeat(jobId, { step: state.step, totalSteps: state.totalSteps, stageLabel: feedLabel, stalled: false }).catch(() => {});
          }
        }
      });

      let errBuf = '';
      child.stderr?.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
      const lastErrLine = () => errBuf.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
      }, MAX_MS);
      const stallTimer = setInterval(() => {
        if (state.status !== 'running') return;
        if (Date.now() - state.lastOutputAt > STALL_MS) state.stalled = true;
        if (db?.activityFeed) db.activityFeed.heartbeat(jobId, { stalled: state.stalled }).catch(() => {});
      }, 15000);
      if (stallTimer.unref) stallTimer.unref();

      const finish = () => { clearTimeout(timer); clearInterval(stallTimer); state.child = null; if (runningJobId === jobId) runningJobId = null; genAdm.release(); };

      child.on('close', (code) => {
        state.finishedAt = Date.now();
        if (state.status === 'canceled') {
          state.stageLabel = 'Canceled'; // user-initiated stop → keep, don't mark error
        } else if (code === 0) {
          state.status = 'done'; state.step = state.totalSteps; state.stageLabel = 'Complete'; state.stalled = false;
          writeGenerateStats({ durationMs: state.finishedAt - state.startedAt });
          if (!measureOnly && db?.messages?.embedBacklog) {
            db.messages.embedBacklog(userId)
              .then((b) => writeGenerateStats({ durationMs: state.finishedAt - state.startedAt, embedded: Number(b?.embedded || 0) }))
              .catch(() => { /* count failed — leave the previous baseline; the fallback still governs */ });
          }
          if (!measureOnly) { try { startChronicleNarrationJob({ dbPath, userId }); } catch { /* never block completion */ } }
          refreshSearchIndex();
          bustMindscapePoints(userId); // clustering re-ran → points changed → drop BOTH points + full caches
        } else if (state.status !== 'error') {
          state.status = 'error';
          const detail = lastErrLine();
          const stage = state.step > 0 ? `Step ${state.step}/${state.totalSteps} (${state.stageLabel}) failed` : 'pipeline failed';
          state.error = detail ? `${stage}: ${detail} (exit ${code})` : `${stage} (exit ${code})`;
          state.failedStep = state.step || null;
        }
        publishTerminal(state.status === 'done' ? 'done' : state.status === 'canceled' ? 'abandoned' : 'error', state.status === 'error' ? classifyPipelineFailure(state) : null);
        finish();
      });
      child.on('error', () => {
        if (state.status !== 'canceled') {
          state.status = 'error'; state.error = 'failed to start clustering';
          publishTerminal('error', 'failed to start clustering');
        }
        state.finishedAt = Date.now();
        finish();
      });
    } catch {
      // The SPAWN threw — reachable when `cwd: process.cwd()` hits ENOENT because the app's working
      // directory was deleted/unmounted underneath it. No child ⇒ no 'close' ⇒ close the job + feed
      // row HERE (terminal 'error' with the content-free constant), free the ticket, and NEVER
      // re-throw: the caller already holds this job's id and must not receive a 500 for a start
      // failure (activity-feed contract A7). Keys were resolved at REQUEST time, above, so a key
      // failure has already propagated before this job existed — it cannot reach here.
      state.status = 'error'; state.error = 'failed to start clustering'; state.finishedAt = Date.now();
      if (runningJobId === jobId) runningJobId = null;
      genAdm.release();
      publishTerminal('error', 'failed to start clustering');
    }
  };

  // COMPUTE GOVERNOR (D-001): a real re-cluster loads Ollama models in step 3 (describe) — a
  // RESIDENT lane; measure-only is python metrics with no model — a BULK lane. Reserve BEFORE any
  // child is created.
  const genAdm = admit(measureOnly
    ? { lane: 'measure', klass: CLASS.BULK, estimateGb: 2, timeoutMs: CLUSTERING_LEASE_MS }
    : { lane: 'clustering', klass: CLASS.RESIDENT, timeoutMs: CLUSTERING_LEASE_MS });
  if (genAdm.ok) { launch(genAdm); return { jobId, status: 'running' }; }

  // ── REFUSED ──────────────────────────────────────────────────────────────────────────────────
  // Measure (BULK) is a non-critical metric refresh refused by memory/budget → busy-return; the
  // caller retries. Clean up the job + feed row so no phantom 'running' remains.
  if (measureOnly) {
    jobs.delete(jobId); if (runningJobId === jobId) runningJobId = null;
    publishTerminal('abandoned', null);
    return { jobId: null, status: 'busy', retryAfterMs: genAdm.retryAfterMs };
  }

  // Clustering is a QUEUE lane (design §3.3): a user-initiated Generate MUST eventually run — the
  // D-004 map-rebuild control must complete, never silently die. Enqueue a retry that launches when
  // the resident slot frees (e.g. a background chronicle pass finishes). The job stays 'running'
  // (accepted + in-flight) with a queued stageLabel; the POST returns status:'queued' so the client
  // knows. Coalesced by lane + bounded depth (RESIDENT_QUEUE_MAX) inside the governor.
  state.stageLabel = 'Queued — waiting for compute…';
  const retry = () => {
    if (state.status !== 'running') return; // canceled while queued
    const adm2 = admit({ lane: 'clustering', klass: CLASS.RESIDENT, timeoutMs: CLUSTERING_LEASE_MS });
    if (adm2.ok) { launch(adm2); return; }
    queueForResident('clustering', retry); // still refused (e.g. memory pressure) → wait for the next release
  };
  const q = queueForResident('clustering', retry);
  if (!q.queued) {
    // Queue is full (depth cap) — honest busy with a retry hint rather than an unbounded backlog.
    jobs.delete(jobId); if (runningJobId === jobId) runningJobId = null;
    publishTerminal('abandoned', null);
    return { jobId: null, status: 'busy', retryAfterMs: genAdm.retryAfterMs };
  }
  return { jobId, status: 'queued' };
}

/** Refresh the analysis/measurement layer on the existing mindscape — NO re-cluster,
 *  NO narration (run-clustering.sh MEASURE_ONLY skips Steps 1-3). Non-destructive, so
 *  it runs even while Generate is kill-switched. Same single-flight lane as Generate
 *  (one pipeline child at a time). The running app supplies the in-memory session key. */
export function startMeasurementJob({ dbPath, userId, db } = {}) {
  return startClusteringJob({ dbPath, userId, db, measureOnly: true });
}

/**
 * Kill-switch for the SQLCipher-collapse backfill (separate from generateLocked so an
 * operator can disable migrations without disabling Generate, and vice-versa). Returns
 * true when backfill is locked via env (MYCELIUM_DISABLE_BACKFILL=1) or a sentinel file
 * `.backfill-disabled` next to the DB. Default OFF.
 */
export function backfillLocked() {
  if (process.env.MYCELIUM_DISABLE_BACKFILL === '1') return true;
  try { return fs.existsSync(path.join(path.dirname(resolveDbPath()), '.backfill-disabled')); }
  catch { return false; }
}

/**
 * Start an in-app SQLCipher-collapse backfill — convert a column's encrypted
 * wrapped-DEK envelopes to plaintext (content) or raw LE-f32 bytes (vector), IN the
 * app's own keyed handle (NOT a spawned child: a 2nd writer would contend on
 * SQLCipher's single-writer lock). Shares the clustering single-flight (`runningJobId`)
 * so a backfill and a re-cluster — both write the same tables — can't race; status
 * polls the SAME /mycelium/generate/status/:id endpoint via the `jobs` Map.
 *
 * Safety: a pre-campaign ciphertext copy of the vault is taken before any mutation and
 * is PURGED only after every column verifies 0 remaining envelopes; on any failure (or
 * a non-zero envelope count) the backup is KEPT for recovery and the job is `error`.
 *
 * @param {{ db: object, dbPath?: string, columns: Array<{table:string, column:string, codec:object}> }} opts
 * @returns {{ jobId: string|null, status: string }}
 */
export function startBackfillJob({ db, dbPath, columns } = {}) {
  if (backfillLocked()) {
    console.error('[mycelium] Backfill is LOCKED (.backfill-disabled / MYCELIUM_DISABLE_BACKFILL) — refusing to run.');
    return { jobId: null, status: 'disabled' };
  }
  // Same single-flight as clustering: a backfill and a re-cluster both write
  // clustering_points/profiles — never let two vault writers run at once.
  const cur = runningJobId ? jobs.get(runningJobId) : null;
  if (cur && (cur.status === 'running' || cur.child)) {
    return { jobId: runningJobId, status: 'already_running' };
  }
  const rawDb = db?._sqlite;
  if (!rawDb || typeof rawDb.prepare !== 'function') return { jobId: null, status: 'unavailable' };
  if (!Array.isArray(columns) || columns.length === 0) return { jobId: null, status: 'no_columns' };

  // Fail-closed disk guard: backfill takes a full VACUUM INTO snapshot (~vault size)
  // then rewrites columns. On a near-full disk the snapshot alone can hit ENOSPC.
  try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
  catch (e) { if (e.code === 'DISK_LOW') { console.error(`[mycelium] Backfill refused — ${e.message}`); return { jobId: null, status: 'disk_low', detail: e.detail }; } throw e; }

  const jobId = `backfill_${crypto.randomBytes(6).toString('hex')}`;
  const startedAt = Date.now();
  const path0 = dbPath || resolveDbPath();
  const state = {
    id: jobId, status: 'running', step: 0, totalSteps: columns.length + 2,
    stageLabel: 'starting', error: null, failedStep: null, stalled: false,
    startedAt, finishedAt: null, priorDurationMs: null, child: null,
  };
  jobs.set(jobId, state);
  runningJobId = jobId;

  (async () => {
    let backupPath = null;
    try {
      // 1. Pre-campaign backup — a CONSISTENT copy of the already-encrypted vault
      //    (ciphertext at rest, safe on disk). MUST NOT be fs.copyFileSync: the app
      //    server is a concurrent writer on this same file, so a byte copy tears
      //    ("database disk image is malformed"). safeVaultCopy uses VACUUM INTO — a
      //    transactionally-consistent, same-key-encrypted snapshot, torn-proof under
      //    the live writer. @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
      state.stageLabel = 'backup';
      backupPath = `${path0}.pre-backfill-${startedAt}`;
      safeVaultCopy(rawDb, backupPath);
      state.step = 1;

      // 2. Per-column backfill on the keyed handle (the engine yields + suspends WAL).
      const masterKey = await getMasterKey();
      for (const c of columns) {
        state.stageLabel = `${c.table}.${c.column}`;
        await backfillColumn(rawDb, { table: c.table, column: c.column, codec: c.codec, masterKey, ...(c.pk ? { pk: c.pk } : {}) });
        state.step += 1;
      }

      // 3. Assert 0 remaining envelopes per column. Purge the backup ONLY when clean.
      state.stageLabel = 'verify';
      const dirty = columns
        .map((c) => ({ c, n: countRemainingEnvelopes(rawDb, c.table, c.column) }))
        .filter((r) => r.n > 0);
      if (dirty.length) {
        state.status = 'error';
        state.error = `envelopes remain: ${dirty.map((r) => `${r.c.table}.${r.c.column}=${r.n}`).join(', ')}`;
        // keep the backup — do NOT purge a dirty run
      } else {
        if (backupPath) { try { fs.unlinkSync(backupPath); } catch { /* */ } }
        state.status = 'done';
      }
    } catch (err) {
      state.status = 'error';
      state.error = String(err?.message || err);   // engine never includes plaintext
      // keep the backup on any failure
    } finally {
      state.step = state.totalSteps;
      state.finishedAt = Date.now();
      state.priorDurationMs = state.finishedAt - startedAt;
      if (runningJobId === jobId) runningJobId = null;
    }
  })();

  return { jobId, status: 'running' };
}

/** Public status view for a job (no internals/secrets — note `child` is omitted). */
export function getJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return { id: j.id, status: j.status, step: j.step, totalSteps: j.totalSteps, stageLabel: j.stageLabel, error: j.error, failedStep: j.failedStep ?? null, stalled: j.stalled ?? false, startedAt: j.startedAt, finishedAt: j.finishedAt, priorDurationMs: j.priorDurationMs ?? null };
}

/**
 * Cancel a running job: stop the child (SIGTERM→SIGKILL) and mark it `canceled`.
 * Lets the UI escape a slow/wedged run instead of waiting out the 45-min cap.
 * `runningJobId` is freed by the child's close handler (once reaped) so a restart
 * can't race the dying child on the same DB. Returns true iff a run was canceled.
 */
export function cancelJob(jobId) {
  const j = jobs.get(jobId);
  if (!j || j.status !== 'running') return false;
  j.status = 'canceled';
  j.stageLabel = 'Canceling…';
  const c = j.child;
  if (c) {
    try { c.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
  }
  return true;
}

// Test seam: reset registry state between verify runs in the same process.
export function _resetJobs() { jobs.clear(); runningJobId = null; }

/** True while a clustering child is alive — the claim heartbeat checks this so
 *  discovery never piles onto a heavy Generate run. */
export function isClusteringRunning() {
  const cur = runningJobId ? jobs.get(runningJobId) : null;
  return !!(cur && (cur.status === 'running' || cur.child));
}

/**
 * Pure gate for FIRST-RUN auto-generation (the enrich drainer's onSettled hook
 * uses this via server-rest). Fire the topology pipeline automatically only when:
 *   - no clustering child is already running (single-flight),
 *   - enough messages are embedded (data floor), and
 *   - NO topology exists yet (clustering_points empty) — so it fires once on the
 *     first generation; re-generation stays a manual, user-driven action.
 * ⚠️ The caller now passes the MANUAL floor (MIN_EMBEDDED=5), not 25 — a real-but-small vault
 * used to sit un-clustered and silent (PIPELINE-TRANSPARENCY-DESIGN §"Filling the gaps" #2). This
 * function's own `min = 25` default is inert (the caller always supplies `min`); it is kept only so
 * a bare call is conservative. Sub-floor vaults are surfaced by the readiness `pipeline` slice
 * (cluster.blocked/too_few_embedded + a Generate button), never stranded.
 * @returns {boolean}
 */
export function shouldAutoGenerate({ embedded, points, clusteringRunning, min = 25, builtAtEmbedded = undefined } = {}) {
  if (clusteringRunning || Number(embedded) < Number(min)) return false;
  if (Number(points) === 0) return true;                       // first run — unchanged
  // ── D-004: AUTO-REBUILD PAST A DRIFT THRESHOLD ────────────────────────────────────
  // `points === 0` alone meant "auto-generate exactly once, ever". Combined with the
  // route's unconditional skip, a map built on day one stayed on day one forever — the
  // operator's 369-point map under a 2510-message vault. This hook fires from the enrich
  // drainer's onSettled, i.e. AFTER embedding has drained, which is precisely when a large
  // import has just made the map stale and precisely when the embed lane is idle.
  //
  // ⚠️ Callers that do not pass `builtAtEmbedded` keep the OLD behaviour exactly
  // (`undefined` ⇒ never auto-rebuild). Opt-in, so no existing caller silently starts
  // spawning heavy re-clusters — the D-001 compute-governor work (QA7 U1) is not built yet
  // and this is a resident-model lane.
  if (builtAtEmbedded === undefined) return false;
  return evaluateFreshness({ embedded, mapped: Number(points), builtAtEmbedded }).stale;
}

/**
 * Spawn the Persona-Claims discovery child for one cadence (heartbeat-driven).
 * Lean fire-and-forget: resolves master keys at spawn time (same source as the
 * clustering job), hands them to the child via an allowlisted env, logs the
 * outcome.
 *
 * Child exit codes — the two "no model" cases are NOT the same thing:
 *   0 → ran, or FAIL-SOFT: the approved model was unreachable (transient) → no-op.
 *   2 → REFUSED: no on-box model is approved. Claims are sensitive and run on-box,
 *       so the child will not substitute a default (see pipeline/discover-claims.mjs).
 *       Fire-and-forget: the close handler below just logs it. Nothing retries, and
 *       the hourly heartbeat re-spawns on the next window exactly as an exit-0 no-op
 *       would — a refusal stalls no state, it only stops running an unapproved model.
 * @returns {{ pid: number|null }}
 */
export function startClaimDiscoveryJob({ dbPath, userId, cadence } = {}) {
  // Fail-closed disk guard: the claims child opens the vault RW and writes; skip on a
  // near-full disk (ENOSPC storm is a corruption co-factor). Fire-and-forget → no pid.
  try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
  catch (e) { if (e.code === 'DISK_LOW') return { pid: null, status: 'disk_low' }; throw e; }
  // COMPUTE GOVERNOR (D-001, L10): discover-claims.mjs runs an on-box model (design §0) — a
  // RESIDENT lane, gated conservatively. (Whether it loads a resident model or only reads is
  // UNCONFIRMED — design §6 — so the safe assignment is RESIDENT; it is off by default anyway.)
  const adm = admit({ lane: 'claim-discovery', klass: CLASS.RESIDENT, timeoutMs: CLAIM_LEASE_MS });
  if (!adm.ok) return { pid: null, status: 'busy', retryAfterMs: adm.retryAfterMs };
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
    // Forward the vault writer-lock family token so this pipeline child is recognized
    // as same-family (not a foreign writer) when it opens the vault. See db/writer-lock.js.
    ...(process.env.MYCELIUM_VAULT_FAMILY ? { MYCELIUM_VAULT_FAMILY: process.env.MYCELIUM_VAULT_FAMILY } : {}),
  };
  const args = ['pipeline/discover-claims.mjs'];
  if (cadence) args.push(`--cadence=${cadence}`);
  let child;
  try {
    child = _spawn('node', args, { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    adm.release();
    return { pid: null };
  }
  adm.bindChild(child);          // governor releases on close/error — crash-release #2
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    adm.release();
    if (code !== 0) process.stderr.write(`[claims] discovery(${cadence}) exited ${code}: ${err.slice(-300)}\n`);
  });
  child.on('error', () => { adm.release(); });
  return { pid: child.pid ?? null };
}

/**
 * Spawn the chronicle-narration child as an ASYNC BACKGROUND pass (post-Generate).
 * Mirrors startClaimDiscoveryJob: re-resolves the master keys at spawn, hands them
 * to the child via an allowlisted env (never args/logs), fire-and-forget, fail-soft.
 *
 * WHY ASYNC: narration calls a per-territory LLM (local Ollama by default). Run
 * inline in Generate's Step 3 it stalled the bar for minutes and the first call's
 * cold model-load blew past the 60s default timeout, cascading to empty chronicles.
 * Off the critical path we give it a GENEROUS timeout (default 180s, env-tunable)
 * that absorbs the cold load; Ollama's keep_alive holds the model warm across the
 * loop. The child (pipeline/describe-chronicles.js) is fail-soft (no model → no-op).
 * @returns {{ pid: number|null }}
 */
/** Best-effort in-RAM search index refresh (registry may be empty in stdio/test
 * boots; rebuild reuses stored message vectors so the cost is profile-text-only). */
function refreshSearchIndex() {
  import('./search/registry.js')
    .then(({ getMindSearch }) => getMindSearch()?.rebuild())
    .catch(() => { /* best-effort — search self-heals on next process start */ });
}

// Single-flight for the chronicle pass: two overlapping Generates would otherwise
// double-narrate every pending territory (duplicate inference spend; last write
// wins). A crashed child clears the flag via its close handler.
let chronicleChildRunning = false;

export function startChronicleNarrationJob({ dbPath, userId, territoryId = null } = {}) {
  if (chronicleChildRunning) return { pid: null };
  // Fail-closed disk guard: describe-chronicles opens the vault RW and writes narration;
  // on a near-full disk that risks the ENOSPC storm. This is the path "describe more"
  // spawns → return a structured disk_low so the UI can say "free N GB" instead of the
  // old silent stuck-"Describing…". @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
  try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
  catch (e) { if (e.code === 'DISK_LOW') return { pid: null, status: 'disk_low', detail: e.detail }; throw e; }
  // COMPUTE GOVERNOR (D-001): describe-chronicles loads an Ollama model — a RESIDENT lane. Reserve
  // the single model slot BEFORE spawning. Refused while any other resident lane (embed-categorize,
  // clustering, another describe, chat) holds it. This is P1: the reported symptom (drain × describe).
  const adm = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT, timeoutMs: DESCRIBE_LEASE_MS });
  if (!adm.ok) return { pid: null, status: 'busy', retryAfterMs: adm.retryAfterMs };
  // territoryId: scoped per-territory "describe more" — describe-chronicles.js narrates
  // just that territory (bypassing the version/drift gate) + rolls up its theme/realm.
  // null = the normal global gap-fill pass. Spawned as a CHILD either way (NEVER in the
  // server event loop — the in-process narration-walk pegged CPU + white-screened the app).
  const scopedTerritory = territoryId != null && Number.isFinite(Number(territoryId)) ? String(Number(territoryId)) : null;
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();
  const childEnv = {
    PATH: process.env.PATH,
    // USER/LOGNAME/HOME, filled from os.userInfo() when a Finder/launchd launch omits them.
    ...identityEnv(),
    LANG: process.env.LANG,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
    // Forward the vault writer-lock family token so this pipeline child is recognized
    // as same-family (not a foreign writer) when it opens the vault. See db/writer-lock.js.
    ...(process.env.MYCELIUM_VAULT_FAMILY ? { MYCELIUM_VAULT_FAMILY: process.env.MYCELIUM_VAULT_FAMILY } : {}),
    // Generous per-territory timeout (background → no UI bar to freeze): absorbs the
    // first call's cold model-load. Env override wins so tests can shrink it.
    MYCELIUM_CHRONICLE_TIMEOUT_MS: process.env.MYCELIUM_CHRONICLE_TIMEOUT_MS || '180000',
    // Chronicle-safe by default: fill gaps, never rewrite an existing/inherited
    // chronicle with the local model (override with MYCELIUM_DESCRIBE_PRESERVE=0).
    MYCELIUM_DESCRIBE_PRESERVE: process.env.MYCELIUM_DESCRIBE_PRESERVE ?? '1',
    // Scoped per-territory describe-more (omitted → global pass).
    ...(scopedTerritory ? { MYCELIUM_DESCRIBE_TERRITORY: scopedTerritory } : {}),
    // Inherit the bundled-runtime envs (packaged app) like the clustering job.
    ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
    ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
  };
  let child;
  try {
    child = _spawn('node', ['pipeline/describe-chronicles.js'], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    adm.release();               // never leak the ticket when the spawn itself throws
    return { pid: null };
  }
  chronicleChildRunning = true;
  adm.bindChild(child);          // governor releases on close/error (first wins) — crash-release #2
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    chronicleChildRunning = false;
    adm.release();               // explicit release (idempotent with the child-binding above)
    if (code !== 0) process.stderr.write(`[chronicles] narration exited ${code}: ${err.slice(-300)}\n`);
    // Chronicles change essence (part of the indexed corpus text) — refresh.
    else { refreshSearchIndex(); bustMindscape(userId); } // narrative changed → drop cache
  });
  child.on('error', () => { chronicleChildRunning = false; adm.release(); });
  return { pid: child.pid ?? null };
}

// Single-flight for the cluster-naming pass, for the same reason chronicles has one: two
// overlapping naming passes would double-narrate every unnamed cluster (duplicate inference
// spend; last write wins). A crashed child clears the flag via its close handler.
let namingChildRunning = false;

/**
 * Spawn the cluster-NAMING child (pipeline/describe-clusters.js) as an ASYNC BACKGROUND pass —
 * the ONE reachable trigger for cluster naming. Mirrors startChronicleNarrationJob EXACTLY:
 * re-resolves both master keys at spawn into an allowlisted child env (never args/logs), the
 * fail-closed disk guard, a single-flight latch, and the child-env identity fill.
 *
 * WHY THIS EXISTS: describe-clusters.js is the ONLY writer of realm/territory name+essence, and
 * before this it was reachable only inside Generate's step 3/16 — which the /mycelium/generate
 * debounce skips whenever topology already exists. So on any vault with a map, an unnamed realm
 * could NEVER be named (DISTILLATION-SURFACE-DESIGN §3). This is that missing trigger.
 *
 * GAP-FILL semantics (MYCELIUM_DESCRIBE_PRESERVE=1): name every UNNAMED / placeholder cluster,
 * NEVER re-narrate a real name. describe-clusters' skip predicate is now placeholder-aware (D10),
 * so PRESERVE fills the gaps rather than skipping them. Idempotent: a second pass finds the names
 * it wrote and skips them (0 inference). Consent is the pipeline's own (createNarrator refuses,
 * §4g-sensitive, when no cloud provider and no approved on-box model — nothing is wired here).
 * @returns {{ pid: number|null, status?: string, detail?: object }}
 */
export function startClusterNamingJob({ dbPath, userId } = {}) {
  if (namingChildRunning) return { pid: null };
  // Fail-closed disk guard: describe-clusters opens the vault RW and writes names/essences; on a
  // near-full disk that risks the ENOSPC storm. Return a structured disk_low so the route can say
  // "free N GB" instead of a silent stuck row. Mirrors startChronicleNarrationJob.
  try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
  catch (e) { if (e.code === 'DISK_LOW') return { pid: null, status: 'disk_low', detail: e.detail }; throw e; }
  // COMPUTE GOVERNOR (D-001, P3/C9): describe-clusters loads the naming model — a RESIDENT lane,
  // and the SAME lane the in-pipeline copy (run-clustering.sh step 3) runs under a clustering
  // ticket. Reserving 'describe-clusters' here means a standalone naming pass is refused while a
  // Generate is clustering (or another describe holds the slot) — closing P3 (two describe-clusters
  // at once) at the JS spawn boundary.
  const adm = admit({ lane: 'describe-clusters', klass: CLASS.RESIDENT, timeoutMs: DESCRIBE_LEASE_MS });
  if (!adm.ok) return { pid: null, status: 'busy', retryAfterMs: adm.retryAfterMs };
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();
  const childEnv = {
    PATH: process.env.PATH,
    // USER/LOGNAME/HOME, filled from os.userInfo() when a Finder/launchd launch omits them.
    ...identityEnv(),
    LANG: process.env.LANG,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
    // Same-family writer-lock token so this pipeline child is not seen as a foreign writer.
    ...(process.env.MYCELIUM_VAULT_FAMILY ? { MYCELIUM_VAULT_FAMILY: process.env.MYCELIUM_VAULT_FAMILY } : {}),
    // GAP-FILL: name the unnamed, preserve real names. describe-clusters reads this flag; the
    // placeholder-aware skip predicate (D10) makes PRESERVE fill placeholders rather than skip
    // them. This is what makes the job's job (naming) actually happen.
    MYCELIUM_DESCRIBE_PRESERVE: '1',
    // Inherit the bundled-runtime envs (packaged app) like the clustering/chronicle jobs.
    ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
    ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
  };
  // The script path is hardcoded (never built from request input); env-overridable ONLY for tests
  // — the same convention startClusteringJob uses (MYCELIUM_CLUSTER_SCRIPT).
  const scriptPath = process.env.MYCELIUM_NAMING_SCRIPT || 'pipeline/describe-clusters.js';
  let child;
  try {
    child = _spawn('node', [scriptPath], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    adm.release();
    return { pid: null };
  }
  namingChildRunning = true;
  adm.bindChild(child);
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    namingChildRunning = false;
    adm.release();
    // Content-free classified failure: the exit code + a stderr tail (describe-clusters' own
    // content-free logs), never a realm name. The pipeline owns its describe:name feed row.
    if (code !== 0) process.stderr.write(`[describe:name] naming exited ${code}: ${err.slice(-300)}\n`);
    // Names changed → they are part of the indexed corpus text, and the mindscape cache holds
    // realm/territory labels. Refresh both so the map + search reflect the new names.
    else { refreshSearchIndex(); bustMindscape(userId); }
  });
  child.on('error', () => { namingChildRunning = false; adm.release(); });
  return { pid: child.pid ?? null };
}

// Test-only reset for the naming single-flight latch (verify:illuminate-naming). Mirrors the
// narration reset; no-op in production paths.
export function _resetClusterNaming() { namingChildRunning = false; }

// ── Narration walk (Phase 3): UI-controlled, pausable/resumable agent narration ──
// The job owns the narration_runs checkpoint + the activity feed + single-flight.
// The actual traversal is an INJECTED async `runWalk({ scope, skipIds, onProgress,
// shouldStop })` — production wires src/agent/narration-walk.js with the assembled
// agent runtime; the gate injects a stub. Pause/cancel never interrupt mid-write:
// they flip narration_runs.status; the walk's shouldStop() reads it and stops AFTER
// the current entity, persisting done_ids as the resume checkpoint.
let narrationRunning = null; // single-flight: the active run_id, or null

const nrQuery = (db, sql, p = []) => db.rawQuery(sql, p).then((r) => (Array.isArray(r) ? r : r.results || []));
async function nrGet(db, runId) { return (await nrQuery(db, `SELECT * FROM narration_runs WHERE run_id = ?`, [runId]))[0] || null; }
async function nrStatus(db, runId) { return (await nrGet(db, runId))?.status || null; }
async function nrUpdate(db, runId, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).concat("updated_at = datetime('now')");
  await nrQuery(db, `UPDATE narration_runs SET ${sets.join(', ')} WHERE run_id = ?`, [...keys.map((k) => fields[k]), runId]);
}

// ── WHERE the narration content actually went (NarrateControl's sovereignty badge) ──────
// Tallies each turn's OBSERVED destination (narration-walk `wireRan`/`onThisDevice`, sourced
// from loop.js actualOnThisDevice — the provider that really answered, AFTER any chain
// advance). NOT a prediction: a sensitive chain is [localPrimary, eu-zdr…, localFloor], so a
// run whose on-box Ollama dies falls back to EU cloud mid-run, and anything decided at START
// would claim "on-box" while the bytes left.
//
// Fail-closed, and the two failure directions are NOT symmetric-but-equal — they are both lies:
// claiming on-box when content left is the §1 leak-class one; claiming it left when it didn't
// is a false alarm that teaches the user to ignore the badge. So UNKNOWN gets its own state and
// claims NOTHING.
//   any turn proven OFF this device → 0  (dominant + sticky: once content leaves, it has left)
//   else any turn we cannot attribute → null (unknown — the local FLOOR has no base_url)
//   else any turn proven ON this device → 1
//   nothing observed → null
function makeDeviceTally(row) {
  let off = 0, unknown = 0, on = 0;
  const jur = new Set();
  // Seed from the row so a RESUME never forgets what an earlier segment did.
  if (row?.on_this_device === 0) off = 1;
  if (row?.on_this_device === 1) on = 1;
  // …and a row that is NULL while turns have already COMPLETED means an earlier segment ran a
  // wire it could not attribute. Without this, the resumed segment could report 1 ("all on this
  // device") on behalf of turns it never saw.
  //
  // ⚠️ KNOWN GAP, currently unreachable — narration_runs persists no `failed` count, so a
  // segment whose turns ALL FAILED on an unattributable wire leaves described+reflected = 0 and
  // this seeding misses it. That is safe ONLY because UNKNOWN means describeProvider returned
  // null (no key + no base_url), and normalizeProvider dials exactly that cfg at
  // DEFAULT_OLLAMA_URL — so an unattributable wire IS on this device and the resumed "1" is
  // TRUE. That is a COUPLING to the floor's default host, not a property of this tally: point
  // the floor off-box and this opens silently, fail-OPEN. verify:narrate-device-claim D10 pins
  // it — if D10 goes red, make this seeding explicit (persist the unknown state) BEFORE the
  // floor moves.
  if (row?.on_this_device == null && ((row?.described || 0) + (row?.reflected || 0)) > 0) unknown = 1;
  try { for (const j of JSON.parse(row?.off_device_jurisdictions || '[]')) jur.add(j); }
  catch { /* corrupt JSON → start the set clean; the on_this_device verdict above still holds */ }
  return {
    observe(p) {
      if (!p?.wireRan) return;                       // no wire ran (§4g refusal / no model)
      if (p.onThisDevice === true) on += 1;
      else if (p.onThisDevice === false) { off += 1; if (p.wireJurisdiction) jur.add(p.wireJurisdiction); }
      else unknown += 1;                             // ⚠️ NOT counted as on-device
    },
    fields: () => ({
      on_this_device: off > 0 ? 0 : unknown > 0 ? null : on > 0 ? 1 : null,
      off_device_jurisdictions: jur.size ? JSON.stringify([...jur].sort()) : null,
    }),
  };
}

/** Start a narration walk. runWalk is required (route wires the real one; gate stubs).
 *  Returns { runId, status } immediately; the walk runs async. Single-flight. */
// A narration run's terminal status — for START and RESUME alike.
//
// ⚠️ 'done' IS A CLAIM, and it was made unconditionally on both paths. A run in which EVERY
// turn failed — a dead Ollama, or a §4g refusal with nothing safe to run on — reported exactly
// what a fully-described run reported. The walk's counters were honest; the STATUS was not, and
// the status is what the UI reads.
//
// It lives here, called by both, because the first fix landed on START ONLY and left RESUME —
// THE RETRY PATH — still claiming done: pause a stalling walk, resume with Ollama still dead,
// every turn fails, UI says "done". Two copies of a rule is how a rule drifts (independent
// review, 2026-07-16).
//
// A PARTIAL failure is NOT an error: it described things. Reporting error there would be the
// mirror mistake — a false failure over a run that did real work.
async function finishNarrationRun(db, runId, walk) {
  if ((await nrStatus(db, runId)) !== 'running') return;   // paused/canceled owns its own status
  const failed = Number(walk?.failed) || 0;
  const skipped = Number(walk?.skipped) || 0;
  const wrote = (Number(walk?.described) || 0) + (Number(walk?.reflected) || 0);
  // 'error' means the run accomplished NOTHING — a TOTAL wipeout (dead Ollama, §4g refusal with
  // nothing safe to run on). `wrote === 0` alone is not that: re-running an already-narrated
  // vault coverage-skips most entities, so a flaky wire that fails 2 of them (wrote 0, skipped
  // many) would falsely read 'error' over a fully-narrated mind (independent review, 2026-07-16).
  // Coverage-skips ARE work done — the run assessed those entities and correctly left them. So
  // error only when nothing was written AND nothing was even skipped.
  if (failed > 0 && wrote === 0 && skipped === 0) {
    await nrUpdate(db, runId, { status: 'error', error: `narration produced nothing: ${failed} turn(s) failed` });
  } else {
    await nrUpdate(db, runId, { status: 'done' });
  }
}

// Propagate a run's TERMINAL narration_runs.status to the GLOBAL activity feed — for START and
// RESUME alike. Lives here, called by both `finally`s, for the same reason finishNarrationRun
// does: the first version put it on start ONLY, so a RESUMED run (= the retry path) that
// completed showed as 'abandoned' in the header feed, and a resumed run that errored never
// surfaced there at all — the reaper had already flipped the paused row, and heartbeat() is
// `WHERE status='running'` so nothing could revive it. Two copies of a status map is how the
// map drifts (independent review, 2026-07-16). NarrateControl reads narration_runs directly, so
// the dedicated control was always right; this is the global feed chip only.
async function finishNarrationFeed(db, runId) {
  if (!db?.activityFeed) return;
  const st = await nrStatus(db, runId);
  const feedStatus = st === 'done' ? 'done' : (st === 'canceled' || st === 'paused') ? 'abandoned' : 'error';
  db.activityFeed.finish(runId, { status: feedStatus }).catch(() => {});
}

// ⚠️ NO `provider` PARAM. It took a caller-supplied label straight onto the row, and the UI
// regex-matched that NAME to tell the user whether narration content left their machine — so
// the caller effectively authored the sovereignty claim (a row labelled "localai" read as
// on-box). It was never a fact about the run: the walk resolves its provider server-side, per
// turn. The destination is now OBSERVED as the walk runs (makeDeviceTally). The vestigial
// narration_runs.provider column stays NULL — see migrations/0050.
export async function startNarrationWalkJob({ db, userId, scope = 'all', runWalk } = {}) {
  if (typeof runWalk !== 'function') throw new TypeError('startNarrationWalkJob: runWalk required');
  if (narrationRunning) { const r = await nrGet(db, narrationRunning); if (r && r.status === 'running') return { runId: r.run_id, status: 'running', already: true }; }
  // COMPUTE GOVERNOR (D-001, L9/P13): the narration walk runs per-entity LLM turns IN-PROCESS — a
  // RESIDENT lane. Reserving the model slot here refuses a walk while a describe child / clustering
  // holds it (and vice-versa), closing P13 (narration walk × chronicles simultaneously).
  const adm = admit({ lane: 'narration-walk', klass: CLASS.RESIDENT, timeoutMs: 0 });
  if (!adm.ok) return { runId: null, status: 'busy', retryAfterMs: adm.retryAfterMs };
  const runId = crypto.randomUUID();
  narrationRunning = runId;
  await nrQuery(db,
    `INSERT INTO narration_runs (run_id, user_id, scope, status) VALUES (?, ?, ?, 'running')`,
    [runId, userId, JSON.stringify(scope)]);
  if (db?.activityFeed) db.activityFeed.begin({ userId, kind: 'mycelium_narrate', id: runId, stageLabel: 'Narrating your mind' }).catch(() => {});

  const done = new Set();
  const device = makeDeviceTally(null);   // a fresh run has observed nothing yet
  const onProgress = async (p) => {
    if (p?.doneKey) done.add(p.doneKey);
    device.observe(p);
    await nrUpdate(db, runId, {
      described: p.described ?? 0, reflected: p.reflected ?? 0, skipped: p.skipped ?? 0, total: p.total ?? 0,
      done_ids: JSON.stringify([...done]),
      current_kind: p.item?.kind ?? null, current_id: p.item?.id ?? null,
      ...device.fields(),
    }).catch(() => {});
    // `failed` is deliberately NOT progress: a turn that produced nothing has not advanced
    // the walk, and counting it would march the bar to 100% on a run that did nothing.
    if (db?.activityFeed) db.activityFeed.heartbeat(runId, { step: (p.described ?? 0) + (p.reflected ?? 0) + (p.skipped ?? 0), totalSteps: p.total ?? 0 }).catch(() => {});
  };
  // Stop cleanly when status is no longer 'running' (paused/canceled by a control route).
  const shouldStop = async () => (await nrStatus(db, runId)) !== 'running';

  (async () => {
    try {
      const walk = await runWalk({ runId, scope, skipIds: [], onProgress, shouldStop });
      await finishNarrationRun(db, runId, walk);
    } catch (e) {
      await nrUpdate(db, runId, { status: 'error', error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    } finally {
      adm.release();                 // crash-release #1 (finally) — the model slot is freed on every exit
      narrationRunning = (narrationRunning === runId) ? null : narrationRunning;
      await finishNarrationFeed(db, runId);
    }
  })();

  return { runId, status: 'running' };
}

/** Pause: stop after the current entity (the walk's shouldStop sees 'paused'). */
export async function pauseNarration({ db, runId }) {
  const r = await nrGet(db, runId); if (!r || r.status !== 'running') return { ok: false, status: r?.status || null };
  await nrUpdate(db, runId, { status: 'paused' });
  return { ok: true, status: 'paused' };
}

/** Resume a paused walk from its done_ids checkpoint (already-done entities skipped). */
export async function resumeNarration({ db, userId, runId, runWalk }) {
  if (typeof runWalk !== 'function') throw new TypeError('resumeNarration: runWalk required');
  const r = await nrGet(db, runId); if (!r || r.status !== 'paused') return { ok: false, status: r?.status || null };
  if (narrationRunning && narrationRunning !== runId) return { ok: false, status: 'busy' };
  // COMPUTE GOVERNOR (D-001, L9): resume is the RETRY path and loads the model just like start —
  // reserve the RESIDENT slot here too, or a resumed walk would run un-governed (the exact "the fix
  // landed on start only" trap the narration status/feed code documents twice in this file).
  const adm = admit({ lane: 'narration-walk', klass: CLASS.RESIDENT, timeoutMs: 0 });
  if (!adm.ok) return { ok: false, status: 'busy', retryAfterMs: adm.retryAfterMs };
  narrationRunning = runId;
  await nrUpdate(db, runId, { status: 'running' });
  // RE-OPEN the global feed row. start's pause left it terminal ('abandoned'), and heartbeat()
  // is `WHERE status='running'`, so without this begin() the header shows the narration as
  // abandoned for the whole resume even as it actively runs. begin() is ON CONFLICT DO UPDATE
  // status='running' → it revives the row cleanly. Symmetric with start (jobs.js begin/finish).
  if (db?.activityFeed) db.activityFeed.begin({ userId, kind: 'mycelium_narrate', id: runId, stageLabel: 'Narrating your mind' }).catch(() => {});
  const scope = JSON.parse(r.scope || '"all"');
  const done = new Set(JSON.parse(r.done_ids || '[]'));
  const device = makeDeviceTally(r);   // SEEDED: an earlier segment's egress must not be forgotten
  const onProgress = async (p) => {
    if (p?.doneKey) done.add(p.doneKey);
    device.observe(p);
    await nrUpdate(db, runId, {
      described: p.described ?? r.described, reflected: p.reflected ?? r.reflected, skipped: p.skipped ?? r.skipped, total: p.total ?? r.total,
      done_ids: JSON.stringify([...done]), current_kind: p.item?.kind ?? null, current_id: p.item?.id ?? null,
      ...device.fields(),
    }).catch(() => {});
    if (db?.activityFeed) db.activityFeed.heartbeat(runId, {}).catch(() => {});
  };
  const shouldStop = async () => (await nrStatus(db, runId)) !== 'running';
  (async () => {
    try {
      const walk = await runWalk({ runId, scope, skipIds: [...done], onProgress, shouldStop });
      await finishNarrationRun(db, runId, walk);
    } catch (e) {
      await nrUpdate(db, runId, { status: 'error', error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    } finally {
      adm.release();                 // crash-release #1 (finally) — symmetric with start
      narrationRunning = (narrationRunning === runId) ? null : narrationRunning;
      await finishNarrationFeed(db, runId);   // symmetric with start — resume is the retry path
    }
  })();
  return { ok: true, status: 'running' };
}

/** Cancel: stop after the current entity; the run ends (checkpoint preserved). */
export async function cancelNarration({ db, runId }) {
  const r = await nrGet(db, runId); if (!r || (r.status !== 'running' && r.status !== 'paused')) return { ok: false, status: r?.status || null };
  await nrUpdate(db, runId, { status: 'canceled' });
  if (narrationRunning === runId) narrationRunning = null;
  return { ok: true, status: 'canceled' };
}

export async function getNarrationStatus({ db, runId, userId }) {
  if (runId) { const r = await nrGet(db, runId); return r && (!userId || r.user_id === userId) ? r : null; }
  // latest for the user
  return (await nrQuery(db, `SELECT * FROM narration_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1`, [userId]))[0] || null;
}

export function _resetNarration() { narrationRunning = null; }
