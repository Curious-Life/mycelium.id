<script lang="ts">
	// Thin route intent → open/focus the Profile tab in the workspace.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';
	onMount(() => workspace.openFromRoute('profile'));
</script>
