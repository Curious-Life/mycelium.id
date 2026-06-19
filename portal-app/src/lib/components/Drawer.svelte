<script lang="ts">
	// A reusable right-side slide-over drawer. First real drawer in the app — kept
	// generic (mirrors the share-viewer modal + WelcomeModal keyframes). Closes on
	// backdrop click + Escape; focus moves to the panel on open. Renders nothing
	// when closed (lazy — children mount only when opened).
	import type { Snippet } from 'svelte';

	let { open = false, onClose = () => {}, title = '', children }:
		{ open?: boolean; onClose?: () => void; title?: string; children?: Snippet } = $props();

	let panel = $state<HTMLElement | undefined>();
	$effect(() => { if (open && panel) queueMicrotask(() => panel?.focus()); });
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') onClose(); }} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="drawer-backdrop" onclick={onClose}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="drawer-panel"
			role="dialog"
			aria-modal="true"
			aria-label={title || 'Panel'}
			tabindex="-1"
			bind:this={panel}
			onclick={(e) => e.stopPropagation()}
		>
			<header class="drawer-head">
				<span class="drawer-title">{title}</span>
				<button class="drawer-close" aria-label="Close" onclick={onClose}>✕</button>
			</header>
			<div class="drawer-body">
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}

<style>
	.drawer-backdrop {
		position: fixed; inset: 0; z-index: 300;
		background: rgba(10, 10, 12, 0.6);
		backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
		display: flex; justify-content: flex-end;
		animation: drawerFade 0.2s ease-out;
	}
	.drawer-panel {
		width: 100%; max-width: 560px; height: 100%;
		display: flex; flex-direction: column;
		background: var(--color-surface); border-left: 1px solid var(--color-border);
		box-shadow: -20px 0 60px rgba(0, 0, 0, 0.4);
		animation: drawerSlide 0.28s cubic-bezier(0.16, 1, 0.3, 1);
		outline: none;
	}
	.drawer-head {
		display: flex; align-items: center; justify-content: space-between;
		padding: 0.9rem 1.2rem; border-bottom: 1px solid var(--color-border); flex-shrink: 0;
	}
	.drawer-title { font-size: 0.9rem; font-weight: 600; color: var(--color-text-primary); }
	.drawer-close {
		width: 26px; height: 26px; border-radius: 7px; border: none; background: none; cursor: pointer;
		color: var(--color-text-tertiary); font-size: 0.85rem;
	}
	.drawer-close:hover { color: var(--color-text-primary); background: var(--color-elevated); }
	.drawer-body { flex: 1; min-height: 0; overflow-y: auto; }

	@keyframes drawerFade { from { opacity: 0; } to { opacity: 1; } }
	@keyframes drawerSlide { from { transform: translateX(24px); opacity: 0.6; } to { transform: translateX(0); opacity: 1; } }
</style>
