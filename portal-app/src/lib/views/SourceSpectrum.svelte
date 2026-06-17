<script lang="ts">
	// The Streams "source spectrum" — at a glance: every source flowing into the
	// vault, its health, and a daily-volume sparkline. Legend + health + filter in
	// one. Backed by GET /portal/streams/spectrum (plaintext-only aggregates).
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import {
		sourcePresentation, statusColor, relativeTime,
		KIND_ORDER, KIND_LABEL, type StreamKind,
	} from '$lib/streams/sources';

	interface SpectrumSource {
		source: string; kind: StreamKind; total: number; today: number;
		lastActivity: string | null; status: string; sparkline: number[];
		connector: unknown | null;
	}

	let { selected = null, onSelect = (_s: string | null) => {} }:
		{ selected?: string | null; onSelect?: (s: string | null) => void } = $props();

	let sources = $state<SpectrumSource[]>([]);
	let loading = $state(true);

	onMount(load);
	async function load() {
		loading = true;
		try {
			const res = await api('/portal/streams/spectrum?windowDays=7');
			const data = await res.json();
			sources = Array.isArray(data.sources) ? data.sources : [];
		} catch { sources = []; }
		loading = false;
	}

	// Group by kind in display order; drop empty groups.
	const groups = $derived(
		KIND_ORDER
			.map((kind) => ({ kind, items: sources.filter((s) => s.kind === kind) }))
			.filter((g) => g.items.length > 0),
	);

	function toggle(source: string) {
		onSelect(selected === source ? null : source);
	}
	// Sparkline bar heights (0..1), guarding the all-zero case.
	function bars(spark: number[]): number[] {
		const max = Math.max(1, ...spark);
		return spark.map((c) => c / max);
	}
</script>

<section class="spectrum" aria-label="Source spectrum">
	{#if loading}
		<div class="hint">Reading your streams…</div>
	{:else if sources.length === 0}
		<div class="hint">No streams yet — connect a source to see it flow in.</div>
	{:else}
		{#each groups as group (group.kind)}
			<div class="group">
				<div class="group-label">{KIND_LABEL[group.kind]}</div>
				<div class="chips">
					{#each group.items as s (s.source)}
						{@const p = sourcePresentation(s.source)}
						<button
							class="chip"
							class:active={selected === s.source}
							style="--src: {p.color};"
							onclick={() => toggle(s.source)}
							title="{p.title} · {s.status} · {relativeTime(s.lastActivity)}"
						>
							<span class="head">
								<span class="mono" style="background: color-mix(in srgb, {p.color} 16%, transparent); color: {p.color};">{p.mono}</span>
								<span class="name">{p.title || s.source}</span>
								<span class="dot" style="background: {statusColor(s.status)};" aria-hidden="true"></span>
							</span>
							<span class="spark" aria-hidden="true">
								{#each bars(s.sparkline) as h, i (i)}
									<span class="bar" style="height: {Math.max(8, Math.round(h * 100))}%; background: {h > 0 ? p.color : 'var(--color-border)'};"></span>
								{/each}
							</span>
							<span class="meta">
								{#if s.status === 'error'}
									<span style="color: var(--color-accent-coral);">needs reconnect</span>
								{:else}
									{s.status} · {relativeTime(s.lastActivity)}{#if s.today > 0} · {s.today} today{/if}
								{/if}
							</span>
						</button>
					{/each}
				</div>
			</div>
		{/each}
	{/if}
</section>

<style>
	.spectrum { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 2px; }
	.hint { font-size: 0.8rem; color: var(--color-text-tertiary); padding: 12px 2px; }
	.group { display: flex; flex-direction: column; gap: 7px; }
	.group-label {
		font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
		color: var(--color-text-tertiary);
	}
	.chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
	.chip {
		display: flex; flex-direction: column; gap: 6px;
		text-align: left; padding: 9px 10px; border-radius: 10px;
		background: var(--color-surface); border: 0.5px solid var(--color-border);
		cursor: pointer; transition: border-color .15s, background .15s; min-width: 0;
	}
	.chip:hover { background: var(--color-elevated); }
	.chip.active { border-color: var(--src); background: color-mix(in srgb, var(--src) 8%, var(--color-surface)); }
	.head { display: flex; align-items: center; gap: 7px; min-width: 0; }
	.mono {
		flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.6rem; font-weight: 600; letter-spacing: 0.02em;
	}
	.name {
		flex: 1; min-width: 0; font-size: 0.8rem; font-weight: 500;
		color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; }
	.spark { display: flex; align-items: flex-end; gap: 2px; height: 16px; }
	.bar { flex: 1; min-width: 2px; border-radius: 1px; opacity: 0.85; }
	.meta { font-size: 0.62rem; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
