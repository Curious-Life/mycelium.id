<script lang="ts">
	// Profile is no longer a standalone tab — it's the first pane of the unified
	// Settings hub (one home for "you"). This route redirects into the hub so old
	// /profile links and bookmarks keep working.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('settings', { pane: 'profile' }));
</script>
