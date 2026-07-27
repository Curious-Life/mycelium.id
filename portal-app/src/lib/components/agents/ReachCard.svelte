<!--
  ReachCard — "where does it live?" The channels it can be reached on and the people
  it knows. Lifted from the old Overview tab, whose two channel rows went to
  goto('/import') and whose Connections row went to goto('/people') — a route that
  does not exist in this app. Both now open the workspace tab that OWNS the setting:
  Streams on its Sources facet (Import merged into Streams, NAV-IA-LOCK-2026-06-08)
  and Connections.
-->
<script lang="ts">
	import { workspace } from '$lib/workspace/store';
	import AgentCard from './AgentCard.svelte';

	let { channels = { telegram: false, discord: false }, loading = false } = $props<{
		channels?: { telegram: boolean; discord: boolean };
		loading?: boolean;
	}>();

	const rows = $derived([
		{ key: 'telegram', label: 'Telegram', on: channels.telegram },
		{ key: 'discord', label: 'Discord', on: channels.discord },
	]);

	const openSources = () => workspace.openFromRoute('streams', { facet: 'sources' });
</script>

<AgentCard title="Reach" loading={loading}>
	<div class="rows">
		{#each rows as r (r.key)}
			<button class="row" onclick={openSources}>
				<span class="dot" class:on={r.on}></span>
				<span class="label">{r.label}</span>
				<span class="state" class:on={r.on}>{r.on ? 'connected' : 'not connected'}</span>
				<span class="chev">›</span>
			</button>
		{/each}
		<button class="row" onclick={() => workspace.openFromRoute('connections')}>
			<span class="dot people"></span>
			<span class="label">Connections</span>
			<span class="state">manage in Connections</span>
			<span class="chev">›</span>
		</button>
	</div>
</AgentCard>

<style>
	.rows { display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.55rem; }
	.row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 0.42rem 0.5rem;
		margin: 0 -0.5rem;
		border: 0;
		border-radius: 8px;
		background: transparent;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}
	.row:hover { background: var(--color-hover); }
	.dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 999px;
		flex-shrink: 0;
		background: var(--color-border);
	}
	.dot.on { background: var(--color-accent-jade); }
	.dot.people { background: rgb(var(--agent-rgb) / 1); }
	.label { font-size: 0.8rem; color: var(--color-text-primary); }
	.state { margin-left: auto; font-size: 0.68rem; color: var(--color-text-tertiary); }
	.state.on { color: var(--color-accent-jade); }
	.chev { font-size: 0.85rem; color: var(--color-text-tertiary); }
</style>
