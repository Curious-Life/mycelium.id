<script lang="ts">
	import TabStrip from './TabStrip.svelte';
	import { workspace } from '$lib/workspace/store';
	import { getView } from '$lib/workspace/registry';
	import type { LeafPane } from '$lib/workspace/types';
	import type { Component } from 'svelte';

	let { pane }: { pane: LeafPane } = $props();

	// Cache the loaded view component CLASS per viewId (keep-alive across switches).
	// Each tab still gets its OWN instance via the {#each} below, so two Library
	// tabs (different docs) are independent.
	let comps = $state<Record<string, Component<Record<string, unknown>>>>({});
	let loading = $state<Record<string, boolean>>({});

	async function ensureLoaded(viewId: string) {
		if (comps[viewId] || loading[viewId]) return;
		loading[viewId] = true;
		try {
			const mod = await getView(viewId)!.load();
			comps = { ...comps, [viewId]: mod.default };
		} catch (e) {
			// Leave it unloaded; the tab body shows a soft error. Don't crash the shell.
			console.error('[workspace] failed to load view', viewId, e);
		} finally {
			loading = { ...loading, [viewId]: false };
		}
	}

	// Eagerly load every open tab's component so switching is instant (keep-alive).
	$effect(() => {
		for (const t of pane.tabs) ensureLoaded(t.viewId);
	});
</script>

<div class="pane">
	<TabStrip
		tabs={pane.tabs}
		activeTabId={pane.activeTabId}
		onfocus={(id) => workspace.focusTab(id)}
		onclose={(id) => workspace.closeTab(id)}
		onopen={(viewId) => workspace.openOrFocus(viewId)}
	/>
	<div class="pane-body">
		{#each pane.tabs as tab (tab.id)}
			{@const Comp = comps[tab.viewId]}
			{@const isActive = tab.id === pane.activeTabId}
			<div class="tab-host" class:active={isActive} aria-hidden={!isActive}>
				{#if Comp}
					<Comp active={isActive} {...tab.params} />
				{:else}
					<div class="tab-loading"><div class="spinner"></div></div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
	.pane-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	/* Keep-alive: every tab stays mounted; only the active one is shown. Inactive
	   tabs keep their state (scroll, etc.); heavy views (Mindscape) pause their
	   render loop via the `active` prop rather than unmounting. */
	.tab-host { position: absolute; inset: 0; display: none; }
	.tab-host.active { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
	.tab-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
	.spinner {
		width: 22px; height: 22px; border-radius: 50%;
		border: 2px solid var(--color-border); border-top-color: var(--color-accent);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
