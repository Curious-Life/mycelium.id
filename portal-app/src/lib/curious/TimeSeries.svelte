<script lang="ts">
	// Temporal line chart — pure SVG, WKWebView-safe (no WebGL/canvas). Plots a
	// series over time with min/max y-labels, first/last x-labels, a soft area
	// fill, gridlines, and a dot on the latest real value. Nulls break the line
	// (honest gaps where a window had no data) rather than interpolating across.
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

		// Area path: only under the longest contiguous run (keep it honest + simple
		// — fill from the line down to the baseline across all drawn segments).
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
		// gridlines at 0/50/100% of range
		const grid = [0, 0.5, 1].map((f) => padT + f * innerH);
		const baseline = lo <= 0 && hi >= 0 ? y(0) : null;
		return { d: d.trim(), areaD: areaD.trim(), last, lo, hi, grid, baseline, innerH };
	});

	const xFirst = $derived(labels[0] ?? '');
	const xLast = $derived(labels[labels.length - 1] ?? '');
</script>

{#if geom}
	<div class="ts">
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
		</svg>
		<div class="y-labels" style="height:{height}px">
			<span>{format(geom.hi)}{unit}</span>
			<span>{format(geom.lo)}{unit}</span>
		</div>
		{#if xFirst || xLast}
			<div class="x-labels"><span>{xFirst}</span><span>{xLast}</span></div>
		{/if}
	</div>
{:else}
	<div class="ts-empty">Not enough history yet to chart over time.</div>
{/if}

<style>
	.ts { position: relative; width: 100%; }
	.ts svg { display: block; width: 100%; height: auto; }
	.grid { stroke: var(--color-border); stroke-width: 1; stroke-dasharray: 2 4; opacity: 0.5; vector-effect: non-scaling-stroke; }
	.zero { stroke: var(--color-text-tertiary); stroke-width: 1; opacity: 0.4; vector-effect: non-scaling-stroke; }
	.y-labels { position: absolute; top: 0; left: 2px; display: flex; flex-direction: column; justify-content: space-between; padding: 2px 0 20px; pointer-events: none; }
	.y-labels span { font-size: 0.62rem; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); letter-spacing: -0.01em; }
	.x-labels { display: flex; justify-content: space-between; margin-top: -14px; padding: 0 2px; }
	.x-labels span { font-size: 0.62rem; color: var(--color-text-tertiary); }
	.ts-empty { font-size: 0.78rem; color: var(--color-text-tertiary); padding: 1.5rem 0; text-align: center; }
</style>
