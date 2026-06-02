<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';
	import { auth } from '$lib/stores/auth';
	import TimelineNav from '$lib/components/timeline/TimelineNav.svelte';
	import LibraryNav from '$lib/components/library/LibraryNav.svelte';
	import AgentsNav from '$lib/components/agents/AgentsNav.svelte';

	const isOpen = $derived($navigationState.sidebarOpen);
	const currentView = $derived($navigationState.primaryView);

	type NavItem = { id: PrimaryView; label: string; icon: string; href: string };

	// V1 primary navigation — the honest, working surface. Screens that have a
	// V1 backend (or gain one in the build-out: Mindscape/Import) live here;
	// everything else is surfaced under "Coming later" below as disabled chips,
	// so the roadmap stays visible without any dead links. (Settings is rendered
	// separately at the bottom.) See docs/UX-COMPLETE-DESIGN-2026-06-01.md.
	const coreNav: NavItem[] = [
		{ id: 'mindscape', label: 'Mycelium', icon: 'ratio',   href: '/mindscape' },
		{ id: 'library',   label: 'Library',  icon: 'folder',  href: '/library' },
		{ id: 'import',    label: 'Import',   icon: 'import',  href: '/import' },
		{ id: 'timeline',  label: 'Timeline', icon: 'tornado', href: '/timeline' },
		{ id: 'profile',   label: 'Profile',  icon: 'profile', href: '/profile' },
	];

	// Planned screens (modules · social · agents). Shown disabled, no routing —
	// they render nothing in V1. Collapsed by default.
	const comingLater = [
		'Spaces', 'Connections', 'Chat', 'Agents', 'Cycles',
		'Wealth', 'Intel', 'Body', 'Vitality', 'Activity', 'Media',
	];
	let comingLaterOpen = $state(false);

	function handleNavClick(item: NavItem) {
		// Don't re-navigate if already on this view — prevents 3D map remount
		if (currentView === item.id) {
			closeMobileDrawer();
			return;
		}
		navigationState.setPrimaryView(item.id);
		goto(item.href);
		closeMobileDrawer();
	}

	async function handleLogout() {
		await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
		auth.logout();
		window.location.href = '/login';
	}


	// Mobile detection
	let isMobile = $state(false);
	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia('(max-width: 767px)');
		isMobile = mq.matches;
		const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	// Close drawer on mobile after navigation
	function closeMobileDrawer() {
		if (isMobile) navigationState.setSidebarOpen(false);
	}

	// Resizable sidebar
	let sidebarWidth = $state(256);
	let isResizing = $state(false);
	let sidebarRef: HTMLElement;

	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-sidebar-width');
			if (saved) {
				const parsed = parseInt(saved);
				if (parsed >= 200 && parsed <= 400) sidebarWidth = parsed;
			}
		}
	});

	function startResize(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		window.addEventListener('mousemove', onResize);
		window.addEventListener('mouseup', stopResize);
	}

	function onResize(e: MouseEvent) {
		if (!isResizing) return;
		sidebarWidth = Math.max(200, Math.min(400, e.clientX));
	}

	function stopResize() {
		isResizing = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		window.removeEventListener('mousemove', onResize);
		window.removeEventListener('mouseup', stopResize);
		if (browser) localStorage.setItem('mycelium-sidebar-width', sidebarWidth.toString());
	}
</script>

<!-- Mobile backdrop -->
{#if isMobile && isOpen}
	<button
		class="mobile-backdrop visible"
		onclick={() => navigationState.setSidebarOpen(false)}
		aria-label="Close menu"
		tabindex="-1"
	></button>
{/if}

<aside
	bind:this={sidebarRef}
	class="sidebar bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col overflow-hidden shrink-0 relative"
	class:closed={!isOpen}
	class:mobile-drawer={isMobile}
	style={isMobile ? '' : `width: ${isOpen ? sidebarWidth + 'px' : '0'};`}
>
	<!-- Spacer top -->
	<div class="pt-2"></div>

	<!-- Primary navigation -->
	<div class="py-3">
		<nav class="flex flex-col gap-1 px-2">
			{#each coreNav as item}
				{@const isActive = currentView === item.id}
				<button
					onclick={() => handleNavClick(item)}
					class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
						{isActive
						? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
						: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
					aria-current={isActive ? 'page' : undefined}
				>
					<div class="w-1.5 h-1.5 rounded-full transition-all duration-150 flex-shrink-0
						{isActive ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-[var(--color-text-tertiary)]'}">
					</div>
					<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
						{#if item.icon === 'ratio'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<rect width="12" height="20" x="6" y="2" rx="2"/>
								<rect width="20" height="12" x="2" y="6" rx="2"/>
							</svg>
						{:else if item.icon === 'folder'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
							</svg>
						{:else if item.icon === 'import'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
							</svg>
						{:else if item.icon === 'tornado'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path d="M21 4H3"/><path d="M18 8H6"/><path d="M19 12H9"/><path d="M16 16h-6"/><path d="M11 20H9"/>
							</svg>
						{:else if item.icon === 'profile'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
							</svg>
						{/if}
					</div>
					<span class="text-sm font-medium">{item.label}</span>
				</button>
			{/each}

			<!-- Coming later: planned screens (modules · social · agents), shown
			     as disabled chips so the roadmap is visible without dead links.
			     Collapsed by default; no routing — these render nothing in V1. -->
			<div class="mt-3 pt-3 border-t border-[var(--color-border)]">
				<button
					class="w-full flex items-center justify-between px-3 py-1.5 mb-1 rounded-md text-[0.65rem] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-widest cursor-pointer hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] transition-colors"
					onclick={() => (comingLaterOpen = !comingLaterOpen)}
					aria-expanded={comingLaterOpen}
				>
					Coming later
					<svg class="w-3.5 h-3.5 opacity-50 transition-transform duration-150 {comingLaterOpen ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
					</svg>
				</button>
				{#if comingLaterOpen}
					{#each comingLater as label}
						<div
							class="flex items-center gap-3 px-3 py-2 rounded-lg opacity-40 cursor-default select-none"
							title="Planned for a future release"
						>
							<div class="w-1.5 h-1.5 rounded-full bg-transparent flex-shrink-0"></div>
							<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<circle cx="12" cy="12" r="8.25" />
								</svg>
							</div>
							<span class="text-sm font-medium">{label}</span>
							<span class="ml-auto text-[0.5rem] uppercase tracking-wider text-[var(--color-text-tertiary)] border border-[var(--color-border)] rounded-full px-1.5 py-0.5">soon</span>
						</div>
					{/each}
				{/if}
			</div>
		</nav>
	</div>

	<!-- Contextual navigation -->
	<div class="flex-1 overflow-y-auto py-3">
		{#if currentView === 'timeline'}
			<TimelineNav />
		{:else if currentView === 'library' || currentView === 'media'}
			<LibraryNav />
		<!-- /agents: no contextual sidebar — the page itself is the agent list. -->
		{:else if currentView === 'agents-disabled'}
			<AgentsNav />
		{/if}
	</div>

	<!-- Settings link -->
	<div class="px-2 py-2 border-t border-[var(--color-border)]">
		<button
			onclick={() => { navigationState.setPrimaryView('settings'); goto('/settings'); closeMobileDrawer(); }}
			class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full
				{currentView === 'settings'
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
		>
			<div class="w-1.5 h-1.5 rounded-full flex-shrink-0
				{currentView === 'settings' ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-[var(--color-text-tertiary)]'}">
			</div>
			<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
				</svg>
			</div>
			<span class="text-sm font-medium">Settings</span>
		</button>
	</div>

	<!-- User footer -->
	<div class="p-3 border-t border-[var(--color-border)]">
		{#if $auth.user}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3 min-w-0">
					<div class="w-9 h-9 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center flex-shrink-0">
						<span class="text-[var(--color-accent)] text-sm font-medium">
							{($auth.user.displayName || '?')[0].toUpperCase()}
						</span>
					</div>
					<div class="min-w-0">
						<div class="text-sm text-[var(--color-text-primary)] font-medium truncate">
							{$auth.user.displayName || 'User'}
						</div>
					</div>
				</div>
				<button
					onclick={handleLogout}
					class="p-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] rounded-lg transition-colors flex-shrink-0"
					aria-label="Sign out"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
					</svg>
				</button>
			</div>
		{/if}
	</div>

	<!-- Resize handle -->
	{#if isOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-handle"
			class:active={isResizing}
			onmousedown={startResize}
		></div>
	{/if}
</aside>

<style>
	.sidebar {
		transition: width 0.2s ease-out, opacity 0.2s ease-out;
	}

	.sidebar.closed {
		opacity: 0;
		border-right: none;
		pointer-events: none;
	}

	/* Mobile drawer overlay */
	.sidebar.mobile-drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		width: 280px !important;
		z-index: 50;
		transform: translateX(0);
		transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
		            opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1);
		opacity: 1;
		box-shadow: 4px 0 24px rgba(0, 0, 0, 0.3);
	}

	.sidebar.mobile-drawer.closed {
		transform: translateX(-100%);
		opacity: 1; /* keep opacity, just slide out */
		pointer-events: none;
		box-shadow: none;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 4px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		transition: background 0.15s;
		z-index: 20;
	}

	.resize-handle:hover,
	.resize-handle.active {
		background: var(--color-accent);
	}
</style>
