<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Sidebar from '$lib/components/shell/Sidebar.svelte';
	import Header from '$lib/components/shell/Header.svelte';
	import ChatFloat from '$lib/components/chat/ChatFloat.svelte';
	import BottomTabBar from '$lib/components/shell/BottomTabBar.svelte';
	import Toast from '$lib/components/shell/Toast.svelte';
	import ImportDropZone from '$lib/components/shell/ImportDropZone.svelte';
	import WorkspaceRoot from '$lib/components/workspace/WorkspaceRoot.svelte';
	import WelcomeModal from '$lib/components/WelcomeModal.svelte';
	import OnboardingGuide from '$lib/components/OnboardingGuide.svelte';
	import { api } from '$lib/api';
	import { navigationState } from '$lib/stores/navigation';
	import { workspace } from '$lib/workspace/store';
	import CommandPalette from '$lib/components/workspace/CommandPalette.svelte';

	const captureMode = browser && new URLSearchParams(window.location.search).has('capture');

	let { children } = $props();

	let paletteOpen = $state(false);   // ⌘K command palette

	const chatOpen = $derived($navigationState.chatOpen);

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

	// Onboarding: fetch status once to decide whether to show welcome + guide
	// The OnboardingGuide component does its own polling after this initial check.
	let welcomeOpen = $state(false);
	let showGuide = $state(false);

	async function checkOnboarding() {
		try {
			const res = await api('/portal/onboarding/status');
			if (!res.ok) return;
			const data = await res.json();
			welcomeOpen = !!data.showWelcome;
			showGuide = !!data.show;
		} catch {
			// Silent — user is probably not logged in or transient error
		}
	}

	function openMobileDrawer() {
		navigationState.setSidebarOpen(true);
	}

	// Keyboard shortcuts
	onMount(() => {
		if (!browser) return;
		checkOnboarding();
		// Phase C: router is up — let the workspace mirror the focused tab → URL.
		workspace.enableUrlSync();
		function handleKeydown(e: KeyboardEvent) {
			// Cmd+J (chat) is disabled in V1 — chat is deferred (no in-app agent
			// loop, D5). Re-enable when the chat surface lands.
			if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
				e.preventDefault();
				navigationState.toggleSidebar();
			}
			if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				paletteOpen = !paletteOpen;
			}
		}
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if captureMode}
	<div class="capture-viewport">
		{@render children()}
	</div>
{:else}
	<div class="h-screen flex flex-col bg-[var(--color-bg)] overflow-hidden">
		<Header />

		<div class="flex-1 flex overflow-hidden">
			<Sidebar />
			<main class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
				<div
					class="flex-1 min-h-0 overflow-hidden flex flex-col"
					class:mobile-content-area={isMobile}
				>
					<WorkspaceRoot />
				</div>
			</main>
		</div>
	</div>

	<!-- Route intents: each (app)/<view>/+page.svelte mounts, opens/focuses its
	     workspace tab, then renders nothing. Hidden so route changes drive tabs
	     (and every existing goto('/x') keeps working) without showing page UI. -->
	<div style="display: none" aria-hidden="true">{@render children()}</div>

	{#if !(isMobile && chatOpen)}
		<BottomTabBar onMoreTap={openMobileDrawer} />
	{/if}

	<ChatFloat visible={chatOpen} />
	<Toast />
	<ImportDropZone />
	<CommandPalette bind:open={paletteOpen} />

	<WelcomeModal bind:open={welcomeOpen} onComplete={() => { showGuide = true; }} />
	{#if showGuide}
		<OnboardingGuide onDismiss={() => { showGuide = false; }} />
	{/if}
{/if}

<style>
	.capture-viewport {
		width: 100vw;
		height: 100vh;
		overflow: hidden;
		background: #0A0A0C;
	}
</style>
