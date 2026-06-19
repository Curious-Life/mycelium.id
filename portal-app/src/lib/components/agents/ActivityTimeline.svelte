<script lang="ts">
	// The real agent activity timeline — historical, sourced from /portal/agent-activity
	// (harness_runs + scheduled cycles), replacing the live-SSE-only feed that falsely read
	// "disconnected / no activity". Each turn (chat / channel / scheduler) is one event with
	// who/where/when + status; click an event to inspect what happened.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import InspectModal from './InspectModal.svelte';

	interface ActivityEvent {
		kind: string;
		id: string;
		ts: string;
		trigger: string;
		status: string;
		source: string;
		who: string;
		where: string;
		inputTokens?: number | null;
		outputTokens?: number | null;
		error?: string | null;
		conversationId?: string | null;
		taskId?: string | null;
		taskName?: string | null;
	}
	interface Cycle {
		id: string;
		name: string;
		schedule: string;
		status: string;
		nextRun?: string | null;
		lastRun?: string | null;
		lastStatus?: string | null;
		runCount?: number;
		outputTarget?: string | null;
		createdBy?: string | null;
	}

	let events = $state<ActivityEvent[]>([]);
	let cycles = $state<Cycle[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let inspectId = $state<string | null>(null);

	async function load(before: string | null = null) {
		try {
			const res = await api(`/portal/agent-activity${before ? `?before=${encodeURIComponent(before)}` : ''}`);
			if (!res?.ok) { error = 'Could not load activity'; return; }
			const data = await res.json();
			if (before) events = [...events, ...(data.events || [])];
			else { events = data.events || []; cycles = data.cycles || []; }
			nextCursor = data.nextCursor || null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'load failed';
		}
	}

	onMount(async () => { await load(); loading = false; });

	async function loadMore() { loadingMore = true; await load(nextCursor); loadingMore = false; }

	// ── grouping by calendar day ──
	function dayKey(ts: string): string {
		const d = new Date(ts);
		const now = new Date();
		const isSame = (a: Date, b: Date) => a.toDateString() === b.toDateString();
		const yest = new Date(now); yest.setDate(now.getDate() - 1);
		if (isSame(d, now)) return 'Today';
		if (isSame(d, yest)) return 'Yesterday';
		return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
	}
	const grouped = $derived.by(() => {
		const out: { day: string; items: ActivityEvent[] }[] = [];
		for (const e of events) {
			const k = dayKey(e.ts);
			const last = out[out.length - 1];
			if (last && last.day === k) last.items.push(e);
			else out.push({ day: k, items: [e] });
		}
		return out;
	});

	function time(ts: string): string {
		return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	}
	function relDay(ts?: string | null): string {
		if (!ts) return '—';
		const d = new Date(ts), now = new Date();
		const diff = d.getTime() - now.getTime();
		const days = Math.round(diff / 86400000);
		if (Math.abs(diff) < 3600000) return `${Math.round(diff / 60000)}m`;
		if (Math.abs(diff) < 86400000) return `${Math.round(diff / 3600000)}h`;
		return days >= 0 ? `in ${days}d` : `${-days}d ago`;
	}

	const sourceDot: Record<string, string> = {
		chat: 'var(--color-accent-amethyst)',
		channel: 'var(--color-accent)',
		scheduler: 'var(--color-accent-aurum)',
	};
	const statusColor: Record<string, string> = {
		done: 'var(--color-accent-jade)',
		running: 'var(--color-accent)',
		queued: 'var(--color-text-tertiary)',
		failed: 'var(--color-accent-coral)',
		aborted: 'var(--color-accent-coral)',
		skipped: 'var(--color-text-tertiary)',
	};
	function cycleMark(c: Cycle): string {
		if (c.status === 'paused') return '⏸';
		if (c.status === 'completed') return '✓';
		if (c.lastStatus === 'error') return '✗';
		if (c.runCount && c.runCount > 0) return '✓';
		return '○';
	}
</script>

<div class="max-w-3xl mx-auto">
	{#if loading}
		<div class="py-12 text-center text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading activity…</div>
	{:else if error}
		<div class="py-12 text-center text-sm text-[var(--color-accent-coral)]">{error}</div>
	{:else}
		<!-- Scheduled cycles -->
		{#if cycles.length}
			<section class="mb-5">
				<h3 class="text-[0.7rem] uppercase tracking-wide text-[var(--color-text-tertiary)] mb-2">Scheduled cycles</h3>
				<div class="flex flex-col gap-1.5">
					{#each cycles as c (c.id)}
						<div class="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm">
							<span class="font-mono text-[var(--color-text-tertiary)] w-4 text-center"
								style="color: {c.lastStatus === 'error' ? 'var(--color-accent-coral)' : (c.runCount ? 'var(--color-accent-jade)' : 'var(--color-text-tertiary)')}">{cycleMark(c)}</span>
							<span class="font-medium text-[var(--color-text-primary)]">{c.name}</span>
							{#if c.status === 'paused'}<span class="text-[0.55rem] px-1.5 py-0.5 rounded bg-[var(--color-hover)] text-[var(--color-text-tertiary)]">paused</span>{/if}
							<span class="ml-auto font-mono text-[0.65rem] text-[var(--color-text-tertiary)]">{c.schedule}</span>
							<span class="text-[0.65rem] text-[var(--color-text-tertiary)] w-20 text-right" title={c.nextRun || ''}>
								{c.runCount ? `ran · next ${relDay(c.nextRun)}` : `next ${relDay(c.nextRun)}`}
							</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Activity river -->
		{#if events.length === 0}
			<div class="py-12 text-center">
				<p class="text-sm text-[var(--color-text-tertiary)]">No agent activity yet</p>
				<p class="text-xs text-[var(--color-text-tertiary)] mt-1">Turns from chat, channels, and scheduled cycles will appear here.</p>
			</div>
		{:else}
			{#each grouped as group (group.day)}
				<div class="mb-1 mt-3 text-[0.65rem] uppercase tracking-wide text-[var(--color-text-tertiary)] sticky top-0 bg-[var(--color-bg)] py-1">{group.day}</div>
				<div class="flex flex-col">
					{#each group.items as e (e.id)}
						<button
							onclick={() => inspectId = e.id}
							class="flex items-center gap-3 px-3 py-2 -mx-3 rounded-lg text-left hover:bg-[var(--color-hover)] transition-colors cursor-pointer"
						>
							<span class="w-2 h-2 rounded-full flex-shrink-0" style="background: {sourceDot[e.source] || 'var(--color-text-tertiary)'}"></span>
							<span class="text-[0.65rem] text-[var(--color-text-tertiary)] font-mono w-12 flex-shrink-0">{time(e.ts)}</span>
							<span class="text-sm text-[var(--color-text-primary)] flex-shrink-0">{e.who}</span>
							<span class="text-[0.7rem] text-[var(--color-text-tertiary)] truncate">→ {e.where}</span>
							<span class="ml-auto flex items-center gap-2 flex-shrink-0">
								{#if (e.outputTokens ?? 0) > 0}<span class="text-[0.6rem] font-mono text-[var(--color-text-tertiary)]">{(e.inputTokens ?? 0) + (e.outputTokens ?? 0)} tok</span>{/if}
								<span class="text-[0.55rem] px-1.5 py-0.5 rounded font-medium" style="background: {(statusColor[e.status] || 'var(--color-text-tertiary)')}1a; color: {statusColor[e.status] || 'var(--color-text-tertiary)'}">{e.status}</span>
							</span>
						</button>
					{/each}
				</div>
			{/each}
			{#if nextCursor}
				<div class="text-center mt-4">
					<button onclick={loadMore} disabled={loadingMore} class="text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] cursor-pointer">
						{loadingMore ? 'Loading…' : 'Load more'}
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</div>

{#if inspectId}
	<InspectModal runId={inspectId} onClose={() => inspectId = null} />
{/if}
