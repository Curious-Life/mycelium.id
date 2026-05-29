<script lang="ts">
	/**
	 * TopologyCard — single-value display for §4.34 H0 persistence
	 * entropy on the user's recent message embeddings (256D matryoshka).
	 *
	 * Higher H0 = more topologically scattered (many separate clusters
	 * of similar size). Lower H0 = a few dominant attractors. The
	 * portal contract surfaces the within-user constraint via
	 * ContractsHover; cross-user comparisons are invalid.
	 *
	 * @see client.ts fetchWindow
	 * @see honesty.ts classifyHonesty
	 * @see packages/metrics/contracts/topology_persistence_entropy.js
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

	const METRIC_ID = 'topology_h0_persistence_entropy';

	let loading = $state(true);
	let loadFailed = $state(false);
	let windowResp = $state<WindowResponse | null>(null);
	let contract = $state<ContractResponse | null>(null);

	async function load() {
		loading = true;
		loadFailed = false;
		try {
			const [w, c] = await Promise.all([
				fetchWindow({ granularity, metrics: [METRIC_ID] }),
				fetchContract('topology_persistence_entropy'),
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

	const value = $derived<number | null>(
		windowResp ? (windowResp.metrics.find((m) => m.metric_id === METRIC_ID)?.value ?? null) : null,
	);

	function fmt(v: number | null): string {
		if (v == null) return '—';
		return v.toFixed(3);
	}
</script>

<div class="card">
	<header>
		<h3>
			Topology — H<sub>0</sub> entropy
			{#if contract}
				<ContractsHover family="topology_persistence_entropy" />
			{/if}
		</h3>
		<span class="grain">{granularity}</span>
	</header>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if loadFailed}
		<p class="muted">Could not load topology data.</p>
	{:else if honestyState}
		{#if honestyState.kind !== 'available'}
			<HonestyBanner state={honestyState} />
		{/if}

		{#if honestyState.kind === 'refusal'}
			<!-- value hidden by design -->
		{:else}
			<div class="value-wrap">
				<div class="value">{fmt(value)}</div>
				<div class="hint">
					Higher = scattered topology (many clusters); lower = few dominant attractors.
				</div>
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
	h3 sub {
		font-size: 0.7em;
		color: #94a3b8;
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
	.value-wrap {
		margin-top: 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.value {
		font-size: 2.2rem;
		font-family: ui-monospace, monospace;
		color: #e5b84c;
		line-height: 1;
	}
	.hint {
		font-size: 0.78rem;
		color: #94a3b8;
		line-height: 1.4;
	}
</style>
