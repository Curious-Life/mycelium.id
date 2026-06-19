<script lang="ts">
	// The movement cross-check, as a 2×2 — pure SVG, WKWebView-safe (no WebGL/canvas),
	// mirrors TimeSeries.svelte conventions. Two independent witnesses of "did you move
	// this week", both self-normalized baseline-z's:
	//   x = |F|  topic-map movement   (Fisher velocity — a clustering construct)
	//   y = |E|  semantic-center move  (global embedding centroid drift — basis-free)
	// The quadrant helper bands by MAGNITUDE (flat <flatZ, moved ≥movedZ), so we plot |z|
	// and split at the movedZ (2σ) threshold. The four cells ARE the four states:
	//   ┌────────────────────┬────────────────────┐
	//   │ meaning only        │ both moved          │   y≥2
	//   │ (hidden-drift)      │ (corroborated)      │
	//   ├────────────────────┼────────────────────┤
	//   │ settled             │ map only            │   y<2
	//   │                     │ (basis-suspect)     │
	//   └────────────────────┴────────────────────┘
	//      x<2                   x≥2
	// Honesty: renders nothing for `insufficient` (fail-closed — no directionless alarm).
	let {
		f = null,
		e = null,
		state = null,
		accent = 'var(--hairline, #8883)',
		movedZ = 2,
		flatZ = 1,
	}: {
		f?: number | null;
		e?: number | null;
		state?: string | null;
		accent?: string;
		movedZ?: number;
		flatZ?: number;
	} = $props();

	const VB = 200;
	const left = 34, right = 190, top = 12, bottom = 168; // square plot region
	const DMAX = 3; // clamp |z| domain to 3σ

	const geom = $derived.by(() => {
		if (!state || state === 'insufficient') return null;
		if (f == null || e == null || !Number.isFinite(Number(f)) || !Number.isFinite(Number(e))) return null;
		const w = right - left, h = bottom - top;
		const mag = (z: number) => Math.min(Math.abs(Number(z)), DMAX);
		const xOf = (m: number) => left + (m / DMAX) * w;
		const yOf = (m: number) => bottom - (m / DMAX) * h;
		const xMoved = xOf(movedZ), yMoved = yOf(movedZ);
		const xFlat = xOf(flatZ), yFlat = yOf(flatZ);
		const px = xOf(mag(f)), py = yOf(mag(e));

		// The cell to highlight for the current state (null = no shade, e.g. consistent).
		let cell: { x: number; y: number; w: number; h: number } | null = null;
		if (state === 'corroborated') cell = { x: xMoved, y: top, w: right - xMoved, h: yMoved - top };
		else if (state === 'basis_suspect') cell = { x: xMoved, y: yMoved, w: right - xMoved, h: bottom - yMoved };
		else if (state === 'hidden_drift') cell = { x: left, y: top, w: xMoved - left, h: yMoved - top };
		else if (state === 'settled') cell = { x: left, y: yMoved, w: xMoved - left, h: bottom - yMoved };

		return { px, py, xMoved, yMoved, xFlat, yFlat, cell };
	});
</script>

{#if geom}
	<div class="xc">
		<svg viewBox="0 0 {VB} {VB}" role="img" aria-label="movement cross-check quadrant">
			<!-- highlighted state cell -->
			{#if geom.cell}
				<rect x={geom.cell.x} y={geom.cell.y} width={geom.cell.w} height={geom.cell.h} fill={accent} fill-opacity="0.12" />
			{/if}
			<!-- plot frame -->
			<rect x={left} y={top} width={right - left} height={bottom - top} class="frame" />
			<!-- settled (flat) inner box -->
			<rect x={left} y={geom.yFlat} width={geom.xFlat - left} height={bottom - geom.yFlat} class="flatbox" />
			<!-- 2σ "moved" dividers -->
			<line x1={geom.xMoved} x2={geom.xMoved} y1={top} y2={bottom} class="moved" />
			<line x1={left} x2={right} y1={geom.yMoved} y2={geom.yMoved} class="moved" />
			<!-- corner labels (cell centres) -->
			<text x={(left + geom.xMoved) / 2} y={top + 13} class="cell">meaning only</text>
			<text x={(geom.xMoved + right) / 2} y={top + 13} class="cell">both moved</text>
			<text x={(left + geom.xMoved) / 2} y={bottom - 6} class="cell">settled</text>
			<text x={(geom.xMoved + right) / 2} y={bottom - 6} class="cell">map only</text>
			<!-- current week -->
			<circle cx={geom.px} cy={geom.py} r="9" fill={accent} fill-opacity="0.18" />
			<circle cx={geom.px} cy={geom.py} r="4.5" fill={accent} vector-effect="non-scaling-stroke" />
			<!-- axis captions -->
			<text x={(left + right) / 2} y={VB - 3} class="axis">topic-map movement (σ) →</text>
			<text x={11} y={(top + bottom) / 2} class="axis" transform="rotate(-90 11 {(top + bottom) / 2})">semantic-center (σ) →</text>
		</svg>
	</div>
{/if}

<style>
	.xc { width: 100%; max-width: 260px; }
	.xc svg { display: block; width: 100%; height: auto; }
	.frame { fill: none; stroke: var(--color-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
	.flatbox { fill: var(--color-text-tertiary); fill-opacity: 0.05; stroke: none; }
	.moved { stroke: var(--color-text-tertiary); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.55; vector-effect: non-scaling-stroke; }
	.cell { font-size: 7px; fill: var(--color-text-tertiary); text-anchor: middle; letter-spacing: 0.02em; }
	.axis { font-size: 7.5px; fill: var(--color-text-tertiary); text-anchor: middle; }
</style>
