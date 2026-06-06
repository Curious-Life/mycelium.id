<script lang="ts">
	// Apple-Health-style progress ring (pure SVG — no WebGL, WKWebView-safe).
	let {
		value = 0,
		max = 1,
		size = 72,
		stroke = 8,
		color = 'var(--color-accent-jade)',
		track = 'rgb(255 255 255 / 0.06)',
		center = '',
		sub = '',
	}: {
		value?: number; max?: number; size?: number; stroke?: number;
		color?: string; track?: string; center?: string; sub?: string;
	} = $props();

	const r = $derived((size - stroke) / 2);
	const circ = $derived(2 * Math.PI * r);
	const pct = $derived(Math.max(0, Math.min(1, max ? value / max : 0)));
	const dash = $derived(circ * pct);
</script>

<div class="ring-wrap" style="width:{size}px;height:{size}px;">
	<svg width={size} height={size} viewBox="0 0 {size} {size}">
		<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} stroke-width={stroke} />
		<circle
			cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color}
			stroke-width={stroke} stroke-linecap="round"
			stroke-dasharray="{dash} {circ}"
			transform="rotate(-90 {size / 2} {size / 2})"
			style="transition: stroke-dasharray 0.7s var(--ease-out);"
		/>
	</svg>
	{#if center}
		<div class="ring-center">
			<span class="rc-main">{center}</span>
			{#if sub}<span class="rc-sub">{sub}</span>{/if}
		</div>
	{/if}
</div>

<style>
	.ring-wrap { position: relative; display: inline-grid; place-items: center; }
	.ring-wrap svg { display: block; }
	.ring-center {
		position: absolute; inset: 0; display: grid; place-content: center;
		text-align: center; line-height: 1; gap: 2px;
	}
	.rc-main { font-size: 1.05rem; font-weight: 600; color: var(--color-text-emphasis); letter-spacing: -0.02em; }
	.rc-sub { font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-text-tertiary); }
</style>
