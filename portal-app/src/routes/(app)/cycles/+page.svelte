<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface CycleInfo {
		id: string;
		description: string;
		schedule: string;
		enabled: boolean;
		essential: boolean;
		fireHour: number | null;
		firedToday: boolean;
		// `status` is overloaded server-side: the GET handler derives 'completed'|'upcoming'
		// for timeline rendering (firedToday→completed). The new cycle-lifecycle status
		// ('active'|'paused'|'cancelled') comes through as `lifecycle` below so the two
		// don't collide.
		status: string;
		nextHour?: number;
		dayOfWeek?: number;
		// Added in Scheduler A4 — surfaced by the server when the agent has
		// picked up scheduler.js's A1 changes; absent on older agents.
		lifecycle?: 'active' | 'paused' | 'cancelled';
		created_by?: 'seed' | 'agent' | 'user';
		purpose?: string | null;
		delivery_channel?: string;
		last_run_at?: string | null;
		last_run_status?: string | null;
	}

	interface AgentCycles {
		agentId: string;
		name: string;
		color: string;
		role: string;
		status: string;
		health: { uptime: number; activeTasks: number; lastMessageTime: string | null; model: string | null } | null;
		cycles: CycleInfo[];
	}

	interface BackgroundJob {
		kind: string;
		status: string;
		stage_label: string;
		started_at: string;
		finished_at: string | null;
		step: number;
		total_steps: number;
	}

	let agents = $state<AgentCycles[]>([]);
	let backgroundJobs = $state<BackgroundJob[]>([]);
	let loading = $state(true);
	let currentDate = $state('');

	const AGENT_COLORS: Record<string, string> = {
		azure: '#5B9FE8', jade: '#4ADE80', coral: '#F87171',
		amethyst: '#A78BFA', aurum: '#E5B84C', crimson: '#EF4444',
		slate: '#94A3B8',
	};

	const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	function scheduleLabel(c: CycleInfo): string {
		if (c.schedule.startsWith('daily:')) return `${c.fireHour}:00`;
		if (c.schedule.startsWith('every:')) {
			const m = c.schedule.match(/(\d+)h/);
			return `every ${m?.[1]}h`;
		}
		if (c.schedule.startsWith('weekly:')) return `${DOW[c.dayOfWeek || 0]} ${c.fireHour}:00`;
		return c.schedule;
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		const min = Math.floor(ms / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min}m ago`;
		const hrs = Math.floor(min / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	function uptimeLabel(s: number): string {
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h`;
		return `${Math.floor(s / 86400)}d`;
	}

	async function refresh() {
		try {
			const res = await api('/portal/cycles');
			if (res.ok) {
				const data = await res.json();
				agents = data.agents || [];
				backgroundJobs = data.backgroundJobs || [];
				currentDate = data.date || new Date().toISOString().split('T')[0];
			}
		} catch {}
	}

	let pendingAction = $state<Record<string, boolean>>({});

	async function cycleAction(agentId: string, cycleId: string, action: 'pause' | 'resume' | 'cancel') {
		if (action === 'cancel') {
			if (!confirm(`Cancel cycle "${cycleId}"? Built-in cycles must be paused instead.`)) return;
		}
		const key = `${agentId}/${cycleId}`;
		pendingAction = { ...pendingAction, [key]: true };
		try {
			const res = await api(`/portal/cycles/${agentId}/${encodeURIComponent(cycleId)}/${action}`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				alert(body.detail || body.error || `Failed to ${action}`);
			}
			await refresh();
		} catch (e) {
			alert(`Network error — ${(e as Error).message}`);
		} finally {
			pendingAction = { ...pendingAction, [key]: false };
		}
	}

	onMount(async () => {
		await refresh();
		loading = false;
	});
</script>

<svelte:head>
	<title>Cycles — Mycelium</title>
</svelte:head>

<div class="cycles-page">
	{#if loading}
		<div class="loading">
			<div class="spinner"></div>
		</div>
	{:else}
		<!-- 24h Timeline -->
		<section class="timeline-section">
			<div class="section-header">
				<h2>Today</h2>
				<span class="date-label">{new Date(currentDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
			</div>

			<div class="timeline-grid">
				<!-- Hour labels -->
				<div class="timeline-hours">
					<div class="timeline-agent-label"></div>
					{#each Array(24) as _, h}
						<div class="hour-mark" class:now={h === new Date().getHours()}>
							{#if h % 3 === 0}{h.toString().padStart(2, '0')}{/if}
						</div>
					{/each}
				</div>

				<!-- Agent rows -->
				{#each agents.filter(a => a.cycles.length > 0) as agent}
					<div class="timeline-row">
						<div class="timeline-agent-label">
							<span class="agent-dot" style="background: {AGENT_COLORS[agent.color] || '#6B7280'}"></span>
							<span class="agent-name-sm">{agent.name}</span>
						</div>
						{#each Array(24) as _, h}
							{@const cyclesAtHour = agent.cycles.filter(c => c.fireHour === h)}
							<div class="hour-cell" class:now={h === new Date().getHours()}>
								{#each cyclesAtHour as c}
									<div
										class="cycle-dot"
										class:completed={c.firedToday}
										class:upcoming={!c.firedToday && h > new Date().getHours()}
										class:essential={c.essential}
										style="background: {c.firedToday ? AGENT_COLORS[agent.color] || '#6B7280' : 'transparent'}; border-color: {AGENT_COLORS[agent.color] || '#6B7280'}"
										title="{c.id}: {c.description} ({scheduleLabel(c)})"
									></div>
								{/each}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		</section>

		<!-- Agent Cards -->
		<section class="agents-section">
			{#each agents.filter(a => a.status === 'online' || a.cycles.length > 0) as agent}
				<div class="agent-card">
					<div class="agent-card-header">
						<span class="agent-dot-lg" style="background: {AGENT_COLORS[agent.color] || '#6B7280'}"></span>
						<div class="agent-card-info">
							<span class="agent-card-name">{agent.name}</span>
							<span class="agent-card-role">{agent.role}</span>
						</div>
						<div class="agent-card-status">
							{#if agent.status === 'online'}
								<span class="status-online">online</span>
								{#if agent.health?.uptime}
									<span class="status-uptime">{uptimeLabel(agent.health.uptime)}</span>
								{/if}
							{:else}
								<span class="status-offline">offline</span>
							{/if}
						</div>
					</div>

					{#if agent.health?.lastMessageTime}
						<div class="agent-last-active">Last active {relativeTime(agent.health.lastMessageTime)}</div>
					{/if}

					<div class="cycle-list">
						{#each agent.cycles as cycle (cycle.id)}
							{@const isPaused = cycle.lifecycle === 'paused'}
							{@const isCancelled = cycle.lifecycle === 'cancelled'}
							{@const isCustom = cycle.created_by === 'agent' || cycle.created_by === 'user'}
							{@const pendingKey = `${agent.agentId}/${cycle.id}`}
							<div
								class="cycle-item"
								class:completed={cycle.firedToday && !isPaused}
								class:essential={cycle.essential}
								class:paused={isPaused}
								class:cancelled={isCancelled}
								class:custom={isCustom}
							>
								<div class="cycle-indicator" class:done={cycle.firedToday && !isPaused}>
									{#if isPaused}&#10073;&#10073;{:else if isCancelled}&#10007;{:else if cycle.firedToday}&#10003;{:else}&#9675;{/if}
								</div>
								<div class="cycle-info">
									<div class="cycle-name-row">
										<span class="cycle-name">{cycle.id}</span>
										{#if isCustom}<span class="cycle-badge custom-badge" title="Custom schedule">custom</span>{/if}
										{#if isPaused}<span class="cycle-badge paused-badge">paused</span>{/if}
										{#if isCancelled}<span class="cycle-badge cancelled-badge">cancelled</span>{/if}
										{#if cycle.delivery_channel && cycle.delivery_channel !== 'lifecycle'}
											<span class="cycle-badge delivery-badge" title="Delivery channel">→ {cycle.delivery_channel}</span>
										{/if}
									</div>
									<span class="cycle-desc">{cycle.description}</span>
									{#if cycle.purpose}
										<span class="cycle-purpose">{cycle.purpose}</span>
									{/if}
								</div>
								<span class="cycle-schedule">{scheduleLabel(cycle)}</span>
								<div class="cycle-actions">
									{#if !isCancelled}
										{#if isPaused}
											<button
												class="cycle-btn"
												disabled={pendingAction[pendingKey]}
												onclick={() => cycleAction(agent.agentId, cycle.id, 'resume')}
												title="Resume"
											>resume</button>
										{:else}
											<button
												class="cycle-btn"
												disabled={pendingAction[pendingKey]}
												onclick={() => cycleAction(agent.agentId, cycle.id, 'pause')}
												title="Pause"
											>pause</button>
										{/if}
										{#if isCustom}
											<button
												class="cycle-btn cycle-btn-danger"
												disabled={pendingAction[pendingKey]}
												onclick={() => cycleAction(agent.agentId, cycle.id, 'cancel')}
												title="Cancel (built-in cycles must be paused instead)"
											>cancel</button>
										{/if}
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</section>

		<!-- Background Jobs -->
		{#if backgroundJobs.length > 0}
			<section class="jobs-section">
				<h3>Background Jobs</h3>
				<div class="jobs-list">
					{#each backgroundJobs as job}
						<div class="job-item" class:running={job.status === 'running'} class:done={job.status === 'done'} class:failed={job.status === 'error' || job.status === 'abandoned'}>
							<span class="job-kind">{job.kind.replace(/_/g, ' ')}</span>
							<span class="job-status">{job.status}</span>
							{#if job.stage_label}<span class="job-stage">{job.stage_label}</span>{/if}
							<span class="job-time">{relativeTime(job.started_at)}</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.cycles-page {
		height: 100%;
		overflow-y: auto;
		padding: 20px 24px;
		background: var(--color-bg);
	}
	.loading {
		display: flex;
		justify-content: center;
		align-items: center;
		height: 200px;
	}
	.spinner {
		width: 24px;
		height: 24px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Section headers */
	.section-header {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 16px;
	}
	.section-header h2 {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}
	.date-label {
		font-size: 13px;
		color: var(--color-text-tertiary);
	}

	/* 24h Timeline */
	.timeline-section {
		margin-bottom: 24px;
	}
	.timeline-grid {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 12px;
		overflow-x: auto;
	}
	.timeline-hours, .timeline-row {
		display: grid;
		grid-template-columns: 100px repeat(24, 1fr);
		gap: 0;
		min-width: 600px;
	}
	.timeline-agent-label {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		font-size: 11px;
	}
	.agent-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.agent-name-sm {
		color: var(--color-text-secondary);
		font-weight: 500;
		white-space: nowrap;
	}
	.hour-mark {
		text-align: center;
		font-size: 9px;
		color: var(--color-text-tertiary);
		padding: 2px 0;
		border-left: 1px solid var(--color-border);
	}
	.hour-mark.now {
		color: var(--color-accent);
		font-weight: 600;
	}
	.hour-cell {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4px 0;
		border-left: 1px solid rgba(255,255,255,0.03);
		min-height: 20px;
	}
	.hour-cell.now {
		background: rgba(91, 159, 232, 0.05);
	}
	.cycle-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid;
		transition: all 0.2s;
	}
	.cycle-dot.completed {
		box-shadow: 0 0 4px currentColor;
	}
	.cycle-dot.essential {
		width: 10px;
		height: 10px;
	}

	/* Agent Cards */
	.agents-section {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 12px;
		margin-bottom: 24px;
	}
	.agent-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 14px;
	}
	.agent-card-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}
	.agent-dot-lg {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.agent-card-info {
		flex: 1;
		min-width: 0;
	}
	.agent-card-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--color-text-primary);
		display: block;
	}
	.agent-card-role {
		font-size: 11px;
		color: var(--color-text-tertiary);
	}
	.agent-card-status {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.status-online {
		font-size: 10px;
		color: var(--color-accent-jade);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.status-offline {
		font-size: 10px;
		color: var(--color-text-tertiary);
		text-transform: uppercase;
	}
	.status-uptime {
		font-size: 10px;
		color: var(--color-text-tertiary);
	}
	.agent-last-active {
		font-size: 11px;
		color: var(--color-text-tertiary);
		margin-bottom: 10px;
	}

	/* Cycle list */
	.cycle-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.cycle-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 6px;
		transition: background 0.15s;
	}
	.cycle-item:hover {
		background: var(--color-elevated);
	}
	.cycle-indicator {
		width: 16px;
		text-align: center;
		font-size: 11px;
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}
	.cycle-indicator.done {
		color: var(--color-accent-jade);
	}
	.cycle-info {
		flex: 1;
		min-width: 0;
	}
	.cycle-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
		display: block;
	}
	.cycle-desc {
		font-size: 10px;
		color: var(--color-text-tertiary);
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cycle-schedule {
		font-size: 10px;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono);
		flex-shrink: 0;
	}
	.cycle-item.essential .cycle-name {
		color: var(--color-accent-aurum);
	}
	.cycle-item.paused { opacity: 0.55; }
	.cycle-item.cancelled { opacity: 0.35; text-decoration: line-through; }
	.cycle-item.custom { border-left: 2px solid var(--color-accent-amethyst, #A78BFA); padding-left: 8px; }

	.cycle-name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.cycle-badge {
		font-size: 9px;
		font-family: var(--font-mono);
		padding: 1px 5px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.custom-badge    { background: rgba(167, 139, 250, 0.15); color: var(--color-accent-amethyst, #A78BFA); }
	.paused-badge    { background: rgba(245, 158, 11, 0.15); color: var(--color-accent-aurum, #E5B84C); }
	.cancelled-badge { background: rgba(248, 113, 113, 0.15); color: var(--color-accent-coral, #F87171); }
	.delivery-badge  { background: var(--color-elevated); color: var(--color-text-tertiary); }

	.cycle-purpose {
		display: block;
		font-size: 10px;
		color: var(--color-text-secondary);
		margin-top: 2px;
		font-style: italic;
	}

	.cycle-actions {
		display: flex;
		gap: 4px;
		opacity: 0;
		transition: opacity 0.12s;
		flex-shrink: 0;
	}
	.cycle-item:hover .cycle-actions,
	.cycle-item:focus-within .cycle-actions,
	.cycle-item.paused .cycle-actions { opacity: 1; }
	.cycle-btn {
		font-size: 10px;
		padding: 2px 8px;
		border-radius: 4px;
		background: var(--color-elevated);
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.cycle-btn:hover { background: var(--color-accent); color: var(--color-bg); }
	.cycle-btn:disabled { opacity: 0.45; cursor: wait; }
	.cycle-btn-danger:hover { background: var(--color-accent-coral, #F87171); color: var(--color-bg); }

	/* Background Jobs */
	.jobs-section {
		margin-bottom: 24px;
	}
	.jobs-section h3 {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-secondary);
		margin: 0 0 10px;
	}
	.jobs-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.job-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 12px;
	}
	.job-kind {
		font-weight: 500;
		color: var(--color-text-primary);
		text-transform: capitalize;
	}
	.job-status {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.job-item.running .job-status { color: var(--color-accent); }
	.job-item.done .job-status { color: var(--color-accent-jade); }
	.job-item.failed .job-status { color: var(--color-accent-coral); }
	.job-stage {
		color: var(--color-text-tertiary);
		flex: 1;
	}
	.job-time {
		color: var(--color-text-tertiary);
		font-size: 11px;
		flex-shrink: 0;
	}

	@media (max-width: 767px) {
		.cycles-page { padding: 12px 16px; }
		.agents-section { grid-template-columns: 1fr; }
	}
</style>
