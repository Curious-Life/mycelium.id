/**
 * Tests for cognitive-metrics/honesty.ts.
 *
 * Verifies the 4-state classifier hits the right branch for every
 * combination of inputs. Pure-function tests; no fetcher mocking.
 *
 * Run: node --experimental-strip-types --test packages/portal/src/lib/cognitive-metrics/__tests__/honesty.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	classifyHonesty,
	COMPUTING_BASELINE_COPY,
	LOW_SAMPLE_THRESHOLD,
	type HonestyState,
} from '../honesty.ts';
import type { PresentationContract, WindowResponse } from '../client.ts';

// ── Fixtures ────────────────────────────────────────────────────────

const baseContract: PresentationContract = {
	agent_must_not_say: ['no EEG framing'],
	science_honesty_footnote: 'Bands are temporal scales, not Hz.',
	delivery_guidance: ['embed numbers in observation'],
	user_voice_grounding: { preferred: ['rhythm'], preserved: ['territory'] },
	refusal_mode: 'Not enough signal yet to read your rhythm at this scale.',
	surface: 'both',
};

function window(
	overrides: Partial<WindowResponse['window']> = {},
): WindowResponse['window'] {
	return {
		granularity: 'delta',
		window_end: '2026-05-08T00:00:00Z',
		era_id: 'era-2026-05-06T07:39:40.048Z',
		message_count: 12,
		low_confidence: false,
		notes: null,
		...overrides,
	};
}

// ── State 1 — refusal ───────────────────────────────────────────────

describe('classifyHonesty — refusal', () => {
	it('returns refusal when window_end is null', () => {
		const out = classifyHonesty({
			window: window({ window_end: null, message_count: 0, low_confidence: true }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'refusal');
		assert.equal((out as Extract<HonestyState, { kind: 'refusal' }>).copy, baseContract.refusal_mode);
	});

	it('refusal copy comes from contract.refusal_mode (not hardcoded)', () => {
		const customContract: PresentationContract = {
			...baseContract,
			refusal_mode: 'CUSTOM REFUSAL TEXT',
		};
		const out = classifyHonesty({
			window: window({ window_end: null }),
			contract: customContract,
		});
		assert.equal((out as { copy: string }).copy, 'CUSTOM REFUSAL TEXT');
	});

	it('refusal wins even if low_confidence is true', () => {
		const out = classifyHonesty({
			window: window({ window_end: null, low_confidence: true }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'refusal');
	});
});

// ── State 2 — computing_baseline ────────────────────────────────────

describe('classifyHonesty — computing_baseline', () => {
	it('triggers when notes mentions baseline (case-insensitive)', () => {
		const out = classifyHonesty({
			window: window({ low_confidence: true, notes: 'baseline_90d not yet populated' }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'computing_baseline');
		assert.equal((out as { copy: string }).copy, COMPUTING_BASELINE_COPY);
	});

	it('triggers when notes mentions BASELINE in caps', () => {
		const out = classifyHonesty({
			window: window({ low_confidence: true, notes: 'BASELINE STILL WARMING' }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'computing_baseline');
	});

	it('triggers when low_confidence is true and notes is null (universal-prod case)', () => {
		const out = classifyHonesty({
			window: window({ low_confidence: true, notes: null }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'computing_baseline');
	});

	it('honors override copy when computingBaselineCopy is provided', () => {
		const out = classifyHonesty({
			window: window({ low_confidence: true, notes: null }),
			contract: baseContract,
			computingBaselineCopy: 'baseline still settling',
		});
		assert.equal((out as { copy: string }).copy, 'baseline still settling');
	});

	it('does NOT trigger when notes is set but does not mention baseline', () => {
		const out = classifyHonesty({
			window: window({ low_confidence: false, notes: 'message_count below floor' }),
			contract: baseContract,
		});
		assert.notEqual(out.kind, 'computing_baseline');
	});
});

// ── State 3 — low_sample ────────────────────────────────────────────

describe('classifyHonesty — low_sample', () => {
	it('triggers when message_count is below threshold', () => {
		const out = classifyHonesty({
			window: window({ message_count: 2, low_confidence: false, notes: 'sample_count_low' }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'low_sample');
		assert.match((out as { copy: string }).copy, /N=2/);
	});

	it('honors lowSampleThreshold override', () => {
		const out = classifyHonesty({
			window: window({ message_count: 8, low_confidence: false, notes: 'noted' }),
			contract: baseContract,
			lowSampleThreshold: 10,
		});
		assert.equal(out.kind, 'low_sample');
	});

	it('default threshold is LOW_SAMPLE_THRESHOLD', () => {
		assert.equal(LOW_SAMPLE_THRESHOLD, 5);
	});

	it('does NOT trigger when message_count meets threshold exactly', () => {
		const out = classifyHonesty({
			window: window({ message_count: 5, low_confidence: false }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'available');
	});
});

// ── State 4 — available ─────────────────────────────────────────────

describe('classifyHonesty — available', () => {
	it('returns available when all conditions clear', () => {
		const out = classifyHonesty({
			window: window({
				message_count: 50,
				low_confidence: false,
				notes: null,
				window_end: '2026-05-08T00:00:00Z',
			}),
			contract: baseContract,
		});
		assert.deepEqual(out, { kind: 'available' });
	});

	it('available even when notes is set (so long as not baseline-related)', () => {
		const out = classifyHonesty({
			window: window({
				message_count: 50,
				low_confidence: false,
				notes: 'computed in 240ms',
			}),
			contract: baseContract,
		});
		assert.equal(out.kind, 'available');
	});
});

// ── Precedence ──────────────────────────────────────────────────────

describe('classifyHonesty — precedence', () => {
	it('refusal beats every other state', () => {
		const out = classifyHonesty({
			window: window({
				window_end: null,
				message_count: 0,
				low_confidence: true,
				notes: 'baseline not yet populated',
			}),
			contract: baseContract,
		});
		assert.equal(out.kind, 'refusal');
	});

	it('computing_baseline beats low_sample', () => {
		const out = classifyHonesty({
			window: window({
				message_count: 1,
				low_confidence: true,
				notes: 'baseline still warming',
			}),
			contract: baseContract,
		});
		assert.equal(out.kind, 'computing_baseline');
	});

	it('low_sample beats available when count < threshold and notes is non-baseline', () => {
		const out = classifyHonesty({
			window: window({ message_count: 3, low_confidence: false, notes: 'some other note' }),
			contract: baseContract,
		});
		assert.equal(out.kind, 'low_sample');
	});
});
