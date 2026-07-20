<script lang="ts">
	// R4-ACTIVITYBARS — the ONE activity-bars primitive used at every mindscape detail level
	// (realm · theme · territory). It carries timestamps (friendly axis labels + a per-bar time in
	// the hover tooltip) and an on-hover "time bar" tooltip, so every level reads the same and no
	// level is left as a bare sparkline with no time context. Presentational only: the optional
	// `onSelect`/`selectedMonth` let the territory-detail level keep its click-to-chronicle
	// behaviour without forking the markup.
	interface Item { month: string; count: number }
	interface Props {
		data: Item[];
		/** Month key (YYYY-MM) currently selected, if the host tracks a selection. */
		selectedMonth?: string | null;
		/** When provided, bars become clickable and call this on click. */
		onSelect?: (item: Item) => void;
		/** Section heading; pass '' to omit. */
		label?: string;
		/** How many trailing months to show. */
		maxBars?: number;
	}
	let { data, selectedMonth = null, onSelect, label = 'Activity', maxBars = 24 }: Props = $props();

	// "2024-07" → "Jul 2024". Falls back to the raw key for anything unparseable.
	function fmtMonth(month: string | undefined): string {
		if (!month) return '';
		const m = /^(\d{4})-(\d{2})/.exec(month);
		if (!m) return month;
		const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
		if (Number.isNaN(d.getTime())) return month;
		return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
	}

	const bars = $derived((data || []).slice(-maxBars));
	const maxCount = $derived(Math.max(1, ...bars.map((b) => b.count)));
	const firstMonth = $derived(bars.length ? fmtMonth(bars[0].month) : '');
	const lastMonth = $derived(bars.length ? fmtMonth(bars[bars.length - 1].month) : '');

	let hovered = $state<Item | null>(null);
	// Freeze the hover tooltip on the selected bar so it doesn't flicker while a period is open.
	const tip = $derived(hovered ?? (selectedMonth ? bars.find((b) => b.month === selectedMonth) ?? null : null));
</script>

{#if bars.length > 0}
	<div class="activity-graph">
		{#if label}<h4>{label}</h4>{/if}
		<div class="activity-bars-container">
			{#if tip}
				<div class="activity-tooltip">{fmtMonth(tip.month)} · {tip.count.toLocaleString()} {tip.count === 1 ? 'point' : 'points'}</div>
			{/if}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="activity-bars" onmouseleave={() => (hovered = null)}>
				{#each bars as item}
					<button
						class="activity-bar"
						class:selected={selectedMonth === item.month}
						class:static={!onSelect}
						type="button"
						style="height: {(item.count / maxCount) * 100}%"
						aria-label="{fmtMonth(item.month)}: {item.count} points"
						title="{fmtMonth(item.month)}: {item.count} points"
						onmouseenter={() => (hovered = item)}
						onclick={() => onSelect?.(item)}
					></button>
				{/each}
			</div>
		</div>
		<div class="activity-labels">
			<span>{firstMonth}</span>
			<span>{lastMonth}</span>
		</div>
	</div>
{/if}

<style>
	.activity-graph {
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border);
	}
	.activity-graph h4 {
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		margin: 0 0 6px;
	}
	.activity-bars-container {
		position: relative;
	}
	.activity-tooltip {
		position: absolute;
		top: -1.5rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 2px 6px;
		font-size: 0.65rem;
		font-weight: 500;
		color: var(--color-text-primary);
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		white-space: nowrap;
		pointer-events: none;
		z-index: 10;
	}
	.activity-bars {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 36px;
		background: var(--color-bg);
		border-radius: 4px;
		padding: 3px;
	}
	.activity-bar {
		flex: 1;
		min-height: 2px;
		background: var(--color-accent);
		border: none;
		padding: 0;
		border-radius: 1px;
		transition: opacity 0.2s, background 0.2s;
		cursor: pointer;
	}
	/* Non-interactive levels: the bar still hovers for the tooltip but isn't a clickable action. */
	.activity-bar.static {
		cursor: default;
	}
	.activity-bar:hover {
		opacity: 0.7;
	}
	.activity-bar.selected {
		background: var(--color-accent-aurum);
		opacity: 1;
		box-shadow: 0 0 4px rgba(229, 184, 76, 0.5);
	}
	.activity-labels {
		display: flex;
		justify-content: space-between;
		font-size: 0.6rem;
		color: var(--color-text-tertiary);
		margin-top: 3px;
	}
</style>
