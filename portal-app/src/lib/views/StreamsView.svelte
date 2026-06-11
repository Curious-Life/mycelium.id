<script lang="ts">
	// Streams — the merged data surface (NAV-IA-LOCK-2026-06-08). Two facets behind
	// one tab:
	//   • Stream  — the live incoming feed (TimelineView: telegram/discord/whatsapp/portal)
	//   • Sources — manage inputs/connectors + run imports (ImportView)
	// The workspace passes `facet` in tab params (mirrored to /streams?facet=…); the
	// segmented control switches between them. Facets lazy-mount on first visit, then
	// stay alive (display-toggled) so switching never refetches.
	import TimelineView from './TimelineView.svelte';
	import ImportView from './ImportView.svelte';

	let { facet = 'stream', setParams }: {
		facet?: 'stream' | 'sources';
		setParams?: (patch: Record<string, unknown>) => void;
	} = $props();

	// The tab param is the single source of truth (mirrored to /streams?facet=…), so
	// the active facet is derived — a click just writes the param back via setParams.
	const current = $derived(facet === 'sources' ? 'sources' : 'stream');

	// Lazy-mount + keep-alive: a facet mounts on first visit, then stays mounted
	// (display-toggled) so switching never refetches.
	let visited = $state<Record<string, boolean>>({});
	$effect(() => { if (!visited[current]) visited = { ...visited, [current]: true }; });

	function select(f: 'stream' | 'sources') {
		previewArea = null;
		setParams?.({ facet: f });
	}

	const facets = [
		{ id: 'stream', label: 'Stream' },
		{ id: 'sources', label: 'Sources' },
	] as const;

	// Planned life-domain streams — moved out of the left-nav "Coming later" list
	// (2026-06-11) into the surface they belong to. Disabled chips with a "soon"
	// badge keep the roadmap visible without dead routes; selecting one shows the
	// placeholder panel rather than a working view.
	const comingSoon = ['Wealth', 'Intel', 'Body', 'Vitality', 'Activity'] as const;
	let previewArea = $state<string | null>(null);
</script>

<div class="streams">
	<div class="seg" role="tablist" aria-label="Streams view">
		{#each facets as f}
			<button
				class="seg-btn"
				class:active={!previewArea && current === f.id}
				role="tab"
				aria-selected={!previewArea && current === f.id}
				onclick={() => select(f.id)}
			>{f.label}</button>
		{/each}

		<span class="soon-sep" aria-hidden="true"></span>
		<span class="soon-label">Coming later</span>
		{#each comingSoon as area}
			<button
				class="seg-btn soon"
				class:active={previewArea === area}
				onclick={() => (previewArea = previewArea === area ? null : area)}
			>
				{area}<span class="soon-pill">soon</span>
			</button>
		{/each}
	</div>

	<div class="facet-body">
		{#if previewArea}
			<div class="facet soon-panel">
				<div class="soon-card">
					<div class="soon-card-title">{previewArea}</div>
					<p class="soon-card-body">
						{previewArea} is a planned stream — your {previewArea.toLowerCase()} data will flow in here.
						It isn't available yet.
					</p>
					<span class="soon-pill">coming later</span>
				</div>
			</div>
		{:else}
			{#if visited.stream}
				<div class="facet" class:hidden={current !== 'stream'}><TimelineView /></div>
			{/if}
			{#if visited.sources}
				<div class="facet" class:hidden={current !== 'sources'}><ImportView /></div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.streams { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
	.seg {
		display: flex; align-items: center; gap: 4px; padding: 8px 12px; flex-shrink: 0; flex-wrap: wrap;
		border-bottom: 1px solid var(--color-border); background: var(--color-surface);
	}
	.seg-btn {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 5px 14px; font-size: 0.8rem; font-weight: 500; border-radius: var(--radius-md, 8px);
		border: none; cursor: pointer; background: none; color: var(--color-text-secondary);
		transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
	}
	.seg-btn:hover { color: var(--color-text-primary); background: var(--color-elevated); }
	.seg-btn.active { color: var(--color-text-primary); background: rgb(var(--color-accent-rgb) / 0.12); }

	/* Coming-later life-domain chips (relocated from the left-nav roadmap). */
	.soon-sep { width: 1px; align-self: stretch; margin: 2px 6px; background: var(--color-border); }
	.soon-label {
		font-size: 0.6rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
		color: var(--color-text-tertiary); padding: 0 2px;
	}
	.seg-btn.soon { color: var(--color-text-tertiary); opacity: 0.7; }
	.seg-btn.soon:hover { opacity: 1; }
	.seg-btn.soon.active { color: var(--color-text-secondary); background: var(--color-elevated); opacity: 1; }
	.soon-pill {
		font-size: 0.5rem; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--color-text-tertiary); border: 1px solid var(--color-border);
		border-radius: 999px; padding: 1px 6px; line-height: 1.4;
	}

	.facet-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	.facet { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
	.facet.hidden { display: none; }

	.soon-panel { align-items: center; justify-content: center; padding: 24px; }
	.soon-card {
		display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center;
		max-width: 360px; padding: 32px; border: 1px solid var(--color-border);
		border-radius: var(--radius-lg, 14px); background: var(--color-surface);
	}
	.soon-card-title { font-size: 1.1rem; font-weight: 600; color: var(--color-text-primary); }
	.soon-card-body { font-size: 0.85rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0; }
</style>
