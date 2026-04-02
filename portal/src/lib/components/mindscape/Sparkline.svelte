<script lang="ts">
	interface Props {
		data: Array<{ month: string; count: number }>;
		width?: number;
		height?: number;
	}

	let { data = [], width = 80, height = 24 }: Props = $props();

	const bars = $derived(() => {
		if (!data || data.length === 0) return [];
		const max = Math.max(...data.map(d => d.count), 1);
		const barWidth = Math.max(2, (width - data.length + 1) / data.length);
		const gap = 1;

		return data.map((d, i) => {
			const barHeight = (d.count / max) * height;
			// Color: recent bars are brighter
			const recency = i / (data.length - 1 || 1);
			const isRecent = i >= data.length - 2;
			return {
				x: i * (barWidth + gap),
				y: height - barHeight,
				w: barWidth,
				h: Math.max(1, barHeight),
				count: d.count,
				month: d.month,
				opacity: 0.3 + recency * 0.7,
				isRecent,
			};
		});
	});

	// Trend: compare last 3 months avg vs previous 3
	const trend = $derived(() => {
		if (!data || data.length < 4) return 'neutral';
		const recent = data.slice(-3).reduce((s, d) => s + d.count, 0) / 3;
		const previous = data.slice(-6, -3).reduce((s, d) => s + d.count, 0) / Math.min(3, data.slice(-6, -3).length || 1);
		if (recent > previous * 1.3) return 'rising';
		if (recent < previous * 0.7) return 'declining';
		return 'neutral';
	});
</script>

{#if bars().length > 0}
	<svg
		width={width}
		height={height}
		class="sparkline"
		class:rising={trend() === 'rising'}
		class:declining={trend() === 'declining'}
		role="img"
		aria-label="Activity sparkline"
	>
		{#each bars() as bar}
			<rect
				x={bar.x}
				y={bar.y}
				width={bar.w}
				height={bar.h}
				rx="1"
				class="bar"
				class:recent={bar.isRecent}
				style="opacity: {bar.opacity}"
			>
				<title>{bar.month}: {bar.count}</title>
			</rect>
		{/each}
	</svg>
{/if}

<style>
	.sparkline {
		display: inline-block;
		vertical-align: middle;
	}
	.bar {
		fill: var(--color-muted);
		transition: fill 0.15s;
	}
	.rising .bar {
		fill: var(--color-accent);
	}
	.rising .bar.recent {
		fill: var(--color-accent);
	}
	.declining .bar {
		fill: var(--color-muted);
	}
	.declining .bar.recent {
		fill: var(--color-muted);
		opacity: 0.5 !important;
	}
	.bar.recent {
		fill: var(--color-text);
	}
</style>
