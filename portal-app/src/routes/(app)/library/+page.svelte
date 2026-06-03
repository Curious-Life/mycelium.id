<script lang="ts">
	// Thin route intent → open/focus the Library tab (carrying ?doc if deep-linked).
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { workspace } from '$lib/workspace/store';

	onMount(() => {
		const doc = $page.url.searchParams.get('doc');
		workspace.openFromRoute('library', doc ? { doc } : {});
	});
</script>
