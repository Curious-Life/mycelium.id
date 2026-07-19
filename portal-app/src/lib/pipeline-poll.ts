// portal-app/src/lib/pipeline-poll.ts
//
// The tick decision for MindscapeView's readiness timer (PIPELINE-TRANSPARENCY-DESIGN-2026-07-19,
// Unit 5 — the built-map live-feed MED deferred from Unit 3).
//
// THE BUG THIS FIXES: MindscapeView's single readiness timer used to CLEAR itself the moment
// `mindGenerated === true` (the map is built). But that same timer is the ONLY feeder of the
// canonical `pipeline` store (its tick calls loadGenerated → ingest(pipeline)). So after the map
// existed, a re-import or a model-approval that re-opened embed/categorize left the built-map
// pipeline overview FROZEN on its last-known stages — stale, never live. The overview held (never
// blanked — §3.2a), but it stopped tracking.
//
// THE FIX, extracted here as a PURE decision so verify:pipeline-poll can DRIVE it (the "run the
// module, don't grep it" discipline, mirroring mind-probe-cap.ts) without mounting the THREE.js-
// heavy MindscapeView: the timer OUTLIVES `mindGenerated === true`, and each tick chooses what to
// fetch — the full convergence poll while the map's existence is still unknown, then ONLY the cheap
// `pipeline` slice once the map is built. No new interval (the SAME timer), no new scan (the
// pipeline slice reuses the SWR-cached counts its siblings already buy — Unit 2's PS-COST).

/** What the readiness timer should do on one tick. */
export type PollTick =
  | 'converge'   // map existence not yet known-true: poll BOTH slices (mindscape,pipeline)
  | 'pipeline'   // map is built: keep ONLY the cheap pipeline slice live (the built-map feed)
  | 'stop';      // the "Checking your mind…" probe cap tripped: the retry state owns it from here

/**
 * Decide the tick action. `exhausted` (the probe cap) OUTRANKS everything — once it trips, the
 * "couldn't read your map — Retry" state owns retry and the timer must stop. Otherwise: while the
 * map's existence is not known-true we run the full convergence poll (which resolves invite-vs-map
 * AND feeds pipeline); once it IS known-true we switch to the pipeline-only refresh so the built-map
 * overview stays live WITHOUT re-running the heavier mindscape convergence read.
 */
export function pollAction(mindGenerated: boolean | null, exhausted: boolean): PollTick {
  if (exhausted) return 'stop';
  return mindGenerated === true ? 'pipeline' : 'converge';
}

/**
 * Whether the timer should be armed at all. It stays armed as long as the probe cap has NOT tripped
 * — crucially, it must OUTLIVE `mindGenerated` becoming true (that is the whole fix; the old code
 * armed only while `mindGenerated !== true`, which is why the pipeline feed froze on a built map).
 */
export function timerArmed(exhausted: boolean): boolean {
  return !exhausted;
}
