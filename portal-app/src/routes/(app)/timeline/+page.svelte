<script lang="ts">
	// Thin route intent → open/focus the Streams tab on its Stream facet.
	// (Timeline merged into Streams — NAV-IA-LOCK-2026-06-08. Deep-link kept.)
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('streams', { facet: 'stream' }));
</script>
