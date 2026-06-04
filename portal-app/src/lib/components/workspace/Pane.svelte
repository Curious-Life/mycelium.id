<script lang="ts">
	import TabStrip from './TabStrip.svelte';
	import { workspace } from '$lib/workspace/store';
	import { getView, REGISTRY } from '$lib/workspace/registry';
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

	const sections = Object.entries(REGISTRY).map(([id, v]) => ({ id, title: v.title }));
</script>

<div class="pane" class:focused={focused && multiPane} onpointerdowncapture={() => workspace.focusPane(pane.id)}>
	<TabStrip
		tabs={pane.tabs}
		activeTabId={pane.activeTabId}
		paneId={pane.id}
		onfocus={(id) => workspace.focusTab(id)}
		onclose={(id) => workspace.closeTab(id)}
		onopen={(viewId) => workspace.openInPane(pane.id, viewId)}
		onsplit={() => workspace.splitPane(pane.id, 'h')}
		onreorder={(tabId, toIndex) => workspace.moveTabWithinPane(pane.id, tabId, toIndex)}
	/>
	<div class="pane-body">
		{#if pane.tabs.length === 0}
			<!-- Empty leaf from a fresh split: a launcher. -->
			<div class="pane-launcher">
				<p class="hint">Open a view in this pane</p>
				<div class="launcher-grid">
					{#each sections as s}
						<button class="launcher-item" onclick={() => workspace.openInPane(pane.id, s.id)}>{s.title}</button>
					{/each}
				</div>
				{#if multiPane}
					<button class="launcher-close" onclick={() => workspace.closePane(pane.id)}>Close this pane</button>
				{/if}
			</div>
		{:else}
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
		{/if}
	</div>
</div>

<style>
	.pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; position: relative; }
	/* Focus ring only matters when there's more than one pane. */
	.pane.focused { box-shadow: inset 0 0 0 1px var(--color-accent); }
	.pane-body { flex: 1; min-height: 0; position: relative; overflow: hidden; }
	.tab-host { position: absolute; inset: 0; display: none; }
	.tab-host.active { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
	.tab-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
	.spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--color-border); border-top-color: var(--color-accent); animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.pane-launcher { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; }
	.hint { font-size: 0.8rem; color: var(--color-text-tertiary); }
	.launcher-grid { display: grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); gap: 8px; max-width: 320px; }
	.launcher-item { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); color: var(--color-text-primary); font-size: 0.82rem; cursor: pointer; transition: border-color 0.15s ease; }
	.launcher-item:hover { border-color: var(--color-accent); }
	.launcher-close { margin-top: 4px; font-size: 0.72rem; color: var(--color-text-tertiary); background: none; border: none; cursor: pointer; }
	.launcher-close:hover { color: var(--color-text-primary); }
</style>
