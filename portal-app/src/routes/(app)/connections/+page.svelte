<script lang="ts">
	// Thin route intent → open/focus the Connections tab in the workspace.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('connections'));
</script>
