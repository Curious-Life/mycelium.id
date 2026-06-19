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

	// Vault identity for the footer — the @handle is the user's name here (the
	// footer leads with it), and the avatar photo if they've set one. From the
	// public profile (not on $auth.user). Silent on failure / no handle.
	let userHandle = $state<string | null>(null);
	let userAvatar = $state<string | null>(null);
	$effect(() => {
		if (!browser) return;
		apiGet<{ handle: string | null; avatar_url?: string | null }>('/portal/profile')
			.then((d) => {
				userHandle = (d?.handle || '').trim() || null;
				userAvatar = (d?.avatar_url || '').trim() || null;
			})
			.catch(() => {});
	});

	// What we show as the user's name in the footer: their @handle (the vault
	// name) first, falling back to the auth display name, then a neutral label.
	// The avatar initial follows the same precedence so it always matches.
	const vaultLabel = $derived(
		userHandle ? `@${userHandle}` : ($auth.user?.displayName || 'Your vault'),
	);
	const vaultInitial = $derived(
		(userHandle || $auth.user?.displayName || '·').trim().charAt(0).toUpperCase() || '·',
	);

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
			<!-- Small, simple line icons (14px, 1.5 stroke). The icon IS the active
			     marker now — accent when active, tertiary otherwise — so there's no
			     separate dot. -->
			<span class="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0
				{isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]'}">
				{#if item.icon === 'ratio'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<rect width="11" height="18" x="6.5" y="3" rx="2"/><rect width="18" height="11" x="3" y="6.5" rx="2"/>
					</svg>
				{:else if item.icon === 'folder'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linejoin="round">
						<path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z"/>
					</svg>
				{:else if item.icon === 'streams'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round">
						<path d="M3 9c.6.5 1.2 1 2.5 1C8 10 8 8 10.5 8c2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1"/>
						<path d="M3 15c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1"/>
					</svg>
				{:else if item.icon === 'people'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round">
						<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>
					</svg>
				{:else if item.icon === 'compass'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linejoin="round">
						<circle cx="12" cy="12" r="9"/><path d="m15 9-2 4-4 2 2-4z"/>
					</svg>
				{:else if item.icon === 'agents'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">
						<rect x="4" y="9" width="16" height="10" rx="2.5"/><path d="M12 9V5"/><circle cx="12" cy="4" r="1"/>
					</svg>
				{:else if item.icon === 'settings'}
					<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round">
						<path d="M4 6h10M18 6h2"/><circle cx="16" cy="6" r="2"/>
						<path d="M4 12h6M14 12h6"/><circle cx="12" cy="12" r="2"/>
						<path d="M4 18h2M10 18h10"/><circle cx="8" cy="18" r="2"/>
					</svg>
				{/if}
			</span>
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

			<!-- Secondary destinations (Curious Life, Agents) render in the SAME flat
			     list as the primary group — one level, no eyebrow section headers.
			     (Body & Health is reached via the Streams → Body tab, not the rail.) -->
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

	<!-- User footer — a single identity row that IS the Settings entry: avatar +
	     @vault-name + a trailing settings glyph, the whole row opening Settings
	     (Profile is its first pane). There is no separate Settings button — it
	     used to sit outside the row and read as inconsistent. Sign-out stays. -->
	<div class="p-3 border-t border-[var(--color-border)] flex-shrink-0">
		{#if $auth.user}
			<div class="flex items-center gap-1">
				<button
					onclick={() => { navigationState.setPrimaryView('settings'); goto(SETTINGS_NAV.href); closeMobileDrawer(); }}
					class="group flex items-center gap-3 min-w-0 flex-1 text-left rounded-lg -m-1 p-1 transition-colors {navActive('settings') ? 'bg-[var(--color-elevated)]' : 'hover:bg-[var(--color-elevated)]'}"
					aria-label="Open settings"
					title="Settings"
				>
					{#if userAvatar}
						<img src={userAvatar} alt="" class="w-9 h-9 rounded-full object-cover flex-shrink-0 border border-[var(--color-border)]" />
					{:else}
						<div class="w-9 h-9 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center flex-shrink-0">
							<span class="text-[var(--color-accent)] text-sm font-medium">{vaultInitial}</span>
						</div>
					{/if}
					<div class="min-w-0 flex-1">
						<div class="text-sm text-[var(--color-text-primary)] font-medium truncate">{vaultLabel}</div>
						<div class="text-xs text-[var(--color-text-tertiary)] truncate">Settings</div>
					</div>
					<span class="flex-shrink-0 mr-1 {navActive('settings') ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]'}">
						<svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round">
							<path d="M4 6h10M18 6h2"/><circle cx="16" cy="6" r="2"/>
							<path d="M4 12h6M14 12h6"/><circle cx="12" cy="12" r="2"/>
							<path d="M4 18h2M10 18h10"/><circle cx="8" cy="18" r="2"/>
						</svg>
					</span>
				</button>
				<button
					onclick={handleLogout}
					class="p-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] rounded-lg transition-colors flex-shrink-0"
					aria-label="Sign out"
					title="Sign out"
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
