<script lang="ts">
	/**
	 * Pipeline-status chip — shell-level indicator for the data-pipeline
	 * coordinator's state. Wave P4 of docs/PIPELINE-COORDINATOR-PLAN.md.
	 *
	 * Compact dot by default (green/aurum/amber/red). Click opens a
	 * popover with the current-stage label, progress, and any
	 * quarantined stages. Polls /portal/pipeline/status every 2 minutes
	 * and re-polls on open.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api';

	interface QuarantinedStage {
		stage: string;
		reason: string;
		since: string | null;
	}

	interface PipelineStatus {
		state: 'healthy' | 'processing' | 'waiting-for-data' | 'error';
		summary: string;
		currentStage: string | null;
		lastActivity: string | null;
		progress: { completed: number; total: number };
		quarantined: QuarantinedStage[];
	}

	let status = $state<PipelineStatus | null>(null);
	let open = $state(false);
	let loading = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		loading = true;
		try {
			const res = await api('/portal/pipeline/status');
			if (res.ok) status = await res.json();
		} catch {
			// Silent — chip will just not update. Not worth a UI error.
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
		if (open) load();
	}

	function close() {
		open = false;
	}

	onMount(() => {
		load();
		// Pipeline advances once per hour at most; 2-min poll is more
		// than fine and cheap on the endpoint (single D1 select).
		pollTimer = setInterval(load, 120_000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	function relativeTime(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.now() - Date.parse(iso);
		if (ms < 60_000) return 'just now';
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
		return `${Math.round(ms / 86_400_000)}d ago`;
	}

	const dotClass = $derived(
		status?.state === 'error' ? 'bg-coral' :
		status?.state === 'processing' ? 'bg-aurum animate-pulse' :
		status?.state === 'healthy' ? 'bg-jade' :
		'bg-[var(--color-text-tertiary)]',
	);

	const ariaLabel = $derived(
		status?.summary || 'Pipeline status unknown',
	);
</script>

<div class="relative">
	<button
		type="button"
		onclick={toggle}
		aria-label={ariaLabel}
		title={ariaLabel}
		class="w-8 h-8 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center justify-center hover:border-[var(--color-accent)] transition-all duration-150"
	>
		<span class="w-2 h-2 rounded-full {dotClass}"></span>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed inset-0 z-40"
			onclick={close}
		></div>
		<div
			class="absolute right-0 mt-2 w-80 z-50 rounded-xl border border-[var(--color-border)] shadow-2xl p-4"
			style="background: rgba(26, 26, 31, 0.98); backdrop-filter: blur(20px);"
			role="dialog"
			aria-label="Pipeline status detail"
		>
			<div class="flex items-center gap-2 mb-2">
				<span class="w-2 h-2 rounded-full {dotClass}"></span>
				<span class="text-sm font-medium text-[var(--color-text-emphasis)]">
					{status?.state === 'error' ? 'Pipeline error' :
					 status?.state === 'processing' ? 'Processing' :
					 status?.state === 'healthy' ? 'All caught up' :
					 status?.state === 'waiting-for-data' ? 'Waiting for data' :
					 loading ? 'Loading…' : 'Unknown'}
				</span>
			</div>

			{#if status}
				<p class="text-xs text-[var(--color-text-secondary)] mb-3 leading-relaxed">
					{status.summary}
				</p>

				<div class="flex items-center justify-between text-[11px] font-mono text-[var(--color-text-tertiary)] mb-3">
					<span>{status.progress.completed} / {status.progress.total} stages</span>
					<span>Last tick: {relativeTime(status.lastActivity)}</span>
				</div>

				<div class="w-full h-1 rounded-full bg-[var(--color-elevated)] overflow-hidden mb-3">
					<div
						class="h-full bg-aurum transition-all duration-500"
						style="width: {(status.progress.completed / Math.max(1, status.progress.total)) * 100}%"
					></div>
				</div>

				{#if status.quarantined.length > 0}
					<div class="mt-3 pt-3 border-t border-[var(--color-border)]">
						<p class="text-[11px] font-medium text-coral uppercase tracking-wider mb-2">
							Stuck stages
						</p>
						<ul class="space-y-1.5">
							{#each status.quarantined as q (q.stage)}
								<li class="text-xs">
									<div class="text-[var(--color-text-primary)]">{q.stage}</div>
									<div class="text-[10px] text-[var(--color-text-tertiary)] line-clamp-2">{q.reason}</div>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{:else if !loading}
				<p class="text-xs text-[var(--color-text-tertiary)] italic">
					Pipeline status unavailable.
				</p>
			{/if}
		</div>
	{/if}
</div>
