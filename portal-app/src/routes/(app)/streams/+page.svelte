<script lang="ts">
	// Thin route intent → open/focus the Streams tab (carrying ?facet if deep-linked).
	// Streams = Import + Timeline merged (NAV-IA-LOCK-2026-06-08).
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		const facet = $page.url.searchParams.get('facet');
		workspace.openFromRoute('streams', facet === 'sources' ? { facet: 'sources' } : {});
	});
</script>
