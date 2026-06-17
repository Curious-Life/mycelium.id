<script lang="ts">
	// Streams — the merged data surface. Facets behind one tab:
	//   • Stream  — the live incoming feed (source spectrum + TimelineView river)
	//   • Sources — manage inputs/connectors + run imports (ImportView)
	//   • Body    — Apple Health (sleep/HRV/activity); folded in here because health
	//               is just another stream of incoming data (BodyView).
	// The workspace passes `facet` in tab params (mirrored to /streams?facet=…); the
	// segmented control switches between them. Facets lazy-mount on first visit, then
	// stay alive (display-toggled) so switching never refetches.
	import StreamRiver from './StreamRiver.svelte';
	import ImportView from './ImportView.svelte';
	import BodyView from './BodyView.svelte';
	import SourceSpectrum from './SourceSpectrum.svelte';

	type Facet = 'stream' | 'sources' | 'body';

	let { facet = 'stream', setParams }: {
		facet?: Facet;
		setParams?: (patch: Record<string, unknown>) => void;
	} = $props();

	// The tab param is the single source of truth (mirrored to /streams?facet=…), so
	// the active facet is derived — a click just writes the param back via setParams.
	const current = $derived<Facet>(facet === 'sources' ? 'sources' : facet === 'body' ? 'body' : 'stream');

	// Lazy-mount + keep-alive: a facet mounts on first visit, then stays mounted
	// (display-toggled) so switching never refetches.
	let visited = $state<Record<string, boolean>>({});
	$effect(() => { if (!visited[current]) visited = { ...visited, [current]: true }; });

	function select(f: Facet) {
		setParams?.({ facet: f });
	}

	const facets = [
		{ id: 'stream', label: 'Stream' },
		{ id: 'sources', label: 'Sources' },
		{ id: 'body', label: 'Body' },
	] as const;

	// Spectrum → river filter. A canonical source key (or null = all). The spectrum
	// chips are the river's source filter (Phase 1); the unified "everything" river
	// + multi-select land in Phase 2.
	let selectedSource = $state<string | null>(null);
</script>

<div class="streams">
	<div class="seg" role="tablist" aria-label="Streams view">
		{#each facets as f}
			<button
				class="seg-btn"
				class:active={current === f.id}
				role="tab"
				aria-selected={current === f.id}
				onclick={() => select(f.id)}
			>{f.label}</button>
		{/each}
	</div>

	<div class="facet-body">
		{#if visited.stream}
			<div class="facet stream-facet" class:hidden={current !== 'stream'}>
				<div class="spectrum-wrap">
					<SourceSpectrum selected={selectedSource} onSelect={(s) => (selectedSource = s)} />
				</div>
				<div class="river-wrap">
					<StreamRiver externalSource={selectedSource} />
				</div>
			</div>
		{/if}
		{#if visited.sources}
			<div class="facet" class:hidden={current !== 'sources'}><ImportView /></div>
		{/if}
		{#if visited.body}
			<div class="facet" class:hidden={current !== 'body'}><BodyView /></div>
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

	.facet-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	.facet { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
	.facet.hidden { display: none; }

	/* Stream facet = source spectrum (hero, capped) above the river (flex-1). */
	.stream-facet { gap: 0; }
	.spectrum-wrap {
		flex-shrink: 0; padding: 14px 16px 12px; max-height: 42%; overflow-y: auto;
		border-bottom: 1px solid var(--color-border); background: var(--color-bg);
	}
	.river-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
