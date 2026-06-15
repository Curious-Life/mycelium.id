<script lang="ts">
	// Thin route intent → open/focus the Settings hub, carrying the deep-linked
	// pane. `?pane=<id>` is canonical; `?tab=<id>` is the pre-2026-06 alias kept
	// alive so old links (onboarding, mindscape, chat) still land on the right
	// pane. Profile is folded in as the first pane (one hub, no separate page).
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { workspace } from '$lib/workspace/store';

	// Old top-tab ids → new pane ids. Only the renamed one needs mapping.
	const TAB_ALIAS: Record<string, string> = {
		connection: 'connections',
	};

	onMount(() => {
		const sp = $page.url.searchParams;
		const raw = sp.get('pane') || sp.get('tab') || '';
		const pane = TAB_ALIAS[raw] || raw;
		workspace.openFromRoute('settings', pane ? { pane } : {});
	});
</script>
