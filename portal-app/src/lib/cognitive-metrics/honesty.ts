/**
 * 4-state honesty classifier for cognitive-metrics windows.
 *
 *   refusal             → no data for this window/era
 *   computing_baseline  → data exists but baseline_90d not yet populated
 *                         (in production today this is the dominant state
 *                          because the compute script doesn't write
 *                          _baseline_90d columns yet — sweep finding
 *                          documented in metrics-handlers.js:99–100)
 *   low_sample          → data exists, baseline known, but message_count
 *                         is below the noise floor — value is advisory
 *   available           → render value as primary affordance
 *
 * The classifier intentionally does NOT collapse to `low_confidence`
 * alone. `low_confidence` will be `true` for every harmonic row in
 * production until baselines compute; gating UI on that flag would
 * surface "warming up" indefinitely. Instead, we pull in the contract's
 * refusal_mode + the window's `notes` field to decide which state to
 * render.
 *
 * @see docs/WORKSTREAM-C-PORTAL-DESIGN-2026-05-08.md §"Honesty rendering"
 */

import type { PresentationContract, WindowResponse } from './client';

export type HonestyState =
	| { kind: 'refusal'; copy: string }
	| { kind: 'computing_baseline'; copy: string }
	| { kind: 'low_sample'; copy: string }
	| { kind: 'available' };

/** Default minimum sample size before a window is considered well-anchored. */
export const LOW_SAMPLE_THRESHOLD = 5;

/**
 * Default copy for state 2 — "computing_baseline" — locked at D-WS-2 default.
 *
 * KNOWN GAP (PR-WSC-FOLLOWUP, flagged 2026-05-08): every harmonic row in
 * production carries `low_confidence: true` because compute_information_harmonics.py:632
 * sets it unconditionally with the comment "global until Phase 6.2 calibrates."
 * The classifier reads that flag + null notes and renders THIS string —
 * which invents a specific reason ("baseline") from a generic signal.
 * The honest fix is server-side: populate `notes` at compute time with the
 * actual reason, so this client classifier renders the server's truth
 * instead of guessing. See docs/COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md
 * §"Honesty-banner gap" for the 3-part fix (copy / hoist / server-notes).
 * Trigger: land alongside Phase 6.2 calibration design, or when compute
 * is being touched anyway.
 */
export const COMPUTING_BASELINE_COPY =
	'Reading is honest but not yet calibrated against your 90-day baseline.';

export interface ClassifyArgs {
	window: WindowResponse['window'];
	contract: PresentationContract;
	/** Override low_sample threshold (default LOW_SAMPLE_THRESHOLD). */
	lowSampleThreshold?: number;
	/** Override the computing_baseline copy. */
	computingBaselineCopy?: string;
}

/**
 * Classify a window into one of the 4 honesty states. Pure function;
 * no side effects. The returned state determines the UI hierarchy:
 * refusal hides the value entirely; computing_baseline + low_sample
 * render the value with an honest caveat; available is the unguarded
 * primary affordance.
 */
export function classifyHonesty(args: ClassifyArgs): HonestyState {
	const { window, contract } = args;
	const threshold = args.lowSampleThreshold ?? LOW_SAMPLE_THRESHOLD;
	const computingCopy = args.computingBaselineCopy ?? COMPUTING_BASELINE_COPY;

	// 1. Refusal — no row for this user/era/granularity. The contract's
	// refusal_mode text is the canonical copy.
	if (window.window_end === null) {
		return { kind: 'refusal', copy: contract.refusal_mode };
	}

	// 2. Computing baseline — explicit notes, OR the universal-prod case
	// where compute hasn't written _baseline_90d yet (server marks
	// low_confidence: true without populating notes). State 2 silently
	// regrades to state 4 when baselines fill — no UI change required.
	const notesMentionsBaseline = !!window.notes && /baseline/i.test(window.notes);
	const baselineSilentlyMissing = window.low_confidence && !window.notes;
	if (notesMentionsBaseline || baselineSilentlyMissing) {
		return { kind: 'computing_baseline', copy: computingCopy };
	}

	// 3. Low sample — data exists, baseline known, but sample size is too
	// small to trust. Honest caveat surfaces the count.
	if (window.message_count < threshold) {
		return {
			kind: 'low_sample',
			copy: `Low sample (N=${window.message_count}) — advisory only.`,
		};
	}

	// 4. Available — render value as primary affordance.
	return { kind: 'available' };
}
