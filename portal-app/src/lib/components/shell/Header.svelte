<script lang="ts">
	import { navigationState } from '$lib/stores/navigation';
	import { theme } from '$lib/stores/theme';
	import PipelineStatusChip from './PipelineStatusChip.svelte';

	const chatOpen = $derived($navigationState.chatOpen);
	const currentView = $derived($navigationState.primaryView);
	const currentTheme = $derived($theme);

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

	function toggleChat() {
		navigationState.toggleChat();
	}

	function toggleTheme() {
		theme.toggle();
	}
</script>

<header
	class="h-12 md:h-14 border-b border-[var(--color-border)] flex items-center px-3 sm:px-4 gap-2 sm:gap-4 bg-[var(--color-surface)] relative z-10 overflow-hidden flex-shrink-0"
>
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
		<!-- Chat toggle — desktop only (mobile uses tab bar) -->
		<button
			onclick={toggleChat}
			class="hidden md:flex relative p-2 rounded-lg transition-colors
				{chatOpen
				? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
			aria-label="Toggle chat"
			title="Chat with Mycelium (Cmd+J)"
		>
			<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="1.5"
					d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
				/>
			</svg>
		</button>

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
