<script lang="ts">
	/**
	 * HarmonicBandsCard — renders the 15 harmonic amplitude metrics
	 * (5 bands × 3 harmonic orders k1/k2/k3) for a given granularity.
	 *
	 * Visual: 5 rows (one per temporal band — gamma/beta/alpha/theta/delta),
	 * each with 3 horizontal bars sized relative to the max amplitude in
	 * the response. Delta + theta emphasized per the spec's delivery
	 * guidance ("bias toward delta + theta for narrative; gamma is too
	 * noisy to surface unfiltered").
	 *
	 * Honesty contract: refusal hides values; computing_baseline +
	 * low_sample show values with a banner caveat; available shows
	 * values plainly.
	 *
	 * @see client.ts fetchWindow
	 * @see honesty.ts classifyHonesty
	 * @see packages/metrics/contracts/information_harmonic_amplitude.js
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

	const BANDS = ['gamma', 'beta', 'alpha', 'theta', 'delta'] as const;
	const KS = [1, 2, 3] as const;

	function metricCols(): string[] {
		const out: string[] = [];
		for (const k of KS) {
			for (const b of BANDS) out.push(`harmonic_amplitude_${b}_k${k}`);
		}
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
				fetchContract('information_harmonic_amplitude'),
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
		// Refetch when granularity changes (parent toggles alpha/theta/delta).
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
		return max || 1; // avoid div-by-zero
	});

	function barWidthPct(v: number | null): number {
		if (v == null) return 0;
		return Math.min(100, (Math.abs(v) / maxAbs()) * 100);
	}

	function fmt(v: number | null): string {
		if (v == null) return '—';
		return v.toFixed(4);
	}
</script>

<div class="card">
	<header>
		<h3>
			Harmonic amplitudes
			{#if contract}
				<ContractsHover family="information_harmonic_amplitude" />
			{/if}
		</h3>
		<span class="grain">{granularity}</span>
	</header>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if loadFailed}
		<p class="muted">Could not load harmonic data.</p>
	{:else if honestyState}
		{#if honestyState.kind !== 'available'}
			<HonestyBanner state={honestyState} />
		{/if}

		{#if honestyState.kind === 'refusal'}
			<!-- Value hidden by design when no data exists. -->
		{:else}
			<div class="grid">
				<div class="header-row">
					<span></span>
					{#each KS as k (k)}
						<span class="col-label">k{k}</span>
					{/each}
				</div>
				{#each BANDS as band (band)}
					<div class="band-row" class:emphasized={band === 'delta' || band === 'theta'}>
						<span class="band-label">{band}</span>
						{#each KS as k (k)}
							{@const v = valueByMetric().get(`harmonic_amplitude_${band}_k${k}`) ?? null}
							<div class="bar-cell" title={`${band} k${k}: ${fmt(v)}`}>
								<div class="bar" style:width={`${barWidthPct(v)}%`}></div>
								<span class="bar-value">{fmt(v)}</span>
							</div>
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
	.grid {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.8rem;
	}
	.header-row,
	.band-row {
		display: grid;
		grid-template-columns: 4rem 1fr 1fr 1fr;
		align-items: center;
		gap: 0.5rem;
	}
	.col-label,
	.band-label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #94a3b8;
		font-family: ui-monospace, monospace;
	}
	.col-label {
		text-align: center;
	}
	.band-row.emphasized .band-label {
		color: #cbd5e1;
	}
	.bar-cell {
		position: relative;
		height: 1.4rem;
		background: #11141c;
		border-radius: 4px;
		overflow: hidden;
		display: flex;
		align-items: center;
	}
	.bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: linear-gradient(to right, rgba(229, 184, 76, 0.35), rgba(229, 184, 76, 0.18));
	}
	.band-row.emphasized .bar {
		background: linear-gradient(to right, rgba(229, 184, 76, 0.55), rgba(229, 184, 76, 0.28));
	}
	.bar-value {
		position: relative;
		z-index: 1;
		padding-left: 0.5rem;
		font-size: 0.7rem;
		color: #cbd5e1;
		font-family: ui-monospace, monospace;
	}
</style>
