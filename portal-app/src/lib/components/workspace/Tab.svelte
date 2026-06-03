<script lang="ts">
	import type { Tab } from '$lib/workspace/types';

	let { tab, active, onfocus, onclose }: {
		tab: Tab;
		active: boolean;
		onfocus: () => void;
		onclose: () => void;
	} = $props();
</script>

<div
	class="tab"
	class:active
	role="tab"
	aria-selected={active}
	tabindex="0"
	title={tab.title}
	onclick={onfocus}
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onfocus(); } }}
>
	<span class="tab-title">{tab.title}</span>
	{#if tab.closable}
		<button
			class="tab-close"
			title="Close tab"
			aria-label="Close {tab.title}"
			onclick={(e) => { e.stopPropagation(); onclose(); }}
		>×</button>
	{/if}
</div>

<style>
	.tab {
		display: flex; align-items: center; gap: 6px;
		padding: 0 10px; height: 100%; max-width: 220px;
		border-right: 1px solid var(--color-border);
		cursor: pointer; color: var(--color-text-secondary);
		font-size: 0.8rem; white-space: nowrap; user-select: none;
		transition: background var(--duration-fast, 120ms) ease, color var(--duration-fast, 120ms) ease;
	}
	.tab:hover { background: var(--color-elevated); color: var(--color-text-primary); }
	.tab.active {
		background: var(--color-bg); color: var(--color-text-primary);
		box-shadow: inset 0 -2px 0 var(--color-accent);
	}
	.tab-title { overflow: hidden; text-overflow: ellipsis; }
	.tab-close {
		opacity: 0; border: none; background: none; color: inherit; cursor: pointer;
		font-size: 1rem; line-height: 1; padding: 1px 4px; border-radius: 4px;
	}
	.tab:hover .tab-close, .tab.active .tab-close { opacity: 0.55; }
	.tab-close:hover { opacity: 1; background: var(--color-surface); }
</style>
