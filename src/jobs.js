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
// reference/server-routes/portal-mindscape-jobs.js.

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

  // Resolve both master keys at spawn time to hand to the child via env. In
  // passphrase-lock mode the keys aren't in the Keychain, so prefer the in-memory
  // session keys (pinned at boot); otherwise re-resolve from the key source.
  // Throws if unavailable — the caller maps that to a 503.
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();

  const scriptPath = process.env.MYCELIUM_CLUSTER_SCRIPT || 'pipeline/run-clustering.sh';
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
    // Packaged self-contained build: use the bundled python + offline model for the
    // clustering child. Unset in dev → run-clustering.sh's $PYTHON seam auto-picks the
    // venv. (PATH already carries the bundled node dir, injected by main.rs.)
    ...(process.env.MYCELIUM_PYTHON ? { PYTHON: process.env.MYCELIUM_PYTHON } : {}),
    ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
    ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
    // Measure-only: run-clustering.sh skips Steps 1-3 (sync/cluster/describe) and
    // refreshes the metric tables on the existing mindscape (Steps 4-16 only).
    ...(measureOnly ? { MYCELIUM_MEASURE_ONLY: '1' } : {}),
  };

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
  if (db?.activityFeed) db.activityFeed.begin({ userId, kind: measureOnly ? 'mycelium_measure' : 'mycelium_generate', id: jobId, totalSteps: 16, stageLabel: feedLabel }).catch(() => {});

  let child;
  try {
    child = spawn('bash', [scriptPath], {
      cwd: process.cwd(),
      env: childEnv,                       // allowlist only — no ambient secrets
      stdio: ['ignore', 'pipe', 'pipe'], // stdout parsed for progress; stderr captured (bounded) to surface the REAL failure reason
    });
  } catch {
    state.status = 'error'; state.error = 'failed to start clustering'; state.finishedAt = Date.now();
    runningJobId = null;
    return { jobId, status: 'running' }; // job created; status will read 'error'
  }
  state.child = child; // expose for cancelJob (never surfaced via getJob)

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

  // Capture the child's stderr in a BOUNDED ring buffer (last ~4 KB) so a
  // failure surfaces its real reason, not just an exit code. The pipeline never
  // prints secrets; we still only ever surface a single trimmed line.
  let errBuf = '';
  child.stderr?.on('data', (d) => {
    errBuf = (errBuf + d.toString()).slice(-4096);
  });
  const lastErrLine = () => errBuf.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
  }, MAX_MS);

  // Inactivity watchdog: flag (don't kill) a run that's gone quiet so the UI can
  // surface "taking longer than usual" + Cancel. Cleared when the child closes.
  // It ALSO sends a keep-alive heartbeat carrying `stalled` — this both refreshes
  // last_heartbeat (so the feed's 45s freshness gate doesn't FALSE-REAP a heavy
  // stage that's quiet on Step lines but still alive) and propagates the stalled
  // flag to the header chip (the feed, not getJob, drives the chip). Gap #4.
  const stallTimer = setInterval(() => {
    if (state.status !== 'running') return;
    if (Date.now() - state.lastOutputAt > STALL_MS) state.stalled = true;
    if (db?.activityFeed) db.activityFeed.heartbeat(jobId, { stalled: state.stalled }).catch(() => {});
  }, 15000);
  if (stallTimer.unref) stallTimer.unref();

  const finish = () => { clearTimeout(timer); clearInterval(stallTimer); state.child = null; if (runningJobId === jobId) runningJobId = null; };

  child.on('close', (code) => {
    state.finishedAt = Date.now();
    if (state.status === 'canceled') {
      state.stageLabel = 'Canceled'; // user-initiated stop → keep, don't mark error
    } else if (code === 0) {
      state.status = 'done'; state.step = state.totalSteps; state.stageLabel = 'Complete'; state.stalled = false;
      writeGenerateStats({ durationMs: state.finishedAt - state.startedAt });
      // Chronicle narration runs ASYNC, after the foreground Generate is done, so a
      // slow local-LLM never stalls the run. Fire-and-forget; territories fill in
      // their chronicles as the background pass writes them (the UI polls). Fail-soft.
      // SKIP for measure-only: it never re-described, so there is nothing new to narrate.
      if (!measureOnly) { try { startChronicleNarrationJob({ dbPath, userId }); } catch { /* never block completion */ } }
      // Describe renamed territories/realms — the in-RAM search corpus indexes
      // name+essence and otherwise stays stale for the whole session (it builds
      // once on first query). Best-effort: rehydrates stored vectors, so no
      // message re-embeds; only profile texts re-embed.
      refreshSearchIndex();
      bustMindscapePoints(userId); // clustering re-ran → points changed → drop BOTH points + full caches
    } else if (state.status !== 'error') {
      state.status = 'error';
      const detail = lastErrLine();
      // Name the STAGE that was running so the user (and the activity feed) sees
      // "Step 7/16 (Fisher trajectory) failed: …" instead of a bare exit code.
      const stage = state.step > 0 ? `Step ${state.step}/${state.totalSteps} (${state.stageLabel}) failed` : 'pipeline failed';
      state.error = detail ? `${stage}: ${detail} (exit ${code})` : `${stage} (exit ${code})`;
      state.failedStep = state.step || null;
    }
    if (db?.activityFeed) db.activityFeed.finish(jobId, { status: state.status === 'done' ? 'done' : state.status === 'canceled' ? 'abandoned' : 'error', error: state.status === 'error' ? state.error : null }).catch(() => {});
    finish();
  });
  child.on('error', () => {
    if (state.status !== 'canceled') {
      state.status = 'error'; state.error = 'failed to start clustering';
    }
    state.finishedAt = Date.now();
    finish();
  });

  return { jobId, status: 'running' };
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
 *   - enough messages are embedded (data floor — avoids a trivial 1-cluster map;
 *     manual Generate's MIN_EMBEDDED=5 still works below this), and
 *   - NO topology exists yet (clustering_points empty) — so it fires once on the
 *     first generation; re-generation stays a manual, user-driven action.
 * @returns {boolean}
 */
export function shouldAutoGenerate({ embedded, points, clusteringRunning, min = 25 } = {}) {
  return !clusteringRunning && Number(embedded) >= Number(min) && Number(points) === 0;
}

/**
 * Spawn the Persona-Claims discovery child for one cadence (heartbeat-driven).
 * Lean fire-and-forget: resolves master keys at spawn time (same source as the
 * clustering job), hands them to the child via an allowlisted env, logs the
 * outcome. The child is FAIL-SOFT (no model → no-op, exit 0).
 * @returns {{ pid: number|null }}
 */
export function startClaimDiscoveryJob({ dbPath, userId, cadence } = {}) {
  // Fail-closed disk guard: the claims child opens the vault RW and writes; skip on a
  // near-full disk (ENOSPC storm is a corruption co-factor). Fire-and-forget → no pid.
  try { assertVaultDiskHeadroom(dbPath || resolveDbPath()); }
  catch (e) { if (e.code === 'DISK_LOW') return { pid: null, status: 'disk_low' }; throw e; }
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
  };
  const args = ['pipeline/discover-claims.mjs'];
  if (cadence) args.push(`--cadence=${cadence}`);
  let child;
  try {
    child = spawn('node', args, { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    return { pid: null };
  }
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    if (code !== 0) process.stderr.write(`[claims] discovery(${cadence}) exited ${code}: ${err.slice(-300)}\n`);
  });
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
  // territoryId: scoped per-territory "describe more" — describe-chronicles.js narrates
  // just that territory (bypassing the version/drift gate) + rolls up its theme/realm.
  // null = the normal global gap-fill pass. Spawned as a CHILD either way (NEVER in the
  // server event loop — the in-process narration-walk pegged CPU + white-screened the app).
  const scopedTerritory = territoryId != null && Number.isFinite(Number(territoryId)) ? String(Number(territoryId)) : null;
  const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
    USER_MASTER: userHex,
    SYSTEM_KEY: systemHex,
    MYCELIUM_DB: dbPath || resolveDbPath(),
    MYCELIUM_USER_ID: userId || process.env.MYCELIUM_USER_ID || 'local-user',
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
    child = spawn('node', ['pipeline/describe-chronicles.js'], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    return { pid: null };
  }
  chronicleChildRunning = true;
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    chronicleChildRunning = false;
    if (code !== 0) process.stderr.write(`[chronicles] narration exited ${code}: ${err.slice(-300)}\n`);
    // Chronicles change essence (part of the indexed corpus text) — refresh.
    else { refreshSearchIndex(); bustMindscape(userId); } // narrative changed → drop cache
  });
  child.on('error', () => { chronicleChildRunning = false; });
  return { pid: child.pid ?? null };
}

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

/** Start a narration walk. runWalk is required (route wires the real one; gate stubs).
 *  Returns { runId, status } immediately; the walk runs async. Single-flight. */
export async function startNarrationWalkJob({ db, userId, scope = 'all', provider = null, runWalk } = {}) {
  if (typeof runWalk !== 'function') throw new TypeError('startNarrationWalkJob: runWalk required');
  if (narrationRunning) { const r = await nrGet(db, narrationRunning); if (r && r.status === 'running') return { runId: r.run_id, status: 'running', already: true }; }
  const runId = crypto.randomUUID();
  narrationRunning = runId;
  await nrQuery(db,
    `INSERT INTO narration_runs (run_id, user_id, scope, provider, status) VALUES (?, ?, ?, ?, 'running')`,
    [runId, userId, JSON.stringify(scope), provider || null]);
  if (db?.activityFeed) db.activityFeed.begin({ userId, kind: 'mycelium_narrate', id: runId, stageLabel: 'Narrating your mind' }).catch(() => {});

  const done = new Set();
  const onProgress = async (p) => {
    if (p?.doneKey) done.add(p.doneKey);
    await nrUpdate(db, runId, {
      described: p.described ?? 0, reflected: p.reflected ?? 0, skipped: p.skipped ?? 0, total: p.total ?? 0,
      done_ids: JSON.stringify([...done]),
      current_kind: p.item?.kind ?? null, current_id: p.item?.id ?? null,
    }).catch(() => {});
    if (db?.activityFeed) db.activityFeed.heartbeat(runId, { step: (p.described ?? 0) + (p.reflected ?? 0) + (p.skipped ?? 0), totalSteps: p.total ?? 0 }).catch(() => {});
  };
  // Stop cleanly when status is no longer 'running' (paused/canceled by a control route).
  const shouldStop = async () => (await nrStatus(db, runId)) !== 'running';

  (async () => {
    try {
      await runWalk({ runId, scope, skipIds: [], onProgress, shouldStop });
      const cur = await nrStatus(db, runId);
      if (cur === 'running') await nrUpdate(db, runId, { status: 'done' });
    } catch (e) {
      await nrUpdate(db, runId, { status: 'error', error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    } finally {
      narrationRunning = (narrationRunning === runId) ? null : narrationRunning;
      const st = await nrStatus(db, runId);
      if (db?.activityFeed) db.activityFeed.finish(runId, { status: st === 'done' ? 'done' : st === 'canceled' ? 'abandoned' : st === 'paused' ? 'abandoned' : 'error' }).catch(() => {});
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
  narrationRunning = runId;
  await nrUpdate(db, runId, { status: 'running' });
  const scope = JSON.parse(r.scope || '"all"');
  const done = new Set(JSON.parse(r.done_ids || '[]'));
  const onProgress = async (p) => {
    if (p?.doneKey) done.add(p.doneKey);
    await nrUpdate(db, runId, {
      described: p.described ?? r.described, reflected: p.reflected ?? r.reflected, skipped: p.skipped ?? r.skipped, total: p.total ?? r.total,
      done_ids: JSON.stringify([...done]), current_kind: p.item?.kind ?? null, current_id: p.item?.id ?? null,
    }).catch(() => {});
    if (db?.activityFeed) db.activityFeed.heartbeat(runId, {}).catch(() => {});
  };
  const shouldStop = async () => (await nrStatus(db, runId)) !== 'running';
  (async () => {
    try {
      await runWalk({ runId, scope, skipIds: [...done], onProgress, shouldStop });
      if ((await nrStatus(db, runId)) === 'running') await nrUpdate(db, runId, { status: 'done' });
    } catch (e) {
      await nrUpdate(db, runId, { status: 'error', error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    } finally {
      narrationRunning = (narrationRunning === runId) ? null : narrationRunning;
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
