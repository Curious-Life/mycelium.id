<!--
	Measurement health — per-stage trackability for the analysis pipeline. Reads
	GET /portal/measurement-health (src/portal-measurement.js → joins the freshness
	verdict map with the pipeline_state ledger). Makes a stale metric family
	DIAGNOSABLE: fresh / stale-because-failed / never-ran / chronically-broken
	(quarantined). Content-free: counts, timestamps, and a bounded stage-error
	class only — no message content. @see docs/DESIGN-measurement-narration-hardening-2026-06-18.md §4.4
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { apiGet } from '$lib/api';

	type Family = {
		table: string | null; stage: string | null; verdict: string | null;
		last_write: string | null; age_ms: number | null; cadence: string | null; description: string | null;
		last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null;
		consecutive_failures: number; quarantined: boolean; last_duration_ms: number | null;
	};
	type Health = {
		families: Family[];
		summary: { total: number; fresh: number; stale: number; missing: number; empty: number; failing: number; quarantined: number };
	};

	let data = $state<Health | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			data = await apiGet<Health>('/portal/measurement-health');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load measurement health';
		} finally {
			loading = false;
		}
	}
	onMount(load);

	// Failing/quarantined dominate the dot colour; else the freshness verdict.
	function dot(f: Family): string {
		if (f.quarantined || f.consecutive_failures > 0) return 'var(--color-danger, #ef4444)';
		if (f.verdict === 'fresh') return 'var(--color-success, #22c55e)';
		if (f.verdict === 'stale') return 'var(--color-warning, #f59e0b)';
		return 'var(--color-text-tertiary, #9ca3af)'; // empty / missing / unknown
	}
	function label(f: Family): string {
		return (f.stage || f.table || 'stage').replace(/[-_]/g, ' ');
	}
	function when(iso: string | null): string {
		if (!iso) return '—';
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return '—';
		return new Date(t).toLocaleString();
	}
	function statusText(f: Family): string {
		if (f.quarantined) return 'Quarantined — failing repeatedly';
		if (f.consecutive_failures > 0) return `Failed ${f.consecutive_failures}× — last computed ${when(f.last_success_at)}`;
		if (f.verdict === 'fresh') return `Up to date · computed ${when(f.last_write || f.last_success_at)}`;
		if (f.verdict === 'stale') return `Stale · last ${when(f.last_write || f.last_success_at)}`;
		if (f.verdict === 'empty') return 'Not computed yet';
		if (f.verdict === 'missing') return 'No data';
		return when(f.last_success_at);
	}
</script>

<section class="card p-5 space-y-4">
	<header class="flex items-center justify-between gap-3 flex-wrap">
		<div>
			<h2 class="text-sm font-semibold">Measurement health</h2>
			<p class="text-xs opacity-60">Per-stage status of your analysis pipeline. Counts &amp; timestamps only — no content.</p>
		</div>
		<button class="text-xs px-2.5 py-1 rounded-full opacity-60 hover:opacity-100 transition-colors cursor-pointer" onclick={load}>Refresh</button>
	</header>

	{#if loading}
		<p class="text-xs opacity-60">Loading…</p>
	{:else if error}
		<p class="text-xs" style="color: var(--color-danger, #ef4444)">{error}</p>
	{:else if data && data.families.length}
		{#if data.summary.quarantined > 0 || data.summary.failing > 0}
			<div class="text-xs rounded px-3 py-2" style="background: color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent); color: var(--color-danger, #ef4444)">
				{data.summary.failing} stage{data.summary.failing === 1 ? '' : 's'} failing{data.summary.quarantined > 0 ? ` · ${data.summary.quarantined} quarantined (needs attention)` : ''}.
			</div>
		{/if}

		<div class="flex flex-wrap gap-2 text-[11px]">
			<span class="opacity-70">{data.summary.fresh} fresh</span>
			<span class="opacity-70">{data.summary.stale} stale</span>
			{#if data.summary.failing > 0}<span style="color: var(--color-danger, #ef4444)">{data.summary.failing} failing</span>{/if}
		</div>

		<div class="space-y-1.5">
			{#each data.families as f (f.stage ?? f.table)}
				<div class="flex items-start gap-2.5 text-xs p-2 rounded bg-[var(--color-surface-2,rgba(255,255,255,0.04))]">
					<span class="mt-1 w-2 h-2 rounded-full flex-shrink-0" style="background: {dot(f)}"></span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium capitalize truncate">{label(f)}</span>
							{#if f.quarantined}<span class="text-[10px] px-1.5 py-0.5 rounded-full" style="background: var(--color-danger, #ef4444); color: white">needs attention</span>{/if}
						</div>
						<div class="text-[11px] opacity-60">{statusText(f)}</div>
						{#if f.last_failure_reason && (f.quarantined || f.consecutive_failures > 0)}
							<div class="text-[10px] mt-0.5 font-mono opacity-70" style="color: var(--color-danger, #ef4444)">{f.last_failure_reason}</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-xs opacity-60">No measurement data yet — run “Refresh analysis”.</p>
	{/if}
</section>
