<script lang="ts">
	// Thin route intent → open/focus the Media tab. The actual UI lives in
	// $lib/views/MediaView.svelte (registered as the 'media' view); the (app)
	// layout renders the workspace, not this page, so without the de-route the
	// media UI rendered into a hidden div and never showed.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('media', {});
	});
</script>
