<script lang="ts">
	// A task in the unified river: title + status pill (+ priority / due).
	import { formatTime } from '$lib/timeline/utils';

	let { item }: { item: { createdAt: string; title?: string; status?: string; priority?: string; dueDate?: string; completedAt?: string } } = $props();
	const done = $derived(item.status === 'completed' || !!item.completedAt);
</script>

<article class="flex gap-2 sm:gap-3 items-start rounded-lg px-2 sm:px-3 py-2.5 -mx-2 sm:-mx-3 hover:bg-[var(--color-hover)] transition-colors">
	<div
		class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
		style="background: color-mix(in srgb, var(--color-accent-aurum) 16%, transparent); color: var(--color-accent-aurum);"
		title="Task"
	>
		<svg class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
			{#if done}
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
			{:else}
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
			{/if}
		</svg>
	</div>
	<div class="flex-1 min-w-0">
		<header class="flex items-baseline gap-2 mb-0.5 flex-wrap">
			<span class="text-xs font-medium text-[var(--color-text-primary)]">Task</span>
			<time class="text-[0.65rem] text-[var(--color-text-tertiary)]" datetime={item.createdAt}>{formatTime(item.createdAt)}</time>
		</header>
		<p class="text-sm text-[var(--color-text-secondary)]" class:line-through={done} class:opacity-60={done}>{item.title}</p>
		<div class="flex items-center gap-2 mt-1 flex-wrap">
			{#if item.status}
				<span class="text-[0.6rem] uppercase tracking-wider px-1.5 py-0.5 rounded"
					style="background: var(--color-elevated); color: {done ? 'var(--color-accent-jade)' : 'var(--color-text-tertiary)'};">{item.status}</span>
			{/if}
			{#if item.priority && item.priority !== 'normal'}
				<span class="text-[0.6rem] uppercase tracking-wider text-[var(--color-text-tertiary)]">{item.priority}</span>
			{/if}
			{#if item.dueDate}
				<span class="text-[0.6rem] text-[var(--color-text-tertiary)]">due {item.dueDate}</span>
			{/if}
		</div>
	</div>
</article>
