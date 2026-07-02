<script lang="ts">
	// Week × top-3 territories — the checkable drill-floor of the page: each week's
	// message volume, split by that week's top-3 territories (+ "other"). Bars are
	// colored by RANK (the top-3 differ week to week); hover reveals the actual
	// names + counts. Shares a page-level hovered week (`hoverDate`, bindable) with
	// the river above it, so one cursor lights up every graph at once.
	// Hand-rolled SVG (WKWebView-safe).
	type Any = Record<string, any>;
	let { data = null, hoverDate = $bindable<string | null>(null) }: { data: Any | null; hoverDate?: string | null } = $props();

	const RANK = ['var(--color-accent-aurum)', 'var(--color-accent)', 'var(--color-accent-amethyst)'];
	const W = 1000, H = 210, ML = 6, MR = 6, MT = 8, MB = 22;
	const PW = W - ML - MR, PH = H - MT - MB;

	const weeks = $derived<Any[]>(data?.weekly_top ?? []);
	const n = $derived(weeks.length);
	const x = (i: number) => (n <= 1 ? ML : ML + (i / (n - 1)) * PW);
	const barW = $derived(n > 1 ? Math.max(1, (PW / n) * 0.8) : 6);
	const maxTotal = $derived(Math.max(1, ...weeks.map((w) => Number(w.total) || 0)));
	const y = (v: number) => MT + PH * (1 - v / maxTotal);

	const dateIndex = $derived.by(() => {
		const m: Record<string, number> = {};
		weeks.forEach((w, i) => { m[w.end] = i; });
		return m;
	});
	const hoverIdx = $derived(hoverDate != null && dateIndex[hoverDate] != null ? dateIndex[hoverDate] : null);
	const hoverWeek = $derived(hoverIdx != null ? weeks[hoverIdx] : null);

	function onMove(e: PointerEvent) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
		hoverDate = weeks[Math.round(frac * (n - 1))]?.end ?? null;
	}

	// One week's stacked segments (bottom→top): top-3 by rank, then "other".
	function segs(w: Any): { yTop: number; h: number; fill: string; op: number }[] {
		const out: { yTop: number; h: number; fill: string; op: number }[] = [];
		let cum = 0;
		(w.top ?? []).forEach((t: Any, r: number) => {
			const c = Number(t.count) || 0; if (c <= 0) return;
			out.push({ yTop: y(cum + c), h: (y(cum) - y(cum + c)), fill: RANK[r % 3], op: 0.85 });
			cum += c;
		});
		const other = Number(w.other) || 0;
		if (other > 0) out.push({ yTop: y(cum + other), h: (y(cum) - y(cum + other)), fill: 'var(--color-text-tertiary)', op: 0.22 });
		return out;
	}

	const ticks = $derived.by(() => {
		const out: { i: number; label: string }[] = []; let last = '';
		weeks.forEach((w, i) => { const yr = String(w.end || '').slice(0, 4); if (yr && yr !== last) { out.push({ i, label: yr }); last = yr; } });
		return out;
	});
	const hasData = $derived(n > 1);
</script>

{#if hasData}
	<div class="wtt">
		<div class="wtt-legend">
			<span><i style="background:{RANK[0]}"></i>#1</span>
			<span><i style="background:{RANK[1]}"></i>#2</span>
			<span><i style="background:{RANK[2]}"></i>#3</span>
			<span><i style="background:var(--color-text-tertiary);opacity:0.4"></i>other</span>
			<span class="wtt-note">bars = messages/week · colored by rank · hover for the topics</span>
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="plot" onpointermove={onMove} onpointerleave={() => (hoverDate = null)}>
			<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Weekly message volume split by the top three territories">
				{#each weeks as w, i}
					{#each segs(w) as s}
						<rect x={(x(i) - barW / 2).toFixed(1)} y={s.yTop.toFixed(1)} width={barW.toFixed(1)} height={Math.max(0, s.h).toFixed(1)} fill={s.fill} fill-opacity={s.op} />
					{/each}
				{/each}
				{#if hoverIdx != null}
					<line x1={x(hoverIdx)} y1={MT} x2={x(hoverIdx)} y2={MT + PH} stroke="var(--color-text-emphasis)" stroke-width="1" stroke-opacity="0.5" />
				{/if}
				{#each ticks as t}
					<line x1={x(t.i)} y1={H - MB} x2={x(t.i)} y2={H - MB + 4} stroke="var(--color-border)" stroke-width="1" />
					<text x={x(t.i)} y={H - MB + 14} class="xt">{t.label}</text>
				{/each}
			</svg>
			{#if hoverWeek}
				{@const frac = hoverIdx! / Math.max(1, n - 1)}
				<div class="tip" class:flip={frac > 0.6} style="left:{(frac * 100).toFixed(1)}%;">
					<div class="tip-h">{hoverWeek.end} · {hoverWeek.total} message{hoverWeek.total === 1 ? '' : 's'}</div>
					{#each (hoverWeek.top ?? []) as t, r}
						<div class="tip-row"><i style="background:{RANK[r % 3]}"></i><span class="tip-n">{t.name}{#if !t.named}<em> (unnamed)</em>{/if}</span><span class="tip-v">{t.count}</span></div>
					{/each}
					{#if !(hoverWeek.top ?? []).length}<div class="tip-row muted">no territory activity</div>{/if}
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="wtt-empty"><p class="muted">Your week-by-week topic volume forms once a few weeks of activity are mapped.</p></div>
{/if}

<style>
	.wtt { display: flex; flex-direction: column; gap: 0.5rem; }
	.plot { position: relative; }
	.plot svg { width: 100%; height: auto; display: block; }
	.wtt-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.9rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.wtt-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
	.wtt-legend i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
	.wtt-note { color: var(--color-text-tertiary); }
	.xt { fill: var(--color-text-tertiary); font-size: 9px; text-anchor: middle; }
	.tip { position: absolute; top: 0; transform: translateX(12px); pointer-events: none; background: var(--color-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.5rem 0.6rem; font-size: 0.72rem; min-width: 11rem; max-width: 16rem; box-shadow: 0 8px 24px rgb(0 0 0 / 0.35); z-index: 2; }
	/* Edge-aware: flip to the left of the cursor near the right edge so it never
	   overflows the chart / app window. */
	.tip.flip { transform: translateX(calc(-100% - 12px)); }
	.tip-h { color: var(--color-text-emphasis); font-weight: 600; margin-bottom: 0.35rem; }
	.tip-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.1rem 0; }
	.tip-row i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
	.tip-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
	.tip-n em { color: var(--color-text-tertiary); font-style: normal; }
	.tip-v { color: var(--color-text-emphasis); font-variant-numeric: tabular-nums; }
	.tip-row.muted { color: var(--color-text-tertiary); }
	.wtt-empty { padding: 1.2rem; border: 1px dashed var(--color-border); border-radius: var(--radius-md); text-align: center; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; line-height: 1.5; }
</style>
