<script lang="ts">
	// Streams — the river-first data surface (Phase 3). Two facets + a drawer:
	//   • Stream  — the live incoming feed (source spectrum + unified river)
	//   • Body    — Apple Health (sleep/HRV/activity); health is just another stream
	//   • Sources — manage inputs/connectors + run imports (ImportView), now a
	//               slide-over DRAWER rather than a co-equal tab, so the river is the
	//               default landing. The `facet=sources` param is KEPT (every deep-
	//               link — /import, onboarding "bring your world in", /streams?facet=
	//               sources — routes through it); the drawer simply RENDERS that state.
	import StreamRiver from './StreamRiver.svelte';
	import ImportView from './ImportView.svelte';
	import BodyView from './BodyView.svelte';
	import SourceSpectrum from './SourceSpectrum.svelte';
	import Drawer from '$lib/components/Drawer.svelte';

	type Facet = 'stream' | 'sources' | 'body';

	let { facet = 'stream', setParams }: {
		facet?: Facet;
		setParams?: (patch: Record<string, unknown>) => void;
	} = $props();

	// The tab param is the single source of truth (mirrored to /streams?facet=…), so
	// the active facet is derived — a click just writes the param back via setParams.
	const current = $derived<Facet>(facet === 'sources' ? 'sources' : facet === 'body' ? 'body' : 'stream');
	// Sources is a drawer overlaid on the stream view; the underlying tab is Stream.
	const underlying = $derived<'stream' | 'body'>(current === 'body' ? 'body' : 'stream');
	const sourcesOpen = $derived(current === 'sources');

	// Lazy-mount + keep-alive: a facet mounts on first visit, then stays mounted
	// (display-toggled) so switching never refetches.
	let visited = $state<Record<string, boolean>>({});
	$effect(() => { if (!visited[current]) visited = { ...visited, [current]: true }; });

	function select(f: Facet) {
		setParams?.({ facet: f });
	}
	function closeSources() {
		setParams?.({ facet: 'stream' });
	}

	const tabs = [
		{ id: 'stream', label: 'Stream' },
		{ id: 'body', label: 'Body' },
	] as const;

	// Spectrum → river filter. A canonical source key (or null = all).
	let selectedSource = $state<string | null>(null);
</script>

<div class="streams">
	<div class="seg" role="tablist" aria-label="Streams view">
		{#each tabs as f}
			<button
				class="seg-btn"
				class:active={underlying === f.id}
				role="tab"
				aria-selected={underlying === f.id}
				onclick={() => select(f.id)}
			>{f.label}</button>
		{/each}
		<button
			class="seg-btn manage"
			class:active={sourcesOpen}
			aria-haspopup="dialog"
			aria-expanded={sourcesOpen}
			onclick={() => select('sources')}
			title="Connect inputs + run imports"
		>
			<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M9.5 2v6M14.5 2v6M7 8h10v3a5 5 0 0 1-10 0V8zM12 16v6"/>
			</svg>
			Manage sources
		</button>
	</div>

	<div class="facet-body">
		{#if visited.stream || underlying === 'stream' || sourcesOpen}
			<div class="facet stream-facet" class:hidden={underlying !== 'stream'}>
				<div class="spectrum-wrap">
					<SourceSpectrum selected={selectedSource} onSelect={(s) => (selectedSource = s)} />
				</div>
				<div class="river-wrap">
					<StreamRiver externalSource={selectedSource} />
				</div>
			</div>
		{/if}
		{#if visited.body}
			<div class="facet" class:hidden={underlying !== 'body'}><BodyView /></div>
		{/if}
	</div>
</div>

<Drawer open={sourcesOpen} onClose={closeSources} title="Manage sources">
	<ImportView />
</Drawer>

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
	/* "Manage sources" is pushed to the right edge of the seg bar; it opens the
	   Sources drawer (not a co-equal tab). */
	.seg-btn.manage { margin-left: auto; color: var(--color-text-tertiary); }
	.seg-btn.manage:hover { color: var(--color-text-primary); }
	.seg-btn.manage .ico { width: 14px; height: 14px; }

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
