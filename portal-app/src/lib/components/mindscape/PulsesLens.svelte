<script lang="ts">
	/**
	 * Pulses lens — chip in the mindscape lens-bar + expanded control
	 * panel (Wave M4 of docs/MINDSCAPE-PULSES-PLAN.md).
	 *
	 * Surfaces:
	 *   - Play / pause + discrete speed slider (0.25× / 0.5× / 1× / 2× / 4×)
	 *   - Layer toggles: phase color, breathing, firing pulses, dormant
	 *   - Hovered-territory phase sparkline (color=phase, height=vitality)
	 *
	 * State lives in mindscapeState (see PulsesState in the store). This
	 * component is purely a reader/writer against that store + a small
	 * local concern for the sparkline fetch.
	 */
	import { mindscapeState } from '$lib/stores/mindscape';
	import { api } from '$lib/api';
	import { phaseColorAt, type PhaseSample } from '$lib/mindscape/phase-color';

	let { expanded = $bindable(false) }: { expanded?: boolean } = $props();

	const playing = $derived($mindscapeState.pulsesPlaying);
	const speed = $derived($mindscapeState.pulsesSpeed);
	const phaseColorOn = $derived($mindscapeState.phaseColorEnabled);
	const breathingOn = $derived($mindscapeState.breathingEnabled);
	const pulsesOn = $derived($mindscapeState.pulsesEnabled);
	const dormantOn = $derived($mindscapeState.dormantVisible);
	const hoveredTid = $derived($mindscapeState.hoveredTerritoryId);

	const SPEED_STEPS = [0.25, 0.5, 1, 2, 4];

	// Lazy-load phase history for the sparkline. Cached after first
	// fetch. The /portal/mindscape/phase-history endpoint returns all
	// territories in one shot; we just filter in-memory.
	let allHistories: Map<number, PhaseSample[]> | null = null;
	let historyLoading = false;

	async function ensureHistoryLoaded() {
		if (allHistories || historyLoading) return;
		historyLoading = true;
		try {
			const res = await api('/portal/mindscape/phase-history');
			if (res.ok) {
				const data = await res.json();
				const map = new Map<number, PhaseSample[]>();
				for (const t of (data.territories || [])) {
					if (Array.isArray(t.history) && t.history.length) {
						map.set(t.territory_id, t.history);
					}
				}
				allHistories = map;
			}
		} catch { /* silent */ }
		finally { historyLoading = false; }
	}

	// Fetch when the user first expands the panel (so the sparkline
	// can render for whatever they hover).
	$effect(() => {
		if (expanded) ensureHistoryLoaded();
	});

	const hoveredHistory = $derived.by(() => {
		if (!allHistories || hoveredTid == null) return null;
		return allHistories.get(hoveredTid) || null;
	});

	// Build an SVG sparkline for the hovered territory: color = phase at
	// each sample, height = vitality. Hard step-function transitions,
	// no interpolation — we hold each daily sample flat to the next.
	const sparklineSegments = $derived.by(() => {
		const hist = hoveredHistory;
		if (!hist || hist.length === 0) return null;
		const firstMs = Date.parse(hist[0].t);
		const lastMs = Date.parse(hist[hist.length - 1].t);
		const span = Math.max(1, lastMs - firstMs);
		const segs: Array<{ x1: number; x2: number; h: number; color: string }> = [];
		for (let i = 0; i < hist.length; i++) {
			const t1 = Date.parse(hist[i].t);
			const t2 = i + 1 < hist.length ? Date.parse(hist[i + 1].t) : lastMs + (span * 0.01);
			const x1 = ((t1 - firstMs) / span) * 100;
			const x2 = Math.max(x1 + 0.1, ((t2 - firstMs) / span) * 100);
			const pc = phaseColorAt(hist, t1);
			segs.push({ x1, x2, h: Math.max(0.1, pc.brightness), color: pc.hex });
		}
		return segs;
	});

	const sparklineRange = $derived.by(() => {
		const hist = hoveredHistory;
		if (!hist || hist.length === 0) return null;
		return {
			from: new Date(hist[0].t).toLocaleDateString('en-US', { year: '2-digit', month: 'short' }),
			to: new Date(hist[hist.length - 1].t).toLocaleDateString('en-US', { year: '2-digit', month: 'short' }),
			samples: hist.length,
		};
	});

	function toggle() { expanded = !expanded; }

	function selectSpeed(s: number) {
		mindscapeState.setPulsesSpeed(s);
	}
</script>

<!-- Chip (always visible in lens-bar) -->
<button
	class="lens-chip"
	class:lens-active={playing}
	onclick={toggle}
	aria-label="Pulses visualization controls"
	title={playing ? `Playing at ${speed}×` : 'Pulses & playback'}
>
	<span class="pulses-icon" class:playing>
		{#if playing}
			<!-- pause / active -->
			<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
		{:else}
			<!-- play -->
			<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
		{/if}
	</span>
	{#if playing}
		<span class="pulses-speed">{speed}×</span>
	{/if}
</button>

{#if expanded}
	<div class="lens-panel">
		<div class="lens-panel-header">
			<span class="lens-panel-title">Pulses</span>
			<button class="lens-dismiss" onclick={toggle} aria-label="Close">&times;</button>
		</div>

		<!-- Play / speed -->
		<div class="pulses-section">
			<div class="pulses-row">
				<button
					class="pulses-btn"
					class:pulses-btn-active={playing}
					onclick={() => mindscapeState.togglePulsesPlaying()}
				>
					{playing ? 'Pause' : 'Play'}
				</button>
				<div class="pulses-speed-row">
					{#each SPEED_STEPS as s}
						<button
							class="pulses-speed-btn"
							class:pulses-speed-active={speed === s}
							onclick={() => selectSpeed(s)}
							aria-label="Speed {s}×"
						>
							{s}×
						</button>
					{/each}
				</div>
			</div>
		</div>

		<!-- Layer toggles -->
		<div class="pulses-section pulses-toggles">
			<label class="pulses-toggle">
				<input type="checkbox" checked={phaseColorOn} onchange={() => mindscapeState.togglePhaseColor()} />
				<span>Phase color</span>
			</label>
			<label class="pulses-toggle">
				<input type="checkbox" checked={breathingOn} onchange={() => mindscapeState.toggleBreathing()} />
				<span>Breathing</span>
			</label>
			<label class="pulses-toggle">
				<input type="checkbox" checked={pulsesOn} onchange={() => mindscapeState.togglePulsesEnabled()} />
				<span>Firing pulses</span>
			</label>
			<label class="pulses-toggle">
				<input type="checkbox" checked={dormantOn} onchange={() => mindscapeState.toggleDormantVisible()} />
				<span>Show dormant territories</span>
			</label>
		</div>

		<!-- Sparkline for hovered territory -->
		<div class="pulses-section pulses-sparkline-wrap">
			<div class="pulses-sparkline-head">
				<span class="pulses-section-title">Phase history</span>
				{#if hoveredTid != null}
					<span class="pulses-sparkline-sub">Hovered — {$mindscapeState.territories[hoveredTid]?.name || `Territory ${hoveredTid}`}</span>
				{:else}
					<span class="pulses-sparkline-sub">hover a territory in 3D</span>
				{/if}
			</div>
			{#if sparklineSegments && sparklineRange}
				<svg class="pulses-sparkline-svg" viewBox="0 0 100 20" preserveAspectRatio="none">
					{#each sparklineSegments as seg}
						<rect
							x={seg.x1}
							y={20 - seg.h * 18}
							width={Math.max(0.2, seg.x2 - seg.x1)}
							height={seg.h * 18}
							fill={seg.color}
							opacity="0.85"
						/>
					{/each}
				</svg>
				<div class="pulses-sparkline-axis">
					<span>{sparklineRange.from}</span>
					<span>{sparklineRange.samples} samples</span>
					<span>{sparklineRange.to}</span>
				</div>
			{:else if hoveredTid != null}
				<p class="pulses-sparkline-empty">No phase history for this territory.</p>
			{:else}
				<div class="pulses-sparkline-placeholder"></div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.pulses-icon { display: inline-flex; align-items: center; justify-content: center; }
	.pulses-icon.playing { color: var(--color-accent); }
	.pulses-speed {
		font-size: 10px; font-variant-numeric: tabular-nums;
		color: var(--color-accent); font-weight: 600;
	}

	.pulses-section { margin-bottom: 14px; }
	.pulses-section:last-child { margin-bottom: 0; }
	.pulses-section-title {
		font-size: 10px; font-weight: 500; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--color-text-tertiary);
	}

	.pulses-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

	.pulses-btn {
		padding: 5px 14px; font-size: 12px; font-weight: 500;
		background: var(--color-elevated); color: var(--color-text-primary);
		border: 1px solid var(--color-border); border-radius: 6px;
		cursor: pointer; transition: all 150ms;
	}
	.pulses-btn:hover { border-color: var(--color-accent); }
	.pulses-btn-active {
		background: var(--color-accent); color: var(--color-bg);
		border-color: var(--color-accent);
	}

	.pulses-speed-row { display: flex; gap: 2px; flex: 1; justify-content: flex-end; }
	.pulses-speed-btn {
		padding: 4px 7px; font-size: 10px; font-variant-numeric: tabular-nums;
		background: transparent; color: var(--color-text-tertiary);
		border: 1px solid var(--color-border); border-radius: 4px;
		cursor: pointer; transition: all 120ms;
	}
	.pulses-speed-btn:hover { color: var(--color-text-primary); border-color: var(--color-accent); }
	.pulses-speed-active {
		background: var(--color-accent); color: var(--color-bg) !important;
		border-color: var(--color-accent);
	}

	.pulses-toggles { display: flex; flex-direction: column; gap: 6px; }
	.pulses-toggle {
		display: flex; align-items: center; gap: 8px;
		font-size: 12px; color: var(--color-text-primary); cursor: pointer;
	}
	.pulses-toggle input[type='checkbox'] { accent-color: var(--color-accent); cursor: pointer; }

	.pulses-sparkline-wrap { border-top: 1px solid var(--color-border); padding-top: 12px; }
	.pulses-sparkline-head {
		display: flex; justify-content: space-between; align-items: baseline;
		margin-bottom: 6px;
	}
	.pulses-sparkline-sub {
		font-size: 10px; color: var(--color-text-tertiary);
		max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.pulses-sparkline-svg {
		width: 100%; height: 32px; display: block;
		background: var(--color-bg); border-radius: 4px;
	}
	.pulses-sparkline-axis {
		display: flex; justify-content: space-between; font-size: 9px;
		color: var(--color-text-tertiary); margin-top: 3px; font-variant-numeric: tabular-nums;
	}
	.pulses-sparkline-empty {
		font-size: 11px; color: var(--color-text-tertiary); font-style: italic;
		text-align: center; padding: 8px 0;
	}
	.pulses-sparkline-placeholder { height: 32px; }
</style>
