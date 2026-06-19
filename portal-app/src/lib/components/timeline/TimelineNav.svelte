<script lang="ts">
	import { navigationState } from '$lib/stores/navigation';

	const state = $derived($navigationState);
	const zoom = $derived(state.timelineZoom);

	const zoomLevels: { id: typeof zoom; label: string }[] = [
		{ id: 'year',    label: 'Year' },
		{ id: 'quarter', label: 'Quarter' },
		{ id: 'month',   label: 'Month' },
		{ id: 'week',    label: 'Week' },
	];
</script>

<div class="flex flex-col h-full">
	<!-- Header with Zoom Controls -->
	<div class="px-4 py-3 border-b border-[var(--color-border)]">
		<div class="flex items-center justify-between mb-3">
			<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
				Timeline
			</span>
		</div>

		<!-- Zoom Controls -->
		<div class="flex gap-1">
			{#each zoomLevels as level}
				{@const isActive = zoom === level.id}
				<button
					class="px-3 py-1.5 text-xs rounded-lg transition-all duration-150 cursor-pointer
						{isActive
						? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] font-medium'
						: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
					onclick={() => navigationState.setTimelineZoom(level.id)}
					title={level.label}
				>
					{level.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Spacer -->
	<div class="flex-1"></div>

	<!-- Quick Jump Section -->
	<div class="px-4 py-3 border-t border-[var(--color-border)]">
		<div class="flex items-center justify-between mb-2">
			<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
				Jump to
			</span>
		</div>
		<div class="flex gap-2">
			<button
				class="flex-1 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] rounded-lg transition-colors"
			>
				Today
			</button>
			<button
				class="flex-1 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] rounded-lg transition-colors"
			>
				Last Week
			</button>
			<button
				class="flex-1 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)] rounded-lg transition-colors"
			>
				Last Month
			</button>
		</div>
	</div>
</div>
