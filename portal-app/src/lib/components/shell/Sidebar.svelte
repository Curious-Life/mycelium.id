<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { apiGet } from '$lib/api';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';
	import { sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '$lib/stores/sidebar';
	import { workspace } from '$lib/workspace/store';
	import { auth } from '$lib/stores/auth';
	import { vaultDisplayLabel } from '$lib/vault-label';
	import PeopleNav from '$lib/components/people/PeopleNav.svelte';
	import LibraryNav from '$lib/components/library/LibraryNav.svelte';
	import {
		PRIMARY_NAV, NAV_SECTIONS, SETTINGS_NAV, PEOPLE_CLUSTER, navItemActive, navItemViewId,
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

	// Auto-update banner: the Tauri backend checks on launch + every 6h and stores any
	// available update in UpdateState; we poll it and surface a small banner above the
	// footer. No-op in the browser / non-Tauri shell (no __TAURI_INTERNALS__).
	let availableUpdate = $state<{ version: string; notes: string } | null>(null);
	let updating = $state(false);
	$effect(() => {
		if (!browser) return;
		const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
		if (!invoke) return;
		let alive = true;
		const poll = async () => {
			try { const u = await invoke('get_available_update'); if (alive) availableUpdate = u ?? null; } catch {}
		};
		poll();
		const t = setInterval(poll, 5 * 60 * 1000);
		return () => { alive = false; clearInterval(t); };
	});
	async function doUpdate() {
		const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
		if (!invoke || updating) return;
		updating = true;
		// install_update downloads + verifies the signature + restarts on success; on
		// failure it throws and we re-enable the button.
		try { await invoke('install_update'); } catch { updating = false; }
	}

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

	// What we show as the vault's NAME in the footer — the ONE centralized
	// vault-label chain (handle → "My Mycelium", handle-first). See $lib/vault-label.
	// ⚠️ Kept SEPARATE from the avatar-INITIAL chain below, which today is ALSO
	// handle-first (userHandle → displayName → '·'). R2-AVATAR/U2.5 will re-order the
	// initial to displayName-first — that is NOT built yet, so this comment describes
	// what the code does now, not the future ordering.
	const vaultLabel = $derived(vaultDisplayLabel(userHandle));
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

	// Nav items are real <a href> anchors (shareable URLs, native a11y). A plain
	// left-click is intercepted for SPA navigation (spec #16 — navigates the
	// CURRENT workspace tab in place, via route → openFromRoute → openInActiveTab).
	// A NEW tab is only ever an EXPLICIT gesture: ⌘/ctrl-click or middle-click
	// (handled here — the native browser new-tab is a dead gesture inside the
	// Tauri/WKWebView shell), right-click → "Open in new tab" (context menu below),
	// or dragging the row onto the tab strip. shift/alt-clicks stay native. A short
	// same-target guard swallows accidental double-fires (spec #15).
	let lastNavId: string | null = null;
	let lastNavAt = 0;
	// people→connections mapping lives ONCE in $lib/nav/config (navItemViewId).
	const itemViewId = navItemViewId;
	function handleNavClick(e: MouseEvent, item: NavItem) {
		if (navJustDragged) { e.preventDefault(); return; }   // a drop, not a click
		if (e.metaKey || e.ctrlKey) {
			// Explicit new-tab intent (browser convention). openOrFocus appends a tab
			// (or focuses the existing one — singletons never duplicate).
			e.preventDefault();
			workspace.openOrFocus(itemViewId(item));
			closeMobileDrawer();
			return;
		}
		if (e.shiftKey || e.altKey || e.button !== 0) return; // leave native gestures alone
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
	// Middle-click = explicit new-tab intent too. Middle presses arrive as
	// `auxclick` (button 1), never `click`.
	function handleNavAux(e: MouseEvent, item: NavItem) {
		if (e.button !== 1) return;
		e.preventDefault();
		workspace.openOrFocus(itemViewId(item));
		closeMobileDrawer();
	}

	// Right-click → a minimal context menu with the one explicit-intent action.
	// Dismissed by click-away (backdrop), a second right-click, or Escape.
	let ctxMenu = $state<{ x: number; y: number; viewId: string } | null>(null);
	function handleNavContext(e: MouseEvent, item: NavItem) {
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY, viewId: itemViewId(item) };
	}
	function ctxOpenNewTab() {
		if (ctxMenu) workspace.openOrFocus(ctxMenu.viewId);
		ctxMenu = null;
		closeMobileDrawer();
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') ctxMenu = null;
	}

	// Drag a section row onto a tab strip → open there as a NEW tab (explicit
	// intent). Pointer-based, following TabStrip's precedent (the app has no HTML5
	// DnD). Mouse-only: capturing touch pointers here would steal the drawer's
	// scroll gesture on mobile. <5px travel stays a click; past it the trailing
	// click is swallowed (navJustDragged) so a drop doesn't also navigate.
	let navDragViewId: string | null = null;
	let navDragStartX = 0;
	let navDragStartY = 0;
	let navDragStarted = false;
	let navJustDragged = false;
	let navDragEl: HTMLElement | null = null;
	let navDragPointerId = -1;
	const navPreventSelect = (e: Event) => e.preventDefault();
	function navHitStrip(e: PointerEvent): HTMLElement | null {
		const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
		return el?.closest('[data-tabstrip-pane]') ?? null;
	}
	function handleNavPointerDown(e: PointerEvent, item: NavItem) {
		if (e.button !== 0 || e.pointerType !== 'mouse') return;
		navDragViewId = itemViewId(item);
		navDragStartX = e.clientX;
		navDragStartY = e.clientY;
		navDragStarted = false;
		navDragEl = e.currentTarget as HTMLElement;
		navDragPointerId = e.pointerId;
		window.addEventListener('pointermove', navPointerMove);
		window.addEventListener('pointerup', navPointerUp);
		window.addEventListener('pointercancel', navPointerUp);
	}
	function navPointerMove(e: PointerEvent) {
		if (!navDragViewId) return;
		if (!navDragStarted) {
			if (Math.abs(e.clientX - navDragStartX) < 5 && Math.abs(e.clientY - navDragStartY) < 5) return;
			navDragStarted = true;
			// Claim the pointer + suppress selection for the rest of the gesture
			// (same reasons as TabStrip's drag: WKWebView reinterprets, text selects).
			document.addEventListener('selectstart', navPreventSelect);
			document.body.style.userSelect = 'none';
			try { navDragEl?.setPointerCapture(navDragPointerId); } catch { /* unsupported */ }
		}
		document.body.style.cursor = navHitStrip(e) ? 'copy' : 'grabbing';
	}
	function navPointerUp(e: PointerEvent) {
		window.removeEventListener('pointermove', navPointerMove);
		window.removeEventListener('pointerup', navPointerUp);
		window.removeEventListener('pointercancel', navPointerUp);
		document.removeEventListener('selectstart', navPreventSelect);
		if (navDragEl && navDragPointerId >= 0) { try { navDragEl.releasePointerCapture(navDragPointerId); } catch { /* already released */ } }
		if (navDragStarted) {
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			if (e.type === 'pointerup' && navDragViewId) {
				const strip = navHitStrip(e);
				const paneId = strip?.getAttribute('data-tabstrip-pane');
				// openInPane = new tab in the strip's pane (an already-open singleton
				// focuses instead — the accepted no-duplicates design).
				if (paneId) workspace.openInPane(paneId, navDragViewId);
			}
			navJustDragged = true;                              // swallow the trailing click
			setTimeout(() => (navJustDragged = false), 0);
		}
		navDragViewId = null;
		navDragStarted = false;
		navDragEl = null;
		navDragPointerId = -1;
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

	// Resizable sidebar. The width lives in a SHARED store ($lib/stores/sidebar)
	// so the Header's left cell (R4-SHELLCHROME) can size its column off the exact
	// same value — the two must stay pixel-aligned, including live during a drag,
	// for the divider to read as one continuous line. The store also owns the
	// localStorage load/persist (same key + 200–400 clamp as before).
	let isResizing = $state(false);
	let sidebarRef: HTMLElement;

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
		// The sidebar's left edge is at x=0, so clientX IS the target width.
		sidebarWidth.set(Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, e.clientX)));
	}

	function stopResize() {
		isResizing = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		window.removeEventListener('mousemove', onResize);
		window.removeEventListener('mouseup', stopResize);
		// Persistence is handled by the shared store's subscribe (localStorage).
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
	style={isMobile ? '' : `width: ${isOpen ? $sidebarWidth + 'px' : '0'};`}
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
			onauxclick={(e) => handleNavAux(e, item)}
			oncontextmenu={(e) => handleNavContext(e, item)}
			onpointerdown={(e) => handleNavPointerDown(e, item)}
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

	{#if availableUpdate}
		<!-- Update-available banner — sits ABOVE the footer divider. The backend has
		     already signature-verified a newer build; Update downloads + installs + restarts. -->
		<div class="mx-3 mb-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2.5 py-2 flex items-center gap-2">
			<div class="min-w-0 flex-1">
				<div class="text-xs font-medium text-[var(--color-text-primary)] truncate">Version {availableUpdate.version} is live</div>
				<div class="text-[0.65rem] text-[var(--color-text-tertiary)] leading-tight">A new update is ready</div>
			</div>
			<button
				onclick={doUpdate}
				disabled={updating}
				class="flex-shrink-0 text-xs font-medium px-2.5 py-1 rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
				title="Download and install v{availableUpdate.version}, then restart">
				{updating ? 'Updating…' : 'Update'}
			</button>
		</div>
	{/if}

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
		<!-- Release badge — deliberately quiet: tiny, tertiary, half-faded, unselectable.
		     __APP_VERSION__ is baked in at build time (vite define ← root package.json),
		     so it always states the running build, with no request and no store. -->
		<div class="mt-1.5 px-1 text-[0.6rem] leading-none text-[var(--color-text-tertiary)] opacity-50 select-none" title="Mycelium v{__APP_VERSION__}">v{__APP_VERSION__}</div>
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

<svelte:window onkeydown={onWindowKeydown} />

{#if ctxMenu}
	<!-- Right-click menu: the ONE explicit new-tab action (markup pattern from
	     TabStrip's "+" menu: backdrop button = click-away dismiss; Escape via the
	     window keydown above). -->
	<button class="ctx-backdrop" tabindex="-1" aria-label="Close menu" onclick={() => (ctxMenu = null)} oncontextmenu={(e) => { e.preventDefault(); ctxMenu = null; }}></button>
	<div class="ctx-menu" role="menu" style="left: {Math.min(ctxMenu.x, (browser ? window.innerWidth : 1e4) - 180)}px; top: {ctxMenu.y}px;">
		<button class="ctx-item" role="menuitem" onclick={ctxOpenNewTab}>Open in new tab</button>
	</div>
{/if}

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

	/* Right-click "Open in new tab" menu (same treatment as TabStrip's "+" menu). */
	.ctx-backdrop { position: fixed; inset: 0; z-index: 60; background: transparent; border: none; cursor: default; }
	.ctx-menu {
		position: fixed; z-index: 61; min-width: 160px;
		background: var(--color-elevated); border: 1px solid var(--color-border);
		border-radius: var(--radius-md, 8px); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.4));
		padding: 4px; display: flex; flex-direction: column;
	}
	.ctx-item {
		text-align: left; padding: 7px 10px; border: none; background: none; cursor: pointer;
		color: var(--color-text-primary); font-size: 0.82rem; border-radius: 6px;
	}
	.ctx-item:hover { background: var(--color-surface); }
</style>
