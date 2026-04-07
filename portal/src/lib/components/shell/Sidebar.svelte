<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { navigationState, type PrimaryView } from '$lib/stores/navigation';
	import { auth } from '$lib/stores/auth';
	import MindscapeRealmNav from '$lib/components/mindscape/MindscapeRealmNav.svelte';
	import TimelineNav from '$lib/components/timeline/TimelineNav.svelte';
	import LibraryNav from '$lib/components/library/LibraryNav.svelte';
	import AgentsNav from '$lib/components/agents/AgentsNav.svelte';

	const isOpen = $derived($navigationState.sidebarOpen);
	const currentView = $derived($navigationState.primaryView);

	let pendingCount = $state(0);
	onMount(() => {
		if (browser) {
			fetch('/portal/connections/count', { credentials: 'include' })
				.then(r => r.json())
				.then(d => { pendingCount = d.pending || 0; })
				.catch(() => {});
			// Refresh every 60s
			const interval = setInterval(() => {
				fetch('/portal/connections/count', { credentials: 'include' })
					.then(r => r.json())
					.then(d => { pendingCount = d.pending || 0; })
					.catch(() => {});
			}, 60000);
			return () => clearInterval(interval);
		}
	});

	type NavItem = { id: PrimaryView; label: string; icon: string; href: string };

	const coreNav: NavItem[] = [
		{ id: 'mindscape', label: 'Mindscape', icon: 'ratio',    href: '/mindscape' },
		{ id: 'library',   label: 'Library',   icon: 'folder',   href: '/library' },
		{ id: 'timeline',  label: 'Timeline',  icon: 'tornado',  href: '/timeline' },
		{ id: 'activity',  label: 'Activity',  icon: 'activity', href: '/activity' },
		{ id: 'agents',    label: 'Agents',    icon: 'agents',   href: '/agents' },
		{ id: 'profile',   label: 'Profile',   icon: 'profile',  href: '/profile' },
		{ id: 'connections', label: 'Connections', icon: 'connections', href: '/connections' },
		{ id: 'contexts',    label: 'Contexts',    icon: 'contexts',    href: '/contexts' },
	];

	const moduleNav: NavItem[] = [
		{ id: 'wealth',    label: 'Wealth',    icon: 'wealth',   href: '/wealth' },
		{ id: 'intel',     label: 'Intel',     icon: 'intel',    href: '/intel' },
	];

	const navItems = [...coreNav, ...moduleNav];

	function handleNavClick(item: typeof navItems[0]) {
		navigationState.setPrimaryView(item.id);
		goto(item.href);
	}

	async function handleLogout() {
		await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
		auth.logout();
		window.location.href = '/login';
	}

	// Editable vault name
	let vaultName = $state('');
	let isEditingName = $state(false);
	let nameInputRef = $state<HTMLInputElement>();

	$effect(() => {
		const settings = $auth.user?.settings as Record<string, unknown> | undefined;
		if (settings?.vault_name && typeof settings.vault_name === 'string') {
			vaultName = settings.vault_name;
		} else {
			vaultName = 'Mycelium';
		}
	});

	function startEditingName() {
		isEditingName = true;
		// Focus after DOM update
		setTimeout(() => nameInputRef?.focus(), 0);
	}

	async function saveName() {
		isEditingName = false;
		const trimmed = vaultName.trim() || 'Mycelium';
		vaultName = trimmed;
		if (trimmed === 'Mycelium') return; // Don't save the default
		try {
			await fetch('/portal/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ vault_name: trimmed }),
			});
			// Update local auth store settings
			if ($auth.user) {
				const settings = ($auth.user.settings || {}) as Record<string, unknown>;
				settings.vault_name = trimmed;
				auth.setUser({ ...$auth.user, settings });
			}
		} catch {}
	}

	function handleNameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveName();
		} else if (e.key === 'Escape') {
			isEditingName = false;
			const settings = $auth.user?.settings as Record<string, unknown> | undefined;
			vaultName = (settings?.vault_name as string) || 'Mycelium';
		}
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

<aside
	bind:this={sidebarRef}
	class="sidebar bg-[var(--color-surface)] border-r border-[var(--color-border)] hidden md:flex flex-col overflow-hidden shrink-0 relative"
	class:closed={!isOpen}
	style="width: {isOpen ? sidebarWidth + 'px' : '0'};"
>
	<!-- Brand header -->
	<div class="p-4 border-b border-[var(--color-border)]">
		<div>
			{#if isEditingName}
				<input
					bind:this={nameInputRef}
					bind:value={vaultName}
					onblur={saveName}
					onkeydown={handleNameKeydown}
					class="text-base font-medium text-[var(--color-text-primary)] bg-transparent border-b border-[var(--color-accent)] outline-none w-full"
					maxlength="60"
				/>
			{:else}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<h1
					class="text-base font-medium text-[var(--color-text-primary)] cursor-text hover:text-[var(--color-accent)] transition-colors"
					onclick={startEditingName}
				>{vaultName}</h1>
			{/if}
			<p class="text-xs text-[var(--color-text-tertiary)]">Intelligence system</p>
		</div>
	</div>

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
						{:else if item.icon === 'tornado'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path d="M21 4H3"/><path d="M18 8H6"/><path d="M19 12H9"/><path d="M16 16h-6"/><path d="M11 20H9"/>
							</svg>
						{:else if item.icon === 'agents'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
							</svg>
						{:else if item.icon === 'activity'}
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
						</svg>
					{:else if item.icon === 'connections'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
							</svg>
						{:else if item.icon === 'contexts'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
							</svg>
						{:else if item.icon === 'profile'}
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
							</svg>
						{/if}
					</div>
					<span class="text-sm font-medium">{item.label}</span>
						{#if item.id === 'connections' && pendingCount > 0}
							<span class="ml-auto text-[0.6rem] font-semibold bg-[var(--color-accent-aurum)] text-[var(--color-bg)] rounded-full px-1.5 py-0.5 min-w-[18px] text-center">{pendingCount}</span>
						{/if}
				</button>
			{/each}

			<!-- Modules -->
			<div class="mt-3 pt-3 border-t border-[var(--color-border)]">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<p class="px-3 pb-1.5 text-[0.6rem] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-widest cursor-pointer hover:text-[var(--color-text-secondary)] transition-colors"
					onclick={() => { navigationState.setPrimaryView('modules'); goto('/modules'); }}
				>Modules</p>
				{#each moduleNav as item}
					{@const isActive = currentView === item.id}
					<button
						onclick={() => handleNavClick(item)}
						class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full
							{isActive
							? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
							: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
						aria-current={isActive ? 'page' : undefined}
					>
						<div class="w-1.5 h-1.5 rounded-full transition-all duration-150 flex-shrink-0
							{isActive ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-[var(--color-text-tertiary)]'}">
						</div>
						<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
							{#if item.icon === 'wealth'}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
								</svg>
							{:else if item.icon === 'intel'}
								<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.73-3.56" />
								</svg>
							{/if}
						</div>
						<span class="text-sm font-medium">{item.label}</span>
					</button>
				{/each}
			</div>
		</nav>
	</div>

	<!-- Contextual navigation -->
	<div class="flex-1 overflow-y-auto py-3">
		{#if currentView === 'mindscape'}
			<MindscapeRealmNav />
		{:else if currentView === 'timeline'}
			<TimelineNav />
		{:else if currentView === 'library' || currentView === 'media'}
			<LibraryNav />
		{:else if currentView === 'agents'}
			<AgentsNav />
		{/if}
	</div>

	<!-- Settings link -->
	<div class="px-2 py-2 border-t border-[var(--color-border)]">
		<button
			onclick={() => { navigationState.setPrimaryView('settings'); goto('/settings'); }}
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
