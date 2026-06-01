<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';

	const currentView = $derived($navigationState.primaryView);
	const chatOpen = $derived($navigationState.chatOpen);

	interface TabItem {
		id: PrimaryView | 'chat';
		label: string;
		href?: string;
		action?: () => void;
	}

	const tabs: TabItem[] = [
		{ id: 'mindscape', label: 'Mycelium', href: '/mindscape' },
		{ id: 'library',   label: 'Library',  href: '/library' },
		{ id: 'chat',      label: 'Chat',     action: () => navigationState.toggleChat() },
		{ id: 'timeline',  label: 'Timeline', href: '/timeline' },
	];

	function handleTab(tab: TabItem) {
		if (tab.action) {
			tab.action();
			return;
		}
		// Close chat when navigating
		if ($navigationState.chatOpen) navigationState.setChatOpen(false);
		navigationState.setPrimaryView(tab.id as PrimaryView);
		goto(tab.href!);
	}

	interface Props {
		onMoreTap: () => void;
	}

	let { onMoreTap }: Props = $props();
</script>

<nav class="tab-bar md:hidden" aria-label="Main navigation">
	{#each tabs as tab}
		{@const isActive = tab.id === 'chat' ? chatOpen : currentView === tab.id}
		<button
			class="tab-item"
			class:active={isActive}
			onclick={() => handleTab(tab)}
			aria-label={tab.label}
			aria-current={isActive ? 'page' : undefined}
		>
			<div class="tab-icon">
				{#if tab.id === 'mindscape'}
					<svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<rect width="12" height="20" x="6" y="2" rx="2"/>
						<rect width="20" height="12" x="2" y="6" rx="2"/>
					</svg>
				{:else if tab.id === 'library'}
					<svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
					</svg>
				{:else if tab.id === 'chat'}
					<svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
					</svg>
				{:else if tab.id === 'timeline'}
					<svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path d="M21 4H3"/><path d="M18 8H6"/><path d="M19 12H9"/><path d="M16 16h-6"/><path d="M11 20H9"/>
					</svg>
				{/if}
			</div>
			<span class="tab-label">{tab.label}</span>
		</button>
	{/each}

	<!-- More button -->
	<button
		class="tab-item"
		class:active={false}
		onclick={onMoreTap}
		aria-label="More"
	>
		<div class="tab-icon">
			<svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
			</svg>
		</div>
		<span class="tab-label">More</span>
	</button>
</nav>

<style>
	.tab-bar {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 30;
		display: flex;
		align-items: stretch;
		justify-content: space-around;
		height: calc(56px + env(safe-area-inset-bottom, 0px));
		padding-bottom: env(safe-area-inset-bottom, 0px);
		background: rgba(20, 20, 23, 0.85);
		backdrop-filter: blur(20px) saturate(180%);
		-webkit-backdrop-filter: blur(20px) saturate(180%);
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	/* Desktop: hide bottom tab bar — sidebar handles navigation */
	@media (min-width: 768px) {
		.tab-bar {
			display: none;
		}
	}

	:global([data-theme='light']) .tab-bar {
		background: rgba(250, 248, 245, 0.85);
		border-top-color: rgba(0, 0, 0, 0.08);
	}

	.tab-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		padding: 6px 0;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-tertiary);
		transition: color var(--duration-fast) var(--ease-out);
		-webkit-tap-highlight-color: transparent;
		position: relative;
	}

	.tab-item.active {
		color: var(--color-accent);
	}

	.tab-item.active::before {
		content: '';
		position: absolute;
		top: 0;
		left: 50%;
		transform: translateX(-50%);
		width: 20px;
		height: 2px;
		background: var(--color-accent);
		border-radius: 0 0 2px 2px;
	}

	.tab-item:active {
		transform: scale(0.92);
		transition: transform 0.1s;
	}

	.tab-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
	}

	.tab-label {
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.01em;
		line-height: 1;
	}
</style>
