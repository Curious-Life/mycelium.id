<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	// Chat is now the floating overlay (ChatFloat) available on all pages
	onMount(() => {
		goto('/mindscape', { replaceState: true });
	});
</script>
