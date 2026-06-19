<script lang="ts">
	// Thin route intent: ensure a Mindscape tab is open/focused in the workspace.
	// EXCEPTION: ?capture mode (3D snapshot/export) bypasses the shell and renders
	// the view full-screen — so render it directly here (the (app) layout already
	// renders children-only in capture mode).
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { workspace } from '$lib/workspace/store';
	import MindscapeView from '$lib/views/MindscapeView.svelte';

	const capture = browser && new URLSearchParams(window.location.search).has('capture');
	onMount(() => { if (!capture) workspace.openFromRoute('mindscape'); });
</script>

{#if capture}
	<MindscapeView active={true} />
{/if}
