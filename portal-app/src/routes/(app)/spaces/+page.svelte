<script lang="ts">
	// Thin route intent → open/focus the Spaces tab in the workspace.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('spaces'));
</script>
