<script lang="ts">
	import TabStrip from './TabStrip.svelte';
	import { workspace, tabDrag } from '$lib/workspace/store';
	import { getView } from '$lib/workspace/registry';
	import type { LeafPane, WsNode } from '$lib/workspace/types';
	import type { Component } from 'svelte';

	let { pane }: { pane: LeafPane } = $props();

	// Is this the focused pane, and are there multiple panes (→ pane is closable)?
	function countLeaves(n: WsNode): number {
		return n.kind === 'leaf' ? 1 : countLeaves(n.children[0]) + countLeaves(n.children[1]);
	}
	const focused = $derived($workspace.focusedPaneId === pane.id);
	const multiPane = $derived(countLeaves($workspace.root) > 1);

	// Cache the loaded view component CLASS per viewId (keep-alive across switches).
	let comps = $state<Record<string, Component<Record<string, unknown>>>>({});
	let loading = $state<Record<string, boolean>>({});

	async function ensureLoaded(viewId: string) {
		if (comps[viewId] || loading[viewId]) return;
		loading[viewId] = true;
		try {
			const mod = await getView(viewId)!.load();
			comps = { ...comps, [viewId]: mod.default };
		} catch (e) {
			console.error('[workspace] failed to load view', viewId, e);
		} finally {
			loading = { ...loading, [viewId]: false };
		}
	}
	$effect(() => { for (const t of pane.tabs) ensureLoaded(t.viewId); });
</script>

<div class="pane" class:focused={focused && multiPane} data-pane-id={pane.id} onpointerdowncapture={() => workspace.focusPane(pane.id)}>
	<TabStrip
		tabs={pane.tabs}
		activeTabId={pane.activeTabId}
		paneId={pane.id}
		onfocus={(id) => workspace.focusTab(id)}
		onclose={(id) => workspace.closeTab(id)}
		onopen={(viewId) => workspace.openInPane(pane.id, viewId)}
		onreorder={(tabId, toIndex) => workspace.moveTabWithinPane(pane.id, tabId, toIndex)}
	/>
	<div class="pane-body">
		{#each pane.tabs as tab (tab.id)}
			{@const Comp = comps[tab.viewId]}
			{@const isActive = tab.id === pane.activeTabId}
			<div class="tab-host" class:active={isActive} aria-hidden={!isActive}>
				{#if Comp}
					<Comp {...tab.params} active={isActive} setParams={(p) => workspace.setTabParams(tab.id, p)} />
				{:else}
					<div class="tab-loading"><div class="spinner"></div></div>
				{/if}
			</div>
		{/each}
	</div>

	{#if $tabDrag && $tabDrag.overPaneId === pane.id && $tabDrag.edge}
		<!-- Drop-zone preview: where the dragged tab will land (split or merge). -->
		<div class="drop-indicator {$tabDrag.edge}" aria-hidden="true"></div>
	{/if}
</div>

<style>
	.pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; position: relative; }
	/* Focus ring only matters when there's more than one pane. */
	.pane.focused { box-shadow: inset 0 0 0 1px var(--color-accent); }
	/* Drop-zone preview while a tab is dragged onto this pane (VS Code / Obsidian style). */
	.drop-indicator { position: absolute; z-index: 30; pointer-events: none; background: var(--color-accent); opacity: 0.22; border-radius: 4px; transition: all 0.07s ease; }
	.drop-indicator.left { left: 0; top: 0; width: 50%; height: 100%; }
	.drop-indicator.right { right: 0; top: 0; width: 50%; height: 100%; }
	.drop-indicator.top { left: 0; top: 0; width: 100%; height: 50%; }
	.drop-indicator.bottom { left: 0; bottom: 0; width: 100%; height: 50%; }
	.drop-indicator.center { inset: 6px; }
	.pane-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	.tab-host { position: absolute; inset: 0; display: none; }
	.tab-host.active { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
	.tab-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
	.spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--color-border); border-top-color: var(--color-accent); animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
