<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Sidebar from '$lib/components/shell/Sidebar.svelte';
	import Header from '$lib/components/shell/Header.svelte';
	import ChatFloat from '$lib/components/chat/ChatFloat.svelte';
	import Toast from '$lib/components/shell/Toast.svelte';
	import { navigationState } from '$lib/stores/navigation';

	let { children } = $props();

	const chatOpen = $derived($navigationState.chatOpen);

	// Keyboard shortcuts
	onMount(() => {
		if (!browser) return;
		function handleKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
				e.preventDefault();
				navigationState.toggleChat();
			}
			if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
				e.preventDefault();
				navigationState.toggleSidebar();
			}
		}
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div class="h-screen flex flex-col bg-[var(--color-bg)] overflow-hidden">
	<Header />

	<div class="flex-1 flex overflow-hidden">
		<Sidebar />
		<main class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
			<div class="flex-1 min-h-0 overflow-hidden flex flex-col">
				{@render children()}
			</div>
		</main>
	</div>
</div>

<ChatFloat visible={chatOpen} />
<Toast />
