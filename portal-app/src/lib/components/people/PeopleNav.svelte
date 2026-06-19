<script lang="ts">
	// People cluster contextual sub-nav (NAV-IA-LOCK-2026-06-08). Shown in the
	// sidebar's contextual region whenever the active view is in the People cluster
	// (connections · spaces · contexts). Each item opens/focuses its registered
	// workspace view.
	import { browser } from '$app/environment';
	import { apiGet } from '$lib/api';
	import { navigationState } from '$lib/stores/navigation';
	import { workspace } from '$lib/workspace/store';

	const currentView = $derived($navigationState.primaryView);

	type Item = { id: string; viewId: string; label: string };
	const items: Item[] = [
		{ id: 'connections', viewId: 'connections', label: 'Connections' },
		{ id: 'spaces',      viewId: 'spaces',      label: 'Spaces' },
		{ id: 'contexts',    viewId: 'contexts',    label: 'Sharing' },
	];

	// Pending inbound connection requests — same count endpoint the sidebar uses.
	let pendingConnections = $state(0);
	$effect(() => {
		if (!browser) return;
		let alive = true;
		const load = async () => {
			try { const d = await apiGet<{ count: number }>('/portal/connections/count'); if (alive) pendingConnections = d.count ?? 0; } catch {}
		};
		load();
		const t = setInterval(load, 15000);
		return () => { alive = false; clearInterval(t); };
	});

	function open(it: Item) {
		navigationState.setPrimaryView(it.id as any);
		workspace.openOrFocus(it.viewId);
	}
</script>

<div class="px-4 py-3 border-b border-[var(--color-border)]">
	<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">People</span>
</div>
<nav class="flex flex-col gap-1 px-2 py-2">
	{#each items as it}
		{@const isActive = currentView === it.id}
		<button
			onclick={() => open(it)}
			class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
				{isActive
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)] font-medium'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
			aria-current={isActive ? 'page' : undefined}
		>
			<span>{it.label}</span>
			{#if it.id === 'connections' && pendingConnections > 0}
				<span class="conn-badge" aria-label="{pendingConnections} pending requests">{pendingConnections}</span>
			{/if}
		</button>
	{/each}
</nav>

<style>
	.conn-badge {
		margin-left: auto;
		min-width: 1.1rem; height: 1.1rem; padding: 0 0.35rem;
		display: inline-flex; align-items: center; justify-content: center;
		font-size: 0.65rem; font-weight: 600; line-height: 1;
		color: var(--color-bg); background: var(--color-accent-aurum); border-radius: 9999px;
	}
</style>
