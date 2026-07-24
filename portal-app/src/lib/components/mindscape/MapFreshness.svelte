<script lang="ts">
	// MapFreshness — "how much of your vault is actually on this map", plus the REBUILD control.
	//
	// Defect D-004 ↻1, all three reported symptoms land here:
	//   1. "i have 2510 points byt the mycelium and map that is shown in mycelium page only has
	//      369 points"  → the two counts are now rendered side by side, always, as a served fact
	//      (GET /portal/mycelium/map-status). Not a note in a skip response; not inferable only by
	//      trying to start a job.
	//   2. "it shows me a text saying map already built; pass ?force=1 to rebuild. this i cant do
	//      from the UI as a user"  → the "Rebuild map" button. It calls generate.rebuild(), which
	//      is start({force:true}) — the same lifecycle as any other run, so it carries real
	//      progress, ETA, stall detection and cancel rather than being a fire-and-forget.
	//   3. "the cluster names dont show, they say territory 2"  → downstream: pipeline/
	//      describe-clusters.js (the only writer of realms.name / territory_profiles.name) runs as
	//      Generate step 3/16, the step the old unconditional skip never reached. A rebuild names
	//      them. The copy says so, because a user watching a several-minute rebuild deserves to
	//      know what it buys.
	//
	// HONESTY RULES (the D-013 taxonomy, applied):
	//   · `unknown` renders as "couldn't check", NEVER as zeros — a failed COUNT must not
	//     impersonate an empty map and invite a pointless rebuild.
	//   · The button is present whether or not the map is stale; staleness only changes the
	//     EMPHASIS and the copy. Hiding a remedy behind a condition the user cannot verify is
	//     how "?force=1" became unreachable in the first place.
	//   · While a run is in flight the button becomes progress. It never sits clickable next to a
	//     spinner claiming nothing is happening.
	import { onMount } from 'svelte';
	import { generate, loadMapStatus, rebuild, fmtSeconds } from '$lib/generate';

	const m = $derived($generate.map);
	const running = $derived(
		$generate.phase === 'starting' || $generate.phase === 'running' || $generate.phase === 'embedding',
	);
	const pct = $derived(
		$generate.totalSteps > 0 ? Math.min(100, Math.round((100 * $generate.step) / $generate.totalSteps)) : 0,
	);
	const n = (v: number) => v.toLocaleString();

	onMount(() => { void loadMapStatus(); });
</script>

{#if m}
	<div class="mapfresh" class:stale={!m.unknown && m.stale}>
		{#if m.unknown}
			<!-- A counting failure is "I could not look", never "your map is empty" (§3.2a). -->
			<p class="mf-fact">Couldn’t check how much of your vault is on the map.</p>
		{:else}
			<p class="mf-fact">
				<strong>{n(m.embedded)}</strong> {m.embedded === 1 ? 'conversation' : 'conversations'} ready ·
				<strong>{n(m.mapped)}</strong> on the map
			</p>
			{#if m.stale}
				<p class="mf-note">
					{n(m.drift)} {m.drift === 1 ? 'conversation is' : 'conversations are'} not on the map yet.
					Rebuilding re-places every point and names the areas that still show a placeholder.
				</p>
			{:else if m.built}
				<p class="mf-note">Your map is up to date.</p>
			{/if}
		{/if}

		{#if running}
			<div class="mf-bar" role="progressbar" aria-label="Rebuilding your map"
				aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
				<div class="mf-bar-fill" style="width: {pct}%"></div>
			</div>
			<p class="mf-note">
				{$generate.message || $generate.stageLabel || 'Rebuilding your map…'}
				{#if $generate.etaSeconds != null}&nbsp;· ~{fmtSeconds($generate.etaSeconds)} left{/if}
			</p>
		{:else}
			<button class="mf-btn" class:primary={!m.unknown && m.stale} onclick={() => rebuild()}>
				{m.unknown || !m.built ? 'Build map' : m.stale ? 'Rebuild map' : 'Rebuild map anyway'}
			</button>
			<p class="mf-meta">Takes a few minutes. Your map keeps working until it finishes.</p>
		{/if}
	</div>
{/if}

<style>
	.mapfresh {
		margin: 0.75rem 0 0;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
		border-radius: 10px;
		background: var(--surface-2, rgba(128, 128, 128, 0.06));
	}
	.mapfresh.stale { border-color: color-mix(in srgb, var(--accent, #b98b3c) 55%, transparent); }
	.mf-fact { margin: 0; font-size: 0.85rem; }
	.mf-note { margin: 0.3rem 0 0; font-size: 0.78rem; opacity: 0.75; line-height: 1.35; }
	.mf-meta { margin: 0.3rem 0 0; font-size: 0.72rem; opacity: 0.55; }
	.mf-bar {
		margin-top: 0.5rem; height: 4px; border-radius: 2px; overflow: hidden;
		background: var(--surface-3, rgba(128, 128, 128, 0.18));
	}
	.mf-bar-fill { height: 100%; background: var(--accent, #b98b3c); transition: width 0.4s ease; }
	.mf-btn {
		margin-top: 0.5rem; padding: 0.35rem 0.7rem; font: inherit; font-size: 0.8rem;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.35)); border-radius: 7px;
		background: transparent; color: inherit; cursor: pointer;
	}
	.mf-btn:hover { background: var(--surface-3, rgba(128, 128, 128, 0.12)); }
	.mf-btn.primary { border-color: var(--accent, #b98b3c); color: var(--accent, #b98b3c); }
</style>
