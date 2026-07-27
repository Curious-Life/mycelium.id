<!--
  ActivityTimeline — "what has it done?" The historical record of every agent turn
  (harness_runs), grouped by day on a single spine, sourced from /portal/agent-activity.

  Changed in the single-view redesign:
  • The "Scheduled cycles" block moved OUT of here — it rendered the same rows the
    Manage tab's ReflectionCyclesSection already owned. Cycles now live in RhythmsCard.
  • Events are loaded by the parent view (one fetch feeds the hero stats, the rhythms
    card and this river); this component owns pagination from there on.
  • A source filter (chat / channels / cycles) — the data always carried `source`;
    nothing surfaced it.
-->
<script lang="ts">
	import { api } from '$lib/api';
	import InspectModal from './InspectModal.svelte';
	import { SOURCE_COLOR, SOURCE_LABEL, STATUS_COLOR } from './agent-visual';

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

	let {
		events = [],
		nextCursor = null,
		loading = false,
		error = null,
		onMore,
		onRefresh,
	} = $props<{
		events?: ActivityEvent[];
		nextCursor?: string | null;
		loading?: boolean;
		error?: string | null;
		onMore?: (before: string) => Promise<void> | void;
		onRefresh?: () => Promise<void> | void;
	}>();

	let loadingMore = $state(false);
	let refreshing = $state(false);
	let inspectId = $state<string | null>(null);
	let filter = $state<string | null>(null);

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		try { await onMore?.(nextCursor); } finally { loadingMore = false; }
	}

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try { await onRefresh?.(); } finally { refreshing = false; }
	}

	// Which source filters are worth offering — only the ones actually present.
	const availableSources = $derived(
		['chat', 'channel', 'scheduler'].filter((s) => events.some((e: ActivityEvent) => e.source === s)),
	);
	const shown = $derived(filter ? events.filter((e: ActivityEvent) => e.source === filter) : events);

	function dayKey(ts: string): string {
		const d = new Date(ts);
		const now = new Date();
		const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
		const yest = new Date(now);
		yest.setDate(now.getDate() - 1);
		if (same(d, now)) return 'Today';
		if (same(d, yest)) return 'Yesterday';
		return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
	}

	const grouped = $derived.by(() => {
		const out: { day: string; items: ActivityEvent[] }[] = [];
		for (const e of shown) {
			const k = dayKey(e.ts);
			const last = out[out.length - 1];
			if (last && last.day === k) last.items.push(e);
			else out.push({ day: k, items: [e] });
		}
		return out;
	});

	const time = (ts: string) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
</script>

<section class="activity">
	<div class="head">
		<h2>Activity</h2>
		<div class="tools">
			{#if availableSources.length > 1}
				<div class="filters" role="group" aria-label="Filter activity by source">
					<button class="chip" class:on={filter === null} onclick={() => (filter = null)}>All</button>
					{#each availableSources as s (s)}
						<button class="chip" class:on={filter === s} onclick={() => (filter = filter === s ? null : s)}>
							<span class="chip-dot" style:background={SOURCE_COLOR[s]}></span>{SOURCE_LABEL[s] || s}
						</button>
					{/each}
				</div>
			{/if}
			{#if onRefresh}
				<button class="refresh" class:spinning={refreshing} onclick={refresh} disabled={refreshing} title="Refresh activity" aria-label="Refresh activity">
					<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
						<path d="M8 2.5a5.5 5.5 0 1 0 5.3 7h-1.6A4 4 0 1 1 8 4a3.95 3.95 0 0 1 2.8 1.2L8.8 7.2H14V2l-2.1 2.1A5.48 5.48 0 0 0 8 2.5z" fill="currentColor"/>
					</svg>
				</button>
			{/if}
		</div>
	</div>

	{#if loading}
		<div class="empty pulse">Loading activity…</div>
	{:else if error}
		<div class="empty err">{error}</div>
	{:else if events.length === 0}
		<div class="empty">
			<p class="big">No turns yet</p>
			<p>Every turn your agent takes — from chat, a channel message, or a scheduled cycle — lands here.</p>
		</div>
	{:else if shown.length === 0}
		<div class="empty">
			<p>Nothing from {SOURCE_LABEL[filter || ''] || filter} in this range.</p>
			<button class="linkish" onclick={() => (filter = null)}>show all</button>
		</div>
	{:else}
		<div class="river">
			{#each grouped as group (group.day)}
				<div class="day">{group.day}</div>
				{#each group.items as e (e.id)}
					<button class="turn" onclick={() => (inspectId = e.id)} title="Inspect this turn">
						<span class="node" style:background={SOURCE_COLOR[e.source] || 'var(--color-text-tertiary)'}></span>
						<span class="time">{time(e.ts)}</span>
						<span class="who">{e.who}</span>
						<span class="where">→ {e.where}{e.taskName ? ` · ${e.taskName}` : ''}</span>
						<span class="tail">
							{#if (e.outputTokens ?? 0) > 0}
								<span class="tokens">{(e.inputTokens ?? 0) + (e.outputTokens ?? 0)} tok</span>
							{/if}
							<span
								class="status"
								style:color={STATUS_COLOR[e.status] || 'var(--color-text-tertiary)'}
								style:background="color-mix(in srgb, {STATUS_COLOR[e.status] || 'var(--color-text-tertiary)'} 14%, transparent)"
							>{e.status}</span>
						</span>
					</button>
				{/each}
			{/each}
		</div>

		{#if nextCursor}
			<div class="more">
				<button class="ghost" onclick={loadMore} disabled={loadingMore}>
					{loadingMore ? 'Loading…' : 'Load earlier turns'}
				</button>
			</div>
		{/if}
	{/if}
</section>

{#if inspectId}
	<InspectModal runId={inspectId} onClose={() => (inspectId = null)} />
{/if}

<style>
	.activity {
		border: 1px solid var(--color-border);
		border-radius: 14px;
		background: var(--color-surface);
		padding: 0.95rem 1.05rem 1.1rem;
	}
	.head { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
	h2 {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-tertiary);
	}
	.tools { margin-left: auto; display: flex; align-items: center; gap: 0.4rem; }
	.filters { display: flex; gap: 0.25rem; }
	.refresh {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--color-text-tertiary);
		cursor: pointer;
	}
	.refresh:hover { color: var(--color-text-primary); background: var(--color-hover); }
	.refresh:disabled { cursor: default; }
	.refresh.spinning svg { animation: spin 0.9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .refresh.spinning svg { animation: none; } }
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.2rem 0.55rem;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		font: inherit;
		font-size: 0.68rem;
		color: var(--color-text-tertiary);
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
	}
	.chip:hover { color: var(--color-text-primary); background: var(--color-hover); }
	.chip.on { background: var(--color-elevated); border-color: var(--color-border); color: var(--color-text-primary); }
	.chip-dot { width: 0.35rem; height: 0.35rem; border-radius: 999px; }

	/* The spine: one continuous line the turn nodes sit ON — so the geometry has to
	   agree. river padding 1.25rem, spine centred at 0.5rem; a turn starts at
	   1.25 − 0.5 = 0.75rem, so its 0.45rem node needs left = 0.5 − 0.225 − 0.75. */
	.river { position: relative; margin-top: 0.7rem; padding-left: 1.25rem; }
	.river::before {
		content: '';
		position: absolute;
		left: 0.5rem;
		top: 0.9rem;
		bottom: 0.5rem;
		width: 1px;
		/* Tinted with the agent's own accent rather than --color-border: a 1px
		   border-coloured hairline on --color-surface is below the visible
		   threshold, and the spine is the thing that makes this read as a timeline. */
		background: linear-gradient(
			to bottom,
			rgb(var(--agent-rgb) / 0.4),
			rgb(var(--agent-rgb) / 0.2) 75%,
			transparent
		);
	}

	.day {
		position: sticky;
		top: 0;
		z-index: 1;
		margin: 0.75rem 0 0.3rem -1.25rem;
		padding: 0.25rem 0 0.25rem 1.25rem;
		background: var(--color-surface);
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--color-text-tertiary);
	}
	.day:first-child { margin-top: 0; }

	.turn {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: calc(100% + 1rem);
		margin-left: -0.5rem;
		padding: 0.36rem 0.5rem;
		border: 0;
		border-radius: 8px;
		background: transparent;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.turn:hover { background: var(--color-hover); }
	.node {
		position: absolute;
		left: -0.475rem;
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 999px;
		box-shadow: 0 0 0 3px var(--color-surface);
	}
	.turn:hover .node { box-shadow: 0 0 0 3px var(--color-surface), 0 0 0 5px rgb(var(--agent-rgb) / 0.25); }

	.time {
		flex-shrink: 0;
		width: 3.5rem;
		font-family: var(--font-mono);
		font-size: 0.64rem;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-tertiary);
	}
	.who { flex-shrink: 0; font-size: 0.8rem; color: var(--color-text-primary); }
	.where {
		min-width: 0;
		font-size: 0.7rem;
		color: var(--color-text-tertiary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tail { margin-left: auto; display: flex; align-items: center; gap: 0.45rem; flex-shrink: 0; }
	.tokens { font-family: var(--font-mono); font-size: 0.6rem; color: var(--color-text-tertiary); }
	.status {
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		font-size: 0.58rem;
		font-weight: 500;
	}

	.empty { padding: 2.25rem 0; text-align: center; font-size: 0.78rem; color: var(--color-text-tertiary); }
	.empty p { margin: 0; }
	.empty .big { font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 0.3rem; }
	.empty.err { color: var(--color-accent-coral); }
	.empty.pulse { animation: fade 1.4s var(--ease-in-out) infinite; }
	@keyframes fade { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { .empty.pulse { animation: none; } }

	.more { margin-top: 0.9rem; text-align: center; }
	.ghost, .linkish {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.32rem 0.75rem;
		background: transparent;
		font: inherit;
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}
	.ghost:hover { color: var(--color-text-primary); background: var(--color-hover); }
	.ghost:disabled { opacity: 0.5; cursor: default; }
	.linkish { border: 0; color: var(--color-accent); margin-top: 0.35rem; }
	.linkish:hover { text-decoration: underline; }

	@media (max-width: 600px) {
		.where { display: none; }
	}
</style>
