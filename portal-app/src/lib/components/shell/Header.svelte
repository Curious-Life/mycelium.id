<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { navigationState } from '$lib/stores/navigation';
	import { theme } from '$lib/stores/theme';
	import { activity, startActivityPolling, fmtEta } from '$lib/stores/activity';

	let activityOpen = $state(false);

	const currentView = $derived($navigationState.primaryView);
	const chatOpen = $derived($navigationState.chatOpen);
	const currentTheme = $derived($theme);

	// In the native Mac shell the window has no title bar (overlay style), so the
	// header doubles as the drag strip. `data-tauri-drag-region` is the standard
	// mechanism; the mousedown fallback covers the case where the server-served
	// page (external URL) doesn't get the attribute handler wired.
	let isTauri = $state(false);
	onMount(() => { if (browser) isTauri = !!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__; });
	// Poll the unified activity feed so the stream dot is live on every page.
	onMount(() => startActivityPolling());

	function startWindowDrag(e: MouseEvent) {
		if (!isTauri || e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest('button, a, input, select, textarea, [role="button"]')) return; // let controls work
		try {
			// `withGlobalTauri` is OFF (hardening: no full Tauri API on window for the
			// remote origin), so reach the core window command through the internals
			// bridge, which Tauri injects for the granted origin regardless of the flag.
			// `core:window:allow-start-dragging` is granted in capabilities/default.json.
			(window as any).__TAURI_INTERNALS__?.invoke?.('plugin:window|start_dragging');
		} catch { /* not in Tauri / API shape differs — data-tauri-drag-region handles it */ }
	}

	const viewLabels: Record<string, string> = {
		mindscape: 'Mycelium',
		library: 'Library',
		streams: 'Streams',
		timeline: 'Streams',
		people: 'People',
		activity: 'Activity',
		agents: 'Agents',
		profile: 'Profile',
		'curious-life': 'Curious Life',
		connections: 'Connections',
		contexts: 'Sharing',
		wealth: 'Wealth',
		intel: 'Intel',
		settings: 'Settings',
		import: 'Import',
		media: 'Media',
		modules: 'Modules',
		cycles: 'Cycles',
		vitality: 'Vitality',
		chat: 'Chat',
	};

	function handleMenuClick() {
		navigationState.toggleSidebar();
	}

	function toggleTheme() {
		theme.toggle();
	}
</script>

<!-- The whole bar is a window-drag handle in the native shell (no native title
     bar). Buttons/links inside are not drag regions, so they stay clickable.
     The mousedown only initiates an OS window-drag — there is no keyboard
     equivalent and no fitting ARIA role, so the static-interaction rule is
     intentionally ignored here. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	data-tauri-drag-region
	onmousedown={startWindowDrag}
	class="app-header h-12 md:h-14 border-b border-[var(--color-border)] flex items-center px-3 sm:px-4 gap-2 sm:gap-3 bg-[var(--color-surface)] relative z-10 overflow-hidden flex-shrink-0"
>
	<!-- Sidebar toggle. macOS traffic-light clearance in the native shell is a
	     DETERMINISTIC CSS padding on `.app-header` under `html.is-tauri` (tagged
	     pre-paint in app.html) — not a post-mount spacer — so the hamburger never
	     flashes under the traffic lights nor lands mis-positioned. -->
	<button
		onclick={handleMenuClick}
		class="p-2 hover:bg-[var(--color-elevated)] rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] flex-shrink-0 hidden md:flex"
		aria-label="Toggle menu"
	>
		<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
	</button>

	<!-- Brand wordmark removed: the app IS Mycelium and the mindscape page already
	     carries the name — a second "Mycelium" up here was pure duplication. The
	     menu + this empty strip stay draggable so the title bar still moves. -->
	<span class="hidden md:block w-2 select-none" data-tauri-drag-region></span>

	<!-- Mobile: page title -->
	<h2 class="md:hidden text-sm font-medium text-[var(--color-text-primary)] truncate">
		{viewLabels[currentView] || 'Mycelium'}
	</h2>

	<!-- Flex spacer -->
	<div class="flex-1"></div>

	<!-- Right side actions -->
	<div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
		<!-- Activity stream dot — pulses while background/inference jobs run; click
		     for the live list (stage · done/total · ETA). Reads the unified feed. -->
		{#if $activity.active.length > 0}
			<div class="relative">
				<button
					onclick={() => (activityOpen = !activityOpen)}
					class="h-8 px-2 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center gap-1.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition-all"
					title="Background activity"
					aria-label={`Background activity (${$activity.active.length})`}
					aria-expanded={activityOpen}
				>
					<span class="relative flex h-2 w-2">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-60"></span>
						<span class="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent)]"></span>
					</span>
					<span class="text-[11px] font-medium">{$activity.active.length}</span>
				</button>
				{#if activityOpen}
					<!-- Click-away backdrop (transparent) — closes the popover on
					     any outside click/scroll-tap. -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div class="fixed inset-0 z-[59]" onclick={() => (activityOpen = false)}></div>
					<!-- POSITION: FIXED, not absolute. The .app-header has overflow-hidden
					     (drag-strip clip), which was scissoring this top-full dropdown into
					     an invisible sliver under the content. A viewport-anchored fixed
					     popover escapes the clip. No ancestor has transform/filter, so
					     fixed resolves to the viewport. Offset matches header height
					     (h-12 / md:h-14) + the right padding (px-3 / sm:px-4). -->
					<div class="fixed top-[3.25rem] md:top-[3.75rem] right-3 sm:right-4 z-[60] min-w-[240px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg" style="backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);">
						<div class="px-2.5 py-1 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Active</div>
						{#each $activity.active as j (j.id)}
							<div class="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
								<span class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] flex-shrink-0"></span>
								<span class="text-[var(--color-text-primary)] truncate">{j.stage}</span>
								{#if j.total > 0}<span class="text-[var(--color-text-tertiary)] flex-shrink-0">{j.done}/{j.total}</span>{/if}
								{#if fmtEta(j.etaSeconds)}<span class="ml-auto text-[var(--color-accent)] flex-shrink-0">{fmtEta(j.etaSeconds)} left</span>{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Chat agent toggle (Cmd/Ctrl+J) — opens the floating tool-using agent. -->
		<button
			onclick={() => navigationState.toggleChat()}
			class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-150 {chatOpen
				? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
				: 'border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]'}"
			title="Chat with your vault (⌘J)"
			aria-label="Toggle chat"
			aria-pressed={chatOpen}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
		</button>

		<!-- Theme toggle -->
		<button
			onclick={toggleTheme}
			class="w-8 h-8 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)] transition-all duration-150"
			title={currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
			aria-label="Toggle theme"
		>
			{#if currentTheme === 'dark'}
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
				</svg>
			{:else}
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="5" />
					<line x1="12" y1="1" x2="12" y2="3" />
					<line x1="12" y1="21" x2="12" y2="23" />
					<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
					<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
					<line x1="1" y1="12" x2="3" y2="12" />
					<line x1="21" y1="12" x2="23" y2="12" />
					<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
					<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
				</svg>
			{/if}
		</button>
	</div>
</header>
