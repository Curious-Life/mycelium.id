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
import { resolveKeys } from './crypto/key-source.js';
import { getSessionKeys } from './account/session-keys.js';
import { dbPath as resolveDbPath } from './paths.js';
import { readGenerateStats, writeGenerateStats } from './generate-stats.js';

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
export function startClusteringJob({ dbPath, userId } = {}) {
  // Single-flight: block while a child is still ALIVE — `running`, or `canceled`
  // but not yet reaped (cur.child set). Prevents two clustering children racing on
  // the same SQLite during a cancel→restart.
  const cur = runningJobId ? jobs.get(runningJobId) : null;
  if (cur && (cur.status === 'running' || cur.child)) {
    return { jobId: runningJobId, status: 'already_running' };
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
  };

  const jobId = `gen_${crypto.randomBytes(6).toString('hex')}`;
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
  const stallTimer = setInterval(() => {
    if (state.status === 'running' && Date.now() - state.lastOutputAt > STALL_MS) state.stalled = true;
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
      try { startChronicleNarrationJob({ dbPath, userId }); } catch { /* never block completion */ }
    } else if (state.status !== 'error') {
      state.status = 'error';
      const detail = lastErrLine();
      state.error = detail ? `${detail} (exit ${code})` : `clustering exited with code ${code}`;
    }
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

/** Public status view for a job (no internals/secrets — note `child` is omitted). */
export function getJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return { id: j.id, status: j.status, step: j.step, totalSteps: j.totalSteps, stageLabel: j.stageLabel, error: j.error, stalled: j.stalled ?? false, startedAt: j.startedAt, finishedAt: j.finishedAt, priorDurationMs: j.priorDurationMs ?? null };
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
 * Spawn the Persona-Claims discovery child for one cadence (heartbeat-driven).
 * Lean fire-and-forget: resolves master keys at spawn time (same source as the
 * clustering job), hands them to the child via an allowlisted env, logs the
 * outcome. The child is FAIL-SOFT (no model → no-op, exit 0).
 * @returns {{ pid: number|null }}
 */
export function startClaimDiscoveryJob({ dbPath, userId, cadence } = {}) {
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
export function startChronicleNarrationJob({ dbPath, userId } = {}) {
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
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
  child.on('close', (code) => {
    if (code !== 0) process.stderr.write(`[chronicles] narration exited ${code}: ${err.slice(-300)}\n`);
  });
  return { pid: child.pid ?? null };
}
