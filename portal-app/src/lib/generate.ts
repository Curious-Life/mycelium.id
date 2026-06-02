// portal-app/src/lib/generate.ts
//
// ONE shared lifecycle for "Generate Mycelium", consumed by both trigger sites
// (the onboarding "activate analysis" card AND the mindscape page). Before this,
// each site duplicated the start/poll logic and BOTH mishandled the real server
// contract — they only special-cased `503 ai_not_ready` + `429` (neither of which
// the server returns) and threw "Failed to start generation" on everything else,
// including the common `409` you get when you click before embedding finishes.
//
// Real backend contract (src/portal-mindscape.js + src/jobs.js):
//   POST /portal/mycelium/generate
//     200 { jobId, status }                       → job running
//     409 { error, reason, embedded, total }      → preflight: not enough embedded yet
//     503 { error }                               → keys/pipeline not ready
//   GET  /portal/mycelium/generate/status/:id     → { status, step, totalSteps,
//                                                     stageLabel, error, startedAt,
//                                                     finishedAt, priorDurationMs }
//   GET  /portal/mycelium/processing-status       → { embedded, total, pending }
//
// On 409 we DON'T error — we show "processing N/M" and AUTO-START once enough is
// embedded. Progress uses the server's totalSteps (5), not a hardcoded guess. ETA
// is seeded from the last run's duration (priorDurationMs) and refined by step
// fraction. Real pipeline errors (e.g. missing deps) are surfaced verbatim.

import { writable, get } from 'svelte/store';
import { api } from './api';

export type GenPhase = 'idle' | 'embedding' | 'starting' | 'running' | 'done' | 'error';

export interface GenState {
  phase: GenPhase;
  jobId: string | null;
  step: number;
  totalSteps: number;
  stageLabel: string;
  embedded: number;
  total: number;
  startedAt: number | null;
  elapsedMs: number;
  etaSeconds: number | null; // null = unknown yet
  message: string; // info (e.g. "processing 12/132 ready")
  error: string; // set iff phase === 'error'
}

const SS_KEY = 'mycelium_gen_job';
const MIN_EMBEDDED = 5;
const POLL_MS = 1500;

const initial: GenState = {
  phase: 'idle', jobId: null, step: 0, totalSteps: 5, stageLabel: '',
  embedded: 0, total: 0, startedAt: null, elapsedMs: 0, etaSeconds: null, message: '', error: '',
};

export const generate = writable<GenState>({ ...initial });

let timer: ReturnType<typeof setInterval> | null = null;
let priorDurationMs: number | null = null;

const patch = (p: Partial<GenState>) => generate.update((s) => ({ ...s, ...p }));
const ss = (fn: (s: Storage) => void) => { try { if (typeof sessionStorage !== 'undefined') fn(sessionStorage); } catch { /* */ } };

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function run() { stop(); timer = setInterval(tick, POLL_MS); void tick(); }

/** Live ETA: seed from the last run's duration; else project from step fraction. */
function computeEta(s: GenState): number | null {
  if (s.startedAt == null) return null;
  const elapsed = (Date.now() - s.startedAt) / 1000;
  if (priorDurationMs && priorDurationMs > 0) return Math.max(0, Math.round(priorDurationMs / 1000 - elapsed));
  if (s.step >= 1 && s.totalSteps > 0) {
    const frac = s.step / s.totalSteps;
    return Math.max(0, Math.round(elapsed / frac - elapsed));
  }
  return null;
}

async function tick() {
  const s = get(generate);
  if (s.phase === 'running') await pollStatus();
  else if (s.phase === 'embedding') await pollEmbedding();
}

async function pollStatus() {
  const s = get(generate);
  if (!s.jobId) return;
  let res: Response;
  try { res = await api(`/portal/mycelium/generate/status/${s.jobId}`); } catch { return; }
  if (!res.ok) { if (res.status === 404) reset(); return; }
  const j: any = await res.json().catch(() => ({}));
  if (j.priorDurationMs != null) priorDurationMs = j.priorDurationMs;
  const startedAt = j.startedAt ?? s.startedAt ?? Date.now();
  if (j.status === 'done') {
    stop(); ss((x) => x.removeItem(SS_KEY));
    patch({ phase: 'done', step: j.totalSteps ?? s.totalSteps, totalSteps: j.totalSteps ?? s.totalSteps, stageLabel: 'Complete', startedAt, elapsedMs: (j.finishedAt ?? Date.now()) - startedAt, etaSeconds: 0 });
    return;
  }
  if (j.status === 'error' || j.status === 'abandoned') {
    stop(); ss((x) => x.removeItem(SS_KEY));
    patch({ phase: 'error', error: j.error || 'Generation failed', startedAt });
    return;
  }
  const next: GenState = {
    ...s, phase: 'running', jobId: j.id ?? s.jobId, step: j.step ?? 0,
    totalSteps: j.totalSteps ?? 5, stageLabel: j.stageLabel || s.stageLabel || 'Starting…',
    startedAt, elapsedMs: Date.now() - startedAt,
  };
  patch({ ...next, etaSeconds: computeEta(next) });
}

async function pollEmbedding() {
  let res: Response;
  try { res = await api('/portal/mycelium/processing-status'); } catch { return; }
  if (!res.ok) return;
  const p: any = await res.json().catch(() => ({}));
  const embedded = Number(p.embedded ?? 0);
  const total = Number(p.total ?? 0);
  if (total === 0) { stop(); patch({ phase: 'error', error: 'Import some conversations first — there is nothing to map yet.' }); return; }
  patch({ embedded, total, message: `Processing your conversations… ${embedded} / ${total} ready` });
  if (embedded >= MIN_EMBEDDED) { stop(); void start(); } // enough embedded → go
}

/** Trigger a run (button click). Idempotent-ish: server single-flights concurrent starts. */
export async function start() {
  patch({ phase: 'starting', error: '', message: '' });
  let res: Response;
  try { res = await api('/portal/mycelium/generate', { method: 'POST' }); }
  catch { patch({ phase: 'error', error: 'Could not reach the server.' }); return; }

  if (res.ok) {
    const data: any = await res.json().catch(() => ({}));
    if (!data.jobId) { patch({ phase: 'error', error: 'Server did not return a job id.' }); return; }
    ss((x) => x.setItem(SS_KEY, data.jobId));
    patch({ phase: 'running', jobId: data.jobId, startedAt: Date.now(), step: 0, totalSteps: 5, stageLabel: 'Starting…', elapsedMs: 0, etaSeconds: null, error: '', message: '' });
    run();
    return;
  }

  const body: any = await res.json().catch(() => ({}));
  if (res.status === 409) {
    // Preflight: not enough embedded yet → WAIT and auto-start. Not an error.
    patch({ phase: 'embedding', embedded: Number(body.embedded ?? 0), total: Number(body.total ?? 0), message: body.error || 'Still processing your conversations…', error: '' });
    run();
    return;
  }
  // 503 / 500 / other → surface the REAL server message + allow Retry.
  patch({ phase: 'error', error: body.error || `Couldn't start generation (HTTP ${res.status}).` });
}

/** Resume polling a job after a page reload. */
export function resume() {
  ss((x) => {
    const jobId = x.getItem(SS_KEY);
    if (jobId) { patch({ phase: 'running', jobId, startedAt: Date.now() }); run(); }
  });
}

/** Clear state (e.g. dismiss a finished/errored run). */
export function reset() {
  stop();
  ss((x) => x.removeItem(SS_KEY));
  generate.set({ ...initial });
}

/** "12s" / "3m 5s" — for elapsed + ETA display. */
export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null) return '';
  const t = Math.max(0, Math.round(sec));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60); const s = t % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
