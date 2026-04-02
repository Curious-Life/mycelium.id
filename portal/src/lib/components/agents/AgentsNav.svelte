<script lang="ts">
	import { api } from '$lib/api';
	import { onMount } from 'svelte';

	interface AgentInfo {
		id: string;
		name: string;
		role: string;
		color: string;
		status: 'online' | 'offline';
		activeTasks: number;
	}

	let agents = $state<AgentInfo[]>([]);
	let selectedAgentId = $state<string | null>(null);

	// Expose filter for the page to read
	export function getSelectedAgentId() {
		return selectedAgentId;
	}

	const colorMap: Record<string, string> = {
		azure: 'var(--color-accent)',
		jade: 'var(--color-accent-jade)',
		coral: 'var(--color-accent-coral)',
		amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)',
	};

	onMount(async () => {
		try {
			const res = await api('/portal/agents');
			if (res.ok) {
				const data = await res.json();
				agents = data.agents || [];
			}
		} catch {}
	});

	// Listen for heartbeat updates from the page's SSE
	function updateAgentStatus(agentId: string, status: 'online' | 'offline', activeTasks: number) {
		agents = agents.map(a =>
			a.id === agentId ? { ...a, status, activeTasks } : a
		);
	}

	// Expose for parent page
	export { updateAgentStatus };
</script>

<div class="flex flex-col h-full">
	<div class="px-4 py-3 border-b border-[var(--color-border)]">
		<span class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
			Agents
		</span>
	</div>

	<nav class="flex flex-col gap-0.5 px-2 py-2 overflow-y-auto">
		<!-- All Agents -->
		<button
			onclick={() => selectedAgentId = null}
			class="flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-150 text-left
				{!selectedAgentId
				? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
		>
			<div class="w-1.5 h-1.5 rounded-full {!selectedAgentId ? 'bg-[var(--color-accent)]' : 'bg-transparent'}"></div>
			<span class="text-sm font-medium">All Agents</span>
			{#if agents.length > 0}
				<span class="ml-auto text-[0.65rem] text-[var(--color-text-tertiary)]">
					{agents.filter(a => a.status === 'online').length}/{agents.length}
				</span>
			{/if}
		</button>

		{#each agents as agent (agent.id)}
			{@const color = colorMap[agent.color] || 'var(--color-text-secondary)'}
			<button
				onclick={() => selectedAgentId = selectedAgentId === agent.id ? null : agent.id}
				class="flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-150 text-left
					{selectedAgentId === agent.id
					? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-elevated)]'}"
			>
				<!-- Status dot -->
				<div class="w-1.5 h-1.5 rounded-full flex-shrink-0"
					class:animate-pulse={agent.activeTasks > 0}
					style="background: {agent.status === 'online'
						? (agent.activeTasks > 0 ? color : 'var(--color-accent-jade)')
						: 'var(--color-accent-coral)'};"
				></div>

				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium truncate">{agent.name}</div>
					<div class="text-[0.65rem] text-[var(--color-text-tertiary)] truncate">{agent.role}</div>
				</div>

				{#if agent.activeTasks > 0}
					<span class="text-[0.6rem] font-mono px-1.5 py-0.5 rounded bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]">
						{agent.activeTasks}
					</span>
				{/if}
			</button>
		{/each}
	</nav>
</div>
