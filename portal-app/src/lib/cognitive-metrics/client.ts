/**
 * Portal client for /portal/metrics/{window, series, contracts/:family}.
 *
 * Pure typed surface — fetchers are injected so tests can stub without
 * mocking the global fetch. Default fetcher lazy-imports the portal
 * `apiGet` helper at call time (matching the lazy-import pattern in
 * lib/api.ts for secure-fetch), so this module can be loaded by a node
 * test runner without resolving the SvelteKit `$lib` alias.
 *
 * @see docs/WORKSTREAM-C-PORTAL-DESIGN-2026-05-08.md (Step 1)
 * @see packages/server/lib/metrics-handlers.js (server-side handlers)
 */

// ── Types — mirror the server response shapes ──────────────────────

export type Granularity = 'alpha' | 'theta' | 'delta';
export type MetricFamily =
	| 'information_harmonic_amplitude'
	| 'bigram_flow_features'
	| 'topology_persistence_entropy';

export interface MetricValue {
	metric_id: string;
	family: MetricFamily;
	value: number | null;
}

export interface WindowResponse {
	window: {
		granularity: Granularity;
		window_end: string | null;
		era_id: string;
		message_count: number;
		low_confidence: boolean;
		notes: string | null;
	};
	metrics: MetricValue[];
}

export interface SeriesPoint {
	window_end: string;
	value: number | null;
	message_count: number;
	low_confidence: boolean;
	notes: string | null;
}

export interface SeriesResponse {
	metric: string;
	family: MetricFamily;
	granularity: Granularity;
	era_id: string;
	series: SeriesPoint[];
}

export interface PresentationContract {
	agent_must_not_say: readonly string[];
	science_honesty_footnote: string;
	delivery_guidance: readonly string[];
	user_voice_grounding: {
		preferred: readonly string[];
		preserved: readonly string[];
	};
	refusal_mode: string;
	surface: 'both' | 'agent_only' | 'portal_only';
}

export interface ContractResponse {
	family: MetricFamily;
	contract: PresentationContract;
	spec_ref: string;
	contract_version: string;
}

// ── Fetcher injection point — default lazy-imports portal apiGet ──
//
// Non-generic on purpose: the runtime fetcher returns `unknown`; each
// public function below names the response type it expects and casts at
// the boundary. Keeping Fetcher non-generic lets tests inject a simple
// stub without satisfying a generic-callability constraint.

export type Fetcher = (path: string, params?: Record<string, string>) => Promise<unknown>;

let _cachedApiGet: Fetcher | null = null;

const defaultFetcher: Fetcher = async (path, params) => {
	if (!_cachedApiGet) {
		const mod = await import('$lib/api');
		_cachedApiGet = mod.apiGet as Fetcher;
	}
	return _cachedApiGet(path, params);
};

// ── Public API ─────────────────────────────────────────────────────

export async function fetchWindow(
	params: { granularity: Granularity; metrics?: string[] },
	fetcher: Fetcher = defaultFetcher,
): Promise<WindowResponse> {
	const qs: Record<string, string> = { granularity: params.granularity };
	if (params.metrics && params.metrics.length > 0) qs.metrics = params.metrics.join(',');
	return (await fetcher('/portal/metrics/window', qs)) as WindowResponse;
}

export async function fetchSeries(
	params: {
		metric: string;
		granularity: Granularity;
		from?: string;
		to?: string;
		limit?: number;
	},
	fetcher: Fetcher = defaultFetcher,
): Promise<SeriesResponse> {
	const qs: Record<string, string> = {
		metric: params.metric,
		granularity: params.granularity,
	};
	if (params.from) qs.from = params.from;
	if (params.to) qs.to = params.to;
	if (params.limit !== undefined) qs.limit = String(params.limit);
	return (await fetcher('/portal/metrics/series', qs)) as SeriesResponse;
}

export async function fetchContract(
	family: MetricFamily,
	fetcher: Fetcher = defaultFetcher,
): Promise<ContractResponse> {
	return (await fetcher(`/portal/metrics/contracts/${family}`)) as ContractResponse;
}
