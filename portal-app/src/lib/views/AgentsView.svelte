<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api';
	import AgentRow from '$lib/components/agents/AgentRow.svelte';

	interface AgentInfo {
		id: string;
		name: string;
		defaultName?: string;
		role: string;
		color: string;
		port: number;
		status: 'online' | 'offline';
		model: string | null;
		activeTasks: number;
		currentTool?: string | null;
		personality?: string;
		avatarEmoji?: string;
	}

	type ViewMode = 'activity' | 'manage';

	interface Provider {
		id: number;
		provider: string;
		label?: string | null;
		status?: string;
		config_dir?: string | null;
	}

	interface Assignment {
		agent_id: string;
		provider_id: number;
		desired_state: 'pending' | 'applied' | 'failed';
		applied_at?: string | null;
		last_error?: string | null;
	}

	interface RuntimeAgent {
		slug: string;
		name?: string;
		port?: number;
		configDir?: string | null;
		ok: boolean;
		error?: string | null;
	}

	interface SecretEntry {
		agentId: string;
		key: string;
		set: boolean;
	}

	interface ActivityEntry {
		id: string;
		type: string; // 'action', 'thought', 'output', 'error', 'status', 'heartbeat'
		content: string;
		timestamp: string;
		agentId?: string;
		agentName?: string;
		agentColor?: string;
		tool?: string;
		// metadata type field from addActivity
		[key: string]: unknown;
	}

	const colorMap: Record<string, string> = {
		azure: 'var(--color-accent)',
		jade: 'var(--color-accent-jade)',
		coral: 'var(--color-accent-coral)',
		amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)',
	};

	let agents = $state<AgentInfo[]>([]);
	let activities = $state<ActivityEntry[]>([]);
	let loading = $state(true);
	let connected = $state(false);
	let agentFilter = $state<string | null>(null);
	let eventSource: EventSource | null = null;

	// Tab toggle: management is the default — /agents is first and foremost
	// the per-agent control surface (display name, Claude assignment, bot
	// tokens). Live activity is a secondary view, on demand.
	let viewMode = $state<ViewMode>('manage');

	// Management-mode state. Loaded lazily on first switch to 'manage' so
	// the activity-default page doesn't pay the cost upfront.
	let providers = $state<Provider[]>([]);
	let assignments = $state<Assignment[]>([]);
	let runtimeAgents = $state<RuntimeAgent[]>([]);
	let secretsState = $state<SecretEntry[]>([]);
	let manageLoading = $state(false);
	let manageError = $state<string | null>(null);
	let manageLoaded = $state(false);

	const MAX_ACTIVITIES = 200;

	const filteredActivities = $derived(
		agentFilter
			? activities.filter(a => a.agentId === agentFilter)
			: activities
	);

	onMount(async () => {
		// Manage is the default view — load its data eagerly. Activity-mode
		// data (the SSE stream) starts on first switch to that tab.
		await loadManageData();
		loading = false;
	});

	onDestroy(() => {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	});

	function connectStream() {
		eventSource = new EventSource('/portal/agents/stream');

		eventSource.onopen = () => {
			connected = true;
		};

		eventSource.onmessage = (event) => {
			try {
				const entry: ActivityEntry = JSON.parse(event.data);

				// Handle heartbeat updates (agent status refresh)
				if (entry.type === 'heartbeat' && 'agents' in entry) {
					const statuses = entry.agents as Array<{
						agentId: string;
						name: string;
						color: string;
						status: string;
						activeTasks: number;
						model: string;
					}>;
					agents = agents.map(a => {
						const update = statuses.find(s => s.agentId === a.id);
						if (update) {
							return { ...a, status: update.status as 'online' | 'offline', activeTasks: update.activeTasks, model: update.model };
						}
						return a;
					});
					return;
				}

				// Update agent's current tool from tool events
				if (entry.agentId) {
					const metaType = entry.type === 'action' ? (entry as Record<string, unknown>).type : null;
					// Check the metadata 'type' field (tool-start, tool-complete)
					const entryMetaType = (entry as Record<string, unknown>)['type'];
					if (entryMetaType === 'tool-start' && entry.tool) {
						agents = agents.map(a =>
							a.id === entry.agentId ? { ...a, currentTool: entry.tool } : a
						);
					} else if (entryMetaType === 'tool-complete') {
						agents = agents.map(a =>
							a.id === entry.agentId ? { ...a, currentTool: null } : a
						);
					}
				}

				// Add to feed (skip keepalives and heartbeats)
				if (entry.type !== 'heartbeat' && entry.agentId) {
					activities = [entry, ...activities].slice(0, MAX_ACTIVITIES);
				}
			} catch { /* skip unparseable */ }
		};

		eventSource.onerror = () => {
			connected = false;
			// Auto-reconnect is handled by EventSource
		};
	}

	function formatTime(dateStr: string) {
		return new Date(dateStr).toLocaleTimeString('en-US', {
			hour: '2-digit', minute: '2-digit', second: '2-digit',
		});
	}

	function getAgentColor(colorName?: string): string {
		return colorMap[colorName || ''] || 'var(--color-text-secondary)';
	}

	async function loadManageData() {
		manageLoading = true;
		manageError = null;
		try {
			const [agentsRes, providersRes, runtimeRes, assignmentsRes, secretsRes] = await Promise.all([
				api('/portal/agents').catch(() => null),
				api('/portal/providers').catch(() => null),
				api('/portal/providers/runtime-state').catch(() => null),
				api('/portal/providers/assignments').catch(() => null),
				api('/portal/settings/secrets').catch(() => null),
			]);

			if (agentsRes?.ok) {
				const data = await agentsRes.json();
				agents = data.agents || agents;
			}
			if (providersRes?.ok) {
				const data = await providersRes.json();
				providers = data.providers || [];
			}
			if (runtimeRes?.ok) {
				const data = await runtimeRes.json();
				runtimeAgents = Array.isArray(data) ? data : (data.agents || []);
			}
			if (assignmentsRes?.ok) {
				const data = await assignmentsRes.json();
				assignments = Array.isArray(data) ? data : (data.assignments || []);
			}
			if (secretsRes?.ok) {
				const data = await secretsRes.json();
				secretsState = data.secrets || [];
			}
			manageLoaded = true;
		} catch (e) {
			manageError = e instanceof Error ? e.message : 'load failed';
		} finally {
			manageLoading = false;
		}
	}

	async function setViewMode(mode: ViewMode) {
		viewMode = mode;
		if (mode === 'manage' && !manageLoaded) {
			await loadManageData();
		}
		if (mode === 'activity' && !eventSource) {
			connectStream();
		}
	}

	function getActivityIcon(entry: ActivityEntry): string {
		const metaType = (entry as Record<string, unknown>)['type'] as string;
		if (metaType === 'tool-start') return '\u25B6';
		if (metaType === 'tool-complete') return '\u2713';
		if (metaType === 'thinking') return '\u00B7\u00B7\u00B7';
		if (metaType === 'claude-start') return '\u26A1';
		if (metaType === 'claude-response') return '\u2190';
		if (entry.type === 'error') return '\u2717';
		if (entry.type === 'status') return '\u25CB';
		return '\u25CF';
	}
</script>

<svelte:head>
	<title>Agents - Mycelium</title>
</svelte:head>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)]">
		<h2 class="text-sm font-medium text-[var(--color-text-primary)]">Agents</h2>

		<!-- View tabs -->
		<div class="ml-3 inline-flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
			<button
				type="button"
				onclick={() => setViewMode('activity')}
				class="px-3 py-1 transition-colors cursor-pointer
					{viewMode === 'activity'
						? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
						: 'bg-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
			>Activity</button>
			<button
				type="button"
				onclick={() => setViewMode('manage')}
				class="px-3 py-1 transition-colors cursor-pointer
					{viewMode === 'manage'
						? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
						: 'bg-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
			>Manage</button>
		</div>

		<div class="ml-auto flex items-center gap-2">
			{#if viewMode === 'activity'}
				<span class="w-1.5 h-1.5 rounded-full {connected ? 'bg-[var(--color-accent-jade)]' : 'bg-[var(--color-accent-coral)]'}"></span>
				<span class="text-xs text-[var(--color-text-tertiary)]">
					{connected ? 'Live' : 'Disconnected'}
				</span>
				{#if filteredActivities.length > 0}
					<span class="text-xs text-[var(--color-text-tertiary)] ml-2">
						{filteredActivities.length} events
					</span>
				{/if}
			{:else}
				<span class="text-xs text-[var(--color-text-tertiary)]">{agents.length} agents</span>
			{/if}
		</div>
	</div>

	<div class="flex-1 overflow-y-auto px-6 py-4">
		{#if viewMode === 'manage'}
			<div class="max-w-3xl mx-auto">
				{#if manageLoading}
					<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse py-12 text-center">Loading…</div>
				{:else if manageError}
					<div class="text-[var(--color-accent-coral)] text-sm py-12 text-center">{manageError}</div>
				{:else}
					<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
						Manage display name, Claude subscription, bot tokens, and inspect runtime state per agent.
						Click a row to expand.
					</p>
					<div class="flex flex-col gap-2">
						{#each agents as agent (agent.id)}
							<AgentRow
								{agent}
								{providers}
								{assignments}
								{runtimeAgents}
								{secretsState}
								onChange={loadManageData}
							/>
						{/each}
					</div>
				{/if}
			</div>
		{:else if loading}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading agents...</div>
			</div>
		{:else}
			<div class="max-w-3xl mx-auto">
				<!-- Agent Cards Row -->
				<div class="flex flex-wrap gap-2 mb-4">
					{#each agents as agent (agent.id)}
						{@const color = getAgentColor(agent.color)}
						<button
							onclick={() => agentFilter = agentFilter === agent.id ? null : agent.id}
							class="flex items-center gap-2 px-3 py-2 rounded-lg border transition-all duration-150 cursor-pointer
								{agentFilter === agent.id
								? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
								: 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-tertiary)]'}"
						>
							<!-- Status dot -->
							<div class="w-2 h-2 rounded-full flex-shrink-0"
								class:animate-pulse={agent.activeTasks > 0}
								style="background: {agent.status === 'online'
									? (agent.activeTasks > 0 ? color : 'var(--color-accent-jade)')
									: 'var(--color-accent-coral)'};"
							></div>

							<!-- Name -->
							<span class="text-sm font-medium" style="color: {color};">
								{agent.name}
							</span>

							<!-- Current tool or status -->
							<span class="text-[0.6rem] font-mono text-[var(--color-text-tertiary)] max-w-[8rem] truncate">
								{#if agent.status === 'offline'}
									offline
								{:else if agent.currentTool}
									{agent.currentTool}
								{:else if agent.activeTasks > 0}
									working
								{:else}
									idle
								{/if}
							</span>
						</button>
					{/each}
				</div>

				<!-- Activity Feed -->
				{#if filteredActivities.length === 0}
					<div class="flex items-center justify-center min-h-[200px]">
						<div class="text-center">
							<p class="text-[var(--color-text-tertiary)] text-sm">No activity yet</p>
							<p class="text-[var(--color-text-tertiary)] text-xs mt-1">
								{connected ? 'Waiting for agent activity...' : 'Connecting to activity stream...'}
							</p>
						</div>
					</div>
				{:else}
					<div class="space-y-0.5">
						{#each filteredActivities as entry (entry.id)}
							{@const color = getAgentColor(entry.agentColor)}
							<div class="flex gap-3 items-start rounded-lg px-3 py-2 -mx-3 hover:bg-[var(--color-hover)] transition-colors">
								<!-- Agent badge -->
								<div
									class="w-7 h-7 rounded-md flex items-center justify-center text-[0.6rem] font-mono font-medium flex-shrink-0 mt-0.5"
									style="background: {color}15; color: {color};"
								>
									{entry.agentName || '??'}
								</div>

								<!-- Content -->
								<div class="flex-1 min-w-0">
									<div class="flex items-baseline gap-2">
										<span class="text-[0.65rem] text-[var(--color-text-tertiary)]">
											{formatTime(entry.timestamp)}
										</span>
										<span class="text-[0.6rem] font-mono text-[var(--color-text-tertiary)]">
											{getActivityIcon(entry)}
										</span>
									</div>
									<p class="text-sm text-[var(--color-text-secondary)] break-words leading-relaxed">
										{entry.content?.length > 300 ? entry.content.slice(0, 300) + '...' : entry.content}
									</p>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
