<script lang="ts">
	// Thin route intent → Body folds into Streams as its 'body' facet, so a /body
	// deep-link focuses the Streams tab and selects that facet. The UI lives in
	// $lib/views/BodyView.svelte, rendered by StreamsView.
	import { onMount } from 'svelte';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		workspace.openFromRoute('streams', { facet: 'body' });
	});
</script>
