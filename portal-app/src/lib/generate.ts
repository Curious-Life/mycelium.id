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

// ⚠️ 'up-to-date' exists because the server has THREE outcomes — started, refused, or
// UNNECESSARY — and this machine could hold two. POST /mycelium/generate returns
// 200 {jobId:null, status:'skipped'} when topology already exists (portal-mindscape.js:626,
// a debounce added because "the mindscape view re-POSTs generate on every load"). That is a
// SUCCESS: there is nothing to do. With no state for it, the success was squeezed into
// 'error' below — and since $generate.error is rendered in ZERO places app-wide, it became
// SILENCE. That is why Illuminate "does nothing": its render condition (realms exist) IS the
// route's skip condition, so it fails 100% of the time it is visible.
// @see docs/DISTILLATION-SURFACE-DESIGN-2026-07-16.md §2a — the same defect class as §3.5's
// invisible drainer `paused`: a state the server has and the client cannot represent.
export type GenPhase = 'idle' | 'embedding' | 'starting' | 'running' | 'done' | 'error' | 'up-to-date';

/** Embedder health as reported by /processing-status (see src/embed/supervisor.js). */
export interface EmbedderHealth { status: string; message: string; detail?: string | null }

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
  embedder: EmbedderHealth | null; // embed-engine health (drives the actionable embedding error)
  stalled: boolean; // server flagged the run as quiet too long ("taking longer than usual")
}

const SS_KEY = 'mycelium_gen_job';
const MIN_EMBEDDED = 5;
const POLL_MS = 1500;
// If the embedded count hasn't moved for this long we stop the "Processing 0/N"
// spinner and surface an actionable error. Can't false-positive on a big import:
// ANY increase resets the clock, so only a true plateau trips it.
const EMBED_STALL_MS = 75_000;

const initial: GenState = {
  phase: 'idle', jobId: null, step: 0, totalSteps: 5, stageLabel: '',
  embedded: 0, total: 0, startedAt: null, elapsedMs: 0, etaSeconds: null, message: '', error: '',
  embedder: null, stalled: false,
};

export const generate = writable<GenState>({ ...initial });

let timer: ReturnType<typeof setInterval> | null = null;
let priorDurationMs: number | null = null;
let embedStallSince = 0; // epoch ms of the last embedded-count change (stall clock)

const patch = (p: Partial<GenState>) => generate.update((s) => ({ ...s, ...p }));
const ss = (fn: (s: Storage) => void) => { try { if (typeof sessionStorage !== 'undefined') fn(sessionStorage); } catch { /* */ } };

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function run() { stop(); timer = setInterval(tick, POLL_MS); void tick(); }

// A projection divides BY elapsed time, so it is worthless until some has passed. 3s ≈ two polls.
const ETA_MIN_ELAPSED_S = 3;

/**
 * Live ETA in seconds, or null when we don't know one yet. Seeded from the last run's duration
 * (priorDurationMs); otherwise projected from the step fraction.
 *
 * ⚠️ `null` is the only honest way to say "not yet" — and 0 is NOT null, it is a claim that the
 * run is over. run() calls tick() IMMEDIATELY, so the first pollStatus lands at elapsed≈0, where
 * `elapsed / frac - elapsed` is 0: a clustering run that takes MINUTES announced "~0s left" the
 * instant it started. priorDurationMs masks that on second+ runs, so it hit hardest on the FIRST
 * run — the fresh vault, where the invite is the only generate surface (MindscapeView:502) and
 * the user has the least context for disbelieving it.
 *
 * Both guards below are load-bearing; neither subsumes the other:
 *   · eta > 0     — kills the elapsed≈0 zero, and the SAME lie at the other end: once a run
 *                   overruns priorDurationMs, `prior - elapsed` goes negative and the old
 *                   `Math.max(0, …)` pinned it at "~0s left" for the rest of a long run.
 *   · min elapsed — a zero-check alone is not enough. At elapsed=0.5s with step 1/5 the
 *                   projection is a confident "~2s left" for a multi-minute run; rounding to a
 *                   non-zero number does not make a projection real.
 * Returning null is rendering-safe, not a blank: the templates already guard with
 * `{#if $generate.etaSeconds != null}` (MindscapeInvite:326), so it simply shows no ETA.
 */
function computeEta(s: GenState): number | null {
  if (s.startedAt == null) return null;
  const elapsed = (Date.now() - s.startedAt) / 1000;
  if (elapsed < ETA_MIN_ELAPSED_S) return null;
  const projected = priorDurationMs && priorDurationMs > 0
    ? priorDurationMs / 1000 - elapsed
    : (s.step >= 1 && s.totalSteps > 0 ? elapsed / (s.step / s.totalSteps) - elapsed : null);
  if (projected == null) return null;
  const eta = Math.round(projected);
  return eta > 0 ? eta : null;
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
  if (j.status === 'canceled') { reset(); return; } // user stopped it → back to idle, no error
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
  // `stalled` is authoritative from the server's inactivity watchdog (survives reloads).
  patch({ ...next, stalled: !!j.stalled, etaSeconds: computeEta(next) });
}

async function pollEmbedding() {
  let res: Response;
  try { res = await api('/portal/mycelium/processing-status'); } catch { return; }
  if (!res.ok) return;
  const p: any = await res.json().catch(() => ({}));
  const embedder: EmbedderHealth | null = p.embedder ?? null;

  // `unknown` = the server could not COUNT (a SQLCipher scan failure), which is NOT the
  // same as "you have no messages". It used to be: the endpoint's catch returned
  // `{ total: 0 }` and the `total === 0` branch below told an owner with 70k messages to
  // "Import some conversations first". Keep polling — a transient scan failure resolves
  // itself, and we must never assert an empty vault from a count that never happened.
  if (p.unknown) { patch({ embedder, message: 'Checking your conversations…' }); return; }

  const embedded = Number(p.embedded ?? 0);
  const total = Number(p.total ?? 0);
  const es = embedder?.status;

  if (total === 0) { stop(); patch({ phase: 'error', embedder, error: 'Import some conversations first — there is nothing to map yet.' }); return; }

  // The embedder is broken (deps missing / keeps crashing / model failed). Don't
  // spin at "0/N" forever — surface its actionable message + offer Retry.
  if (es === 'deps_missing' || es === 'down' || es === 'error') {
    stop();
    patch({ phase: 'error', embedder, error: embedder?.message || 'The embedding engine isn’t running. Restart the app and try again.' });
    return;
  }

  // Reset the stall clock on ANY forward progress so a big import can't false-trip.
  const prev = get(generate).embedded;
  const now = Date.now();
  if (embedStallSince === 0 || embedded > prev) embedStallSince = now;

  patch({ embedded, total, embedder, message: `Processing your conversations… ${embedded.toLocaleString()} / ${total.toLocaleString()} ready` });

  if (embedded >= MIN_EMBEDDED) { stop(); void start(); return; } // enough embedded → go

  // Plateaued too long while not actively embedding/loading → actionable stall.
  if (now - embedStallSince > EMBED_STALL_MS && es !== 'loading') {
    stop();
    patch({
      phase: 'error', embedder,
      error: embedder?.message
        || (embedded > 0
          ? `Only ${embedded} of ${total} are ready and embedding has stalled. Restart the app and try again.`
          : 'Embedding hasn’t started. The embedding engine may not be running — restart the app and try again.'),
    });
  }
}

/** Trigger a run (button click). Idempotent-ish: server single-flights concurrent starts. */
export async function start() {
  patch({ phase: 'starting', error: '', message: '' });
  let res: Response;
  try { res = await api('/portal/mycelium/generate', { method: 'POST' }); }
  catch { patch({ phase: 'error', error: 'Could not reach the server.' }); return; }

  if (res.ok) {
    const data: any = await res.json().catch(() => ({}));
    // The map is already built — nothing to do. NOT an error (it used to be, and being an
    // unrendered error made it silence). Callers that show progress must render this.
    if (data.status === 'skipped') {
      patch({ phase: 'up-to-date', message: data.note || 'Your map is already built.', error: '' });
      return;
    }
    if (!data.jobId) { patch({ phase: 'error', error: 'Server did not return a job id.' }); return; }
    ss((x) => x.setItem(SS_KEY, data.jobId));
    patch({ phase: 'running', jobId: data.jobId, startedAt: Date.now(), step: 0, totalSteps: 5, stageLabel: 'Starting…', elapsedMs: 0, etaSeconds: null, error: '', message: '' });
    run();
    return;
  }

  const body: any = await res.json().catch(() => ({}));
  if (res.status === 409) {
    // Preflight: not enough embedded yet → WAIT and auto-start. Not an error.
    embedStallSince = Date.now(); // start the stall clock for this embedding wait
    patch({ phase: 'embedding', embedded: Number(body.embedded ?? 0), total: Number(body.total ?? 0), message: body.error || 'Still processing your conversations…', error: '', stalled: false });
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
  embedStallSince = 0;
  ss((x) => x.removeItem(SS_KEY));
  generate.set({ ...initial });
}

/**
 * Cancel the current run and return to idle. In `running` it asks the server to
 * stop the pipeline child; in `embedding` (no job yet) it just stops waiting.
 * Either way the UI is freed immediately — no 45-min lockout.
 */
export async function cancel() {
  const s = get(generate);
  if (s.jobId) {
    try { await api(`/portal/mycelium/generate/cancel/${s.jobId}`, { method: 'POST' }); } catch { /* best-effort */ }
  }
  reset();
}

/** "12s" / "3m 5s" — for elapsed + ETA display. */
export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null) return '';
  const t = Math.max(0, Math.round(sec));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60); const s = t % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
