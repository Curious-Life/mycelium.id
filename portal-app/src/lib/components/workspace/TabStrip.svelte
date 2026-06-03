<script lang="ts">
	import Tab from './Tab.svelte';
	import { REGISTRY } from '$lib/workspace/registry';
	import type { Tab as TabT } from '$lib/workspace/types';

	let { tabs, activeTabId, onfocus, onclose, onopen }: {
		tabs: TabT[];
		activeTabId: string | null;
		onfocus: (id: string) => void;
		onclose: (id: string) => void;
		onopen: (viewId: string) => void;
	} = $props();

	let menuOpen = $state(false);
	const sections = Object.entries(REGISTRY).map(([id, v]) => ({ id, title: v.title }));

	function pick(id: string) {
		menuOpen = false;
		onopen(id);
	}
</script>

<div class="tab-strip" role="tablist">
	<div class="tabs">
		{#each tabs as tab (tab.id)}
			<Tab
				{tab}
				active={tab.id === activeTabId}
				onfocus={() => onfocus(tab.id)}
				onclose={() => onclose(tab.id)}
			/>
		{/each}
	</div>

	<div class="new-wrap">
		<button class="tab-new" title="Open a view" aria-label="Open a view" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>+</button>
		{#if menuOpen}
			<!-- click-away backdrop -->
			<button class="menu-backdrop" tabindex="-1" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
			<div class="menu" role="menu">
				{#each sections as s}
					<button class="menu-item" role="menuitem" onclick={() => pick(s.id)}>{s.title}</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.tab-strip {
		display: flex; align-items: stretch; height: 36px; min-height: 36px;
		background: var(--color-surface); border-bottom: 1px solid var(--color-border);
	}
	.tabs { display: flex; overflow-x: auto; scrollbar-width: none; }
	.tabs::-webkit-scrollbar { display: none; }
	.new-wrap { position: relative; display: flex; align-items: stretch; }
	.tab-new {
		flex-shrink: 0; width: 34px; border: none; background: none; cursor: pointer;
		color: var(--color-text-tertiary); font-size: 1.15rem; line-height: 1;
	}
	.tab-new:hover { color: var(--color-text-primary); background: var(--color-elevated); }
	.menu-backdrop { position: fixed; inset: 0; z-index: 40; background: transparent; border: none; cursor: default; }
	.menu {
		position: absolute; top: 38px; right: 4px; z-index: 50; min-width: 160px;
		background: var(--color-elevated); border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 8px); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.4));
		padding: 4px; display: flex; flex-direction: column;
	}
	.menu-item {
		text-align: left; padding: 7px 10px; border: none; background: none; cursor: pointer;
		color: var(--color-text-primary); font-size: 0.82rem; border-radius: 6px;
	}
	.menu-item:hover { background: var(--color-surface); }
</style>
