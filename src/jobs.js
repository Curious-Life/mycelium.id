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
import { dbPath as resolveDbPath } from './paths.js';

const MAX_MS = Number(process.env.MYCELIUM_GEN_MAX_MS) || 45 * 60 * 1000; // 45 min hard cap
const STAGE_LABELS = {
  1: 'Syncing content…',
  2: 'Clustering (FAISS + Leiden + Ward)…',
  3: 'Describing realms + territories…',
  4: 'Computing co-firing…',
  5: 'Computing information harmonics…',
};

const jobs = new Map();   // jobId → state (kept for status polling)
let runningJobId = null;  // single-flight: at most one clustering run at a time

/**
 * Start a clustering run. Single-flight: a second call while one is in flight
 * returns the in-flight job. Returns { jobId, status: 'running' | 'already_running' }.
 * @param {{ dbPath?: string, userId?: string }} opts
 */
export function startClusteringJob({ dbPath, userId } = {}) {
  if (runningJobId && jobs.get(runningJobId)?.status === 'running') {
    return { jobId: runningJobId, status: 'already_running' };
  }

  // Bound memory: evict old finished jobs (status polling only needs recent ones).
  if (jobs.size > 50) {
    for (const [id, j] of jobs) {
      if (j.status !== 'running') jobs.delete(id);
      if (jobs.size <= 25) break;
    }
  }

  // Re-resolve keys from the configured source (env / Keychain / 1Password) at
  // spawn time. Throws if unavailable — the caller maps that to a 503.
  const { userHex, systemHex } = resolveKeys();

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

  let buf = '';
  child.stdout.on('data', (d) => {
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

  child.on('close', (code) => {
    clearTimeout(timer);
    state.finishedAt = Date.now();
    if (code === 0) { state.status = 'done'; state.step = state.totalSteps; state.stageLabel = 'Complete'; }
    else if (state.status !== 'error') {
      state.status = 'error';
      const detail = lastErrLine();
      state.error = detail ? `${detail} (exit ${code})` : `clustering exited with code ${code}`;
    }
    if (runningJobId === jobId) runningJobId = null;
  });
  child.on('error', () => {
    clearTimeout(timer);
    state.status = 'error'; state.error = 'failed to start clustering'; state.finishedAt = Date.now();
    if (runningJobId === jobId) runningJobId = null;
  });

  return { jobId, status: 'running' };
}

/** Public status view for a job (no internals/secrets). */
export function getJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return { id: j.id, status: j.status, step: j.step, totalSteps: j.totalSteps, stageLabel: j.stageLabel, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt };
}

// Test seam: reset registry state between verify runs in the same process.
export function _resetJobs() { jobs.clear(); runningJobId = null; }
