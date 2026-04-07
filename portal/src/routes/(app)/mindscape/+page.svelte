<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { mindscapeState, timelineHealth } from '$lib/stores/mindscape';
	import MindscapeDetail from '$lib/components/mindscape/MindscapeDetail.svelte';
	import Sparkline from '$lib/components/mindscape/Sparkline.svelte';
	import { api, apiGet, apiPut } from '$lib/api';
	import ConnectionsChecklist from '$lib/components/ConnectionsChecklist.svelte';

	// Health data for body state bar
	interface HealthDay { date: string; sleep_duration_min: number|null; sleep_efficiency: number|null; hrv_avg: number|null; resting_hr: number|null; steps: number|null; }
	interface HealthSummary { today: HealthDay|null; averages: Record<string, number|null>; trends: Record<string, string>; days: HealthDay[]; }
	let healthData = $state<HealthSummary|null>(null);

	// Lazy load 3D component (THREE.js is heavy)
	let Mindscape3D: any = $state(null);

	$effect(() => {
		if (browser && !Mindscape3D) {
			import('$lib/components/mindscape/Mindscape3D.svelte').then((module) => {
				Mindscape3D = module.default;
			});
		}
	});

	// Load mindscape store data (for left nav panel)
	$effect(() => {
		if (browser) {
			mindscapeState.load();
			// Load health summary
			apiGet<HealthSummary>('/portal/health/summary', { days: '7' })
				.then(d => { healthData = d; })
				.catch(() => {});
		}
	});

	const th = $derived($timelineHealth);

	// Growth events
	let viewMode: '3d' | 'growth' | 'territories' = $state('3d');
	let growthEvents: any[] = $state([]);
	let growthLoading = $state(false);
	let expandedStep: string | null = $state(null);

	// Onboarding state
	let aiProvider: 'claude' | 'api' = $state('claude');
	let aiSubProvider: 'anthropic' | 'openai' = $state('anthropic');
	let aiKeyInput = $state('');
	let aiKeySaving = $state(false);
	let aiKeySaved = $state(false);
	let aiKeyError = $state('');
	let claudeAuthLoading = $state(false);
	let claudeAuthDone = $state(false);
	let claudeAuthError = $state('');
	let claudeAuthUrl = $state('');
	let claudeAuthCode = $state('');
	let telegramTokenInput = $state('');
	let discordTokenInput = $state('');
	let integrationSaving = $state(false);
	let integrationSaved: string | null = $state(null);

	// Check if Claude Code is already authenticated on page load
	$effect(() => {
		if (browser && !claudeAuthDone) {
			api('/portal/auth/claude/status').then(async (res) => {
				if (res.ok) {
					const data = await res.json();
					if (data.authenticated) claudeAuthDone = true;
				}
			}).catch(() => {});
		}
	});

	async function connectClaude() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		claudeAuthUrl = '';
		try {
			const res = await api('/portal/auth/claude', { method: 'POST' });
			if (!res.ok) throw new Error('Failed to start auth');
			const data = await res.json();
			if (data.url) {
				claudeAuthUrl = data.url;
				window.open(data.url, '_blank');
			} else {
				throw new Error('No auth URL returned');
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Connection failed';
		}
		claudeAuthLoading = false;
	}

	async function submitClaudeCode() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		try {
			const res = await api('/portal/auth/claude/code', {
				method: 'POST',
				body: JSON.stringify({ code: claudeAuthCode.trim() }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(data.error || 'Failed to authenticate');
			}
			claudeAuthDone = true;
			claudeAuthUrl = '';
			claudeAuthCode = '';
			// Navigate to timeline to show the welcome greeting
			if (data.greeting) {
				setTimeout(() => goto('/timeline'), 1500);
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Authentication failed';
		}
		claudeAuthLoading = false;
	}

	async function saveAiKey() {
		aiKeySaving = true;
		aiKeyError = '';
		aiKeySaved = false;
		try {
			const key = aiSubProvider === 'anthropic' ? 'CLAUDE_API_KEY' : 'OPENAI_API_KEY';
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({ key, value: aiKeyInput.trim() }),
			});
			if (!res.ok) throw new Error('Failed to save');
			aiKeySaved = true;
			setTimeout(() => { aiKeySaved = false; }, 3000);
		} catch (e: any) {
			aiKeyError = e.message || 'Failed to save key';
		}
		aiKeySaving = false;
	}

	async function saveIntegration(key: string, value: string, scope: string) {
		integrationSaving = true;
		integrationSaved = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({ key, value: value.trim(), scope }),
			});
			if (!res.ok) throw new Error('Failed to save');
			const tag = key.includes('TELEGRAM') ? 'telegram' : 'discord';
			integrationSaved = tag;
			setTimeout(() => { integrationSaved = null; }, 3000);
		} catch {}
		integrationSaving = false;
	}

	async function loadGrowthEvents() {
		if (growthEvents.length > 0) return;
		growthLoading = true;
		try {
			const res = await fetch('/portal/mindscape/growth?limit=100', { credentials: 'include' });
			if (res.ok) {
				const data = await res.json();
				growthEvents = data.events || [];
			}
		} catch (e) {
			console.error('Failed to load growth events:', e);
		}
		growthLoading = false;
	}

	// Territory profiles + activations + realms
	let territories: any[] = $state([]);
	let realms: any[] = $state([]);
	let activations: any = $state(null);
	let territoriesLoading = $state(false);
	let selectedTerritory: any = $state(null);
	let selectedRealmId: number | null = $state(null);

	let noiseStats: { total: number; noise: number; noisePct: string } | null = $state(null);

	async function loadTerritories() {
		if (territories.length > 0) return;
		territoriesLoading = true;
		try {
			const [terrRes, actRes, realmRes, noiseRes] = await Promise.all([
				fetch('/portal/mindscape/territories', { credentials: 'include' }),
				fetch('/portal/mindscape/activations', { credentials: 'include' }),
				fetch('/portal/mindscape/realms', { credentials: 'include' }),
				fetch('/portal/mindscape/noise-stats', { credentials: 'include' }),
			]);
			if (terrRes.ok) {
				const data = await terrRes.json();
				territories = data.territories || [];
			}
			if (actRes.ok) {
				activations = await actRes.json();
			}
			if (realmRes.ok) {
				const data = await realmRes.json();
				realms = data.realms || [];
			}
			if (noiseRes.ok) {
				noiseStats = await noiseRes.json();
			}
		} catch (e) {
			console.error('Failed to load territories:', e);
		}
		territoriesLoading = false;
	}

	// Merge activation data into territory profiles
	const enrichedTerritories = $derived(() => {
		if (!territories.length) return [];
		const actMap = new Map<number, any>();
		if (activations?.active) {
			for (const a of activations.active) {
				actMap.set(a.territory_id, a);
			}
		}
		let filtered = territories.map(t => ({
			...t,
			activation: actMap.get(t.territory_id) || null,
		}));

		// Filter by selected realm if drilled in
		if (selectedRealmId !== null) {
			filtered = filtered.filter(t => t.realm_id === selectedRealmId);
		}

		return filtered.sort((a, b) => {
			const aAct = a.activation ? 1000 + Math.abs(a.activation.surprise) : (a.energy || 0);
			const bAct = b.activation ? 1000 + Math.abs(b.activation.surprise) : (b.energy || 0);
			return bAct - aAct;
		});
	});

	// Enrich realms with territory counts from territory data
	const enrichedRealms = $derived(() => {
		if (!realms.length) return [];
		const realmTerritoryCount = new Map<number, number>();
		const realmMessageCount = new Map<number, number>();
		for (const t of territories) {
			if (t.realm_id != null) {
				realmTerritoryCount.set(t.realm_id, (realmTerritoryCount.get(t.realm_id) || 0) + 1);
				realmMessageCount.set(t.realm_id, (realmMessageCount.get(t.realm_id) || 0) + (t.message_count || 0));
			}
		}
		return realms.map(r => ({
			...r,
			territory_count: r.territory_count || realmTerritoryCount.get(r.realm_id) || 0,
			total_messages: r.total_messages || realmMessageCount.get(r.realm_id) || 0,
		})).sort((a, b) => (b.total_messages || 0) - (a.total_messages || 0));
	});

	function drillIntoRealm(realmId: number) {
		selectedRealmId = realmId;
		selectedTerritory = null;
	}

	function goBackToRealms() {
		selectedRealmId = null;
		selectedTerritory = null;
	}

	const selectedRealmName = $derived(() => {
		if (selectedRealmId === null) return '';
		return realms.find(r => r.realm_id === selectedRealmId)?.name || `Realm ${selectedRealmId}`;
	});

	$effect(() => {
		if (viewMode === 'growth' && browser) loadGrowthEvents();
		if (viewMode === 'territories' && browser) loadTerritories();
	});

	function eventIcon(type: string) {
		switch (type) {
			case 'formed': return '+';
			case 'grew': return '^';
			case 'split': return '/';
			case 'merged': return '&';
			case 'dissolved': return 'x';
			case 'stable': return '=';
			default: return '?';
		}
	}

	function eventColor(type: string) {
		switch (type) {
			case 'formed': return 'var(--color-success, #10b981)';
			case 'grew': return 'var(--color-accent)';
			case 'dissolved': return 'var(--color-error, #ef4444)';
			case 'split': return 'var(--color-warning, #f59e0b)';
			case 'merged': return 'var(--color-info, #3b82f6)';
			default: return 'var(--color-muted)';
		}
	}

	const msState = $derived($mindscapeState);

	// Resizable panel state
	let panelWidth = $state(320);
	let isResizing = $state(false);
	let containerRef: HTMLElement;

	// Load saved width from localStorage
	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-detail-width');
			if (saved) {
				const parsed = parseInt(saved);
				if (parsed >= 250 && parsed <= 600) {
					panelWidth = parsed;
				}
			}
		}
	});

	// Resize handlers
	function startResize(e: MouseEvent) {
		e.preventDefault();
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		window.addEventListener('mousemove', onResize);
		window.addEventListener('mouseup', stopResize);
	}

	function onResize(e: MouseEvent) {
		if (!isResizing || !containerRef) return;
		const containerRect = containerRef.getBoundingClientRect();
		const newWidth = e.clientX - containerRect.left;
		panelWidth = Math.max(250, Math.min(600, newWidth));
	}

	function stopResize() {
		isResizing = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		window.removeEventListener('mousemove', onResize);
		window.removeEventListener('mouseup', stopResize);
		if (browser) {
			localStorage.setItem('mycelium-detail-width', panelWidth.toString());
		}
	}
</script>

<svelte:head>
	<title>Mindscape - Mycelium</title>
</svelte:head>

<div class="mindscape-layout" class:resizing={isResizing} bind:this={containerRef}>
	<!-- Navigation + detail panel (always visible) -->
	<aside class="nav-panel" style="width: {panelWidth}px;">
		<MindscapeDetail />
		<!-- Resize handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="resize-handle"
			class:active={isResizing}
			onmousedown={startResize}
		></div>
	</aside>

	<!-- Main content area -->
	<main class="view-panel">
		<!-- Body State bar — shows timeline health when scrubbing, today otherwise -->
		{#if th.active || healthData?.today}
			<div class="health-bar">
				{#if th.active}
					<!-- Timeline period averages -->
					{#if th.sleep != null}
						{@const h = Math.floor(th.sleep / 60)}
						{@const m = th.sleep % 60}
						<span class="hb-metric" title="Sleep avg">
							<span class="hb-icon" style="color: #818cf8;">&#9790;</span>
							{h}h{m.toString().padStart(2,'0')}m
						</span>
					{/if}
					{#if th.hrv != null}
						<span class="hb-metric" title="HRV avg">
							<span class="hb-icon" style="color: #4ade80;">&#9829;</span>
							{th.hrv}ms
						</span>
					{/if}
					{#if th.rhr != null}
						<span class="hb-metric" title="RHR avg">
							<span class="hb-icon" style="color: #f87171;">&#9829;</span>
							{th.rhr}bpm
						</span>
					{/if}
					{#if th.steps != null}
						<span class="hb-metric" title="Steps avg">
							<span class="hb-icon" style="color: #fb923c;">&#x1F6B6;</span>
							{th.steps.toLocaleString()}
						</span>
					{/if}
					{#if th.mindful != null}
						<span class="hb-metric" title="Mindfulness avg">
							<span class="hb-icon" style="color: #a78bfa;">&#x1F9D8;</span>
							{th.mindful}m
						</span>
					{/if}
				{:else if healthData?.today}
					{@const t = healthData.today}
					{#if t.sleep_duration_min != null}
						{@const h = Math.floor(t.sleep_duration_min / 60)}
						{@const m = Math.round(t.sleep_duration_min % 60)}
						<span class="hb-metric" title="Sleep">
							<span class="hb-icon" style="color: #818cf8;">&#9790;</span>
							{h}h{m.toString().padStart(2,'0')}m
							{#if t.sleep_efficiency != null}<span class="hb-sub">{Math.round(t.sleep_efficiency * 100)}%</span>{/if}
						</span>
					{/if}
					{#if t.hrv_avg != null}
						<span class="hb-metric" title="HRV">
							<span class="hb-icon" style="color: #4ade80;">&#9829;</span>
							{Math.round(t.hrv_avg)}ms
						</span>
					{/if}
					{#if t.resting_hr != null}
						<span class="hb-metric" title="Resting HR">
							<span class="hb-icon" style="color: #f87171;">&#9829;</span>
							{Math.round(t.resting_hr)}bpm
						</span>
					{/if}
					{#if t.steps != null}
						<span class="hb-metric" title="Steps">
							<span class="hb-icon" style="color: #fb923c;">&#x1F6B6;</span>
							{t.steps.toLocaleString()}
						</span>
					{/if}
					{#if healthData.trends}
						{#each Object.entries(healthData.trends) as [k, v]}
							{#if v && v !== 'insufficient'}
								{@const label = k === 'sleep_duration_min' ? 'Sleep' : k === 'hrv_avg' ? 'HRV' : k === 'resting_hr' ? 'RHR' : k === 'steps' ? 'Steps' : null}
								{#if label}
									{@const arrow = v === 'improving' ? '\u2197' : v === 'declining' ? '\u2198' : '\u2192'}
									{@const clr = v === 'improving' ? '#4ade80' : v === 'declining' ? '#f87171' : 'var(--color-text-tertiary)'}
									<span class="hb-trend" style="color: {clr}">{arrow}{label}</span>
								{/if}
							{/if}
						{/each}
					{/if}
				{/if}
			</div>
		{/if}

		<!-- View toggle -->
		<div class="view-toggle">
			<button class:active={viewMode === 'territories'} onclick={() => viewMode = 'territories'}>Territories</button>
			<button class:active={viewMode === '3d'} onclick={() => viewMode = '3d'}>3D Map</button>
			<button class:active={viewMode === 'growth'} onclick={() => viewMode = 'growth'}>Growth</button>
		</div>

		{#if viewMode === 'territories'}
			<div class="territories-view">
				{#if territoriesLoading}
					<div class="loading-3d"><div class="spinner"></div></div>
				{:else if territories.length === 0 && realms.length === 0}
					<p class="empty-state">No territory profiles yet. Run the clustering pipeline to generate territory descriptions.</p>
				{:else}
					<!-- Breadcrumb -->
					{#if selectedRealmId !== null}
						<div class="breadcrumb">
							<button class="breadcrumb-link" onclick={goBackToRealms}>Mindscape</button>
							<span class="breadcrumb-sep">/</span>
							<span class="breadcrumb-current">{selectedRealmName()}</span>
						</div>
					{/if}

					<div class="activation-summary">
						{#if activations?.total_messages}
							<span class="act-stat">{activations.total_messages} messages today</span>
							<span class="act-stat">{activations.active?.length || 0} territories active</span>
							{#if activations.silent?.length}
								<span class="act-stat silent">{activations.silent.length} usually-active silent</span>
							{/if}
						{/if}
						{#if noiseStats}
							<span class="act-stat">{noiseStats.total.toLocaleString()} points</span>
							{#if noiseStats.noise > 0}
								<span class="act-stat unclustered">{noiseStats.noise.toLocaleString()} unclustered ({noiseStats.noisePct}%)</span>
							{/if}
						{/if}
					</div>

					<!-- Realm cards (top level) -->
					{#if selectedRealmId === null && enrichedRealms().length > 0}
						<div class="realm-list">
							{#each enrichedRealms() as r (r.realm_id)}
								<button class="realm-card" onclick={() => drillIntoRealm(r.realm_id)}>
									<div class="realm-header">
										<span class="realm-name">{r.name || `Realm ${r.realm_id}`}</span>
										<span class="realm-count">{r.point_count?.toLocaleString() || 0} points · {r.territory_count} territories</span>
									</div>
									{#if r.essence}
										<p class="realm-essence">{r.essence}</p>
									{/if}
									<div class="realm-footer">
										<span class="realm-msgs">{r.total_messages || 0} msgs</span>
										{#if r.activity_timeline?.length}
											<Sparkline data={r.activity_timeline} width={80} height={20} />
										{/if}
									</div>
								</button>
							{/each}
						</div>
					{/if}

					<!-- Territory list (within a realm or flat if no realms) -->
					{#if selectedRealmId !== null || enrichedRealms().length === 0}
						<div class="territory-list">
							{#each enrichedTerritories() as t (t.territory_id)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="territory-card"
									class:active-today={t.activation}
									class:selected={selectedTerritory?.territory_id === t.territory_id}
									onclick={() => selectedTerritory = selectedTerritory?.territory_id === t.territory_id ? null : t}
								>
									<div class="terr-header">
										<span class="terr-name">{t.name || `Territory ${t.territory_id}`}</span>
										<div class="terr-badges">
											<button
												type="button"
												class="badge visibility-badge"
												class:vis-public={t.visibility === 'public'}
												class:vis-friends={t.visibility === 'friends'}
												onclick={(e: MouseEvent) => {
													e.stopPropagation();
													const next = t.visibility === 'private' ? 'public' : t.visibility === 'public' ? 'friends' : 'private';
													apiPut(`/portal/mindscape/territory/${t.territory_id}/visibility`, { visibility: next }).then(() => {
														t.visibility = next;
													}).catch(() => {});
												}}
												title={`Visibility: ${t.visibility || 'private'} (click to cycle)`}
											>
												{t.visibility === 'public' ? '\u{1F310}' : t.visibility === 'friends' ? '\u{1F465}' : '\u{1F512}'}
											</button>
											{#if t.activation}
												{#if t.activation.surprise > 0.5}
													<span class="badge surge">SURGE</span>
												{:else if t.activation.surprise < -0.3}
													<span class="badge quiet">QUIET</span>
												{:else}
													<span class="badge active">ACTIVE</span>
												{/if}
											{/if}
											{#if t.growth_state === 'growing'}
												<span class="badge growing">growing</span>
											{/if}
										</div>
									</div>

									{#if t.essence}
										<p class="terr-essence">{t.essence}</p>
									{/if}

									<div class="terr-metrics">
										<span class="metric">
											<span class="metric-label">msgs</span>
											<span class="metric-value">{(t.message_count || 0).toLocaleString()}</span>
										</span>
										<span class="metric">
											<span class="metric-label">energy</span>
											<span class="metric-value">{((t.energy || 0) * 100).toFixed(1)}%</span>
										</span>
										{#if t.explored_percent}
											<span class="metric" title="% of messages analyzed by Claude for this territory's chronicle">
												<span class="metric-label">analyzed</span>
												<span class="metric-value">{t.explored_percent}%</span>
											</span>
										{/if}
										{#if t.activation}
											<span class="metric today">
												<span class="metric-label">today</span>
												<span class="metric-value">{t.activation.today_count}</span>
											</span>
										{/if}
										{#if t.activity_timeline?.length}
											<Sparkline data={t.activity_timeline} />
										{/if}
									</div>

									{#if selectedTerritory?.territory_id === t.territory_id}
										<div class="terr-detail">
											{#if t.chronicle}
												<div class="detail-section">
													<h4>Chronicle</h4>
													<p class="chronicle-text">{t.chronicle}</p>
												</div>
											{:else if t.story_arc}
												<div class="detail-section">
													<h4>Story</h4>
													<p>{t.story_arc}</p>
												</div>
											{/if}
											{#if t.story_current_chapter}
												<div class="detail-section">
													<h4>Current Chapter</h4>
													<p>{t.story_current_chapter}</p>
												</div>
											{/if}
											{#if t.signature_patterns?.length}
												<div class="detail-section">
													<h4>Patterns</h4>
													<ul>{#each t.signature_patterns as p}<li>{p}</li>{/each}</ul>
												</div>
											{/if}
											{#if t.uncertainty_open_questions?.length}
												<div class="detail-section">
													<h4>Open Threads</h4>
													<ul>{#each t.uncertainty_open_questions as q}<li>{q}</li>{/each}</ul>
												</div>
											{/if}
											{#if t.activation?.agents?.length}
												<div class="detail-section">
													<h4>Active Agents Today</h4>
													<p>{t.activation.agents.join(', ')}</p>
												</div>
											{/if}
											{#if t.explored_percent}
												<div class="detail-section explored-note">
													<span>{t.explored_count || 0} of {t.message_count || 0} messages analyzed ({t.explored_percent}%)</span>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{:else if viewMode === '3d'}
			{#if msState.points && msState.points.length > 0}
				{#if Mindscape3D}
					<Mindscape3D />
				{:else}
					<div class="loading-3d">
						<div class="spinner"></div>
					</div>
				{/if}
			{:else}
				<!-- Onboarding: grow your mindscape -->
				<div class="onboarding">
					<div class="onboarding-inner">
						<div class="onboarding-icon">&#x25C6;</div>
						<h2 class="onboarding-title">Activate your mindscape</h2>
						<p class="onboarding-desc">Connect your first data source and watch your knowledge come to life.</p>
						<ConnectionsChecklist showTitle={false} />
						<p class="onboarding-footer">Every conversation, document, and message shapes your mindscape. It grows with you.</p>
					</div>
				</div>
			{/if}
		{:else}
			<!-- Growth timeline view -->
			<div class="growth-view">
				<h2>Semantic Growth Timeline</h2>
				{#if growthLoading}
					<div class="loading-3d"><div class="spinner"></div></div>
				{:else if growthEvents.length === 0}
					<p class="empty-state">No growth events yet. Run the clustering pipeline to start tracking semantic evolution.</p>
				{:else}
					<div class="growth-timeline">
						{#each growthEvents as event}
							<div class="growth-event">
								<div class="event-indicator" style="color: {eventColor(event.event_type)}">
									<span class="event-icon">{eventIcon(event.event_type)}</span>
								</div>
								<div class="event-content">
									<div class="event-header">
										<span class="event-type" style="color: {eventColor(event.event_type)}">{event.event_type}</span>
										<span class="event-level">{event.level}</span>
										{#if event.cluster_id != null}
											<span class="event-cluster">#{event.cluster_id}</span>
										{/if}
									</div>
									<div class="event-stats">
										{#if event.point_count != null}
											<span>{event.point_count} points</span>
										{/if}
										{#if event.point_delta && event.point_delta !== 0}
											<span class="delta" class:positive={event.point_delta > 0}>
												{event.point_delta > 0 ? '+' : ''}{event.point_delta}
											</span>
										{/if}
										{#if event.jaccard_score}
											<span class="jaccard">J={event.jaccard_score}</span>
										{/if}
									</div>
									{#if event.description}
										<p class="event-desc">{event.description}</p>
									{/if}
									<time class="event-time">{new Date(event.created_at).toLocaleString()}</time>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</main>
</div>

<style>
	.health-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 6px 12px;
		min-height: 30px;
		background: var(--color-surface);
		border-bottom: 1px solid var(--color-border);
		font-size: 0.7rem;
		color: var(--color-text-secondary);
		flex-wrap: nowrap;
		overflow: hidden;
	}
	.hb-metric {
		display: flex;
		align-items: center;
		gap: 3px;
		white-space: nowrap;
	}
	.hb-icon { font-size: 0.8rem; }
	.hb-sub { font-size: 0.6rem; color: var(--color-text-tertiary); }
	.hb-trend {
		font-size: 0.6rem;
		font-weight: 500;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(255,255,255,0.05);
	}

	.mindscape-layout {
		display: flex;
		width: 100%;
		height: 100%;
		position: relative;
	}

	.mindscape-layout.resizing {
		user-select: none;
	}

	.nav-panel {
		flex-shrink: 0;
		height: 100%;
		overflow: hidden;
		border-right: 1px solid var(--color-border);
		background: var(--color-surface);
		z-index: 10;
		position: relative;
	}

	.view-panel {
		flex: 1;
		height: 100%;
		min-width: 0;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: 0;
		width: 4px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		transition: background 0.15s;
		z-index: 20;
	}

	.resize-handle:hover,
	.resize-handle.active {
		background: var(--color-accent);
	}

	.loading-3d {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		background: var(--color-bg);
	}

	.spinner {
		width: 32px;
		height: 32px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.view-toggle {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 20;
		display: flex;
		gap: 2px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 2px;
	}
	.view-toggle button {
		padding: 6px 14px;
		border: none;
		background: transparent;
		color: var(--color-muted);
		font-size: 12px;
		font-weight: 500;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
	}
	.view-toggle button.active {
		background: var(--color-accent);
		color: var(--color-bg);
	}

	.growth-view {
		padding: 56px 24px 24px;
		height: 100%;
		overflow-y: auto;
		background: var(--color-bg);
	}
	.growth-view h2 {
		font-size: 18px;
		font-weight: 600;
		margin-bottom: 20px;
		color: var(--color-text);
	}
	/* Onboarding */
	.onboarding {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		background: var(--color-bg);
	}
	.onboarding-inner {
		max-width: 480px;
		padding: 3rem 2.5rem;
		text-align: center;
	}
	.onboarding-icon {
		color: var(--color-accent-aurum, #B8860B);
		font-size: 1.5rem;
		margin-bottom: 1.5rem;
		opacity: 0.6;
	}
	.onboarding-title {
		font-size: 1.25rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 0.5rem;
	}
	.onboarding-desc {
		font-size: 0.85rem;
		color: var(--color-text-secondary);
		line-height: 1.6;
		margin-bottom: 2rem;
	}
	.onboarding-checklist {
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
		margin-bottom: 2rem;
	}
	.onboarding-step {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: var(--color-surface);
		border-radius: 8px;
		transition: background 0.15s ease;
		border: none;
		width: 100%;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
	}
	.onboarding-step:hover {
		background: var(--color-elevated);
	}
	.step-arrow {
		color: var(--color-text-tertiary);
		font-size: 0.7rem;
		flex-shrink: 0;
		margin-left: auto;
	}
	.step-guide {
		padding: 0.75rem 1rem 0.75rem 3.5rem;
		background: var(--color-elevated);
		border-radius: 0 0 8px 8px;
		margin-top: -2px;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.7;
	}
	.step-guide p {
		margin: 0.25rem 0;
	}
	.step-guide code {
		font-family: var(--font-mono, monospace);
		font-size: 0.7rem;
		background: var(--color-surface);
		padding: 1px 5px;
		border-radius: 3px;
		color: var(--color-accent-aurum, #B8860B);
	}
	.step-guide a {
		color: var(--color-accent-aurum, #B8860B);
		text-decoration: none;
	}
	.step-guide a:hover {
		text-decoration: underline;
	}
	.guide-tabs {
		display: flex;
		gap: 2px;
		margin-bottom: 0.75rem;
		background: var(--color-surface);
		border-radius: 6px;
		padding: 2px;
	}
	.guide-tabs button {
		flex: 1;
		padding: 0.35rem 0.5rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.65rem;
		font-weight: 500;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--color-text-tertiary);
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.guide-tabs button.active {
		background: var(--color-bg);
		color: var(--color-text-primary);
	}
	.guide-input-row {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.guide-input {
		flex: 1;
		padding: 0.45rem 0.6rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.7rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		color: var(--color-text-primary);
		outline: none;
	}
	.guide-input:focus {
		border-color: var(--color-accent-aurum, #B8860B);
	}
	.guide-save-btn {
		padding: 0.45rem 0.75rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.65rem;
		font-weight: 500;
		background: var(--color-accent-aurum, #B8860B);
		color: #fff;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.15s ease;
	}
	.guide-save-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.guide-hero {
		padding: 0.6rem 0.75rem;
		background: rgba(184, 134, 11, 0.06);
		border-radius: 6px;
		margin-bottom: 0.75rem;
	}
	.guide-hero p {
		margin: 0.15rem 0;
		font-size: 0.72rem;
		color: var(--color-text-secondary);
	}
	.guide-hero strong {
		color: var(--color-accent-aurum, #B8860B);
	}
	.guide-steps-compact {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.gsc-step {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.72rem;
		color: var(--color-text-secondary);
	}
	.gsc-num {
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-surface);
		border-radius: 50%;
		font-size: 0.6rem;
		font-weight: 600;
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}
	.guide-ssh-hint {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		margin-top: 0.5rem;
	}
	.guide-tabs-sub {
		display: flex;
		gap: 2px;
		margin-bottom: 0.5rem;
	}
	.guide-tabs-sub button {
		padding: 0.25rem 0.6rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.6rem;
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text-tertiary);
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.guide-tabs-sub button.active {
		border-color: var(--color-accent-aurum, #B8860B);
		color: var(--color-accent-aurum, #B8860B);
	}
	.guide-connect-btn {
		width: 100%;
		padding: 0.65rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		font-weight: 500;
		background: var(--color-accent-aurum, #B8860B);
		color: #fff;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: opacity 0.15s ease;
		margin-top: 0.5rem;
	}
	.guide-connect-btn:hover { opacity: 0.9; }
	.guide-connect-btn:disabled { opacity: 0.5; cursor: wait; }
	.guide-error {
		color: #f87171;
		font-size: 0.68rem;
		margin-top: 0.35rem;
	}
	.data-sources {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px;
	}
	.data-source {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		background: var(--color-surface);
		border-radius: 6px;
		font-size: 0.7rem;
	}
	.ds-icon {
		font-size: 0.9rem;
		flex-shrink: 0;
	}
	.ds-name {
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
	}
	.ds-desc {
		color: var(--color-text-tertiary);
		font-size: 0.62rem;
		display: none;
	}
	.ds-format {
		margin-left: auto;
		font-family: var(--font-mono, monospace);
		font-size: 0.55rem;
		color: var(--color-text-tertiary);
		background: var(--color-elevated);
		padding: 1px 4px;
		border-radius: 2px;
		white-space: nowrap;
	}
	.step-icon {
		font-size: 1.1rem;
		width: 2rem;
		text-align: center;
		flex-shrink: 0;
	}
	.step-content {
		flex: 1;
		min-width: 0;
	}
	.step-name {
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--color-text-primary);
	}
	.step-desc {
		font-size: 0.72rem;
		color: var(--color-text-tertiary);
		margin-top: 1px;
	}
	.step-status {
		font-family: var(--font-mono, monospace);
		font-size: 0.6rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 2px 6px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.step-status.pending {
		color: var(--color-accent-aurum, #B8860B);
		background: rgba(184, 134, 11, 0.1);
	}
	.step-status.optional {
		color: var(--color-text-tertiary);
		background: var(--color-elevated);
	}
	.step-status.connected {
		color: #4ade80;
		background: rgba(74, 222, 128, 0.1);
	}
	.onboarding-footer {
		font-size: 0.72rem;
		color: var(--color-text-tertiary);
		line-height: 1.5;
		font-style: italic;
	}

	.empty-state {
		color: var(--color-muted);
		font-size: 14px;
		text-align: center;
		padding: 48px 24px;
	}
	.growth-timeline {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.growth-event {
		display: flex;
		gap: 12px;
		padding: 10px 12px;
		border-radius: 8px;
		transition: background 0.15s;
	}
	.growth-event:hover {
		background: var(--color-surface);
	}
	.event-indicator {
		flex-shrink: 0;
		width: 28px;
		text-align: center;
		padding-top: 2px;
	}
	.event-icon {
		font-family: var(--font-mono);
		font-size: 16px;
		font-weight: 700;
	}
	.event-content {
		flex: 1;
		min-width: 0;
	}
	.event-header {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 13px;
	}
	.event-type {
		font-weight: 600;
		text-transform: capitalize;
	}
	.event-level {
		color: var(--color-muted);
		font-size: 11px;
		background: var(--color-surface);
		padding: 1px 6px;
		border-radius: 4px;
	}
	.event-cluster {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-muted);
	}
	.event-stats {
		display: flex;
		gap: 10px;
		font-size: 12px;
		color: var(--color-muted);
		margin-top: 3px;
	}
	.delta.positive {
		color: var(--color-success, #10b981);
	}
	.jaccard {
		font-family: var(--font-mono);
		font-size: 11px;
	}
	.event-desc {
		font-size: 13px;
		color: var(--color-text);
		margin-top: 4px;
	}
	.event-time {
		font-size: 11px;
		color: var(--color-muted);
		display: block;
		margin-top: 3px;
	}

	/* Breadcrumb */
	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 12px;
		font-size: 13px;
	}
	.breadcrumb-link {
		color: var(--color-accent);
		background: none;
		border: none;
		cursor: pointer;
		font-size: 13px;
		font-family: inherit;
		padding: 0;
	}
	.breadcrumb-link:hover {
		text-decoration: underline;
	}
	.breadcrumb-sep {
		color: var(--color-muted);
	}
	.breadcrumb-current {
		color: var(--color-text);
		font-weight: 600;
	}

	/* Realm cards */
	.realm-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 8px;
		margin-bottom: 16px;
	}
	.realm-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 16px;
		background: var(--color-surface);
		border: 1px solid transparent;
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}
	.realm-card:hover {
		border-color: var(--color-accent);
		transform: translateY(-1px);
		box-shadow: 0 0 20px rgba(229, 184, 76, 0.1), 0 4px 12px rgba(0, 0, 0, 0.3);
	}
	.realm-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
	}
	.realm-name {
		font-weight: 600;
		font-size: 15px;
		color: var(--color-text);
	}
	.realm-count {
		font-size: 11px;
		color: var(--color-muted);
		background: var(--color-bg);
		padding: 2px 8px;
		border-radius: 10px;
	}
	.realm-essence {
		font-size: 13px;
		color: var(--color-muted);
		line-height: 1.4;
		margin: 0 0 8px;
	}
	.realm-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.realm-msgs {
		font-size: 12px;
		color: var(--color-muted);
		font-family: var(--font-mono);
	}

	/* Territories view */
	.territories-view {
		padding: 56px 24px 24px;
		height: 100%;
		overflow-y: auto;
		background: var(--color-bg);
	}
	.activation-summary {
		display: flex;
		gap: 16px;
		padding: 12px 16px;
		background: var(--color-surface);
		border-radius: 8px;
		margin-bottom: 16px;
		font-size: 13px;
	}
	.act-stat {
		color: var(--color-text);
		font-weight: 500;
	}
	.act-stat.silent {
		color: var(--color-warning, #f59e0b);
	}
	.act-stat.unclustered {
		color: var(--color-muted);
		font-style: italic;
	}
	.territory-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.territory-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 14px 16px;
		background: var(--color-surface);
		border: 1px solid transparent;
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}
	.territory-card:hover {
		border-color: var(--color-border);
		box-shadow: 0 0 16px rgba(229, 184, 76, 0.08), 0 2px 8px rgba(0, 0, 0, 0.2);
	}
	.territory-card.selected {
		border-color: var(--color-accent);
		box-shadow: 0 0 24px rgba(229, 184, 76, 0.15), 0 4px 12px rgba(0, 0, 0, 0.3);
	}
	.territory-card.active-today {
		border-left: 3px solid var(--color-accent);
		box-shadow: inset 2px 0 0 var(--color-accent), 0 0 12px rgba(229, 184, 76, 0.05);
	}
	.terr-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}
	.terr-name {
		font-weight: 600;
		font-size: 14px;
		color: var(--color-text);
	}
	.terr-badges {
		display: flex;
		gap: 4px;
	}
	.badge {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		border: 1px solid transparent;
	}
	.badge.surge {
		background: rgba(229, 184, 76, 0.2);
		color: var(--color-accent);
		border-color: rgba(229, 184, 76, 0.3);
		box-shadow: 0 0 8px rgba(229, 184, 76, 0.1);
	}
	.badge.quiet {
		background: rgba(245, 158, 11, 0.15);
		color: var(--color-warning, #f59e0b);
		border-color: rgba(245, 158, 11, 0.25);
	}
	.badge.active {
		background: rgba(16, 185, 129, 0.15);
		color: var(--color-success, #10b981);
		border-color: rgba(16, 185, 129, 0.25);
	}
	.badge.growing {
		background: rgba(59, 130, 246, 0.15);
		color: var(--color-info, #3b82f6);
		border-color: rgba(59, 130, 246, 0.25);
	}
	.visibility-badge {
		cursor: pointer;
		font-size: 11px;
		padding: 1px 4px;
		background: transparent;
		border: 1px solid var(--color-border);
		opacity: 0.5;
		transition: opacity 0.15s;
	}
	.visibility-badge:hover { opacity: 1; }
	.visibility-badge.vis-public {
		border-color: rgba(74, 222, 128, 0.3);
		opacity: 0.8;
	}
	.visibility-badge.vis-friends {
		border-color: rgba(91, 159, 232, 0.3);
		opacity: 0.8;
	}
	.terr-essence {
		font-size: 13px;
		color: var(--color-muted);
		margin: 6px 0 0;
		line-height: 1.4;
	}
	.terr-metrics {
		display: flex;
		gap: 14px;
		margin-top: 8px;
	}
	.metric {
		display: flex;
		gap: 4px;
		align-items: baseline;
		font-size: 12px;
	}
	.metric-label {
		color: var(--color-muted);
		font-size: 11px;
	}
	.metric-value {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-weight: 500;
	}
	.metric.today .metric-value {
		color: var(--color-accent);
	}
	.terr-detail {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--color-border);
	}
	.detail-section {
		margin-bottom: 10px;
	}
	.detail-section h4 {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 4px;
	}
	.detail-section p {
		font-size: 13px;
		color: var(--color-text);
		line-height: 1.5;
	}
	.detail-section ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.detail-section li {
		font-size: 13px;
		color: var(--color-text);
		padding: 2px 0;
	}
	.detail-section li::before {
		content: '- ';
		color: var(--color-muted);
	}
	.chronicle-text {
		white-space: pre-wrap;
		line-height: 1.5;
	}
	.explored-note {
		font-size: 12px;
		color: var(--color-muted);
		border-top: 1px solid rgba(255,255,255,0.05);
		padding-top: 8px;
		margin-top: 4px;
	}
</style>
