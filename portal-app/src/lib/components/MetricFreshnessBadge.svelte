<script lang="ts">
	/**
	 * MetricFreshnessBadge — surfaces per-table data staleness inline.
	 *
	 * Drop next to a chart or section that depends on derived-metric
	 * tables. Pass `tables` listing the relevant table names; the badge
	 * fetches /portal/metric-freshness and shows an orange pill iff any
	 * of those tables exceed their staleness budget. Hover/click reveals
	 * which tables and how stale.
	 *
	 *   <MetricFreshnessBadge tables={['fisher_trajectory', 'fisher_milestones']} />
	 *
	 * Failure-quiet: if the endpoint errors or auth is missing, the
	 * component renders nothing — better than falsely claiming "fresh."
	 *
	 * Spec: docs/architecture/MEASUREMENT-PLANE-PLAN.md (PR 0.3).
	 */
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface Props {
		tables: string[];
	}
	const { tables }: Props = $props();

	type Verdict = 'fresh' | 'stale' | 'missing' | 'empty';
	interface MetricRow {
		table: string;
		verdict: Verdict;
		last_write: string | null;
		age_ms: number | null;
		budget_ms: number;
		cadence: string;
		description: string;
	}

	let metrics = $state<MetricRow[]>([]);
	let loaded = $state(false);
	let showDetail = $state(false);

	onMount(async () => {
		try {
			const res = await api('/portal/metric-freshness');
			if (!res.ok) return;
			const data = await res.json();
			metrics = (data.metrics || []).filter((m: MetricRow) => tables.includes(m.table));
			loaded = true;
		} catch {
			// fail silent — page renders without badge
		}
	});

	const stale = $derived(metrics.filter((m) => m.verdict === 'stale'));
	const empty = $derived(metrics.filter((m) => m.verdict === 'empty'));
	const showBadge = $derived(loaded && (stale.length > 0 || empty.length > 0));

	function ageLabel(ms: number | null): string {
		if (ms === null) return 'never';
		const days = ms / 86_400_000;
		if (days >= 2) return `${Math.round(days)}d ago`;
		const hours = ms / 3_600_000;
		if (hours >= 2) return `${Math.round(hours)}h ago`;
		return `${Math.round(ms / 60_000)}m ago`;
	}
</script>

{#if showBadge}
	<button
		type="button"
		class="badge"
		class:stale={stale.length > 0}
		class:empty={empty.length === metrics.length && stale.length === 0}
		onclick={() => (showDetail = !showDetail)}
		title="Click for details"
	>
		⏳
		{#if stale.length > 0}
			data {ageLabel(Math.max(...stale.map((m) => m.age_ms ?? 0)))}
		{:else}
			data not yet computed
		{/if}
	</button>

	{#if showDetail}
		<div class="detail" role="dialog" aria-label="Metric freshness detail">
			<h4>Data freshness</h4>
			<ul>
				{#each metrics as m (m.table)}
					<li class:stale={m.verdict === 'stale'} class:empty={m.verdict === 'empty'}>
						<span class="table">{m.table}</span>
						<span class="verdict">{m.verdict}</span>
						{#if m.last_write}
							<span class="age">last: {ageLabel(m.age_ms)}</span>
						{:else}
							<span class="age">no rows yet</span>
						{/if}
						<span class="desc">{m.description}</span>
					</li>
				{/each}
			</ul>
			<p class="note">
				A stale metric means the compute pipeline that produces it hasn't run within
				its expected cadence. Fresh data will return when the pipeline catches up.
			</p>
		</div>
	{/if}
{/if}

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.6rem;
		font-size: 0.75rem;
		font-weight: 500;
		border: 1px solid currentColor;
		border-radius: 999px;
		background: transparent;
		color: #f59e0b;
		cursor: pointer;
	}
	.badge.stale {
		color: #f59e0b;
	}
	.badge.empty {
		color: #94a3b8;
	}
	.badge:hover {
		background: rgba(245, 158, 11, 0.08);
	}

	.detail {
		position: absolute;
		z-index: 50;
		margin-top: 0.4rem;
		padding: 0.8rem 1rem;
		background: #11131a;
		border: 1px solid #2a2f3a;
		border-radius: 8px;
		min-width: 360px;
		max-width: 480px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		color: #cbd5e1;
		font-size: 0.85rem;
	}
	.detail h4 {
		margin: 0 0 0.6rem 0;
		font-size: 0.9rem;
		color: #f1f5f9;
	}
	.detail ul {
		list-style: none;
		padding: 0;
		margin: 0 0 0.8rem 0;
	}
	.detail li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.5rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid #1c1f28;
		font-size: 0.78rem;
	}
	.detail li:last-child {
		border-bottom: none;
	}
	.detail li.stale .verdict {
		color: #f59e0b;
	}
	.detail li.empty .verdict {
		color: #94a3b8;
	}
	.detail .table {
		font-family: ui-monospace, monospace;
		color: #e2e8f0;
	}
	.detail .age {
		color: #94a3b8;
		font-size: 0.72rem;
	}
	.detail .desc {
		grid-column: 1 / -1;
		color: #94a3b8;
		font-size: 0.72rem;
		margin-top: 0.1rem;
	}
	.detail .note {
		margin: 0;
		padding-top: 0.6rem;
		border-top: 1px solid #1c1f28;
		font-size: 0.72rem;
		color: #94a3b8;
		line-height: 1.4;
	}
</style>
