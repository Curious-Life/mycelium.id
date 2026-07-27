// portal-app/src/lib/pipeline.ts
//
// The CLIENT half of the canonical `pipeline` status (PIPELINE-TRANSPARENCY-DESIGN-2026-07-19
// §"Module shape"). ONE store, read by every surface that shows "where is my data in the
// pipeline?" — so the fresh-vault invite and the built-map view can never disagree (the two-voice
// overlap the design deletes). The server assembles the ordered stage machine in readiness.js's
// `pipeline` slice (import → embed → categorize → cluster → describe → measure); this is the thin
// consumer of it.
//
// ⚠️ NO NEW POLL / NO NEW VOICE (§"Design principles", §"The problem" #the two competing voices).
// This store owns NO setInterval. It is FED by ONE host today — MindscapeView — from its existing
// readiness read; both surfaces that render the overview are SUBSCRIBERS, not feeders:
//   • MindscapeView is the sole feeder: its `loadGenerated` poll (~4s) already fetches
//     `slices=mindscape,pipeline` and calls ingest(body.pipeline) — one fetch, both slices, zero
//     extra server scans (the pipeline slice shares mindscape's memoized count, Unit 2's PS-COST).
//   • MindscapeInvite (fresh vault) and the built-map aside BOTH just MOUNT <PipelineStatus/>, which
//     subscribes to this shared store. Neither fetches `pipeline` itself or calls ingest — so the
//     fresh-vault invite and the built map can never disagree (one voice, the design's fix).
//   • ⚠️ BUILT MAP (Unit 5): MindscapeView's timer now OUTLIVES mindGenerated===true and calls
//     refreshPipeline() each tick (pollAction → 'pipeline'), so on a BUILT map the overview stays
//     LIVE — a re-import / model-approval updates it without a second poll or new interval. See
//     MindscapeView's $effect and src/lib/pipeline-poll.ts.
// A dedicated refreshPipeline() exists for a host that wants a one-shot read, but it too is a
// single fetch a caller schedules on ITS cadence — never an interval this module arms. Adding a
// second independent poller is exactly the "two competing voices" the design removes.
//
// §3.2a (fail-soft — never blank to a fabricated state): a FAILED read (network throw, !ok, or a
// slice-wide `unknown`) HOLDS the last good stages rather than clearing them. Before ANY read has
// landed — the fresh process, INCLUDING the case where the host's very first fetch THREW so ingest
// was never called — the store reads `unknown:true` (rendered "checking…"), never a fabricated
// idle/done. That is why `initial.unknown` is `true`: an idle "Waiting for data" is only honest once
// an ingest has actually PROVEN the vault is idle (empty + loaded); until then we don't know. A
// counting error must not impersonate an empty or a finished pipeline (the same rule readiness.js's
// slice fails-closed on).

import { writable } from 'svelte/store';
import { api } from './api';

/** A stage's lifecycle state — mirrors the server enum (readiness.js pipeline()). Never a bare boolean. */
export type StageState = 'pending' | 'running' | 'blocked' | 'done';

/** The remedy a blocked stage always carries — a fixed label + a target Unit 4 will wire to a route. */
export interface StageAction { label: string; target: string }

/** One ordered stage, exactly as the server emits it. Counts + enums only — never vault text (§1). */
export interface Stage {
  key: string;
  state: StageState;
  count?: { done: number; total?: number };
  etaSeconds?: number;
  reason?: string;
  action?: StageAction;
  /** Per-stage pause state (QA R2) — set by readiness.js for embed/categorize so the co-located
   *  Stop/Resume control knows its two-state label. Undefined for stages with no pause control. */
  paused?: boolean;
  /** P8b — `cluster` only, and ONLY on a built map: has the vault grown enough since the map was
   *  made that it is worth rebuilding? Set from the SAME evaluateFreshness() that governs POST
   *  /mycelium/generate's debounce, so an armed auto-rebuild cannot ask for a run the route skips.
   *  Undefined on every other stage and on an unbuilt map — absent means "not a claim", not false. */
  stale?: boolean;
  /** P8b — `cluster` only: how many embedded messages are not represented on the map yet. A count
   *  of MESSAGES, not points; the two are different tables and the copy must not fuse them. */
  drift?: number;
}

/**
 * `overall` is the server's four-value summary (idle | running | blocked | done). We type it as a
 * WIDER string on purpose: Unit 5 makes the generate store a projection of THIS, folding its
 * error / up-to-date / skipped outcomes in (the "$generate.error renders in ZERO places" fix). The
 * component renders those arms today with a DEFAULT fallback, so a value added later is shown, not
 * silenced — the same deny-by-default discipline MindscapeInvite's `!== 'idle'` guard uses.
 */
export type PipelineOverall = 'idle' | 'running' | 'blocked' | 'done' | 'error' | 'up-to-date' | 'skipped' | string;

export interface PipelineState {
  stages: Stage[];
  overall: PipelineOverall;
  blockedOn: string | null;
  /** true whenever we have never had a good read to hold — the fresh-process case, incl. a first
   *  read that threw before ingest ran. Renders "checking…", never a fabricated idle/done. */
  unknown: boolean;
  /** true once any good read has landed — the latch §3.2a holds across a later failure. */
  loaded: boolean;
}

// unknown:true from construction — a store nothing has ingested into does NOT know the vault is
// idle; only a completed ingest of a genuinely-empty slice earns the idle "Waiting for data" copy.
const initial: PipelineState = { stages: [], overall: 'idle', blockedOn: null, unknown: true, loaded: false };

export const pipeline = writable<PipelineState>({ ...initial });

/**
 * Fold a `pipeline` SLICE (the object under `readiness.pipeline`) into the store.
 * §3.2a: a missing slice OR a slice-wide `unknown` HOLDS the last good stages if we have them;
 * only a fresh process with nothing to hold surfaces `unknown:true` (rendered as "checking…",
 * never a fabricated state).
 */
export function ingest(slice: Partial<PipelineState> & { unknown?: boolean } | null | undefined) {
  pipeline.update((prev) => {
    if (!slice || slice.unknown || !Array.isArray(slice.stages)) {
      // Nothing trustworthy this time. Hold the last good answer; if we have none, say we don't know.
      if (prev.loaded) return prev;
      return { ...initial, unknown: true };
    }
    const next: PipelineState = {
      stages: slice.stages as Stage[],
      overall: (slice.overall as PipelineOverall) ?? 'idle',
      blockedOn: slice.blockedOn ?? null,
      unknown: false,
      loaded: true,
    };
    // ⚠️ IDLE-CADENCE FLICKER GUARD (QA R4-11). MindscapeView's ~4s timer is the sole feeder and it
    // OUTLIVES the built map — so ingest() runs every tick for the whole pre-generate life of the
    // invite. Returning a fresh object each tick re-emits the store even when the read is BIT-FOR-BIT
    // identical (the static empty-vault case: `import` pending, nothing moving), forcing every
    // <PipelineStatus/> subscriber — including the one mounted inside the invite — to re-render on a
    // fixed cadence: the visible "reloads ~10×" churn. Hold the SAME reference when nothing changed so
    // subscribers only re-render on a REAL change (a count moved, a stage advanced, eta ticked). This
    // is a pure de-dup: an actual change still serializes differently and emits, so live progress is
    // untouched (verify no regression to the processing cadence — eta/counts still update per tick).
    if (prev.loaded && samePipeline(prev, next)) return prev;
    return next;
  });
}

/** Structural equality on the RENDERED fields (stages/overall/blockedOn) — the loaded/unknown latch
 *  bits are identical whenever we reach the compare. Cheap JSON compare over plain server data; a
 *  false "differs" only costs one extra (idempotent) re-render, never a wrong render. */
function samePipeline(a: PipelineState, b: PipelineState): boolean {
  return (
    a.overall === b.overall &&
    a.blockedOn === b.blockedOn &&
    JSON.stringify(a.stages) === JSON.stringify(b.stages)
  );
}

/** Fold a whole readiness RESPONSE (`{ pipeline: {...}, ... }`) — the shape hosts already hold. */
export function ingestReadiness(payload: { pipeline?: Partial<PipelineState> & { unknown?: boolean } } | null | undefined) {
  ingest(payload?.pipeline);
}

/**
 * A one-shot read of `slices=pipeline`, for a host that has no readiness fetch of its own to ride.
 * NOT an interval — the caller schedules it on an EXISTING cadence. A throw or !ok HOLDS the last
 * good stages (ingest(null)), never blanks the surface.
 */
export async function refreshPipeline() {
  let res: Response;
  try { res = await api('/portal/readiness?slices=pipeline'); }
  catch { ingest(null); return; }          // network failure ⇒ hold (§3.2a)
  if (!res.ok) { ingest(null); return; }   // server error ⇒ hold
  const body: any = await res.json().catch(() => null);
  ingest(body?.pipeline);
}

/** Clear the store (e.g. on sign-out). Rarely needed; kept symmetric with the other stores. */
export function reset() { pipeline.set({ ...initial }); }
