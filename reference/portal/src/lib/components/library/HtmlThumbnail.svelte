<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api';

	let {
		path,
		title = '',
		ariaLabel = '',
	}: { path: string; title?: string; ariaLabel?: string } = $props();

	// Module-scoped cache so a doc viewed in grid + list (or remounted)
	// doesn't re-hit the network. Keyed by path; value is a Promise so
	// concurrent mounts share one fetch.
	let cache: Map<string, Promise<string | null>>;
	if (typeof window !== 'undefined') {
		// @ts-expect-error attach to window to survive HMR
		cache = window.__libraryHtmlPreviewCache ||= new Map();
	} else {
		cache = new Map();
	}

	let container = $state<HTMLDivElement | null>(null);
	let scale = $state(0.25);
	let html = $state<string | null>(null);
	let loaded = $state(false);
	let visible = $state(false);
	let io: IntersectionObserver | null = null;
	let ro: ResizeObserver | null = null;

	// Logical viewport the iframe renders at — picked so a typical
	// agent-authored document (≈ desktop article width) downscales
	// cleanly into the thumbnail. The iframe is then transform-scaled
	// to fit the actual container width.
	const LOGICAL_WIDTH = 1024;

	async function loadContent() {
		if (html !== null) return;
		try {
			let p = cache.get(path);
			if (!p) {
				// /portal/documents/:path returns { document: { content, ... } }.
				// We only need the body for the iframe srcdoc.
				p = api(`/portal/documents/${path}`)
					.then(async (r) => (r.ok ? (await r.json()).document?.content || null : null))
					.catch(() => null);
				cache.set(path, p);
			}
			html = (await p) ?? '';
		} finally {
			loaded = true;
		}
	}

	function recomputeScale() {
		if (!container) return;
		const w = container.clientWidth;
		if (w > 0) scale = w / LOGICAL_WIDTH;
	}

	onMount(() => {
		if (!container) return;
		recomputeScale();
		ro = new ResizeObserver(recomputeScale);
		ro.observe(container);

		io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					visible = true;
					io?.disconnect();
					io = null;
					loadContent();
				}
			},
			{ rootMargin: '200px' },
		);
		io.observe(container);
	});

	onDestroy(() => {
		io?.disconnect();
		ro?.disconnect();
	});

	// Logical iframe height — keep it tall enough that a one-screen page
	// doesn't get cropped to a sliver after scaling. The container's
	// aspect ratio + overflow:hidden controls what the user actually sees.
	const LOGICAL_HEIGHT = 1400;
</script>

<div
	bind:this={container}
	class="relative w-full h-full overflow-hidden bg-white"
	aria-label={ariaLabel || `Preview of ${path}`}
>
	{#if visible && loaded && html}
		<iframe
			title={ariaLabel || path}
			srcdoc={html}
			sandbox="allow-scripts"
			loading="lazy"
			class="absolute top-0 left-0 border-0 pointer-events-none"
			style="width: {LOGICAL_WIDTH}px; height: {LOGICAL_HEIGHT}px; transform: scale({scale}); transform-origin: 0 0;"
		></iframe>
	{:else if visible && loaded && !html}
		<!-- Empty doc / fetch returned no content — show the same icon
			 + title fallback as a non-HTML card so the user sees
			 something meaningful instead of blank white. -->
		<div class="absolute inset-0 p-3 flex flex-col items-start gap-2 bg-[var(--color-elevated)] text-[var(--color-text-secondary)]">
			<svg class="w-3.5 h-3.5 text-[var(--color-text-tertiary)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
				<polyline points="14 2 14 8 20 8"/>
			</svg>
			{#if title}
				<span class="text-xs font-medium text-[var(--color-text-primary)] truncate w-full">{title}</span>
			{/if}
			<span class="text-[10px] text-[var(--color-text-tertiary)] truncate w-full">{path}</span>
		</div>
	{:else}
		<!-- Skeleton while waiting / loading -->
		<div class="absolute inset-0 bg-gradient-to-br from-[var(--color-elevated)] to-[var(--color-surface)] animate-pulse"></div>
	{/if}
</div>
