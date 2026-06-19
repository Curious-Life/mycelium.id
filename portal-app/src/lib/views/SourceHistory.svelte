<script lang="ts">
	// The Streams history graph — ONE stacked-bar chart of every item that ever
	// flowed into the vault, one bar per day since the first item, each bar
	// segmented + coloured by its source. Replaces the per-source sparkline wall:
	// the whole history at a glance, with a clickable legend that filters the river.
	//
	// Backed by GET /portal/streams/history (PLAINTEXT-only aggregates — §7 fail-safe,
	// no decryption path). When the span is long we bucket adjacent days so the bar
	// count stays readable; a short history stays day-per-bar.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { sourcePresentation } from '$lib/streams/sources';

	interface History {
		start: string | null; end: string; days: string[];
		sources: { source: string; kind: string; total: number }[];
		series: Record<string, number[]>;
		clamped: boolean;
	}

	let { selected = null, onSelect = (_s: string | null) => {} }:
		{ selected?: string | null; onSelect?: (s: string | null) => void } = $props();

	let data = $state<History | null>(null);
	let loading = $state(true);
	let hovered = $state<number | null>(null);

	onMount(load);
	async function load() {
		loading = true;
		try {
			const res = await api('/portal/streams/history');
			data = await res.json();
		} catch { data = null; }
		loading = false;
	}

	const MAX_BARS = 120;       // adjacent days fold into one bar beyond this
	const CHART_W = 1000;       // SVG user-space width (stretched to container)
	const CHART_H = 200;        // SVG user-space height

	// Sources in stack order (largest total at the bottom).
	const sources = $derived(data?.sources ?? []);
	const grandTotal = $derived(sources.reduce((a, s) => a + s.total, 0));

	// Fold adjacent days into `groupSize`-day buckets when history is long.
	interface Bucket { label: string; total: number; counts: Record<string, number>; }
	const view = $derived.by(() => {
		const d = data;
		if (!d || !d.days.length) return { buckets: [] as Bucket[], groupSize: 1, max: 1 };
		const groupSize = Math.max(1, Math.ceil(d.days.length / MAX_BARS));
		const buckets: Bucket[] = [];
		for (let i = 0; i < d.days.length; i += groupSize) {
			const slice = d.days.slice(i, i + groupSize);
			const counts: Record<string, number> = {};
			let total = 0;
			for (const s of d.sources) {
				let c = 0;
				const arr = d.series[s.source] || [];
				for (let j = i; j < i + groupSize && j < arr.length; j++) c += arr[j] || 0;
				if (c > 0) counts[s.source] = c;
				total += c;
			}
			buckets.push({ label: rangeLabel(slice), total, counts });
		}
		const max = Math.max(1, ...buckets.map((b) => b.total));
		return { buckets, groupSize, max };
	});

	const slot = $derived(view.buckets.length ? CHART_W / view.buckets.length : CHART_W);
	const gap = $derived(slot < 6 ? 0 : Math.min(3, slot * 0.16));
	const barW = $derived(Math.max(0.6, slot - gap));

	// Stacked segments for one bucket: bottom-up, source order. Returns rects in
	// SVG user space (y grows downward; 0 = top).
	function segments(b: Bucket) {
		const out: { source: string; y: number; h: number; color: string }[] = [];
		let yBottom = CHART_H;
		for (const s of sources) {
			const c = b.counts[s.source] || 0;
			if (c <= 0) continue;
			const h = (c / view.max) * CHART_H;
			yBottom -= h;
			out.push({ source: s.source, y: yBottom, h, color: sourcePresentation(s.source).color });
		}
		return out;
	}

	function toggle(source: string) { onSelect(selected === source ? null : source); }

	// "Jun 3" / "Jun 3–9" / "Jun 28 – Jul 4" from YYYY-MM-DD day keys.
	function fmtDay(key: string, withYear = false): string {
		const [y, m, d] = key.split('-').map(Number);
		const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] || '';
		return withYear ? `${mon} ${d}, ${y}` : `${mon} ${d}`;
	}
	function rangeLabel(slice: string[]): string {
		if (!slice.length) return '';
		if (slice.length === 1) return fmtDay(slice[0]);
		const a = slice[0], b = slice[slice.length - 1];
		const sameMonth = a.slice(0, 7) === b.slice(0, 7);
		return sameMonth ? `${fmtDay(a)}–${b.split('-')[2].replace(/^0/, '')}` : `${fmtDay(a)} – ${fmtDay(b)}`;
	}
	// Whole numbers only — counts are integers; round + thousands-separate, no decimals.
	function fmt(n: number): string {
		return Math.round(n).toLocaleString();
	}

	// Hovered-bucket breakdown for the tooltip (sources desc by count).
	const tip = $derived.by(() => {
		if (hovered == null) return null;
		const b = view.buckets[hovered];
		if (!b) return null;
		const rows = Object.entries(b.counts)
			.map(([source, c]) => ({ source, c, ...sourcePresentation(source) }))
			.sort((a, z) => z.c - a.c);
		const leftPct = ((hovered + 0.5) / view.buckets.length) * 100;
		return { label: b.label, total: b.total, rows, leftPct };
	});
</script>

<section class="history" aria-label="Stream history by source">
	{#if loading}
		<div class="hint">Reading your streams…</div>
	{:else if !data || !view.buckets.length}
		<div class="hint">No streams yet — connect a source to see it flow in.</div>
	{:else}
		<div class="head-row">
			<div class="caption">
				<strong>{fmt(grandTotal)}</strong> items
				{#if data.start}· since {fmtDay(data.start, true)}{/if}
				{#if data.clamped}<span class="clamp" title="History is very long — earliest data is grouped.">· trimmed</span>{/if}
			</div>
			{#if selected}
				<button class="clear" onclick={() => onSelect(null)}>Showing {sourcePresentation(selected).title || selected} — clear filter ✕</button>
			{/if}
		</div>

		<div class="chart-wrap">
			<svg class="chart" viewBox="0 0 {CHART_W} {CHART_H}" preserveAspectRatio="none" role="img" aria-label="Daily volume by source">
				{#each view.buckets as b, i (i)}
					{#each segments(b) as seg (seg.source)}
						<rect
							x={i * slot + gap / 2} y={seg.y} width={barW} height={seg.h}
							fill={seg.color}
							opacity={selected && selected !== seg.source ? 0.12 : hovered != null && hovered !== i ? 0.5 : 0.9}
						/>
					{/each}
					<!-- full-height transparent hit target for reliable hover on thin bars -->
					<rect
						x={i * slot} y="0" width={slot} height={CHART_H} fill="transparent"
						role="presentation"
						onmouseenter={() => (hovered = i)}
						onmouseleave={() => (hovered = null)}
					/>
				{/each}
			</svg>

			{#if tip}
				<div class="tip" style="left: {tip.leftPct}%;">
					<div class="tip-head">{tip.label} · {fmt(tip.total)} items</div>
					{#each tip.rows.slice(0, 6) as r (r.source)}
						<div class="tip-row">
							<span class="sw" style="background: {r.color};"></span>
							<span class="tn">{r.title || r.source}</span>
							<span class="tc">{fmt(r.c)}</span>
						</div>
					{/each}
					{#if tip.rows.length > 6}<div class="tip-more">+{tip.rows.length - 6} more</div>{/if}
				</div>
			{/if}
		</div>

		<div class="axis">
			<span>{data.start ? fmtDay(data.start, true) : ''}</span>
			<span>Today</span>
		</div>

		<div class="legend">
			{#each sources as s (s.source)}
				{@const p = sourcePresentation(s.source)}
				<button
					class="leg"
					class:active={selected === s.source}
					class:dim={selected && selected !== s.source}
					style="--src: {p.color};"
					onclick={() => toggle(s.source)}
					title="{p.title || s.source} · {s.total} items — click to filter the river"
				>
					<span class="sw" style="background: {p.color};"></span>
					<span class="ln">{p.title || s.source}</span>
					<span class="lc">{fmt(s.total)}</span>
				</button>
			{/each}
		</div>
	{/if}
</section>

<style>
	.history { display: flex; flex-direction: column; gap: 10px; padding: 2px 0; }
	.hint { font-size: 0.8rem; color: var(--color-text-tertiary); padding: 12px 2px; }

	.head-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
	.caption { font-size: 0.78rem; color: var(--color-text-secondary); }
	.caption strong { color: var(--color-text-primary); font-weight: 600; }
	.clamp { color: var(--color-text-tertiary); }
	.clear {
		font-size: 0.72rem; color: var(--color-text-secondary); background: var(--color-surface);
		border: 0.5px solid var(--color-border); border-radius: 999px; padding: 3px 10px; cursor: pointer;
	}
	.clear:hover { color: var(--color-text-primary); background: var(--color-elevated); }

	.chart-wrap { position: relative; }
	.chart {
		display: block; width: 100%; height: 200px;
		border-bottom: 1px solid var(--color-border);
	}
	.chart rect { transition: opacity .12s ease; }

	.tip {
		position: absolute; top: 0; transform: translateX(-50%) translateY(-6px);
		min-width: 150px; max-width: 240px; pointer-events: none; z-index: 5;
		background: var(--color-elevated); border: 0.5px solid var(--color-border);
		border-radius: 8px; padding: 8px 10px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
	}
	.tip-head { font-size: 0.68rem; font-weight: 600; color: var(--color-text-primary); margin-bottom: 5px; white-space: nowrap; }
	.tip-row { display: flex; align-items: center; gap: 6px; font-size: 0.68rem; color: var(--color-text-secondary); }
	.tip-row .tn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tip-row .tc { color: var(--color-text-primary); font-variant-numeric: tabular-nums; }
	.tip-more { font-size: 0.64rem; color: var(--color-text-tertiary); margin-top: 3px; }

	.axis { display: flex; justify-content: space-between; font-size: 0.64rem; color: var(--color-text-tertiary); }

	.legend { display: flex; flex-wrap: wrap; gap: 6px; }
	.leg {
		display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px;
		border-radius: 999px; background: var(--color-surface); border: 0.5px solid var(--color-border);
		cursor: pointer; transition: border-color .15s, background .15s, opacity .15s;
		font-size: 0.72rem; color: var(--color-text-secondary);
	}
	.leg:hover { background: var(--color-elevated); color: var(--color-text-primary); }
	.leg.active { border-color: var(--src); background: color-mix(in srgb, var(--src) 10%, var(--color-surface)); color: var(--color-text-primary); }
	.leg.dim { opacity: 0.5; }
	.sw { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
	.ln { white-space: nowrap; }
	.lc { color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
</style>
