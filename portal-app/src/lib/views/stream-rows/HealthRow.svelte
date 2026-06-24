<script lang="ts">
	// A health day in the unified river: one summary line (Sleep · steps · HRV).
	import { sourcePresentation } from '$lib/streams/sources';
	import { formatTime } from '$lib/timeline/utils';

	let { item }: { item: { source: string; createdAt: string; date?: string; preview?: string } } = $props();
	const p = $derived(sourcePresentation(item.source));
</script>

<article class="flex gap-2 sm:gap-3 items-start rounded-lg px-2 sm:px-3 py-2.5 -mx-2 sm:-mx-3 hover:bg-[var(--color-hover)] transition-colors">
	<div
		class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
		style="background: color-mix(in srgb, {p.color} 16%, transparent); color: {p.color};"
		title={p.title}
	>
		<svg class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
		</svg>
	</div>
	<div class="flex-1 min-w-0">
		<header class="flex items-baseline gap-2 mb-0.5 flex-wrap">
			<span class="text-xs font-medium text-[var(--color-text-primary)]">{p.title}</span>
			<span class="text-[0.65rem] text-[var(--color-text-tertiary)]">·&nbsp;{item.date}</span>
			<time class="text-[0.65rem] text-[var(--color-text-tertiary)]" datetime={item.createdAt}>{formatTime(item.createdAt)}</time>
		</header>
		<p class="text-sm text-[var(--color-text-secondary)]">{item.preview}</p>
	</div>
</article>
