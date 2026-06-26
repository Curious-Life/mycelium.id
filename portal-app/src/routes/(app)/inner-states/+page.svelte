<script lang="ts">
	// Thin route intent → open/focus the Inner States tab. The UI lives in
	// $lib/views/InnerStatesView.svelte (registered as the 'inner-states' view); the
	// (app) layout renders the workspace by REGISTRY, not this page.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('inner-states', {});
	});
</script>
