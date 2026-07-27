<!--
  AgentsView — the agent's home, as ONE view.

  Was three tabs (Overview / Activity / Manage) over a single agent — V1 is
  single-agent by construction (GET /agents returns one synthetic `personal-agent`,
  src/portal-chat.js), so "Manage" was an accordion with one row and the three tabs
  each answered a different third of the same question. Last-activity was rendered in
  three places, the name in two, and the scheduled cycles twice from the same rows.

  Now: hero (who) → rail (what it may see / where it lives / what powers it)
  → main column (what it will do → what it has done). See
  the agents-page single-view design.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import AgentHero from '$lib/components/agents/AgentHero.svelte';
	import AccessCard from '$lib/components/agents/AccessCard.svelte';
	import ReachCard from '$lib/components/agents/ReachCard.svelte';
	import EngineCard from '$lib/components/agents/EngineCard.svelte';
	import RhythmsCard from '$lib/components/agents/RhythmsCard.svelte';
	import ActivityTimeline from '$lib/components/agents/ActivityTimeline.svelte';
	// P8d: relocated from the mindscape rail — see the mount site below for why.
	import NarrateControl from '$lib/components/mindscape/NarrateControl.svelte';
	import { agentColorChannels } from '$lib/components/agents/agent-visual';

	interface AgentInfo {
		id: string;
		name: string;
		defaultName?: string;
		role?: string | null;
		color?: string;
		port?: number;
		status: 'online' | 'offline';
		model?: string | null;
		activeTasks?: number;
	}
	interface Identity { name: string; channelWrite: boolean; scopes: string[]; allScopes: string[] }
	interface Provider { id: number; provider: string; label?: string | null; status?: string; config_dir?: string | null }
	interface Assignment { agent_id: string; provider_id: number; desired_state: 'pending' | 'applied' | 'failed'; applied_at?: string | null; last_error?: string | null }
	interface RuntimeAgent { slug: string; name?: string; port?: number; configDir?: string | null; ok: boolean; error?: string | null }
	interface SecretEntry { agentId: string; key: string; set: boolean }
	interface ActivityEvent { kind: string; id: string; ts: string; trigger: string; status: string; source: string; who: string; where: string; inputTokens?: number | null; outputTokens?: number | null; error?: string | null; conversationId?: string | null; taskId?: string | null; taskName?: string | null }
	interface Cycle { id: string; name: string; schedule: string; status: string; nextRun?: string | null; lastRun?: string | null; lastStatus?: string | null; runCount?: number; outputTarget?: string | null; createdBy?: string | null }

	// ── Wave 1: identity + activity (the fold) ──
	let agents = $state<AgentInfo[]>([]);
	let identity = $state<Identity | null>(null);
	let events = $state<ActivityEvent[]>([]);
	let cycles = $state<Cycle[]>([]);
	let nextCursor = $state<string | null>(null);
	let coreLoading = $state(true);
	let activityError = $state<string | null>(null);

	// ── Wave 2: the rail (providers / runtime / secrets / channels) ──
	let providers = $state<Provider[]>([]);
	let assignments = $state<Assignment[]>([]);
	let runtimeAgents = $state<RuntimeAgent[]>([]);
	let secretsState = $state<SecretEntry[]>([]);
	let channels = $state<{ telegram: boolean; discord: boolean }>({ telegram: false, discord: false });
	let railLoading = $state(true);

	// ── Character one-liner (read-only preview; authored on the character page) ──
	let personaLine = $state<string | null>(null);

	const agent = $derived<AgentInfo>(
		agents[0] || { id: 'personal-agent', name: identity?.name || 'Mycelium', color: 'amethyst', status: 'online' },
	);
	const agentRgb = $derived(agentColorChannels(agent.color));
	const runtime = $derived(runtimeAgents.find((r) => r.slug === agent.id) || null);
	const reachable = $derived(runtime?.ok !== false);

	// The engine that powers this agent: a resolved Claude subscription (literal
	// assignment, else the '*' wildcard) wins; otherwise the local model. Same walk
	// EngineCard renders, so the hero and the detail can never disagree.
	//
	// null until the provider/assignment wave lands. "Otherwise the local model" is a
	// conclusion drawn from an EMPTY assignment list, and an empty list means the same
	// thing whether there is no subscription or the request simply has not returned —
	// so before it returns the hero says nothing rather than asserting "Local model"
	// and silently correcting itself a moment later.
	const engineLabel = $derived.by<string | null>(() => {
		if (railLoading) return null;
		const claude = providers.filter((p) => p.provider === 'claude' && p.status !== 'quarantined');
		const literal = assignments.find((a) => a.agent_id === agent.id);
		const wild = assignments.find((a) => a.agent_id === '*');
		const pid = literal?.provider_id ?? wild?.provider_id ?? null;
		const obj = pid != null ? claude.find((p) => p.id === pid) : null;
		if (obj) return `Claude subscription · ${obj.label || `Claude #${obj.id}`}`;
		return agent.model ? `Local model · ${agent.model}` : 'Local model';
	});

	const lastEvent = $derived(events[0] || null);

	// ── Hero stats ──
	// "Turns today" is counted from the loaded page only. If every loaded event is
	// still today AND another page exists, the true count is higher — say so with a
	// "+" rather than reporting a number we cannot stand behind.
	const stats = $derived.by(() => {
		const today = new Date().toDateString();
		const todayCount = events.filter((e) => new Date(e.ts).toDateString() === today).length;
		const truncated = !!nextCursor && events.length > 0 && todayCount === events.length;
		const activeCycles = cycles.filter((c) => c.status === 'active').length;
		const connected = (channels.telegram ? 1 : 0) + (channels.discord ? 1 : 0);
		return [
			{ label: 'Turns today', value: truncated ? `${todayCount}+` : `${todayCount}` },
			{ label: 'Active cycles', value: `${activeCycles}` },
			{ label: 'Channels', value: `${connected}/2`, tone: connected ? 'var(--color-accent-jade)' : undefined },
		];
	});

	async function loadCore() {
		const [agentsRes, idRes, actRes] = await Promise.all([
			api('/portal/agents').catch(() => null),
			api('/portal/agent-identity').catch(() => null),
			api('/portal/agent-activity').catch(() => null),
		]);
		if (agentsRes?.ok) { const d = await agentsRes.json(); agents = d.agents || []; }
		if (idRes?.ok) identity = await idRes.json();
		if (actRes?.ok) {
			const d = await actRes.json();
			events = d.events || [];
			cycles = d.cycles || [];
			nextCursor = d.nextCursor || null;
			activityError = null;
		} else {
			activityError = 'Could not load activity';
		}
		coreLoading = false;
	}

	async function loadRail() {
		const [provRes, runRes, assignRes, secRes, chRes] = await Promise.all([
			api('/portal/providers').catch(() => null),
			api('/portal/providers/runtime-state').catch(() => null),
			api('/portal/providers/assignments').catch(() => null),
			api('/portal/settings/secrets').catch(() => null),
			api('/portal/channels').catch(() => null),
		]);
		if (provRes?.ok) { const d = await provRes.json(); providers = d.providers || []; }
		if (runRes?.ok) { const d = await runRes.json(); runtimeAgents = Array.isArray(d) ? d : (d.agents || []); }
		if (assignRes?.ok) { const d = await assignRes.json(); assignments = Array.isArray(d) ? d : (d.assignments || []); }
		if (secRes?.ok) { const d = await secRes.json(); secretsState = d.secrets || []; }
		if (chRes?.ok) {
			const d = await chRes.json();
			channels = {
				telegram: !!(d.telegram?.enabled ?? d.telegram?.connected ?? d.telegram),
				discord: !!(d.discord?.enabled ?? d.discord?.connected ?? d.discord),
			};
		}
		railLoading = false;
	}

	// The first line of PROSE in self.md. Markdown headings are skipped rather than
	// stripped — self.md conventionally opens with "# Self", and the old preview
	// (AgentRow) dutifully rendered "Self" as the agent's personality.
	function firstMeaningfulLine(md: string): string | null {
		for (const raw of md.split('\n')) {
			const trimmed = raw.trim();
			if (!trimmed || trimmed.startsWith('#') || /^[-=*_]{3,}$/.test(trimmed)) continue;
			const line = trimmed.replace(/^[-*>]\s*/, '').trim();
			if (line) return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
		}
		return null;
	}

	async function loadPersona() {
		// Only the personal agent carries a character capsule today.
		if (agent.id !== 'personal-agent') return;
		try {
			const r = await api('/portal/character/being');
			const d = r.ok ? await r.json() : null;
			personaLine = d?.content ? firstMeaningfulLine(d.content) : null;
		} catch { personaLine = null; }
	}

	onMount(() => {
		// Two waves so the fold paints without waiting on the five rail requests.
		loadCore().then(loadPersona);
		loadRail();
	});

	async function refreshActivity() {
		const res = await api('/portal/agent-activity').catch(() => null);
		if (res?.ok) {
			const d = await res.json();
			events = d.events || [];
			cycles = d.cycles || [];
			nextCursor = d.nextCursor || null;
			activityError = null;
		}
	}

	async function loadMore(before: string) {
		const res = await api(`/portal/agent-activity?before=${encodeURIComponent(before)}`).catch(() => null);
		if (!res?.ok) return;
		const d = await res.json();
		events = [...events, ...(d.events || [])];
		nextCursor = d.nextCursor || null;
	}

	// Identity changed (name / scopes / channel writes) → re-read the identity spine.
	async function refreshIdentity() {
		const [agentsRes, idRes] = await Promise.all([
			api('/portal/agents').catch(() => null),
			api('/portal/agent-identity').catch(() => null),
		]);
		if (agentsRes?.ok) { const d = await agentsRes.json(); agents = d.agents || agents; }
		if (idRes?.ok) identity = await idRes.json();
	}
</script>

<svelte:head><title>Agents - Mycelium</title></svelte:head>

<div class="page" style:--agent-rgb={agentRgb}>
	<div class="wrap">
		<AgentHero
			{agent}
			{engineLabel}
			lastActivityAt={lastEvent?.ts || null}
			lastActivityWho={lastEvent?.who || null}
			activeTasks={agent.activeTasks ?? 0}
			{reachable}
			{personaLine}
			{stats}
			onChange={refreshIdentity}
		/>

		<div class="grid">
			<div class="rail">
				<AccessCard {identity} loading={coreLoading} onChange={refreshIdentity} />
				<ReachCard {channels} loading={railLoading} />
				<EngineCard {agent} {providers} {assignments} {runtime} {secretsState} loading={railLoading} onChange={loadRail} />
			</div>

			<div class="main">
				<RhythmsCard {cycles} />
				<!-- P8d — the narration walk MOVED HERE from the mindscape rail (operator decision,
				     QA9 sprint design). It is an AGENT job: the agent walks your territories and
				     writes about them, with its own start/pause/resume/cancel lifecycle and its own
				     device-attribution badge. In the mindscape rail it sat beside a pipeline stage
				     list it has nothing to do with — the rail is the PIPELINE's surface, and the
				     sprint's layout rule (a section is a STAGE) has no room for a thing that is not
				     one. Here it lands exactly where this view's own structure says it belongs:
				     the main column reads "what it will do → what it has done", and a walk you can
				     start now sits between the scheduled rhythms and the completed activity.
				     ⚠️ RELOCATED, NOT DELETED — POST /mycelium/narrate*, narration_runs and all
				     seven narrate gates are untouched. The caller audit found this component is the
				     ONLY client consumer of those routes and had exactly ONE mount site, so the
				     move is a mount-point change with no server surface implicated. -->
				<NarrateControl />
				<ActivityTimeline
					{events}
					{nextCursor}
					loading={coreLoading}
					error={activityError}
					onMore={loadMore}
					onRefresh={refreshActivity}
				/>
			</div>
		</div>
	</div>
</div>

<style>
	/* The pane body is overflow:hidden, so the view owns its own scroll (the
	   AgentsView/SettingsView/CharacterView pattern). */
	.page { height: 100%; overflow-y: auto; }
	.wrap {
		max-width: 1180px;
		margin: 0 auto;
		padding: 1.25rem 1.5rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.grid {
		display: grid;
		grid-template-columns: 20rem minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.rail {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		position: sticky;
		top: 0;
	}
	.main { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }

	/* One column, in DOM order — hero → rail → rhythms → activity, the same narrative. */
	@media (max-width: 1080px) {
		.grid { grid-template-columns: 1fr; }
		.rail { position: static; }
	}
	@media (max-width: 600px) {
		.wrap { padding: 1rem 0.85rem 2.5rem; }
	}
</style>
