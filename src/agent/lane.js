// src/agent/lane.js — a minimal serial lane (Semaphore(1)) for autonomous turns.
// Phase 5, Step 4b. Spec §5.5.
//
// Autonomous turns (scheduler wake-cycles; later, native channel turns) must run
// ONE-AT-A-TIME: they share the on-box model + the keyed DB, and a stampede of
// concurrent local-model turns starves the event loop and the inference server
// (the same failure the in-memory search index hit — see [[pipeline-integrity]]).
// A single serial lane gives the at-most-one-concurrent invariant the odysseus
// daemon enforces with Semaphore(1).
//
// DELIBERATELY NOT for interactive chat: chat turns are user-driven and must stay
// concurrent across tabs (serializing them is a visible behaviour change). Only the
// autonomous surfaces enqueue here.
//
// SECURITY: the lane moves opaque thunks; it never sees prompt/response content and
// never logs. A thunk that throws is isolated — it settles its own promise and the
// next item still runs (one wedged turn can't freeze the lane).

/**
 * Create a serial promise-queue. `enqueue(fn)` resolves/rejects with fn()'s outcome,
 * but fn is only invoked once all previously-enqueued thunks have settled.
 * @returns {{ enqueue:(fn:()=>Promise<any>)=>Promise<any>, size:()=>number, idle:()=>boolean }}
 */
export function createLane() {
  let tail = Promise.resolve(); // the chain; each enqueue appends to it
  let pending = 0;

  function enqueue(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('lane.enqueue: fn required'));
    pending += 1;
    // Chain onto tail so fn runs strictly after the previous thunk settles. We
    // advance `tail` on a branch that NEVER rejects (settle-and-swallow) so one
    // failing thunk can't poison the chain for everyone after it; the caller still
    // sees the real outcome via the returned promise.
    const result = tail.then(() => fn());
    tail = result.then(() => {}, () => {}).finally(() => { pending -= 1; });
    return result;
  }

  return {
    enqueue,
    size: () => pending,
    idle: () => pending === 0,
  };
}

export default createLane;
