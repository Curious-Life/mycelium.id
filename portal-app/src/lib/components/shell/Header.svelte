<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { navigationState } from '$lib/stores/navigation';
	import { theme } from '$lib/stores/theme';
	import { viewLabel } from '$lib/nav/config';
	import { workspace } from '$lib/workspace/store';
	import TabStrip from '$lib/components/workspace/TabStrip.svelte';
	import type { WsNode, LeafPane } from '$lib/workspace/types';
	import { activity, startActivityPolling, fmtEta } from '$lib/stores/activity';

	// One consolidated activity indicator (next to chat) — ALWAYS present. A calm
	// dim dot when idle; accent + count + a clickable job list when work is running.
	let activityOpen = $state(false);
	const active = $derived($activity.active);
	onMount(() => startActivityPolling());

	const currentView = $derived($navigationState.primaryView);

	// Hoist the workspace tabs into the header row (one bar instead of two) for the
	// common single-pane case. When the workspace is split into multiple panes, each
	// pane keeps its own in-pane strip (Pane.svelte) and the header shows none.
	function collectLeaves(n: WsNode): LeafPane[] {
		return n.kind === 'leaf' ? [n] : [...collectLeaves(n.children[0]), ...collectLeaves(n.children[1])];
	}
	const onlyPane: LeafPane | null = $derived.by(() => {
		const leaves = collectLeaves($workspace.root);
		return leaves.length === 1 ? leaves[0] : null;
	});
	const chatOpen = $derived($navigationState.chatOpen);
	const currentTheme = $derived($theme);

	// In the native Mac shell the window has no title bar (overlay style), so the
	// header doubles as the drag strip. `data-tauri-drag-region` is the standard
	// mechanism; the mousedown fallback covers the case where the server-served
	// page (external URL) doesn't get the attribute handler wired.
	let isTauri = $state(false);
	onMount(() => { if (browser) isTauri = !!(window as any).__TAURI__ || !!(window as any).__TAURI_INTERNALS__; });

	function startWindowDrag(e: MouseEvent) {
		if (!isTauri || e.button !== 0) return;
		const t = e.target as HTMLElement;
		// Controls + the hoisted tab strip own their own gestures (click/drag-reorder).
		if (t.closest('button, a, input, select, textarea, [role="button"], .tab-strip')) return;
		try {
			// `withGlobalTauri` is OFF (hardening: no full Tauri API on window for the
			// remote origin), so reach the core window command through the internals
			// bridge, which Tauri injects for the granted origin regardless of the flag.
			// `core:window:allow-start-dragging` is granted in capabilities/default.json.
			(window as any).__TAURI_INTERNALS__?.invoke?.('plugin:window|start_dragging');
		} catch { /* not in Tauri / API shape differs — data-tauri-drag-region handles it */ }
	}


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
	class="app-header h-10 border-b border-[var(--color-border)] flex items-center px-2 sm:px-3 gap-1.5 sm:gap-2 bg-[var(--color-surface)] relative z-10 overflow-hidden flex-shrink-0"
>
	<!-- Sidebar toggle. macOS traffic-light clearance in the native shell is a
	     DETERMINISTIC CSS padding on `.app-header` under `html.is-tauri` (tagged
	     pre-paint in app.html) — not a post-mount spacer — so the hamburger never
	     flashes under the traffic lights nor lands mis-positioned. -->
	<button
		onclick={handleMenuClick}
		class="p-1 hover:bg-[var(--color-elevated)] rounded-md transition-colors text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] flex-shrink-0 hidden md:flex"
		aria-label="Toggle menu"
	>
		<svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
	</button>

	<!-- Brand wordmark removed: the app IS Mycelium and the mindscape page already
	     carries the name — a second "Mycelium" up here was pure duplication. The
	     menu + this empty strip stay draggable so the title bar still moves. -->
	<span class="hidden md:block w-2 select-none" data-tauri-drag-region></span>

	<!-- Mobile: page title -->
	<h2 class="md:hidden text-sm font-medium text-[var(--color-text-primary)] truncate">
		{viewLabel(currentView)}
	</h2>

	<!-- Workspace tabs, hoisted into the header (desktop, single pane) — one bar, not
	     two. Falls back to a flex spacer on mobile / when the workspace is split. -->
	{#if onlyPane}
		<div class="hidden md:flex flex-1 min-w-0 self-stretch overflow-hidden">
			<TabStrip
				inline
				tabs={onlyPane.tabs}
				activeTabId={onlyPane.activeTabId}
				paneId={onlyPane.id}
				onfocus={(id) => workspace.focusTab(id)}
				onclose={(id) => workspace.closeTab(id)}
				onopen={(viewId) => workspace.openInPane(onlyPane.id, viewId)}
				onreorder={(tabId, toIndex) => workspace.moveTabWithinPane(onlyPane.id, tabId, toIndex)}
			/>
		</div>
		<div class="flex-1 md:hidden"></div>
	{:else}
		<div class="flex-1"></div>
	{/if}

	<!-- Right side actions -->
	<div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
		<!-- Activity indicator — ALWAYS visible next to chat. Idle = a calm dim dot
		     ("Idle"); active = an accent dot + count, clickable for the live job list
		     (stage · done/total · ETA). The single source of truth for pipeline /
		     inference / background-job status. -->
		<div class="relative">
			<button
				onclick={() => { if (active.length) activityOpen = !activityOpen; }}
				class="h-7 px-2 rounded-full border flex items-center gap-1.5 transition-all duration-150 {active.length
					? 'border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-accent)] cursor-pointer'
					: 'border-[var(--color-border)]/60 bg-transparent text-[var(--color-text-tertiary)] cursor-default'}"
				title={active.length ? 'Background activity' : 'Idle'}
				aria-label={active.length ? `Background activity (${active.length})` : 'System idle'}
				aria-expanded={activityOpen}
			>
				{#if active.length}
					<span class="relative inline-flex h-2 w-2">
						<span class="animate-pulse absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-50"></span>
						<span class="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent)]"></span>
					</span>
					<span class="text-[11px] font-medium">{active.length}</span>
				{:else}
					<span class="inline-flex rounded-full h-2 w-2 bg-[var(--color-text-tertiary)]/70"></span>
				{/if}
			</button>
			{#if activityOpen && active.length}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="fixed inset-0 z-[59]" onclick={() => (activityOpen = false)}></div>
				<div class="fixed top-[2.75rem] right-2 sm:right-3 z-[60] min-w-[240px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg" style="backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);">
					<div class="px-2.5 py-1 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Active</div>
					{#each active as j (j.id)}
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

		<!-- Chat agent toggle (Cmd/Ctrl+J) — opens the floating tool-using agent. -->
		<button
			onclick={() => navigationState.toggleChat()}
			class="w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-150 {chatOpen
				? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
				: 'border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]'}"
			title="Chat with your vault (⌘J)"
			aria-label="Toggle chat"
			aria-pressed={chatOpen}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
		</button>

		<!-- Theme toggle -->
		<button
			onclick={toggleTheme}
			class="w-7 h-7 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)] transition-all duration-150"
			title={currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
			aria-label="Toggle theme"
		>
			{#if currentTheme === 'dark'}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
				</svg>
			{:else}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
