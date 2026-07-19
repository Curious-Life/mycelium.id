<script lang="ts">
	// Thin route intent → open/focus this agent's character tab in the workspace.
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('character', { id: $page.params.id }));
</script>
