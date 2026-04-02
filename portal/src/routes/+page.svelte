<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	onMount(() => {
		goto('/mindscape');
	});
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
	<div class="animate-pulse text-[var(--color-text-tertiary)]">Redirecting...</div>
</div>
