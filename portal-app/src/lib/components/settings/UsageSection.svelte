<!--
	Token Usage — transparency on how many input/output tokens Mycelium consumes,
	categorized by area (chat / narration / claims / …), source (chat · gateway ·
	enrichment), provider, and model. Reads GET /portal/usage (src/portal-usage.js →
	db.usage.summary over the llm_usage table). Counts only — no prompt/response text
	is ever stored or shown. CSS bars (the portal has no chart lib, matching the
	activity chip). @see docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md §12.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { apiGet } from '$lib/api';

	type Group = { key: string; inputTokens: number; outputTokens: number; events: number };
	type RecentEvent = {
		at: string; source: string; area: string; provider: string | null; model: string | null;
		jurisdiction: string | null; isLocal: boolean; inputTokens: number; outputTokens: number;
		estimated: boolean; durationMs: number | null;
	};
	type Summary = {
		days: number;
		totals: { inputTokens: number; outputTokens: number; events: number };
		byArea: Group[]; bySource: Group[]; byProvider: Group[]; byModel: Group[]; byDay: Group[];
		recent: RecentEvent[];
	};

	const RANGES = [
		{ days: 7, label: '7 days' },
		{ days: 30, label: '30 days' },
		{ days: 90, label: '90 days' },
		{ days: 365, label: '1 year' },
	];

	let data = $state<Summary | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let days = $state(30);

	const fmt = (n: number) => n.toLocaleString();
	const total = (g: Group) => g.inputTokens + g.outputTokens;
	// Largest group total, for proportional bars (guard against /0).
	function maxOf(groups: Group[]): number {
		return Math.max(1, ...groups.map(total));
	}

	async function load() {
		loading = true;
		error = null;
		try {
			data = await apiGet<Summary>('/portal/usage', { days: String(days) });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load usage';
		} finally {
			loading = false;
		}
	}

	onMount(load);
</script>

<section class="card p-5 space-y-5">
	<header class="flex items-center justify-between gap-3 flex-wrap">
		<div>
			<h2 class="text-sm font-semibold">Token usage</h2>
			<p class="text-xs opacity-60">Input &amp; output tokens consumed — by area, provider and model. Counts only; no message content is stored.</p>
		</div>
		<div class="flex gap-1">
			{#each RANGES as r}
				<button
					class="text-xs px-2.5 py-1 rounded-full transition-colors cursor-pointer {days === r.days ? 'bg-white/15 font-medium' : 'opacity-60 hover:opacity-100'}"
					onclick={() => { days = r.days; load(); }}
				>{r.label}</button>
			{/each}
		</div>
	</header>

	{#if loading}
		<p class="text-xs opacity-60">Loading…</p>
	{:else if error}
		<p class="text-xs text-red-400">{error}</p>
	{:else if data && data.totals.events > 0}
		<!-- Totals -->
		<div class="grid grid-cols-3 gap-3">
			<div class="rounded-lg bg-white/5 p-3">
				<div class="text-[11px] uppercase tracking-wide opacity-50">Input</div>
				<div class="text-lg font-semibold tabular-nums">{fmt(data.totals.inputTokens)}</div>
			</div>
			<div class="rounded-lg bg-white/5 p-3">
				<div class="text-[11px] uppercase tracking-wide opacity-50">Output</div>
				<div class="text-lg font-semibold tabular-nums">{fmt(data.totals.outputTokens)}</div>
			</div>
			<div class="rounded-lg bg-white/5 p-3">
				<div class="text-[11px] uppercase tracking-wide opacity-50">Calls</div>
				<div class="text-lg font-semibold tabular-nums">{fmt(data.totals.events)}</div>
			</div>
		</div>

		<!-- Breakdown tables: by area, provider, model -->
		{#snippet breakdown(title: string, groups: Group[])}
			{#if groups.length}
				<div class="space-y-1.5">
					<div class="text-[11px] uppercase tracking-wide opacity-50">{title}</div>
					{#each groups as g}
						<div class="flex items-center gap-2 text-xs">
							<div class="w-28 shrink-0 truncate" title={g.key}>{g.key}</div>
							<div class="flex-1 h-3 rounded-full bg-white/5 overflow-hidden flex">
								<div class="h-full bg-sky-400/70" style="width: {(g.inputTokens / maxOf(groups)) * 100}%" title="input {fmt(g.inputTokens)}"></div>
								<div class="h-full bg-violet-400/70" style="width: {(g.outputTokens / maxOf(groups)) * 100}%" title="output {fmt(g.outputTokens)}"></div>
							</div>
							<div class="w-24 shrink-0 text-right tabular-nums opacity-70">{fmt(total(g))}</div>
						</div>
					{/each}
				</div>
			{/if}
		{/snippet}

		<div class="flex items-center gap-3 text-[11px] opacity-60">
			<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-sky-400/70"></span>input</span>
			<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-violet-400/70"></span>output</span>
		</div>

		{@render breakdown('By area', data.byArea)}
		{@render breakdown('By source', data.bySource)}
		{@render breakdown('By provider', data.byProvider)}
		{@render breakdown('By model', data.byModel)}

		<!-- Recent calls -->
		{#if data.recent.length}
			<div class="space-y-1.5">
				<div class="text-[11px] uppercase tracking-wide opacity-50">Recent calls</div>
				<div class="overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="opacity-50 text-left">
							<tr>
								<th class="font-normal py-1 pr-3">When</th>
								<th class="font-normal py-1 pr-3">Area</th>
								<th class="font-normal py-1 pr-3">Model</th>
								<th class="font-normal py-1 pr-3 text-right">In</th>
								<th class="font-normal py-1 text-right">Out</th>
							</tr>
						</thead>
						<tbody>
							{#each data.recent.slice(0, 20) as e}
								<tr class="border-t border-white/5">
									<td class="py-1 pr-3 whitespace-nowrap opacity-70">{new Date(e.at).toLocaleString()}</td>
									<td class="py-1 pr-3">{e.area}{#if e.isLocal}<span class="opacity-50"> · local</span>{/if}</td>
									<td class="py-1 pr-3 truncate max-w-[10rem]" title={e.model ?? ''}>{e.model ?? '—'}</td>
									<td class="py-1 pr-3 text-right tabular-nums">{fmt(e.inputTokens)}{#if e.estimated}<span class="opacity-40" title="estimated (provider reported no count)">*</span>{/if}</td>
									<td class="py-1 text-right tabular-nums">{fmt(e.outputTokens)}{#if e.estimated}<span class="opacity-40">*</span>{/if}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="text-[10px] opacity-40">* estimated (~4 chars/token) when the provider reported no token count.</p>
			</div>
		{/if}
	{:else}
		<p class="text-xs opacity-60">No model usage recorded yet. Once you chat or run enrichment, consumption shows up here.</p>
	{/if}
</section>
