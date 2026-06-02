<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { navigationState } from '$lib/stores/navigation';
	import { theme } from '$lib/stores/theme';
	import PipelineStatusChip from './PipelineStatusChip.svelte';

	const currentView = $derived($navigationState.primaryView);
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
		if (t.closest('button, a, input, select, textarea, [role="button"]')) return; // let controls work
		try {
			const tauri = (window as any).__TAURI__;
			const getWin = tauri?.window?.getCurrentWindow || tauri?.webviewWindow?.getCurrentWebviewWindow;
			getWin?.()?.startDragging?.();
		} catch { /* not in Tauri / API shape differs — the attribute handles it */ }
	}

	const viewLabels: Record<string, string> = {
		mindscape: 'Mycelium',
		library: 'Library',
		timeline: 'Timeline',
		activity: 'Activity',
		agents: 'Agents',
		profile: 'Profile',
		connections: 'Connections',
		contexts: 'Spaces',
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
     bar). Buttons/links inside are not drag regions, so they stay clickable. -->
<header
	data-tauri-drag-region
	onmousedown={startWindowDrag}
	class="h-12 md:h-14 border-b border-[var(--color-border)] flex items-center px-3 sm:px-4 gap-2 sm:gap-4 bg-[var(--color-surface)] relative z-10 overflow-hidden flex-shrink-0"
>
	<!-- macOS traffic-light clearance in the native shell (overlay title bar). -->
	{#if isTauri}
		<div class="w-[68px] shrink-0 hidden md:block" data-tauri-drag-region></div>
	{/if}

	<!-- Sidebar toggle — visible on all sizes -->
	<button
		onclick={handleMenuClick}
		class="p-2 hover:bg-[var(--color-elevated)] rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] flex-shrink-0 hidden md:flex"
		aria-label="Toggle menu"
	>
		<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16" />
		</svg>
	</button>

	<!-- Mobile: page title -->
	<h2 class="md:hidden text-sm font-medium text-[var(--color-text-primary)] truncate">
		{viewLabels[currentView] || 'Mycelium'}
	</h2>

	<!-- Flex spacer -->
	<div class="flex-1"></div>

	<!-- Right side actions -->
	<div class="flex items-center gap-1 sm:gap-2 flex-shrink-0">
		<!-- Chat is deferred in V1 (no in-app agent loop — D5); the toggle is
		     hidden until the chat surface lands. See docs/UX-COMPLETE-DESIGN. -->

		<!-- Pipeline coordinator status (Wave P4) -->
		<PipelineStatusChip />

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
