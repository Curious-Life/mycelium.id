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
	import SourceHistory from './SourceHistory.svelte';
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

	// Search lives in the top bar now: a compact circle that expands to an input.
	// The term is owned here and pushed into the river (which reloads, debounced).
	let searchOpen = $state(false);
	let searchQuery = $state('');
	function toggleSearch() {
		searchOpen = !searchOpen;
		if (!searchOpen) searchQuery = '';
	}
	function closeSearch() { searchOpen = false; searchQuery = ''; }
	// Focus the field the moment it appears (no a11y autofocus attribute warning).
	function focusOnShow(node: HTMLInputElement) { node.focus(); }
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
		<!-- Search your streams — a circle that expands to an input on click. -->
		<div class="search" class:open={searchOpen}>
			<button
				class="search-btn"
				onclick={toggleSearch}
				aria-label={searchOpen ? 'Close search' : 'Search your streams'}
				aria-expanded={searchOpen}
				title="Search your streams"
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
			</button>
			{#if searchOpen}
				<input
					class="search-input"
					placeholder="Search your streams…"
					aria-label="Search streams"
					bind:value={searchQuery}
					use:focusOnShow
					onkeydown={(e) => { if (e.key === 'Escape') closeSearch(); }}
				/>
				{#if searchQuery}
					<button class="search-x" onclick={() => (searchQuery = '')} aria-label="Clear search">✕</button>
				{/if}
			{/if}
		</div>
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
				<div class="river-wrap">
					<StreamRiver externalSource={selectedSource} query={searchQuery} header={graphHeader} />
				</div>
			</div>
		{/if}
		{#if visited.body}
			<div class="facet" class:hidden={underlying !== 'body'}><BodyView /></div>
		{/if}
	</div>
</div>

<!-- The history graph is handed to the river as its scroll-top header, so it
     moves up with the feed instead of pinning a fixed band above it. -->
{#snippet graphHeader()}
	<SourceHistory selected={selectedSource} onSelect={(s) => (selectedSource = s)} />
{/snippet}

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
	/* "Manage sources" sits at the right edge of the seg bar (after search); it
	   opens the Sources drawer (not a co-equal tab). */
	.seg-btn.manage { color: var(--color-text-tertiary); }
	.seg-btn.manage:hover { color: var(--color-text-primary); }
	.seg-btn.manage .ico { width: 14px; height: 14px; }

	/* Search — a circle that expands to an input. It owns the right-edge push, so
	   it + "Manage sources" cluster at the far right of the bar. */
	.search { display: inline-flex; align-items: center; margin-left: auto; }
	.search.open {
		background: var(--color-surface); border: 1px solid var(--color-border);
		border-radius: 999px; padding-right: 4px;
	}
	.search-btn {
		display: inline-flex; align-items: center; justify-content: center;
		width: 30px; height: 30px; border-radius: 999px; cursor: pointer;
		background: none; border: 1px solid transparent; color: var(--color-text-tertiary);
		transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
	}
	.search:not(.open) .search-btn { border-color: var(--color-border); }
	.search:not(.open) .search-btn:hover { color: var(--color-text-primary); background: var(--color-elevated); }
	.search.open .search-btn { color: var(--color-text-tertiary); }
	.search-btn svg { width: 15px; height: 15px; }
	.search-input {
		width: 180px; max-width: 42vw; background: none; border: none; outline: none;
		font-size: 0.8rem; color: var(--color-text-primary); padding: 0 2px;
	}
	.search-input::placeholder { color: var(--color-text-tertiary); }
	.search-x {
		display: inline-flex; align-items: center; background: none; border: none; cursor: pointer;
		color: var(--color-text-tertiary); padding: 0 4px; font-size: 0.8rem;
	}
	.search-x:hover { color: var(--color-text-primary); }

	.facet-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	.facet { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
	.facet.hidden { display: none; }

	/* Stream facet = the river, which now carries the history graph as its own
	   scroll-top header (so the graph scrolls away as you read down). */
	.stream-facet { gap: 0; }
	.river-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
