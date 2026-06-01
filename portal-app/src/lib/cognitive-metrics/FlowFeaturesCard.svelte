<script lang="ts">
	/**
	 * FlowFeaturesCard — renders the 25 bigram flow features
	 * (5 features × 5 bands) for a given granularity. Visual: a 5×5
	 * grid where rows are features and columns are temporal bands.
	 *
	 * Each cell shows the value as a small numeric pill, with a
	 * background heat-shade scaled by absolute magnitude across the
	 * card. Per the contract, this is within-user shape-of-flow only;
	 * cross-user comparisons are invalid (surfaced via ContractsHover).
	 *
	 * @see client.ts fetchWindow
	 * @see honesty.ts classifyHonesty
	 * @see packages/metrics/contracts/bigram_flow_features.js
	 */

	import { onMount } from 'svelte';
	import {
		fetchContract,
		fetchWindow,
		type ContractResponse,
		type Granularity,
		type WindowResponse,
	} from './client.ts';
	import { classifyHonesty, type HonestyState } from './honesty.ts';
	import HonestyBanner from './HonestyBanner.svelte';
	import ContractsHover from './ContractsHover.svelte';

	interface Props {
		granularity: Granularity;
	}
	const { granularity }: Props = $props();

	const FEATURES = [
		'mean_crossing_rate',
		'slope_sign_change_rate',
		'autocorrelation_lag1',
		'variance',
		'total_spectral_energy',
	] as const;
	const BANDS = ['gamma', 'beta', 'alpha', 'theta', 'delta'] as const;

	const FEATURE_LABEL: Record<(typeof FEATURES)[number], string> = {
		mean_crossing_rate: 'crossing rate',
		slope_sign_change_rate: 'reversal rate',
		autocorrelation_lag1: 'continuity (γ)',
		variance: 'variance',
		total_spectral_energy: 'spectral energy',
	};

	function metricCols(): string[] {
		const out: string[] = [];
		for (const f of FEATURES) for (const b of BANDS) out.push(`${f}_${b}`);
		return out;
	}

	let loading = $state(true);
	let loadFailed = $state(false);
	let windowResp = $state<WindowResponse | null>(null);
	let contract = $state<ContractResponse | null>(null);

	async function load() {
		loading = true;
		loadFailed = false;
		try {
			const [w, c] = await Promise.all([
				fetchWindow({ granularity, metrics: metricCols() }),
				fetchContract('bigram_flow_features'),
			]);
			windowResp = w;
			contract = c;
		} catch {
			loadFailed = true;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	$effect(() => {
		if (windowResp && windowResp.window.granularity !== granularity) load();
	});

	const honestyState = $derived<HonestyState | null>(
		windowResp && contract
			? classifyHonesty({ window: windowResp.window, contract: contract.contract })
			: null,
	);

	const valueByMetric = $derived(() => {
		const m = new Map<string, number | null>();
		if (windowResp) for (const r of windowResp.metrics) m.set(r.metric_id, r.value);
		return m;
	});

	const maxAbs = $derived(() => {
		if (!windowResp) return 0;
		let max = 0;
		for (const r of windowResp.metrics) {
			if (r.value != null && Math.abs(r.value) > max) max = Math.abs(r.value);
		}
		return max || 1;
	});

	function heatOpacity(v: number | null): number {
		if (v == null) return 0;
		return Math.min(0.55, (Math.abs(v) / maxAbs()) * 0.55);
	}

	function fmt(v: number | null): string {
		if (v == null) return '—';
		const abs = Math.abs(v);
		if (abs > 0 && abs < 0.001) return v.toExponential(1);
		return v.toFixed(3);
	}
</script>

<div class="card">
	<header>
		<h3>
			Flow shape
			{#if contract}
				<ContractsHover family="bigram_flow_features" />
			{/if}
		</h3>
		<span class="grain">{granularity}</span>
	</header>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if loadFailed}
		<p class="muted">Could not load flow data.</p>
	{:else if honestyState}
		{#if honestyState.kind !== 'available'}
			<HonestyBanner state={honestyState} />
		{/if}

		{#if honestyState.kind === 'refusal'}
			<!-- value hidden by design -->
		{:else}
			<div class="table" role="table" aria-label="Bigram flow features by feature × band">
				<div class="row head" role="row">
					<span class="cell head-cell" role="columnheader"></span>
					{#each BANDS as band (band)}
						<span class="cell head-cell" role="columnheader">{band}</span>
					{/each}
				</div>
				{#each FEATURES as feature (feature)}
					<div class="row" role="row">
						<span class="cell row-label" role="rowheader">{FEATURE_LABEL[feature]}</span>
						{#each BANDS as band (band)}
							{@const v = valueByMetric().get(`${feature}_${band}`) ?? null}
							<span
								class="cell value"
								role="cell"
								title={`${FEATURE_LABEL[feature]} · ${band}: ${fmt(v)}`}
								style:background={`rgba(229, 184, 76, ${heatOpacity(v)})`}
							>
								{fmt(v)}
							</span>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.card {
		padding: 1rem 1.1rem;
		background: #0e1118;
		border: 1px solid #1c1f28;
		border-radius: 10px;
		color: #cbd5e1;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.85rem;
	}
	h3 {
		margin: 0;
		font-size: 0.95rem;
		color: #f1f5f9;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.grain {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #94a3b8;
		font-family: ui-monospace, monospace;
	}
	.muted {
		margin: 0;
		color: #94a3b8;
		font-style: italic;
	}
	.table {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.8rem;
	}
	.row {
		display: grid;
		grid-template-columns: 9rem repeat(5, 1fr);
		gap: 0.25rem;
		align-items: stretch;
	}
	.cell {
		padding: 0.4rem 0.5rem;
		font-size: 0.72rem;
		font-family: ui-monospace, monospace;
		border-radius: 4px;
		background: #11141c;
		color: #cbd5e1;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row.head .cell {
		background: transparent;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 0.66rem;
		padding: 0.2rem 0.5rem;
	}
	.cell.row-label {
		text-align: left;
		color: #cbd5e1;
		text-transform: none;
		letter-spacing: 0;
		background: transparent;
		font-family: inherit;
		font-size: 0.78rem;
	}
	.cell.value {
		transition: background-color 0.2s ease;
	}
</style>
