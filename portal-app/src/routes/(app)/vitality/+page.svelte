<script lang="ts">
	// Thin route intent → open/focus the Vitality tab. The actual UI lives in
	// $lib/views/VitalityView.svelte (registered as the 'vitality' view); the (app)
	// layout renders the workspace, not this page, so without the de-route the
	// vitality UI rendered into a hidden div and never showed.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('vitality', {});
	});
</script>
