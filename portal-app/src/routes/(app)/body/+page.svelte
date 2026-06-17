<script lang="ts">
	// Thin route intent → open/focus the Body tab. The actual UI lives in
	// $lib/views/BodyView.svelte (registered as the 'body' view); the (app)
	// layout renders the workspace, not this page, so without the de-route the
	// body UI rendered into a hidden div and never showed.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('body', {});
	});
</script>
