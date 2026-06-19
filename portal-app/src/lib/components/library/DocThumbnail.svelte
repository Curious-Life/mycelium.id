<script lang="ts">
	/**
	 * DocThumbnail — preview for any library doc, picking the right
	 * render path by extension.
	 *
	 *   .html / .htm        → live render in a sandboxed iframe (same
	 *                         approach as HtmlThumbnail; logical 1024px
	 *                         viewport scaled down to fit the card)
	 *   .md / .markdown     → marked + DOMPurify HTML render, scaled
	 *                         like the HTML path so a long doc still
	 *                         "looks like a page" in thumbnail form
	 *   anything else       → first ~30 lines of plain text, monospaced,
	 *                         clipped on overflow
	 *
	 * The fetch + cache + lazy-mount pattern matches HtmlThumbnail —
	 * a doc viewed in grid + list (or remounted from a folder drill)
	 * doesn't re-hit the network.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { getDocPreview } from '$lib/stores/docPreviews';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { wrapHtmlForLive } from '$lib/iframe-live';

	let {
		path,
		title = '',
		ariaLabel = '',
	}: { path: string; title?: string; ariaLabel?: string } = $props();

	let container = $state<HTMLDivElement | null>(null);
	let scale = $state(0.25);
	let content = $state<string | null>(null);
	let loaded = $state(false);
	let visible = $state(false);
	let io: IntersectionObserver | null = null;
	let ro: ResizeObserver | null = null;

	const LOGICAL_WIDTH = 1024;
	const LOGICAL_HEIGHT = 1400;

	const ext = $derived((path.split('.').pop() || '').toLowerCase());
	const kind = $derived<'html' | 'markdown' | 'text'>(
		ext === 'html' || ext === 'htm'      ? 'html'
		: ext === 'md' || ext === 'markdown' ? 'markdown'
		: 'text',
	);

	// Marked + DOMPurify pass for markdown — done up front so the
	// preview renders without flashing raw markup.
	const markdownHtml = $derived.by(() => {
		if (kind !== 'markdown' || !content) return '';
		try {
			const raw = marked.parse(content, { gfm: true, breaks: true }) as string;
			return DOMPurify.sanitize(raw);
		} catch {
			return '';
		}
	});

	async function loadContent() {
		if (content !== null) return;
		try {
			// Batched snippet preview (one POST per frame of visible cards) instead
			// of a full-document fetch per card. See $lib/stores/docPreviews.
			content = (await getDocPreview(path)) ?? '';
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
</script>

<div
	bind:this={container}
	class="relative w-full h-full overflow-hidden"
	style="background: var(--color-surface);"
	aria-label={ariaLabel || `Preview of ${path}`}
>
	{#if visible && loaded && content}
		{#if kind === 'html'}
			<!-- Live render in sandboxed null-origin iframe — agent-authored
			     scripts run, but cannot reach portal cookies / parent DOM. -->
			<iframe
				title={ariaLabel || path}
				srcdoc={wrapHtmlForLive(content)}
				sandbox="allow-scripts"
				loading="lazy"
				class="absolute top-0 left-0 border-0 pointer-events-none"
				style="width: {LOGICAL_WIDTH}px; height: {LOGICAL_HEIGHT}px; transform: scale({scale}); transform-origin: 0 0; background: Canvas;"
			></iframe>
		{:else if kind === 'markdown'}
			<!-- Markdown rendered, scaled down. The `prose` styling
			     gives headings + lists + paragraphs visible structure
			     so the thumbnail reads as "a page" rather than a wall
			     of text. -->
			<div
				class="absolute top-0 left-0 doc-thumb-prose pointer-events-none"
				style="width: {LOGICAL_WIDTH}px; height: {LOGICAL_HEIGHT}px; transform: scale({scale}); transform-origin: 0 0; padding: 32px 40px;"
			>
				{@html markdownHtml}
			</div>
		{:else}
			<!-- Plain text: monospaced, the doc's actual content. Same
			     scale trick as HTML/markdown so a 200-line file still
			     fits in the card with readable type. -->
			<pre
				class="absolute top-0 left-0 m-0 whitespace-pre-wrap font-mono text-[14px] leading-[1.5] pointer-events-none"
				style="width: {LOGICAL_WIDTH}px; height: {LOGICAL_HEIGHT}px; transform: scale({scale}); transform-origin: 0 0; padding: 32px 40px; word-break: break-word; color: var(--color-text-primary);"
			>{content}</pre>
		{/if}
	{:else if visible && loaded && !content}
		<!-- Empty doc / fetch returned no content -->
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
		<!-- Skeleton -->
		<div class="absolute inset-0 bg-gradient-to-br from-[var(--color-elevated)] to-[var(--color-surface)] animate-pulse"></div>
	{/if}
</div>

<style>
	/* Lightweight typography for markdown thumbnails. We can't use
	   global @tailwindcss/typography here because the rule set is too
	   heavy for a thumbnail render. These selectors apply only inside
	   .doc-thumb-prose.

	   Colors use the portal's semantic tokens so the thumbnail follows
	   the active theme (dark by default; light when [data-theme="light"]
	   is set on <html>). Thumbnails used to be hardcoded to a paper-light
	   aesthetic regardless of theme — see 2026-05-07. */
	:global(.doc-thumb-prose) { color: var(--color-text-primary); font-family: ui-sans-serif, system-ui, sans-serif; }
	:global(.doc-thumb-prose h1) { font-size: 28px; font-weight: 600; margin: 0 0 14px; line-height: 1.2; color: var(--color-text-emphasis); }
	:global(.doc-thumb-prose h2) { font-size: 22px; font-weight: 600; margin: 18px 0 10px; line-height: 1.25; color: var(--color-text-emphasis); }
	:global(.doc-thumb-prose h3) { font-size: 18px; font-weight: 600; margin: 14px 0 8px; line-height: 1.3; }
	:global(.doc-thumb-prose p) { margin: 0 0 12px; line-height: 1.55; }
	:global(.doc-thumb-prose ul), :global(.doc-thumb-prose ol) { margin: 0 0 12px; padding-left: 22px; line-height: 1.55; }
	:global(.doc-thumb-prose li) { margin: 0 0 4px; }
	:global(.doc-thumb-prose code) { font-family: ui-monospace, monospace; font-size: 0.92em; background: var(--color-elevated); padding: 1px 4px; border-radius: 3px; }
	:global(.doc-thumb-prose pre) { background: var(--color-elevated); padding: 8px 10px; border-radius: 4px; overflow: hidden; font-size: 12px; }
	:global(.doc-thumb-prose blockquote) { border-left: 3px solid var(--color-border); padding-left: 10px; color: var(--color-text-secondary); margin: 0 0 12px; }
	:global(.doc-thumb-prose a) { color: var(--color-accent-aurum); text-decoration: underline; }
	:global(.doc-thumb-prose img) { max-width: 100%; height: auto; }
</style>
