<script lang="ts">
	// Tiny sparkline (line + soft area fill). Pure SVG. Renders nothing for <2 pts.
	let {
		points = [],
		width = 132,
		height = 40,
		color = 'var(--color-accent)',
		fill = true,
		pad = 3,
	}: {
		points?: number[]; width?: number; height?: number;
		color?: string; fill?: boolean; pad?: number;
	} = $props();

	const geom = $derived.by(() => {
		const xs = points.filter((p) => Number.isFinite(p));
		if (xs.length < 2) return null;
		const min = Math.min(...xs);
		const max = Math.max(...xs);
		const span = max - min || 1;
		const innerW = width - pad * 2;
		const innerH = height - pad * 2;
		const pts = xs.map((v, i) => {
			const x = pad + (i / (xs.length - 1)) * innerW;
			const y = pad + (1 - (v - min) / span) * innerH;
			return [x, y] as [number, number];
		});
		const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
		const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
		return { line, area, last: pts[pts.length - 1] };
	});

	const uid = `sg${Math.floor(Math.random() * 1e6)}`;
</script>

{#if geom}
	<svg {width} {height} viewBox="0 0 {width} {height}" class="spark" preserveAspectRatio="none">
		<defs>
			<linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
				<stop offset="0%" stop-color={color} stop-opacity="0.28" />
				<stop offset="100%" stop-color={color} stop-opacity="0" />
			</linearGradient>
		</defs>
		{#if fill}<path d={geom.area} fill="url(#{uid})" stroke="none" />{/if}
		<path d={geom.line} fill="none" stroke={color} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
		<circle cx={geom.last[0]} cy={geom.last[1]} r="2.4" fill={color} />
	</svg>
{:else}
	<div class="spark-empty" style="width:{width}px;height:{height}px;"></div>
{/if}

<style>
	.spark { display: block; overflow: visible; }
	.spark-empty {
		display: grid; place-items: center;
		border-bottom: 1px dashed var(--color-border);
		opacity: 0.5;
	}
</style>
