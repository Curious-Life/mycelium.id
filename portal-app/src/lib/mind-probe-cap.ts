// portal-app/src/lib/mind-probe-cap.ts
//
// The bound for MindscapeView's "Checking your mind…" readiness probe.
//
// loadGenerated() re-probes /readiness?slices=mindscape every GEN_POLL_MS (~4s) while the answer
// is not known-true, and on failure it holds `mindGenerated === null` — which renders the
// "Checking your mind…" spinner. With no bound, a /readiness that KEEPS failing (a fresh machine
// whose vault the server cannot read) spins that indicator FOREVER. That is the same
// unbounded-spinner class as generate.ts's `unknown` cap (#232): a failed READ must never
// masquerade as an infinite "checking" — nor as an empty map (§3.2a: a failed read claims nothing).
//
// This bounds it. After PROBE_MAX_FAILS consecutive failed probes (~20s at the 4s cadence) the view
// stops retrying on its own and shows a RETRYABLE "couldn't read your map — Retry" state. The bound
// is extracted here as a pure decision so verify:generate-phase can DRIVE it (probeExhausted at /
// below the bound) without mounting the THREE.js-heavy MindscapeView — the same "run the module,
// don't grep it" discipline the generate-store gates use.
export const PROBE_MAX_FAILS = 5;

/**
 * True once the readiness probe has failed enough CONSECUTIVE times to stop the "Checking your
 * mind…" spinner and offer Retry instead. A single successful probe resets the caller's count to 0,
 * so only a persistent failure ever reaches the bound. Must be a finite bound — the whole point is
 * that the retry count is not allowed to be unbounded.
 */
export function probeExhausted(failCount: number, maxFails: number = PROBE_MAX_FAILS): boolean {
  return failCount >= maxFails;
}
