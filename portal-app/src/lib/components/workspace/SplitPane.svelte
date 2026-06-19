<script lang="ts">
	// A split: two children + a draggable divider. Resize is IMPERATIVE (mutate
	// flex-basis directly during the drag, like ChatFloat, to avoid Svelte thrash),
	// committing the final ratio to the store on pointerup.
	import { workspace } from '$lib/workspace/store';
	import type { SplitNode } from '$lib/workspace/types';
	import type { Snippet } from 'svelte';

	let { split, a, b }: { split: SplitNode; a: Snippet; b: Snippet } = $props();

	let container: HTMLDivElement;
	let childA: HTMLDivElement;
	let childB: HTMLDivElement;
	let resizing = false;

	function startResize(e: PointerEvent) {
		e.preventDefault();
		resizing = true;
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		document.body.style.cursor = split.dir === 'h' ? 'col-resize' : 'row-resize';
		document.body.style.userSelect = 'none';
	}
	function onMove(e: PointerEvent) {
		if (!resizing || !container) return;
		const rect = container.getBoundingClientRect();
		let pct = split.dir === 'h'
			? ((e.clientX - rect.left) / rect.width) * 100
			: ((e.clientY - rect.top) / rect.height) * 100;
		pct = Math.max(15, Math.min(85, pct));
		if (childA) childA.style.flexBasis = pct + '%';
		if (childB) childB.style.flexBasis = 100 - pct + '%';
	}
	function onUp() {
		if (!resizing) return;
		resizing = false;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		const basis = childA ? parseFloat(childA.style.flexBasis) : split.sizes[0];
		if (!Number.isNaN(basis)) workspace.resizeSplit(split.id, [basis, 100 - basis]);
	}
</script>

<div class="split {split.dir}" bind:this={container}>
	<div class="child" bind:this={childA} style="flex-basis: {split.sizes[0]}%">{@render a()}</div>
	<button class="divider" aria-label="Resize panes" title="Drag to resize" onpointerdown={startResize}></button>
	<div class="child" bind:this={childB} style="flex-basis: {split.sizes[1]}%">{@render b()}</div>
</div>

<style>
	.split { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
	.split.h { flex-direction: row; }
	.split.v { flex-direction: column; }
	.child { flex-grow: 0; flex-shrink: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
	.divider {
		flex: 0 0 auto; border: none; padding: 0; background: var(--color-border);
		transition: background var(--duration-fast, 120ms) ease; z-index: 5;
	}
	.split.h > .divider { width: 4px; cursor: col-resize; }
	.split.v > .divider { height: 4px; cursor: row-resize; }
	.divider:hover, .divider:active { background: var(--color-accent); }
</style>
