<script lang="ts">
	// Thin route intent → open/focus this space's tab in the workspace.
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('space', { id: $page.params.id }));
</script>
