<script lang="ts">
	// MyceliumCanvas — thin Svelte wrapper around mycelium-engine (the landing
	// page's hyphal-network hero animation). Sizes to its parent; cleans up on destroy.
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { startMycelium } from './mycelium-engine';

	let canvas = $state<HTMLCanvasElement | undefined>();
	let stop: (() => void) | null = null;

	onMount(() => {
		if (!browser || !canvas) return;
		stop = startMycelium(canvas);
	});
	onDestroy(() => stop?.());
</script>

<canvas bind:this={canvas} class="mycelium-canvas"></canvas>

<style>
	.mycelium-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		pointer-events: none; /* decorative — never intercept clicks on the card */
	}
</style>
