// src/system/service-state.js — THE ONE state machine every service-health surface
// renders from (QA6 P1 §3, "honest state taxonomy").
//
// WHY THIS EXISTS. Every supervisor in this repo already speaks a rich per-service
// status vocabulary (embed/supervisor.js, transcribe/supervisor.js, enrich/drainer.js,
// hardware/ollama-daemon.js). What did NOT exist was a single agreed mapping from that
// vocabulary onto the FOUR states a human surface actually needs — so each screen
// re-derived it, and each one drew a slightly different line. The two live consequences:
//
//   • a RED error indicator over a service that is merely LOADING. `deps_missing`,
//     `installing_deps`, `starting`, `loading` and `downloading` are all "work in
//     progress or a setup step", not faults — but a surface that tests
//     `status !== 'ok'` paints every one of them as broken.
//   • an "it is empty / not set up" claim over a service that is BUSY. `unknown` is
//     "nobody has reported yet", not "you never configured this" — collapsing the two
//     is how "nothing to map yet" ends up on screen while the thing is running.
//
// THE FOUR STATES (+ one honest absence). Distinct, never conflated:
//
//   'checking'  — we do NOT know. No report yet / the health read itself failed.
//                 Renders as "checking…". NEVER as ok, NEVER as an error.
//   'loading'   — the service is coming up or fetching what it needs. Transient by
//                 nature; a spinner, never red. Includes a dependency INSTALL that is
//                 actually running.
//   'ready'     — measured healthy.
//   'degraded'  — usable-but-not-doing-the-thing, or blocked on a decision the OWNER
//                 made or must make (no model chosen, paused, deps genuinely absent).
//                 A choice or a setup step — warn, never alarm, and never "broken".
//   'failed'    — a genuine fault: it tried and could not.
//
// RETRYABILITY is a SEPARATE axis and is deliberately not folded into the state: a
// 'loading' service is not retryable (there is nothing to retry — it is trying), a
// 'failed' one always is, and a 'degraded' one is retryable only when the blocker is
// an install/dependency the app can re-attempt rather than a choice the owner made.
//
// SECURITY (§1): pure enum→enum. This module never touches vault content, never logs,
// and never sees a message body — callers pass a status STRING.

/** Every status token any supervisor in this repo emits, grouped by the state it means. */
const READY = new Set(['ok', 'ready']);

const LOADING = new Set([
  'loading',          // model loading into memory (embed + transcribe supervisors)
  'starting',         // process (re)starting (transcribe supervisor)
  'downloading',      // model weights coming down (transcribe supervisor, drainer)
  'installing_deps',  // pip install RUNNING (transcribe supervisor) — a step in progress
  'checking',         // tts phase: probing what's on disk
  'pulling',          // ollama pull in flight
]);

const DEGRADED = new Set([
  'no_model',         // the owner has not chosen one — a CHOICE, not a fault
  'paused',           // the owner stopped it — a CHOICE, not a fault
  'deps_missing',     // an install we can re-attempt; actionable, but not "broken"
  'needs-runtime',    // tts: the runtime isn't installed yet
  'unavailable',      // reported present-but-not-usable
]);

const FAILED = new Set([
  'down',             // keeps crashing / cannot start
  'error',            // it tried and failed
  'failed',
]);

/** Statuses whose blocker the app can itself re-attempt (⇒ a Retry is honest). */
const RETRYABLE_DEGRADED = new Set(['deps_missing', 'needs-runtime', 'unavailable']);

/**
 * Map a supervisor status token onto the ONE four-state taxonomy.
 *
 * Fail-CLOSED on anything unrecognised: an unknown token is 'checking' (an honest
 * absence), never 'ready'. A new supervisor status can therefore never fabricate a
 * green ✓ merely by not being in a list — the failure mode that shipped a fake
 * "Included ✓" over a dead embedder before ModelHealth's own fix.
 *
 * @param {string|null|undefined} status
 * @returns {'checking'|'loading'|'ready'|'degraded'|'failed'}
 */
export function serviceState(status) {
  const s = String(status || '').trim();
  if (!s || s === 'unknown') return 'checking';
  if (READY.has(s)) return 'ready';
  if (LOADING.has(s)) return 'loading';
  if (DEGRADED.has(s)) return 'degraded';
  if (FAILED.has(s)) return 'failed';
  return 'checking';   // fail-closed: never guess 'ready'
}

/**
 * Is offering the owner a "Retry" honest for this status?
 *
 * TRUE for every genuine fault, and for the degraded blockers the app can itself
 * re-attempt (a dependency install, a runtime install). FALSE while it is loading
 * (nothing to retry — it IS retrying) and FALSE for an owner CHOICE (no_model /
 * paused): the remedy there is a choice, not a retry, and a Retry button would train
 * the owner to "fix" their own deliberate configuration.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isRetryable(status) {
  const st = serviceState(status);
  if (st === 'failed') return true;
  if (st === 'degraded') return RETRYABLE_DEGRADED.has(String(status || '').trim());
  return false;
}

/**
 * The transcription PRE-FLIGHT reason token for a NON-'ok' health status — the ONE
 * derivation both the in-process job (enrich/transcribe-attachment.js) and the route's
 * 409 branch (portal-attachments.js) render from, so they can never draw the line
 * differently the way each surface used to. Only a genuine owner CHOICE ('no_model') is
 * 'no-model' (the ONE reason that tells the owner to download a model); a service that is
 * merely loading/starting/installing says 'not-ready-yet' and is retryable-by-waiting; a
 * genuine fault is 'engine-down'; everything else (a re-attemptable dependency blocker) is
 * 'not-ready'. Pure status→token; never touches content.
 *
 * @param {string|null|undefined} status a supervisor health status
 * @returns {'not-ready-yet'|'no-model'|'engine-down'|'not-ready'}
 */
export function transcribeNotReadyReason(status) {
  const state = serviceState(status);
  if (state === 'loading') return 'not-ready-yet';
  if (String(status || '').trim() === 'no_model') return 'no-model';
  if (state === 'failed') return 'engine-down';
  return 'not-ready';
}

/**
 * Normalise a supervisor health object into the shape every surface renders.
 * Never invents a status: a missing/unreadable health becomes 'checking'.
 *
 * @param {{status?:string,message?:string,detail?:string,model?:string,progress?:any}|null|undefined} health
 * @returns {{status:string, state:string, retryable:boolean, message:string|null, detail:string|null, model:string|null, progress:any}}
 */
export function normalizeHealth(health) {
  const status = String(health?.status || 'unknown');
  return {
    status,
    state: serviceState(status),
    retryable: isRetryable(status),
    message: health?.message ?? null,
    detail: health?.detail ?? null,
    model: health?.model ?? null,
    progress: health?.progress ?? null,
  };
}

export default serviceState;
