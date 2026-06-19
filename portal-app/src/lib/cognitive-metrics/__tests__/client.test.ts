/**
 * Tests for cognitive-metrics/client.ts.
 *
 * Tests inject a mock Fetcher to verify path + query-string construction
 * and return-shape passthrough. The lazy `apiGet` import is never
 * triggered (default fetcher is overridden in every test).
 *
 * Run: node --experimental-strip-types --test packages/portal/src/lib/cognitive-metrics/__tests__/client.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	fetchWindow,
	fetchSeries,
	fetchContract,
	type ContractResponse,
	type Fetcher,
	type SeriesResponse,
	type WindowResponse,
} from '../client.ts';

// ── Mock-fetcher helpers ────────────────────────────────────────────

interface CapturedCall {
	path: string;
	params?: Record<string, string>;
}

function makeFetcher<T>(response: T): { fetcher: Fetcher; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	const fetcher: Fetcher = async (path, params) => {
		calls.push({ path, params });
		return response as unknown;
	};
	return { fetcher, calls };
}

// ── fetchWindow ─────────────────────────────────────────────────────

describe('fetchWindow', () => {
	const stubResponse: WindowResponse = {
		window: {
			granularity: 'delta',
			window_end: '2026-05-08T00:00:00Z',
			era_id: 'era-2026-05-06T07:39:40.048Z',
			message_count: 12,
			low_confidence: true,
			notes: null,
		},
		metrics: [
			{ metric_id: 'harmonic_amplitude_delta_k1', family: 'information_harmonic_amplitude', value: 0.1234 },
		],
	};

	it('hits /portal/metrics/window with granularity', async () => {
		const { fetcher, calls } = makeFetcher(stubResponse);
		await fetchWindow({ granularity: 'delta' }, fetcher);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].path, '/portal/metrics/window');
		assert.deepEqual(calls[0].params, { granularity: 'delta' });
	});

	it('joins metrics array as comma-separated string', async () => {
		const { fetcher, calls } = makeFetcher(stubResponse);
		await fetchWindow({ granularity: 'theta', metrics: ['m1', 'm2', 'm3'] }, fetcher);
		assert.deepEqual(calls[0].params, { granularity: 'theta', metrics: 'm1,m2,m3' });
	});

	it('omits metrics param when empty array', async () => {
		const { fetcher, calls } = makeFetcher(stubResponse);
		await fetchWindow({ granularity: 'alpha', metrics: [] }, fetcher);
		assert.deepEqual(calls[0].params, { granularity: 'alpha' });
	});

	it('returns the response shape unchanged', async () => {
		const { fetcher } = makeFetcher(stubResponse);
		const out = await fetchWindow({ granularity: 'delta' }, fetcher);
		assert.deepEqual(out, stubResponse);
	});

	it('propagates fetcher errors', async () => {
		const errFetcher: Fetcher = async () => {
			throw new Error('GET /portal/metrics/window failed (401)');
		};
		await assert.rejects(() => fetchWindow({ granularity: 'delta' }, errFetcher), /401/);
	});
});

// ── fetchSeries ─────────────────────────────────────────────────────

describe('fetchSeries', () => {
	const stub: SeriesResponse = {
		metric: 'harmonic_amplitude_delta_k1',
		family: 'information_harmonic_amplitude',
		granularity: 'delta',
		era_id: 'era-2026-05-06T07:39:40.048Z',
		series: [
			{ window_end: '2026-05-01T00:00:00Z', value: 0.1, message_count: 10, low_confidence: true, notes: null },
		],
	};

	it('hits /portal/metrics/series with required params', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchSeries({ metric: 'harmonic_amplitude_delta_k1', granularity: 'delta' }, fetcher);
		assert.equal(calls[0].path, '/portal/metrics/series');
		assert.deepEqual(calls[0].params, {
			metric: 'harmonic_amplitude_delta_k1',
			granularity: 'delta',
		});
	});

	it('passes optional from/to/limit', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchSeries(
			{
				metric: 'harmonic_amplitude_delta_k1',
				granularity: 'delta',
				from: '2026-05-01T00:00:00Z',
				to: '2026-05-08T00:00:00Z',
				limit: 50,
			},
			fetcher,
		);
		assert.deepEqual(calls[0].params, {
			metric: 'harmonic_amplitude_delta_k1',
			granularity: 'delta',
			from: '2026-05-01T00:00:00Z',
			to: '2026-05-08T00:00:00Z',
			limit: '50',
		});
	});

	it('serializes limit=0 explicitly (does not silently drop)', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchSeries({ metric: 'm', granularity: 'delta', limit: 0 }, fetcher);
		assert.equal(calls[0].params?.limit, '0');
	});
});

// ── fetchContract ───────────────────────────────────────────────────

describe('fetchContract', () => {
	const stub: ContractResponse = {
		family: 'information_harmonic_amplitude',
		contract: {
			agent_must_not_say: ['no EEG framing'],
			science_honesty_footnote: 'Bands are temporal scales, not Hz.',
			delivery_guidance: ['embed numbers in observation'],
			user_voice_grounding: { preferred: ['rhythm'], preserved: ['territory'] },
			refusal_mode: 'Not enough signal yet to read your rhythm at this scale.',
			surface: 'both',
		},
		spec_ref: 'COGNITIVE-METRICS-SPEC.md §4.23',
		contract_version: 'v1.3.3',
	};

	it('routes to /portal/metrics/contracts/:family', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchContract('information_harmonic_amplitude', fetcher);
		assert.equal(calls[0].path, '/portal/metrics/contracts/information_harmonic_amplitude');
		assert.equal(calls[0].params, undefined);
	});

	it('returns the contract response unchanged', async () => {
		const { fetcher } = makeFetcher(stub);
		const out = await fetchContract('information_harmonic_amplitude', fetcher);
		assert.deepEqual(out, stub);
	});

	it('passes through bigram_flow_features', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchContract('bigram_flow_features', fetcher);
		assert.equal(calls[0].path, '/portal/metrics/contracts/bigram_flow_features');
	});

	it('passes through topology_persistence_entropy', async () => {
		const { fetcher, calls } = makeFetcher(stub);
		await fetchContract('topology_persistence_entropy', fetcher);
		assert.equal(calls[0].path, '/portal/metrics/contracts/topology_persistence_entropy');
	});
});
