<script lang="ts">
	// Thin route intent → open/focus the Agents tab. The actual UI lives in
	// $lib/views/AgentsView.svelte (registered as the 'agents' view); the (app)
	// layout renders the workspace, not this page, so without the de-route the
	// agents UI rendered into a hidden div and never showed.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('agents', {});
	});
</script>
