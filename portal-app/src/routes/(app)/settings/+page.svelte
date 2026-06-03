<script lang="ts">
	// Thin route intent → open/focus the Settings tab in the workspace.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('settings'));
</script>
