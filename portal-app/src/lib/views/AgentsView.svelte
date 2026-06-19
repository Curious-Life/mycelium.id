<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import AgentRow from '$lib/components/agents/AgentRow.svelte';
	import AgentOverview from '$lib/components/agents/AgentOverview.svelte';
	import ActivityTimeline from '$lib/components/agents/ActivityTimeline.svelte';

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

	type ViewMode = 'overview' | 'activity' | 'manage';

	interface Provider { id: number; provider: string; label?: string | null; status?: string; config_dir?: string | null; }
	interface Assignment { agent_id: string; provider_id: number; desired_state: 'pending' | 'applied' | 'failed'; applied_at?: string | null; last_error?: string | null; }
	interface RuntimeAgent { slug: string; name?: string; port?: number; configDir?: string | null; ok: boolean; error?: string | null; }
	interface SecretEntry { agentId: string; key: string; set: boolean; }

	const colorMap: Record<string, string> = {
		azure: 'var(--color-accent)',
		jade: 'var(--color-accent-jade)',
		coral: 'var(--color-accent-coral)',
		amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)',
	};
	function getAgentColor(colorName?: string): string { return colorMap[colorName || ''] || 'var(--color-accent-amethyst)'; }

	let agents = $state<AgentInfo[]>([]);
	let loading = $state(true);
	// Last activity (most recent run) — for the collapsed agent cards' "active Xm ago" indicator.
	let lastActivityLabel = $state<string | null>(null);

	let viewMode = $state<ViewMode>('overview');

	// Manage-mode state (loaded lazily on first switch to 'manage').
	let providers = $state<Provider[]>([]);
	let assignments = $state<Assignment[]>([]);
	let runtimeAgents = $state<RuntimeAgent[]>([]);
	let secretsState = $state<SecretEntry[]>([]);
	let manageLoading = $state(false);
	let manageError = $state<string | null>(null);
	let manageLoaded = $state(false);

	const primaryAgent = $derived(agents[0] || null);

	onMount(async () => {
		const [agentsRes, actRes] = await Promise.all([
			api('/portal/agents').catch(() => null),
			api('/portal/agent-activity').catch(() => null),
		]);
		if (agentsRes?.ok) { const d = await agentsRes.json(); agents = d.agents || []; }
		if (actRes?.ok) {
			const d = await actRes.json();
			const e = (d.events || [])[0];
			if (e) lastActivityLabel = `${e.who} · ${rel(e.ts)}`;
		}
		loading = false;
	});

	function rel(ts: string): string {
		const diff = Date.now() - new Date(ts).getTime();
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
		return `${Math.round(diff / 86400000)}d ago`;
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
			if (agentsRes?.ok) { const data = await agentsRes.json(); agents = data.agents || agents; }
			if (providersRes?.ok) { const data = await providersRes.json(); providers = data.providers || []; }
			if (runtimeRes?.ok) { const data = await runtimeRes.json(); runtimeAgents = Array.isArray(data) ? data : (data.agents || []); }
			if (assignmentsRes?.ok) { const data = await assignmentsRes.json(); assignments = Array.isArray(data) ? data : (data.assignments || []); }
			if (secretsRes?.ok) { const data = await secretsRes.json(); secretsState = data.secrets || []; }
			manageLoaded = true;
		} catch (e) {
			manageError = e instanceof Error ? e.message : 'load failed';
		} finally {
			manageLoading = false;
		}
	}

	async function setViewMode(mode: ViewMode) {
		viewMode = mode;
		if (mode === 'manage' && !manageLoaded) await loadManageData();
	}

	const TABS: { id: ViewMode; label: string }[] = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'activity', label: 'Activity' },
		{ id: 'manage', label: 'Manage' },
	];
</script>

<svelte:head>
	<title>Agents - Mycelium</title>
</svelte:head>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)]">
		<h2 class="text-sm font-medium text-[var(--color-text-primary)]">Agents</h2>
		<div class="ml-3 inline-flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
			{#each TABS as tab (tab.id)}
				<button
					type="button"
					onclick={() => setViewMode(tab.id)}
					class="px-3 py-1 transition-colors cursor-pointer
						{viewMode === tab.id
							? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
							: 'bg-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
				>{tab.label}</button>
			{/each}
		</div>
		<div class="ml-auto flex items-center gap-2">
			{#if lastActivityLabel}
				<span class="text-xs text-[var(--color-text-tertiary)]">Last: {lastActivityLabel}</span>
			{/if}
		</div>
	</div>

	<div class="flex-1 overflow-y-auto px-6 py-4">
		{#if loading}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading agents…</div>
			</div>
		{:else if viewMode === 'overview'}
			<AgentOverview name={primaryAgent?.name || 'Mycelium'} color={getAgentColor(primaryAgent?.color)} />
		{:else if viewMode === 'activity'}
			<ActivityTimeline />
		{:else}
			<!-- Manage -->
			<div class="max-w-3xl mx-auto">
				{#if manageLoading}
					<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse py-12 text-center">Loading…</div>
				{:else if manageError}
					<div class="text-[var(--color-accent-coral)] text-sm py-12 text-center">{manageError}</div>
				{:else}
					<p class="text-[0.7rem] text-[var(--color-text-tertiary)] mb-4">
						Manage display name, Claude subscription, bot tokens, and inspect runtime state per agent. Click a row to expand.
					</p>
					<div class="flex flex-col gap-2">
						{#each agents as agent (agent.id)}
							<AgentRow
								{agent}
								{providers}
								{assignments}
								{runtimeAgents}
								{secretsState}
								lastActivity={lastActivityLabel}
								onChange={loadManageData}
							/>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
