<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { apiGet } from '$lib/api';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';
	import { workspace } from '$lib/workspace/store';
	import { auth } from '$lib/stores/auth';
	import PeopleNav from '$lib/components/people/PeopleNav.svelte';
	import LibraryNav from '$lib/components/library/LibraryNav.svelte';
	import {
		PRIMARY_NAV, NAV_SECTIONS, SETTINGS_NAV, PEOPLE_CLUSTER, navItemActive,
		type NavItem,
	} from '$lib/nav/config';

	const isOpen = $derived($navigationState.sidebarOpen);
	const currentView = $derived($navigationState.primaryView);

	// People nav badge — combined count: pending invites + unread direct messages
	// + newly-received shares. One poll of /people/badge drives the single dot.
	// Degrades silently to 0 when federation is off.
	let peopleBadge = $state(0);
	$effect(() => {
		if (!browser) return;
		let alive = true;
		const load = async () => {
			try { const d = await apiGet<{ total: number }>('/portal/people/badge'); if (alive) peopleBadge = d.total ?? 0; } catch {}
		};
		load();
		const t = setInterval(load, 15000);
		return () => { alive = false; clearInterval(t); };
	});

	// Navigation is driven entirely by $lib/nav/config — the single source of truth
	// shared with the mobile tab bar and the header title (see that file for why).
	// PRIMARY_NAV = Mycelium · Library · Streams · People; NAV_SECTIONS adds the
	// labelled groups below it (Curious Life, the Agents section); SETTINGS_NAV is
	// pinned in the footer. People is active across its whole cluster.
	const peopleCluster = PEOPLE_CLUSTER;
	function navActive(id: PrimaryView): boolean {
		return navItemActive(id, currentView);
	}

	// Nav items are real <a href> anchors so the browser's native right-click /
	// ⌘-click / middle-click "open in new tab" works (spec #17) and the route is a
	// shareable URL. A plain left-click is intercepted here for SPA navigation
	// (spec #16 — same-tab, no full reload); modified/middle clicks fall through to
	// the browser. A short same-target guard swallows accidental double-fires so
	// rapid clicking can't stack navigations (spec #15).
	let lastNavId: string | null = null;
	let lastNavAt = 0;
	function handleNavClick(e: MouseEvent, item: NavItem) {
		// Let the browser handle "open in new tab/window" gestures natively.
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
		e.preventDefault();
		const now = Date.now();
		if (item.id === lastNavId && now - lastNavAt < 400) { closeMobileDrawer(); return; }
		lastNavId = item.id;
		lastNavAt = now;
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
	<!-- One nav row, reused for every sidebar destination (primary items, the
	     section items, and the pinned Settings entry) so the active-state, icon,
	     and badge treatment can never drift between them. -->
	{#snippet navLink(item: NavItem)}
		{@const isActive = navActive(item.id)}
		<a
			href={item.href}
			onclick={(e) => handleNavClick(e, item)}
			class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full no-underline
				{isActive
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
			aria-current={isActive ? 'page' : undefined}
		>
			<div class="w-1.5 h-1.5 rounded-full transition-all duration-150 flex-shrink-0
				{isActive ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-[var(--color-text-tertiary)]'}">
			</div>
			<span class="text-sm font-medium">{item.label}</span>
			{#if item.id === 'people' && peopleBadge > 0}
				<span class="conn-badge" aria-label="{peopleBadge} new (invites, messages, shares)">{peopleBadge}</span>
			{/if}
		</a>
	{/snippet}

	<div class="flex-1 min-h-0 overflow-y-auto">
	<!-- Spacer top -->
	<div class="pt-2"></div>

	<!-- Primary navigation -->
	<div class="py-3">
		<nav class="flex flex-col gap-1 px-2">
			{#each PRIMARY_NAV as item}
				{@render navLink(item)}
			{/each}

			<!-- All secondary destinations (Curious Life, Body & Health, Agents) render
			     in the SAME flat list as the primary group — one level, no eyebrow
			     section headers (per app-UI feedback: "all in one level"). -->
			{#each NAV_SECTIONS as section}
				{#each section.items as item}
					{@render navLink(item)}
				{/each}
			{/each}
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

	<!-- Settings hub (pinned) — Profile is now the first pane inside Settings,
	     so the sidebar carries one "You" entry instead of two. The footer
	     identity below also deep-links to the Profile pane. -->
	<div class="px-2 py-2 border-t border-[var(--color-border)] flex-shrink-0 flex flex-col gap-1">
		{@render navLink(SETTINGS_NAV)}
	</div>

	<!-- User footer -->
	<div class="p-3 border-t border-[var(--color-border)] flex-shrink-0">
		{#if $auth.user}
			<div class="flex items-center justify-between">
				<button
					onclick={() => { navigationState.setPrimaryView('settings'); goto('/settings?pane=profile'); closeMobileDrawer(); }}
					class="flex items-center gap-3 min-w-0 flex-1 text-left rounded-lg -m-1 p-1 hover:bg-[var(--color-elevated)] transition-colors"
					aria-label="Open your profile"
				>
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
				</button>
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
</style>
