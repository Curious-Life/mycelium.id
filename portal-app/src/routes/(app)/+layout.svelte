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
	import OnboardingFlow from '$lib/components/onboarding/OnboardingFlow.svelte';
	import { navigationState } from '$lib/stores/navigation';
	import { workspace } from '$lib/workspace/store';
	import CommandPalette from '$lib/components/workspace/CommandPalette.svelte';

	const captureMode = browser && new URLSearchParams(window.location.search).has('capture');

	// Embed mode (the native iOS app's WKWebview): hide the web chrome — Header,
	// Sidebar, BottomTabBar, ChatFloat — so the native tab bar is the SINGLE nav.
	// Set once via ?embed=1 and persisted in sessionStorage so it survives the SPA's
	// client-side navigations within the same webview session.
	if (browser && new URLSearchParams(window.location.search).has('embed')) {
		try { sessionStorage.setItem('myc_embed', '1'); } catch { /* private mode */ }
	}
	const embed = browser && (
		new URLSearchParams(window.location.search).has('embed') ||
		(() => { try { return sessionStorage.getItem('myc_embed') === '1'; } catch { return false; } })()
	);

	let { children } = $props();

	let paletteOpen = $state(false);   // ⌘K command palette

	const chatOpen = $derived($navigationState.chatOpen);

	// Native shell bridge: tell the iOS app when the in-app chat is open so it can
	// hide its floating Record button (which otherwise overlaps chat's controls).
	// Guarded — a plain no-op in a normal browser (no webkit message handler).
	$effect(() => {
		if (!browser) return;
		try {
			(window as any).webkit?.messageHandlers?.mycChat?.postMessage(chatOpen ? 1 : 0);
		} catch { /* not running inside the native shell */ }
	});

	// Native shell → portal: let the iOS Chat action open the (nicely-formatted)
	// in-app chat instead of a bare native chat. Idempotent (won't toggle closed).
	onMount(() => {
		if (!browser) return;
		(window as any).__mycOpenChat = () => {
			if (!$navigationState.chatOpen) navigationState.toggleChat();
		};
		return () => { try { delete (window as any).__mycOpenChat; } catch { /* noop */ } };
	});

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

	// Onboarding is fully owned by OnboardingFlow (the unified v2 controller —
	// state machine over /portal/onboarding/status + providers + mindscape). The
	// layout just mounts it; it self-gates (welcome → import → connect → generate).

	function openMobileDrawer() {
		navigationState.setSidebarOpen(true);
	}

	// Keyboard shortcuts
	onMount(() => {
		if (!browser) return;
		// Phase C: router is up — let the workspace mirror the focused tab → URL.
		workspace.enableUrlSync();
		function handleKeydown(e: KeyboardEvent) {
			// Cmd/Ctrl+J toggles the floating chat agent (the in-app tool-using
			// agent over the vault — src/portal-chat.js).
			if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
				e.preventDefault();
				navigationState.toggleChat();
			}
			// Cmd/Ctrl+\ toggles the sidebar. — chat is deferred (no in-app agent
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
	<div class="app-shell flex flex-col bg-[var(--color-bg)] overflow-hidden">
		{#if !embed}<Header />{/if}

		<div class="flex-1 flex overflow-hidden">
			{#if !embed}<Sidebar />{/if}
			<main class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
				<div
					class="flex-1 min-h-0 overflow-hidden flex flex-col"
					class:mobile-content-area={isMobile && !embed}
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

	{#if !embed && !(isMobile && chatOpen)}
		<BottomTabBar onMoreTap={openMobileDrawer} />
	{/if}

	{#if !embed}<ChatFloat visible={chatOpen} />{/if}
	<Toast />
	<ImportDropZone />
	<CommandPalette bind:open={paletteOpen} />

	<OnboardingFlow />
{/if}

<style>
	/* Dynamic viewport height: plain 100vh on iOS Safari/WKWebView is the LARGE
	   viewport (excludes the dynamic toolbar), so the bottom of the app is clipped
	   behind the browser chrome. 100dvh tracks the visible viewport; the preceding
	   100vh line is the fallback for engines without dvh. */
	.app-shell {
		height: 100vh;
		height: 100dvh;
	}
	.capture-viewport {
		width: 100vw;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		background: #0A0A0C;
	}
</style>
