<!--
  RhythmsCard — "what will it do?" The one place scheduled work lives.

  Before this, the same scheduled_tasks rows were rendered TWICE by two tabs that
  never agreed: the Activity tab's read-only "Scheduled cycles" list (GET
  /portal/agent-activity → db.harness.listTasks) and the Manage tab's editable
  ReflectionCyclesSection (GET /portal/settings/reflection → the SAME listTasks,
  filtered to created_by === 'reflection-cycle').

  The two sets are not equal — the reflection filter drops tasks the agent or the
  user created — so this card keeps the editable list AND renders the remainder
  under "Other scheduled tasks". Nothing is lost, nothing is shown twice.
  The split is done client-side on `createdBy`, which /agent-activity already
  returns (src/portal-agent-activity.js), so it costs no extra request.
-->
<script lang="ts">
	import ReflectionCyclesSection from '$lib/components/settings/ReflectionCyclesSection.svelte';
	import { relWhen } from './agent-visual';

	type Cycle = {
		id: string; name: string; schedule: string; status: string;
		nextRun?: string | null; lastRun?: string | null; lastStatus?: string | null;
		runCount?: number; outputTarget?: string | null; createdBy?: string | null;
	};

	let { cycles = [] } = $props<{ cycles?: Cycle[] }>();

	const REFLECTION = 'reflection-cycle';
	const others = $derived(cycles.filter((c: Cycle) => c.createdBy !== REFLECTION));
</script>

<div class="rhythms">
	<div class="slot">
		<ReflectionCyclesSection />
	</div>

	{#if others.length}
		<section class="other">
			<h3>Other scheduled tasks</h3>
			<p class="hint">Cycles you or your agent created outside the reflection rhythms.</p>
			<div class="list">
				{#each others as c (c.id)}
					<div class="task">
						<span class="mark" class:err={c.lastStatus === 'error'} class:ran={!!c.runCount}>
							{#if c.status === 'paused'}⏸{:else if c.lastStatus === 'error'}✗{:else if c.runCount}✓{:else}○{/if}
						</span>
						<span class="name">{c.name}</span>
						{#if c.status === 'paused'}<span class="tag">paused</span>{/if}
						<span class="schedule">{c.schedule}</span>
						<span class="next" title={c.nextRun || ''}>{c.status === 'paused' ? '—' : relWhen(c.nextRun)}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.rhythms { display: flex; flex-direction: column; gap: 0.75rem; }

	/* ReflectionCyclesSection was authored as a standalone Settings card: the global
	   .card class (16px radius + shadow-lg), a text-base semibold title and a
	   text-sm intro paragraph. Dropped into the Agents page unchanged it shouted
	   over ACCESS / REACH / ENGINE / ACTIVITY, which are quiet overlines. Retune it
	   HERE (not in the component, which stays generic) so the page reads as one
	   surface — same card shell, same heading rank, same body scale. */
	.slot :global(.card) {
		border-radius: 14px;
		box-shadow: none;
		padding: 0.95rem 1.05rem 1.05rem;
	}
	.slot :global(.card > div:first-child h3) {
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-tertiary);
	}
	.slot :global(.card > div:first-child p) {
		font-size: 0.72rem;
		line-height: 1.5;
		color: var(--color-text-tertiary);
	}
	/* The section's on/off controls are native checkboxes — paint them with the
	   product accent instead of the browser default blue. */
	.slot :global(input[type='checkbox']) {
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	.other {
		border: 1px solid var(--color-border);
		border-radius: 14px;
		background: var(--color-surface);
		padding: 0.95rem 1.05rem 1.05rem;
	}
	h3 {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-tertiary);
	}
	.hint { margin: 0.4rem 0 0.6rem; font-size: 0.72rem; color: var(--color-text-tertiary); }

	.list { display: flex; flex-direction: column; gap: 0.3rem; }
	.task {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 9px;
		font-size: 0.78rem;
	}
	.mark { width: 0.9rem; text-align: center; font-family: var(--font-mono); color: var(--color-text-tertiary); }
	.mark.ran { color: var(--color-accent-jade); }
	.mark.err { color: var(--color-accent-coral); }
	.name { color: var(--color-text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tag {
		font-size: 0.55rem;
		padding: 0.1rem 0.35rem;
		border-radius: 999px;
		background: var(--color-elevated);
		color: var(--color-text-tertiary);
	}
	.schedule { margin-left: auto; font-family: var(--font-mono); font-size: 0.64rem; color: var(--color-text-tertiary); }
	.next { width: 5rem; text-align: right; font-size: 0.66rem; color: var(--color-text-tertiary); }
</style>
