<script lang="ts">
	// Inspect a single agent run — what actually happened: the conversation it ran on (the
	// owner's own decrypted messages) + the hash-only record of any vault writes it made.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	let { runId, onClose }: { runId: string; onClose: () => void } = $props();

	interface Msg { role: string; content: string; source?: string | null; createdAt?: string | null; }
	interface Write { tool: string; trigger?: string; argHash?: string | null; createdAt?: string | null; }
	interface Run {
		id: string; trigger: string; status: string; who: string; where: string;
		inputTokens?: number | null; outputTokens?: number | null; error?: string | null;
		startedAt?: string | null; finishedAt?: string | null; taskName?: string | null;
	}

	let run = $state<Run | null>(null);
	let messages = $state<Msg[]>([]);
	let writes = $state<Write[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	onMount(async () => {
		try {
			const res = await api(`/portal/agent-activity/${encodeURIComponent(runId)}`);
			if (!res?.ok) { error = res?.status === 404 ? 'Run not found' : 'Could not load'; return; }
			const data = await res.json();
			run = data.run; messages = data.messages || []; writes = data.writes || [];
		} catch (e) { error = e instanceof Error ? e.message : 'load failed'; }
		finally { loading = false; }
	});

	function ts(s?: string | null): string { return s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
	onclick={onClose}
	onkeydown={(e) => e.key === 'Escape' && onClose()}
	role="button"
	tabindex="-1"
>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-xl" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
		<div class="flex items-center gap-2 px-5 py-3 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-surface)]">
			<h3 class="text-sm font-medium text-[var(--color-text-primary)]">Activity detail</h3>
			<button onclick={onClose} class="ml-auto text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] cursor-pointer text-lg leading-none">×</button>
		</div>

		<div class="px-5 py-4">
			{#if loading}
				<div class="py-8 text-center text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
			{:else if error}
				<div class="py-8 text-center text-sm text-[var(--color-accent-coral)]">{error}</div>
			{:else if run}
				<!-- Run summary -->
				<dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm mb-4">
					<dt class="text-[var(--color-text-tertiary)]">Activated by</dt><dd class="text-[var(--color-text-primary)]">{run.who}</dd>
					<dt class="text-[var(--color-text-tertiary)]">Where</dt><dd class="text-[var(--color-text-primary)]">{run.where}{run.taskName ? ` · ${run.taskName}` : ''}</dd>
					<dt class="text-[var(--color-text-tertiary)]">Status</dt><dd class="text-[var(--color-text-primary)]">{run.status}{run.error ? ` (${run.error})` : ''}</dd>
					<dt class="text-[var(--color-text-tertiary)]">When</dt><dd class="text-[var(--color-text-primary)]">{ts(run.startedAt)}{run.finishedAt ? ` → ${ts(run.finishedAt)}` : ''}</dd>
					{#if (run.outputTokens ?? 0) > 0}
						<dt class="text-[var(--color-text-tertiary)]">Tokens</dt><dd class="text-[var(--color-text-primary)]">{run.inputTokens ?? 0} in · {run.outputTokens ?? 0} out</dd>
					{/if}
				</dl>

				<!-- Vault writes (hash-only) -->
				{#if writes.length}
					<div class="mb-4">
						<h4 class="text-[0.7rem] uppercase tracking-wide text-[var(--color-text-tertiary)] mb-1.5">Vault writes</h4>
						<div class="flex flex-col gap-1">
							{#each writes as w}
								<div class="flex items-center gap-2 text-[0.75rem] text-[var(--color-text-secondary)]">
									<span class="font-mono px-1.5 py-0.5 rounded bg-[var(--color-hover)]">{w.tool}</span>
									<span class="font-mono text-[var(--color-text-tertiary)] text-[0.6rem] truncate">#{w.argHash}</span>
									<span class="ml-auto text-[var(--color-text-tertiary)]">{ts(w.createdAt)}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Conversation -->
				<h4 class="text-[0.7rem] uppercase tracking-wide text-[var(--color-text-tertiary)] mb-1.5">Conversation</h4>
				{#if messages.length === 0}
					<p class="text-sm text-[var(--color-text-tertiary)]">No conversation recorded for this turn.</p>
				{:else}
					<div class="flex flex-col gap-2">
						{#each messages as m}
							<div class="rounded-lg px-3 py-2 {m.role === 'assistant' ? 'bg-[var(--color-accent)]/5' : 'bg-[var(--color-hover)]'}">
								<div class="text-[0.6rem] uppercase tracking-wide text-[var(--color-text-tertiary)] mb-0.5">{m.role}{m.source ? ` · ${m.source}` : ''}</div>
								<p class="text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">{m.content}</p>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
