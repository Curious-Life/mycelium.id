<script lang="ts">
	// A document item in the unified river: title + summary preview. Full content is
	// a click-through (deferred). Badge colour/monogram from the source registry.
	import { sourcePresentation } from '$lib/streams/sources';
	import { formatTime } from '$lib/timeline/utils';

	let { item }: { item: { source: string; createdAt: string; title?: string; preview?: string; path?: string; sourceType?: string } } = $props();
	const p = $derived(sourcePresentation(item.source));
	const title = $derived(item.title || item.path || 'Untitled');
</script>

<article class="flex gap-2 sm:gap-3 items-start rounded-lg px-2 sm:px-3 py-2.5 -mx-2 sm:-mx-3 hover:bg-[var(--color-hover)] transition-colors">
	<div
		class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
		style="background: color-mix(in srgb, {p.color} 16%, transparent); color: {p.color};"
		title={p.title}
	>
		<svg class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
		</svg>
	</div>
	<div class="flex-1 min-w-0">
		<header class="flex items-baseline gap-2 mb-0.5 flex-wrap">
			<span class="text-xs font-medium text-[var(--color-text-primary)] truncate">{title}</span>
			<span class="text-[0.65rem] text-[var(--color-text-tertiary)]">·&nbsp;{p.title}</span>
			<time class="text-[0.65rem] text-[var(--color-text-tertiary)]" datetime={item.createdAt}>{formatTime(item.createdAt)}</time>
		</header>
		{#if item.preview}
			<p class="text-sm text-[var(--color-text-secondary)] line-clamp-2">{item.preview}</p>
		{/if}
	</div>
</article>
