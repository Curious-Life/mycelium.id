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
  // An error we invite the user to RE-ATTEMPT rather than escalate. Set only on the
  // capped-`unknown` state (a scan that kept failing) — 'unknown' is "I could not look",
  // never "it is empty", so the surface offers Retry, not a dead end. Distinguishes this
  // from the genuinely-terminal errors ("import first", embedder deps missing) that Retry
  // cannot help. Surfaces render a Retry affordance iff this is true.
  retryable: boolean;
}

const SS_KEY = 'mycelium_gen_job';
const MIN_EMBEDDED = 5;
const POLL_MS = 1500;
// If the embedded count hasn't moved for this long we stop the "Processing 0/N"
// spinner and surface an actionable error. Can't false-positive on a big import:
// ANY increase resets the clock, so only a true plateau trips it.
const EMBED_STALL_MS = 75_000;
// If /processing-status keeps answering `unknown` (the server could not COUNT — a SQLCipher
// scan failure) for this long, stop polling and surface a RETRYABLE error. This is the ONLY
// pollEmbedding branch that used to lack a cap, so a persistent scan failure spun the
// "Checking your conversations…" indicator FOREVER on a fresh machine (the live-test hang).
// A transient unknown resolves itself and never trips this: the first non-unknown poll clears
// the clock. Shorter than EMBED_STALL_MS because `unknown` is a hard read failure, not slow
// progress — there is nothing to wait for, only to re-attempt.
const UNKNOWN_STALL_MS = 25_000;
// A GENUINELY empty vault reports `total: 0` PERSISTENTLY; an ACTIVE import reports a TRANSIENT 0 —
// the /processing-status count rides db.messages.embedBacklogCached (an SWR memo), so mid-import it
// can serve a stale pre-import snapshot, and right at the start no row has committed yet. Both read
// as `total === 0` WITHOUT `unknown` (the scan SUCCEEDED; it just measured a 0 that is already
// stale). Hard-erroring on the first 0 turned that race into a false "Import some conversations
// first — there is nothing to map yet" MID-IMPORT (QA P1-C). So this is bounded exactly like
// unknownSince: keep polling on a 0 (calm, no error), and surface the empty-vault terminal ONLY once
// the 0 PERSISTS past EMPTY_CONFIRM_MS. An active import populates counts within a tick or two, well
// under this window, so the false error can never fire; a truly-empty vault waits this out once and
// then gets the honest message. `unknown` (above) already owns the scan-FAILURE case; this owns a
// real-but-transient 0. Shorter than EMBED_STALL_MS: a 0 needs only enough time to rule out the
// pre-population race, not a whole plateau.
const EMPTY_CONFIRM_MS = 12_000;
// A POST /generate that never answers strands the spinner in 'starting' FOREVER (the sibling of
// the `unknown` hang: the server accepted the request but the socket wedged). start() arms the
// poll BEFORE awaiting the POST, so tick() bounds a hung request even while it is outstanding —
// past START_TIMEOUT_MS with no response the 'starting' spinner becomes a RETRYABLE error. Same
// shape as the embedStallSince/unknownSince clocks: a wall-clock bound checked by the existing
// poll, not a floor. 20s is deliberately generous: POST /generate is NOT a bare ack — it runs a
// SYNCHRONOUS readiness preflight (an embedded-count scan over the vault) before it answers, and
// on a cold SQLCipher page cache that scan can take several seconds. 20s comfortably covers a slow
// cold scan while still catching a genuinely wedged socket that will never answer.
const START_TIMEOUT_MS = 20_000;
// The server's OWN authoritative hard cap on a run (src/jobs.js:43 MAX_MS): it lets a healthy job
// run this long and only SIGKILLs at the boundary, after which the job closes to an `error`/
// `abandoned` status the poll already terminates on. Mirror it here so the CLIENT ceiling can sit
// ABOVE it — the server's cap must be what ends a healthy run, never the client's.
const SERVER_MAX_MS = 45 * 60 * 1000; // 45 min — keep in sync with src/jobs.js MAX_MS
// A run the server never advances past 'running' AND never self-terminates would poll FOREVER.
// This client ceiling is ONLY a backstop for that pathological case — a server so wedged it blew
// past its own MAX_MS without even emitting the terminal status. So it sits a margin ABOVE
// SERVER_MAX_MS: a HEALTHY long run (a 76k-message vault: clustering + the LLM describe step + 16
// heavy Python measure steps can legitimately take 20+ min) is ended by the SERVER's cap/SIGKILL,
// not torn down here. Measured from the job's own startedAt, so a reload can't reset it.
const RUN_CEILING_MS = SERVER_MAX_MS + 5 * 60 * 1000; // 50 min — server's 45-min cap + 5-min margin
// NOTE (deliberately NO independent `stalled` kill): the server sets `stalled` only after ≥5 min of
// stdout silence (jobs.js STALL_MS) as a SOFT hint that KEEPS THE RUN ALIVE all the way to MAX_MS —
// a legit quiet measure step trips it routinely. The client honours that: `stalled` drives the
// "taking longer than usual" copy but is NOT a terminal. Hard-killing on it (as an earlier grace
// did) tore down healthy runs the server was still nursing. The 50-min ceiling is the only client
// terminal for a wedged run.

const initial: GenState = {
  phase: 'idle', jobId: null, step: 0, totalSteps: 5, stageLabel: '',
  embedded: 0, total: 0, startedAt: null, elapsedMs: 0, etaSeconds: null, message: '', error: '',
  embedder: null, stalled: false, retryable: false,
};

export const generate = writable<GenState>({ ...initial });

let timer: ReturnType<typeof setInterval> | null = null;
let priorDurationMs: number | null = null;
let embedStallSince = 0; // epoch ms of the last embedded-count change (stall clock)
let unknownSince = 0; // epoch ms of the first consecutive `unknown` count (scan-failure clock)
let zeroSince = 0; // epoch ms of the first consecutive `total===0` count (transient-empty clock, P1-C)
let startingSince = 0; // epoch ms of entering 'starting' (hung-POST watchdog clock)

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
  else if (s.phase === 'starting') checkStarting();
}

// The hung-POST watchdog. start() arms the poll BEFORE awaiting the POST, so this fires even while
// that request is still outstanding. Past START_TIMEOUT_MS we cap 'starting' to a RETRYABLE error;
// start()'s own post-await guard (phase !== 'starting') then keeps a late response from un-capping
// it. A start that answers normally leaves 'starting' long before the bound, so this is inert on
// the happy path.
function checkStarting() {
  if (startingSince === 0) return;
  if (Date.now() - startingSince > START_TIMEOUT_MS) {
    stop();
    patch({ phase: 'error', retryable: true, message: '',
      error: 'Starting is taking too long — the server hasn’t responded yet. Try again.' });
  }
}

async function pollStatus() {
  const s = get(generate);
  if (!s.jobId) return;
  let res: Response;
  try { res = await api(`/portal/mycelium/generate/status/${s.jobId}`); } catch { return; }
  if (!res.ok) { if (res.status === 404) reset(); return; }
  const j: any = await res.json().catch(() => ({}));
  // Un-cap race guard. We read `s` before two awaits (api + json); in that window an overlapping
  // poll, a cancel(), or a reset() may have written a TERMINAL and cleared the timer. Without this
  // a late poll would patch `phase:'running'` back over that terminal → a frozen spinner with no
  // live poll. If we are no longer the running job we're stale — drop this response untouched.
  // (start() has the sibling guard after ITS await; pollStatus lacked one.)
  if (get(generate).phase !== 'running') return;
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
  // Client ceiling on a wedged run — a BACKSTOP only. The server's MAX_MS (45 min) is the
  // authoritative cap on a healthy run; this fires solely if the server blew past that WITHOUT
  // self-terminating (never emitting done/error/abandoned), so it sits ABOVE MAX_MS. `stalled` is
  // deliberately NOT part of this condition: it is the server's SOFT "quiet for ≥5 min" hint that
  // keeps the run alive to MAX_MS (a legit quiet measure step trips it), so hard-killing on it tore
  // down healthy runs. We surface `stalled` as the "taking longer" copy below, never as a terminal.
  // elapsed is measured from the job's own startedAt so a reload can't reset it.
  const runMs = next.elapsedMs;
  if (runMs > RUN_CEILING_MS) {
    stop(); ss((x) => x.removeItem(SS_KEY));
    patch({ phase: 'error', startedAt, stalled: !!j.stalled, retryable: true,
      error: 'This run has been going far longer than expected and may be stuck. Try again, or restart the app.' });
    return;
  }
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
  // itself, so we keep polling — BUT NOT FOREVER. This branch was the ONLY one in pollEmbedding
  // without a cap (total===0, deps_missing/down/error, and the plateau all terminate), so a
  // PERSISTENT `unknown` — a fresh machine whose vault the server cannot read — spun this
  // indicator with no exit (the live-test "Checking your conversations…" hang, 2026-07-18). Now
  // the `unknownSince` clock (mirrors `embedStallSince`) bounds it: past UNKNOWN_STALL_MS we stop
  // and surface a RETRYABLE error. Crucially this is NOT an empty-vault claim — `unknown` is
  // "I could not look", never "it is empty" — so the copy says "couldn't read your vault yet"
  // and the surface offers Retry, never "import some conversations first".
  if (p.unknown) {
    const now = Date.now();
    if (unknownSince === 0) unknownSince = now; // start the clock on the FIRST unknown
    if (now - unknownSince > UNKNOWN_STALL_MS) {
      stop();
      patch({
        phase: 'error', embedder, retryable: true, message: '',
        error: 'Couldn’t read your vault just yet. This is usually temporary — try again.',
      });
      return;
    }
    patch({ embedder, message: 'Reading your vault…' }); // transient, calm — NOT "checking your mind"
    return;
  }
  unknownSince = 0; // a count that succeeded clears the scan-failure clock

  const embedded = Number(p.embedded ?? 0);
  const total = Number(p.total ?? 0);
  const es = embedder?.status;

  // A `total === 0` is EITHER a truly-empty vault OR the transient-0 race of an active import (see
  // EMPTY_CONFIRM_MS). We cannot tell the two apart from one poll, so DON'T hard-error on the first
  // 0 — bound it with a clock (mirrors unknownSince). Keep polling calmly; only after 0 PERSISTS past
  // EMPTY_CONFIRM_MS do we conclude the vault is genuinely empty and show the honest terminal. Any
  // non-zero total below clears the clock, so a mid-import 0 that populates within a tick or two
  // never reaches the error (QA P1-C).
  if (total === 0) {
    const now = Date.now();
    if (zeroSince === 0) zeroSince = now;
    if (now - zeroSince > EMPTY_CONFIRM_MS) {
      stop();
      patch({ phase: 'error', embedder, error: 'Import some conversations first — there is nothing to map yet.' });
      return;
    }
    patch({ embedder, message: 'Preparing your conversations…' });
    return;
  }
  zeroSince = 0; // a real, non-zero total clears the transient-empty clock

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
  unknownSince = 0; // a fresh attempt restarts every stall clock
  zeroSince = 0;
  startingSince = Date.now(); // arm the hung-POST watchdog (checkStarting)
  patch({ phase: 'starting', error: '', message: '', retryable: false });
  run(); // arm the poll NOW so tick()→checkStarting bounds a POST that never answers
  let res: Response;
  try { res = await api('/portal/mycelium/generate', { method: 'POST' }); }
  catch { stop(); patch({ phase: 'error', error: 'Could not reach the server.' }); return; }
  // The watchdog (or a reset/cancel) may have moved us off 'starting' while the POST was in flight
  // — e.g. the server answered only AFTER START_TIMEOUT_MS. Honor that terminal; never un-cap it.
  if (get(generate).phase !== 'starting') return;

  if (res.ok) {
    const data: any = await res.json().catch(() => ({}));
    // The map is already built — nothing to do. NOT an error (it used to be, and being an
    // unrendered error made it silence). Callers that show progress must render this.
    if (data.status === 'skipped') {
      stop();
      patch({ phase: 'up-to-date', message: data.note || 'Your map is already built.', error: '' });
      return;
    }
    if (!data.jobId) { stop(); patch({ phase: 'error', error: 'Server did not return a job id.' }); return; }
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
  stop();
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
  unknownSince = 0;
  zeroSince = 0;
  startingSince = 0;
  ss((x) => x.removeItem(SS_KEY));
  generate.set({ ...initial });
}

/**
 * Re-attempt after a RETRYABLE failure (the capped-`unknown` scan error). Clears the stall
 * clocks and re-runs start() — the same entry the first attempt used. Distinct from reset()
 * (which returns to idle and says nothing): retry keeps the user moving toward a mindscape
 * rather than dead-ending on a read failure that is usually transient.
 */
export async function retry() {
  unknownSince = 0;
  embedStallSince = 0;
  zeroSince = 0;
  await start();
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
