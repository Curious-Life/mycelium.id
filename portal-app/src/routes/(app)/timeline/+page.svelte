<script lang="ts">
	// Thin route intent → open/focus the Timeline tab in the workspace.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('timeline'));
</script>
