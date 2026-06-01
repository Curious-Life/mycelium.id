<script lang="ts">
	/**
	 * CognitiveShapeTab — parent for Workstream C's Vitality-page tab.
	 *
	 * Owns:
	 *   - Granularity state (alpha · theta · delta; default delta per
	 *     spec delivery guidance)
	 *   - Era banner — derives era_id from a tiny probe call (one
	 *     metric column) on mount/grain-change. Server is the truth;
	 *     never compute era_id client-side.
	 *   - Freshness pill — wraps MetricFreshnessBadge for the
	 *     cognitive_metrics_harmonic table (registered in METRIC_BUDGETS
	 *     via Step 0).
	 *
	 * Defers per-family rendering + per-family data fetching to the
	 * three cards (Step 3). Parent → cards is one-way: pass
	 * `granularity`; each card refetches its own slice.
	 *
	 * @see docs/WORKSTREAM-C-PORTAL-DESIGN-2026-05-08.md (Step 4)
	 */

	import { onMount } from 'svelte';
	import MetricFreshnessBadge from '$lib/components/MetricFreshnessBadge.svelte';
	import HarmonicBandsCard from './HarmonicBandsCard.svelte';
	import FlowFeaturesCard from './FlowFeaturesCard.svelte';
	import TopologyCard from './TopologyCard.svelte';
	import { fetchWindow, type Granularity, type WindowResponse } from './client.ts';

	const GRANULARITIES: readonly Granularity[] = ['alpha', 'theta', 'delta'];
	const GRAIN_LABEL: Record<Granularity, string> = {
		alpha: 'per-message',
		theta: '10-msg',
		delta: 'daily',
	};
	const PROBE_METRIC = 'topology_h0_persistence_entropy';

	// Default delta — spec contract: "Bias toward delta + theta (week +
	// month) for narrative. Gamma is too noisy."
	let granularity = $state<Granularity>('delta');

	let probeLoading = $state(true);
	let probe = $state<WindowResponse | null>(null);
	let probeFailed = $state(false);

	async function loadProbe() {
		probeLoading = true;
		probeFailed = false;
		try {
			probe = await fetchWindow({ granularity, metrics: [PROBE_METRIC] });
		} catch {
			probeFailed = true;
		} finally {
			probeLoading = false;
		}
	}

	onMount(loadProbe);

	$effect(() => {
		// Refetch probe when grain changes so era + window_end track.
		if (probe && probe.window.granularity !== granularity) loadProbe();
	});

	function selectGrain(g: Granularity) {
		if (g !== granularity) granularity = g;
	}

	const eraId = $derived(probe?.window.era_id ?? null);
	const windowEnd = $derived(probe?.window.window_end ?? null);
</script>

<section class="tab" aria-label="Cognitive shape">
	<header class="tab-header">
		<div class="title-row">
			<h2>Cognitive shape</h2>
			<MetricFreshnessBadge tables={['cognitive_metrics_harmonic']} />
		</div>

		<div class="grain-selector" role="tablist" aria-label="Granularity">
			{#each GRANULARITIES as g (g)}
				<button
					type="button"
					role="tab"
					aria-selected={g === granularity}
					class="grain-btn"
					class:active={g === granularity}
					onclick={() => selectGrain(g)}
				>
					<span class="grain-name">{g}</span>
					<span class="grain-label">{GRAIN_LABEL[g]}</span>
				</button>
			{/each}
		</div>

		<div class="era-banner">
			{#if probeLoading}
				<span class="muted">Probing era…</span>
			{:else if probeFailed}
				<span class="muted">Era unavailable.</span>
			{:else if eraId}
				<span class="era-id" title="Server-resolved era anchor">{eraId}</span>
				<span class="sep">·</span>
				<span class="grain-cite">{granularity} grain</span>
				{#if windowEnd}
					<span class="sep">·</span>
					<span class="window-end">last window {windowEnd}</span>
				{:else}
					<span class="sep">·</span>
					<span class="muted">no window yet</span>
				{/if}
			{/if}
		</div>
	</header>

	<div class="cards">
		<HarmonicBandsCard {granularity} />
		<FlowFeaturesCard {granularity} />
		<TopologyCard {granularity} />
	</div>
</section>

<style>
	.tab {
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
		padding: 1rem 0;
	}
	.tab-header {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
		color: #f1f5f9;
		font-weight: 500;
	}
	.grain-selector {
		display: inline-flex;
		gap: 0.3rem;
		padding: 0.25rem;
		background: #0a0c12;
		border: 1px solid #1c1f28;
		border-radius: 8px;
		align-self: flex-start;
	}
	.grain-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.45rem 0.9rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: #94a3b8;
		cursor: pointer;
		min-width: 5.5rem;
		transition: background 0.15s ease, color 0.15s ease;
	}
	.grain-btn:hover {
		color: #cbd5e1;
		background: rgba(229, 184, 76, 0.05);
	}
	.grain-btn.active {
		color: #e5b84c;
		background: rgba(229, 184, 76, 0.12);
		border-color: rgba(229, 184, 76, 0.3);
	}
	.grain-name {
		font-size: 0.8rem;
		font-weight: 500;
		text-transform: lowercase;
		letter-spacing: 0.02em;
	}
	.grain-label {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #64748b;
		font-family: ui-monospace, monospace;
		margin-top: 0.15rem;
	}
	.grain-btn.active .grain-label {
		color: #94a3b8;
	}
	.era-banner {
		font-size: 0.78rem;
		color: #94a3b8;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		font-family: ui-monospace, monospace;
	}
	.era-id {
		color: #cbd5e1;
	}
	.sep {
		color: #475569;
	}
	.muted {
		color: #94a3b8;
		font-style: italic;
	}
	.cards {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
	}
	@media (min-width: 1100px) {
		.cards {
			grid-template-columns: 1fr 1fr;
		}
		/* HarmonicBandsCard takes the full width on top, others share row 2. */
		.cards :global(> :first-child) {
			grid-column: 1 / -1;
		}
	}
</style>
