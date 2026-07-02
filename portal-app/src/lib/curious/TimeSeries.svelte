<script lang="ts">
	// Temporal line chart — pure SVG, WKWebView-safe (no WebGL/canvas). Plots a
	// series over time with min/max y-labels, dated x-ticks, a soft area fill,
	// gridlines, and a dot on the latest real value. Nulls break the line (honest
	// gaps where a window had no data) rather than interpolating across.
	//
	// Hover-to-inspect: a vertical cursor snaps to the nearest real point and a
	// tooltip shows that point's value + date. The tooltip is EDGE-AWARE — it
	// flips to the left of the cursor near the right edge and clamps inside the
	// chart, so it never spills outside the app window.
	let {
		points = [],
		labels = [],
		color = 'var(--color-accent)',
		height = 160,
		area = true,
		yMin = undefined,
		yMax = undefined,
		unit = '',
		format = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)),
		valueLabel = '',
		rows = undefined,
	}: {
		points?: (number | null)[];
		labels?: string[];
		color?: string;
		height?: number;
		area?: boolean;
		yMin?: number;
		yMax?: number;
		unit?: string;
		format?: (v: number) => string;
		/** Optional noun shown in the tooltip after the value, e.g. "active". */
		valueLabel?: string;
		/** Optional per-point breakdown rows (already sorted, descending) shown under
		 *  the value in the hover tooltip — e.g. the named territories active that week. */
		rows?: { name: string; detail?: string }[][];
	} = $props();

	const W = 600;
	const padL = 4, padR = 8, padT = 10, padB = 18;

	const geom = $derived.by(() => {
		const n = points.length;
		const finite = points.filter((p): p is number => p != null && Number.isFinite(p));
		if (n < 2 || finite.length < 1) return null;
		const lo = yMin ?? Math.min(...finite);
		const hi = yMax ?? Math.max(...finite);
		const span = hi - lo || 1;
		const innerW = W - padL - padR;
		const innerH = height - padT - padB;
		const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
		const y = (v: number) => padT + (1 - (v - lo) / span) * innerH;

		// Build line path with gaps (null → break).
		let d = '', open = false;
		const pts: { i: number; v: number; x: number; y: number }[] = [];
		points.forEach((p, i) => {
			if (p == null || !Number.isFinite(p)) { open = false; return; }
			const px = x(i), py = y(p);
			d += `${open ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)} `;
			open = true;
			pts.push({ i, v: p, x: px, y: py });
		});

		// Area path: fill from the line down to the baseline across all drawn segments.
		let areaD = '';
		open = false;
		points.forEach((p, i) => {
			if (p == null || !Number.isFinite(p)) {
				if (open) { const prev = x(i - 1); areaD += `L${prev.toFixed(1)} ${(height - padB).toFixed(1)} Z `; open = false; }
				return;
			}
			const px = x(i), py = y(p);
			if (!open) { areaD += `M${px.toFixed(1)} ${(height - padB).toFixed(1)} L${px.toFixed(1)} ${py.toFixed(1)} `; open = true; }
			else areaD += `L${px.toFixed(1)} ${py.toFixed(1)} `;
		});
		if (open) { const last = pts[pts.length - 1]; areaD += `L${last.x.toFixed(1)} ${(height - padB).toFixed(1)} Z `; }

		const last = pts[pts.length - 1] ?? null;
		const grid = [0, 0.5, 1].map((f) => padT + f * innerH);
		const baseline = lo <= 0 && hi >= 0 ? y(0) : null;
		return { d: d.trim(), areaD: areaD.trim(), last, lo, hi, grid, baseline, innerH, x, y, pts, n };
	});

	// ── Dated x-axis ticks — up to ~5 evenly-spaced labels (not just first/last) ──
	const xTicks = $derived.by(() => {
		const g = geom; if (!g) return [];
		const n = g.n;
		const want = Math.min(5, n);
		const out: { i: number; xPct: number; label: string }[] = [];
		const seen = new Set<number>();
		for (let k = 0; k < want; k++) {
			const i = want === 1 ? 0 : Math.round((k / (want - 1)) * (n - 1));
			if (seen.has(i)) continue;
			seen.add(i);
			const label = (labels[i] ?? '').slice(0, 10);
			if (label) out.push({ i, xPct: (g.x(i) / W) * 100, label });
		}
		return out;
	});

	// ── Hover ─────────────────────────────────────────────────────────────────
	let hoverIdx = $state<number | null>(null);
	const hover = $derived.by(() => {
		const g = geom; if (!g || hoverIdx == null || !g.pts.length) return null;
		// snap to the nearest REAL point (skip nulls)
		let best = g.pts[0];
		for (const p of g.pts) if (Math.abs(p.i - hoverIdx) < Math.abs(best.i - hoverIdx)) best = p;
		return { ...best, label: (labels[best.i] ?? '').slice(0, 10), xPct: (best.x / W) * 100, yPct: (best.y / height) * 100 };
	});
	const flipLeft = $derived(hover != null && hover.xPct > 58);

	function onMove(e: PointerEvent) {
		const g = geom; if (!g) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
		hoverIdx = Math.round(frac * (g.n - 1));
	}
</script>

{#if geom}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ts" onpointermove={onMove} onpointerleave={() => (hoverIdx = null)}>
		<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" role="img" aria-label="time series">
			{#each geom.grid as gy}
				<line x1={padL} x2={W - padR} y1={gy} y2={gy} class="grid" />
			{/each}
			{#if geom.baseline != null}
				<line x1={padL} x2={W - padR} y1={geom.baseline} y2={geom.baseline} class="zero" />
			{/if}
			{#if area}<path d={geom.areaD} fill={color} fill-opacity="0.10" stroke="none" />{/if}
			<path d={geom.d} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
			{#if geom.last}<circle cx={geom.last.x} cy={geom.last.y} r="3.5" fill={color} vector-effect="non-scaling-stroke" />{/if}
			{#if hover}
				<line x1={hover.x} x2={hover.x} y1={padT} y2={height - padB} class="cursor" vector-effect="non-scaling-stroke" />
				<circle cx={hover.x} cy={hover.y} r="3.5" fill="var(--color-bg)" stroke={color} stroke-width="2" vector-effect="non-scaling-stroke" />
			{/if}
		</svg>
		<div class="y-labels" style="height:{height}px">
			<span>{format(geom.hi)}{unit}</span>
			<span>{format(geom.lo)}{unit}</span>
		</div>
		{#if xTicks.length}
			<div class="x-labels">
				{#each xTicks as t}<span class="xt" style="left:{t.xPct}%">{t.label}</span>{/each}
			</div>
		{/if}
		{#if hover}
			<div class="ts-tip" class:flip={flipLeft} style="left:{hover.xPct}%; top:{Math.max(2, hover.yPct)}%">
				<span class="tip-v" style="color:{color}">{format(hover.v)}{unit}{valueLabel ? ` ${valueLabel}` : ''}</span>
				{#if hover.label}<span class="tip-d">{hover.label}</span>{/if}
				{#if rows && rows[hover.i] && rows[hover.i].length}
					<div class="tip-rows">
						{#each rows[hover.i] as r}
							<div class="tip-brow"><span class="tip-rn">{r.name}</span>{#if r.detail}<span class="tip-rd">{r.detail}</span>{/if}</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<div class="ts-empty">Not enough history yet to chart over time.</div>
{/if}

<style>
	.ts { position: relative; width: 100%; padding-bottom: 16px; }
	.ts svg { display: block; width: 100%; height: auto; }
	.grid { stroke: var(--color-border); stroke-width: 1; stroke-dasharray: 2 4; opacity: 0.5; vector-effect: non-scaling-stroke; }
	.zero { stroke: var(--color-text-tertiary); stroke-width: 1; opacity: 0.4; vector-effect: non-scaling-stroke; }
	.cursor { stroke: var(--color-text-emphasis); stroke-opacity: 0.45; stroke-width: 1; }
	.y-labels { position: absolute; top: 0; left: 2px; display: flex; flex-direction: column; justify-content: space-between; padding: 2px 0 20px; pointer-events: none; }
	.y-labels span { font-size: 0.62rem; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); letter-spacing: -0.01em; }
	.x-labels { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; pointer-events: none; }
	.x-labels .xt { position: absolute; transform: translateX(-50%); font-size: 0.6rem; color: var(--color-text-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
	/* first/last ticks hug the edges so they don't clip */
	.x-labels .xt:first-child { transform: translateX(0); }
	.x-labels .xt:last-child { transform: translateX(-100%); }
	.ts-tip { position: absolute; transform: translate(10px, -50%); pointer-events: none; z-index: 3; display: flex; flex-direction: column; gap: 1px; background: var(--color-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 0.28rem 0.45rem; box-shadow: 0 6px 18px rgb(0 0 0 / 0.3); white-space: nowrap; }
	.ts-tip.flip { transform: translate(calc(-100% - 10px), -50%); }
	.tip-v { font-size: 0.78rem; font-weight: 600; font-variant-numeric: tabular-nums; }
	.tip-d { font-size: 0.6rem; color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
	.tip-rows { margin-top: 3px; display: flex; flex-direction: column; gap: 1px; max-width: 15rem; }
	.tip-brow { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; font-size: 0.62rem; }
	.tip-rn { color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tip-rd { color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; flex: none; }
	.ts-empty { font-size: 0.78rem; color: var(--color-text-tertiary); padding: 1.5rem 0; text-align: center; }
</style>
