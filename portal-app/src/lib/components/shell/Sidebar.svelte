<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { apiGet } from '$lib/api';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';
	import { workspace } from '$lib/workspace/store';
	import { auth } from '$lib/stores/auth';
	import PeopleNav from '$lib/components/people/PeopleNav.svelte';
	import LibraryNav from '$lib/components/library/LibraryNav.svelte';

	const isOpen = $derived($navigationState.sidebarOpen);
	const currentView = $derived($navigationState.primaryView);

	// Pending inbound connection requests — feeds the Connections nav badge.
	// Polls the lightweight count endpoint; degrades silently when federation
	// is off (count stays 0).
	let pendingConnections = $state(0);
	$effect(() => {
		if (!browser) return;
		let alive = true;
		const load = async () => {
			try { const d = await apiGet<{ count: number }>('/portal/connections/count'); if (alive) pendingConnections = d.count ?? 0; } catch {}
		};
		load();
		const t = setInterval(load, 60000);
		return () => { alive = false; clearInterval(t); };
	});

	type NavItem = { id: PrimaryView; label: string; icon: string; href: string };

	// Launch primary navigation — 5 destinations (NAV-IA-LOCK-2026-06-08):
	//   Mycelium · Library · Streams (Import+Timeline) · People (Connections/Spaces/
	//   Sharing cluster) · Curious Life. Profile + Settings are pinned at the bottom.
	//   Not-yet-shipped life-domain surfaces (Wealth/Body/…) now live as "coming
	//   later" facets inside Streams, not the nav.
	const coreNav: NavItem[] = [
		{ id: 'mindscape', label: 'Mycelium', icon: 'ratio',   href: '/mindscape' },
		{ id: 'library',   label: 'Library',  icon: 'folder',  href: '/library' },
		{ id: 'streams',   label: 'Streams',  icon: 'streams', href: '/streams' },
		{ id: 'people',    label: 'People',   icon: 'people',  href: '/connections' },
	];

	// The People item is active across its whole cluster (its sub-nav — Connections /
	// Spaces / Sharing — renders in the contextual region below), not just one view.
	const peopleCluster = new Set<string>(['people', 'connections', 'spaces', 'contexts']);
	function navActive(id: PrimaryView): boolean {
		return id === 'people' ? peopleCluster.has(currentView) : currentView === id;
	}

	// Curious Life — the one aspirational surface, set apart from the working
	// tabs above: traverse from where your paths have led toward who you're
	// becoming. (The planned life-domain areas — Wealth/Intel/Body/Vitality/
	// Activity — now live as "coming later" facets inside Streams, not the nav.)
	const curiousLife: NavItem = { id: 'curious-life', label: 'Curious Life', icon: 'compass', href: '/curious-life' };

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
	<!-- Scrollable nav region: primary nav + contextual nav scroll together so a
	     tall list (core nav + Curious Life + contextual sub-nav) can never push
	     Settings / the user footer off-screen. Settings + footer are pinned
	     below as flex-shrink-0 siblings. -->
	<div class="flex-1 min-h-0 overflow-y-auto">
	<!-- Spacer top -->
	<div class="pt-2"></div>

	<!-- Primary navigation -->
	<div class="py-3">
		<nav class="flex flex-col gap-1 px-2">
			{#each coreNav as item}
				{@const isActive = navActive(item.id)}
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
						{:else if item.icon === 'streams'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1"/>
								<path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1"/>
								<path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1"/>
							</svg>
						{:else if item.icon === 'people'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
								<circle cx="9" cy="7" r="4"/>
								<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
								<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
							</svg>
						{:else if item.icon === 'profile'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
							</svg>
						{:else if item.icon === 'connections'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<circle cx="6" cy="6" r="2.25" /><circle cx="18" cy="18" r="2.25" /><circle cx="18" cy="6" r="2.25" />
								<path stroke-linecap="round" stroke-linejoin="round" d="M8 7.5l8 9M16 6.2A6 6 0 0 0 7 15" />
							</svg>
						{:else if item.icon === 'spaces'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.75h16.5M3.75 9.75V6a2.25 2.25 0 0 1 2.25-2.25h3l2 2.25h7.5a2.25 2.25 0 0 1 2.25 2.25v9.75A2.25 2.25 0 0 1 18.75 20.25H5.25A2.25 2.25 0 0 1 3 18V9.75z" />
							</svg>
						{:else if item.icon === 'contexts'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
								<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12c0 .35-.03.69-.08 1.02l1.86 1.46-1.5 2.6-2.2-.9a7.5 7.5 0 0 1-1.77 1.02l-.33 2.34h-3l-.33-2.34a7.5 7.5 0 0 1-1.77-1.02l-2.2.9-1.5-2.6 1.86-1.46A7.6 7.6 0 0 1 4.5 12c0-.35.03-.69.08-1.02L2.72 9.52l1.5-2.6 2.2.9A7.5 7.5 0 0 1 8.19 6.8l.33-2.34h3l.33 2.34c.63.25 1.22.59 1.77 1.02l2.2-.9 1.5 2.6-1.86 1.46c.05.33.08.67.08 1.02Z" opacity="0.4" />
							</svg>
						{/if}
					</div>
					<span class="text-sm font-medium">{item.label}</span>
					{#if item.id === 'people' && pendingConnections > 0}
						<span class="conn-badge" aria-label="{pendingConnections} pending requests">{pendingConnections}</span>
					{/if}
				</button>
			{/each}

			<!-- Curious Life — set apart between the working tabs and the roadmap.
			     Aurum→amethyst accent marks it as the aspirational surface. -->
			<div class="mt-3 pt-3 border-t border-[var(--color-border)]">
				<button
					onclick={() => handleNavClick(curiousLife)}
					class="curious group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full"
					class:active={currentView === 'curious-life'}
					aria-current={currentView === 'curious-life' ? 'page' : undefined}
				>
					<div class="curious-dot w-1.5 h-1.5 rounded-full flex-shrink-0"></div>
					<div class="curious-icon w-5 h-5 flex items-center justify-center flex-shrink-0">
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<circle cx="12" cy="12" r="9" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M14.8 9.2l-1.7 3.9-3.9 1.7 1.7-3.9z" />
						</svg>
					</div>
					<span class="curious-label text-sm font-medium">Curious Life</span>
				</button>
			</div>

		</nav>
	</div>

	<!-- Contextual navigation -->
	<div class="py-3">
		{#if currentView === 'library' || currentView === 'media'}
			<LibraryNav />
		{:else if peopleCluster.has(currentView)}
			<PeopleNav />
		{/if}
	</div>
	</div><!-- /scrollable nav region -->

	<!-- Profile + Settings (pinned) -->
	<div class="px-2 py-2 border-t border-[var(--color-border)] flex-shrink-0 flex flex-col gap-1">
		<button
			onclick={() => { navigationState.setPrimaryView('profile'); goto('/profile'); closeMobileDrawer(); }}
			class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full
				{currentView === 'profile'
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
		>
			<div class="w-1.5 h-1.5 rounded-full flex-shrink-0
				{currentView === 'profile' ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-[var(--color-text-tertiary)]'}">
			</div>
			<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
				</svg>
			</div>
			<span class="text-sm font-medium">Profile</span>
		</button>
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
	<div class="p-3 border-t border-[var(--color-border)] flex-shrink-0">
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

	/* Pending-request badge on the Connections nav item. */
	.conn-badge {
		margin-left: auto;
		min-width: 1.1rem;
		height: 1.1rem;
		padding: 0 0.35rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.65rem;
		font-weight: 600;
		line-height: 1;
		color: var(--color-bg);
		background: var(--color-accent-aurum);
		border-radius: 9999px;
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

	/* Curious Life — the aspirational nav item, marked apart with a warm
	   aurum→amethyst accent (gold of where you've been → violet of becoming). */
	.curious .curious-label {
		background: linear-gradient(90deg, var(--color-accent-aurum), var(--color-accent-amethyst));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.curious .curious-icon { color: var(--color-accent-aurum); transition: color var(--duration-fast) var(--ease-out); }
	.curious .curious-dot {
		background: var(--color-accent-aurum);
		box-shadow: 0 0 8px rgb(var(--color-accent-aurum-rgb) / 0.55);
	}
	.curious:hover { background: var(--color-elevated); }
	.curious.active {
		background: linear-gradient(90deg, rgb(var(--color-accent-aurum-rgb) / 0.12), rgb(var(--color-accent-amethyst-rgb) / 0.12));
	}
	.curious.active .curious-dot { box-shadow: 0 0 10px rgb(var(--color-accent-aurum-rgb) / 0.9); }
</style>
