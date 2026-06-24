<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import MetricFreshnessBadge from '$lib/components/MetricFreshnessBadge.svelte';
	import CognitiveShapeTab from '$lib/cognitive-metrics/CognitiveShapeTab.svelte';

	// Workstream C tab toggle. Default: Vitality (Phase 1 surface) so the
	// existing surface remains the default landing experience.
	let activeTab = $state<'vitality' | 'cognitive-shape'>('vitality');

	let data = $state<any>(null);
	let loading = $state(true);
	let granularity = $state<'day' | 'week' | 'month'>('month');
	let selectedWindow = $state<{ start: string; end: string; idx: number } | null>(null);

	// Fisher trajectory data (Phase 5 integration). Fetched in parallel with
	// the snapshot — failures here MUST NOT block the page.
	let trajectorySummary = $state<any>(null);     // /portal/trajectory/summary
	let trajectoryRows = $state<any[]>([]);        // /portal/trajectory weekly_step rows
	let milestones = $state<any[]>([]);            // /portal/trajectory/milestones (active)

	// Hierarchy level for the Movement card. Realm is the most stable across
	// reclustering and the canonical headline; theme is mid-grain; territory
	// is the most granular. Switcher re-fetches summary + rows on change.
	let trajectoryLevel = $state<'realm' | 'theme' | 'territory'>('realm');

	// Period-detail panel width (drag-resizable, persists in localStorage).
	const PANEL_MIN = 280;
	const PANEL_MAX = 720;
	const PANEL_DEFAULT = 320;
	let panelWidth = $state(PANEL_DEFAULT);
	let panelDragging = $state(false);

	onMount(async () => {
		// Restore persisted panel width.
		try {
			const stored = localStorage.getItem('vitality:panelWidth');
			if (stored) {
				const n = parseInt(stored, 10);
				if (Number.isFinite(n) && n >= PANEL_MIN && n <= PANEL_MAX) panelWidth = n;
			}
		} catch { /* silent */ }

		// Snapshot + milestones in parallel; trajectory data is fetched by
		// loadTrajectoryAtLevel which is also re-fired on level switch.
		const [snapshotRes, milestonesRes] = await Promise.allSettled([
			api('/portal/vitality/snapshot'),
			api('/portal/trajectory/milestones?limit=5'),
		]);

		if (snapshotRes.status === 'fulfilled' && snapshotRes.value.ok) {
			try { data = await snapshotRes.value.json(); } catch { /* silent */ }
		}
		if (milestonesRes.status === 'fulfilled' && milestonesRes.value.ok) {
			try {
				const j = await milestonesRes.value.json();
				milestones = j.milestones || [];
			} catch { /* silent */ }
		}

		await loadTrajectoryAtLevel(trajectoryLevel);

		loading = false;
	});

	// Level-aware trajectory loader. Called on mount and on level switch.
	// Failure-quiet — Fisher outage just leaves the card empty for that level.
	async function loadTrajectoryAtLevel(level: 'realm' | 'theme' | 'territory') {
		try {
			const summaryRes = await api(`/portal/trajectory/summary?period=month&level=${level}`);
			if (summaryRes.ok) {
				const j = await summaryRes.json();
				trajectorySummary = j.summary;
			}
		} catch { /* silent */ }
		try {
			const rowsRes = await api(`/portal/trajectory?level=${level}&window_type=weekly_step`);
			if (rowsRes.ok) {
				const j = await rowsRes.json();
				trajectoryRows = j.trajectory || [];
			}
		} catch { /* silent */ }
	}

	// Re-fetch when the level toggle changes. Skip on first run (covered
	// by onMount) — `loaded` flag distinguishes mount-time from user action.
	let trajectoryLevelLoaded = false;
	$effect(() => {
		const lvl = trajectoryLevel;
		if (!trajectoryLevelLoaded) { trajectoryLevelLoaded = true; return; }
		loadTrajectoryAtLevel(lvl);
	});

	function persistPanelWidth(n: number) {
		try { localStorage.setItem('vitality:panelWidth', String(n)); } catch { /* silent */ }
	}

	// Drag-to-resize handlers. Left edge of the panel is the drag affordance.
	function startPanelDrag(_ev: PointerEvent) {
		panelDragging = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		const onMove = (e: PointerEvent) => {
			if (!panelDragging) return;
			// Panel is on the right; width = (window.innerWidth - mouseX), clamped.
			const w = Math.min(PANEL_MAX, Math.max(PANEL_MIN, window.innerWidth - e.clientX));
			panelWidth = w;
		};
		const onUp = () => {
			panelDragging = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			persistPanelWidth(panelWidth);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	async function dismissMilestone(id: string) {
		try {
			const res = await api(`/portal/trajectory/milestones/${id}/dismiss`, { method: 'POST' });
			if (res.ok) milestones = milestones.filter((m) => m.id !== id);
		} catch { /* silent */ }
	}

	// ── Helpers ──

	function pct(v: number | null | undefined, max = 1) {
		if (v == null) return 0;
		return Math.min(100, Math.max(0, (v / max) * 100));
	}

	function fmt(v: number | null | undefined, d = 0) {
		if (v == null) return '—';
		return d > 0 ? v.toFixed(d) : Math.round(v).toString();
	}

	// ── Fisher phase → landscape mapping ──
	// Replaces the heuristic landscape badge when Fisher trajectory data exists.
	// Fisher phase is the principled signal (R = D/L); the heuristic above is
	// a fallback for periods before Fisher data was computed.
	const PHASE_TO_LANDSCAPE: Record<string, { state: string; color: string; gradient: string; narrative: string }> = {
		cycling:      { state: 'Cycling',      color: '#fb923c', gradient: 'rgba(251,146,60,0.1)', narrative: 'Lots of movement returning to start. Often processing rather than progressing — integration may help.' },
		exploring:    { state: 'Exploring',    color: '#f59e0b', gradient: 'rgba(245,158,11,0.1)', narrative: 'Productive wandering — covering territory before settling. Mid-range R between 0.3 and 0.7.' },
		transforming: { state: 'Transforming', color: '#06b6d4', gradient: 'rgba(6,182,212,0.1)',  narrative: 'Straight-line movement. You went somewhere and stayed. Genuine transformation territory.' },
		stable:       { state: 'Stable',       color: '#4ade80', gradient: 'rgba(74,222,128,0.08)', narrative: 'Holding ground. Movement is below the noise floor — a still period that may be integration time.' },
	};

	// ── Landscape state logic ──

	function getLandscape(freq: any[], fp: any) {
		if (!freq?.length && !fp) return { state: 'Awaiting', color: '#6B6B75', gradient: 'rgba(107,107,117,0.08)', narrative: 'Generate your mindscape and run the clustering pipeline to see your cognitive vitality.' };

		const latest = freq?.[0];
		if (!latest) {
			return { state: 'Measured', color: '#06b6d4', gradient: 'rgba(6,182,212,0.06)', narrative: 'Cognitive profile computed. Run the vitality pipeline to unlock temporal insights.' };
		}

		const coh = latest.coherence ?? 0.5;
		const ent = latest.entropy ?? 0.5;
		const tcr = latest.compression ?? 0.3;
		const lr = latest.learning_rate ?? 0;

		if (coh > 0.7 && ent > 0.5 && lr < 0.1)
			return { state: 'Flowing', color: '#06b6d4', gradient: 'rgba(6,182,212,0.1)', narrative: 'Integrated and diverse — your thinking spans many domains with high coherence.' };
		if (coh > 0.7 && ent < 0.3)
			return { state: 'Focused', color: '#8b5cf6', gradient: 'rgba(139,92,246,0.1)', narrative: 'Deep focus — your attention is concentrated in a few territories with strong integration.' };
		if (lr > 0.2 && ent > 0.4)
			return { state: 'Exploring', color: '#f59e0b', gradient: 'rgba(245,158,11,0.1)', narrative: 'Active exploration — your topic distribution is shifting rapidly across territories.' };
		if (tcr < 0.15)
			return { state: 'Cycling', color: '#fb923c', gradient: 'rgba(251,146,60,0.1)', narrative: 'Repetitive patterns detected — your language is becoming more compressible.' };
		if (coh < 0.4)
			return { state: 'Fragmenting', color: '#f87171', gradient: 'rgba(248,113,113,0.1)', narrative: 'Low coherence — your territories are diverging. This can precede reorganization.' };
		return { state: 'Steady', color: '#4ade80', gradient: 'rgba(74,222,128,0.08)', narrative: 'Balanced rhythm — coherent thinking with moderate exploration.' };
	}

	function generateInsights(freq: any[]): string[] {
		if (!freq?.length || freq.length < 3) return [];
		const insights: string[] = [];
		const recent = freq.slice(0, 3);
		const older = freq.slice(3, 6);

		if (recent.length >= 2 && older.length >= 1) {
			const recentCoh = recent.reduce((a: number, f: any) => a + (f.coherence || 0), 0) / recent.length;
			const olderCoh = older.reduce((a: number, f: any) => a + (f.coherence || 0), 0) / older.length;
			if (recentCoh > olderCoh + 0.05) insights.push(`Coherence rising — your thinking is becoming more integrated.`);
			else if (recentCoh < olderCoh - 0.05) insights.push(`Coherence declining — your territories are diverging. Often precedes a breakthrough.`);
		}

		if (recent.length >= 2 && older.length >= 1) {
			const recentTcr = recent.reduce((a: number, f: any) => a + (f.compression || 0), 0) / recent.length;
			const olderTcr = older.reduce((a: number, f: any) => a + (f.compression || 0), 0) / older.length;
			if (recentTcr < olderTcr - 0.02) insights.push(`Compression dropping — more repetitive patterns. Consider exploring new questions.`);
			else if (recentTcr > olderTcr + 0.02) insights.push(`Information density rising — your conversations are generating more novel content.`);
		}

		const latest = recent[0];
		if (latest?.learning_rate > 0.15) insights.push(`High learning rate — your topic distribution is shifting significantly.`);
		if (latest?.entropy > 0.7) insights.push(`Attention widely distributed across ${latest.territory_count || 'many'} territories.`);
		if (latest?.entropy < 0.3 && latest?.territory_count > 5) insights.push(`Attention concentrated despite having ${latest.territory_count} territories — deep focus mode.`);

		return insights;
	}

	// ── Radar chart SVG ──

	function radarPoints(scores: number[], radius: number, cx: number, cy: number) {
		const n = scores.length;
		return scores.map((s, i) => {
			const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
			const r = s * radius;
			return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
		}).join(' ');
	}

	function radarAxisEnd(i: number, n: number, radius: number, cx: number, cy: number) {
		const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
		return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
	}

	// ── Area chart path ──

	function areaPath(points: { x: number; y: number }[], w: number, h: number, baseline: number) {
		if (points.length < 2) return '';
		const path = points.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(' ');
		return `${path} L ${points[points.length - 1].x},${baseline} L ${points[0].x},${baseline} Z`;
	}

	function linePath(points: { x: number; y: number }[]) {
		if (points.length < 2) return '';
		return points.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(' ');
	}

	// ── Derived data ──

	const filteredFreq = $derived((data?.vitality as any[] || []).filter((f: any) => f.granularity === granularity).sort((a: any, b: any) => (b.window_end || '').localeCompare(a.window_end || '')));

	// Landscape state: Fisher phase wins when trajectory data exists; otherwise
	// fall back to the legacy heuristic on coh/ent/lr/tcr. The Fisher phase is
	// the principled answer (categorical from R = D/L over weekly_step), the
	// heuristic was a proxy for what we now measure honestly.
	const landscape = $derived.by(() => {
		const heuristic = getLandscape(filteredFreq, data?.fingerprint);
		// Phase 1: prefer phase_recent (rolling 90d) over legacy `phase`
		// (cumulative R = D/L, degenerate). Coalesce keeps existing rows
		// rendering correctly until PR 1.4 fleet recompute populates
		// phase_recent on every host.
		const fisherPhase = trajectorySummary?.phase_recent ?? trajectorySummary?.phase;
		if (fisherPhase && PHASE_TO_LANDSCAPE[fisherPhase]) {
			return { ...PHASE_TO_LANDSCAPE[fisherPhase], _source: 'fisher' as const };
		}
		return { ...heuristic, _source: 'heuristic' as const };
	});
	const insights = $derived(generateInsights(filteredFreq));

	const radarScores = $derived(
		data?.fingerprint
			? [data.fingerprint.depth_score || 0, data.fingerprint.breadth_score || 0, data.fingerprint.coherence_score || 0, data.fingerprint.exploration_score || 0]
			: [0, 0, 0, 0]
	);

	const radarLabels = ['Depth', 'Breadth', 'Coherence', 'Exploration'];

	const complexityPoints = $derived(() => {
		const cx = (data?.complexity || []).filter((c: any) => c.level === 'global').reverse();
		if (cx.length < 2) return [];
		const max = Math.max(...cx.map((c: any) => c.lz_complexity || 0)) || 1;
		const w = 100;
		const h = 100;
		const pad = 4;
		return cx.map((c: any, i: number) => ({
			x: pad + ((w - pad * 2) * i) / (cx.length - 1),
			y: h - pad - ((c.lz_complexity || 0) / max) * (h - pad * 2),
			raw: c.lz_complexity,
			date: c.window_end,
		}));
	});

	const sentimentPoints = $derived(() => {
		const days = [...(data?.sentiment || [])].reverse();
		if (days.length < 2) return { points: [], maxMsg: 0 };
		const maxMsg = Math.max(...days.map((d: any) => d.msg_count || 0)) || 1;
		const maxVal = Math.max(...days.map((d: any) => Math.abs(d.avg_valence || 0))) || 0.5;
		const w = 100;
		const h = 100;
		const mid = h / 2;
		const pad = 4;
		return {
			points: days.map((d: any, i: number) => ({
				x: pad + ((w - pad * 2) * i) / (days.length - 1),
				y: mid - ((d.avg_valence || 0) / maxVal) * (mid - pad),
				valence: d.avg_valence || 0,
				volume: d.msg_count || 0,
				volumeH: ((d.msg_count || 0) / maxMsg) * (h - pad * 2),
				date: d.day,
			})),
			maxMsg,
		};
	});

	const growthColors: Record<string, string> = {
		formed: '#4ade80', grew: '#E5B84C', dissolved: '#f87171',
		split: '#fb923c', merged: '#3b82f6', stable: '#6B6B75',
	};

	// Selected window context
	const selectedFreq = $derived(
		selectedWindow ? filteredFreq?.find((f: any) => f.window_end === selectedWindow?.end) : null
	);
	const selectedEvents = $derived(
		selectedWindow ? (data?.growthEvents || []).filter((e: any) =>
			e.created_at >= (selectedWindow?.start || '') && e.created_at <= ((selectedWindow?.end || '') + 'T23:59:59')
		) : []
	);

	// Closest weekly_step Fisher row to the selected window. Trajectory windows
	// don't always align with snapshot windows (different cadences), so we
	// pick the row whose [start, end] overlaps the most. Only meaningful when
	// granularity is week or month.
	const selectedFisherRow = $derived.by(() => {
		if (!selectedWindow || !trajectoryRows.length) return null;
		const selStart = selectedWindow.start || '';
		const selEnd = selectedWindow.end || '';
		// Find the trajectory row whose window encompasses or overlaps the selection.
		// Pick the one with the largest end-time that's <= selectedEnd.
		const candidates = trajectoryRows.filter((r) =>
			r.window_end <= selEnd + 'T23:59:59' && r.window_start >= selStart.slice(0, 10),
		);
		if (candidates.length > 0) {
			return candidates.sort((a, b) => (b.window_end || '').localeCompare(a.window_end || ''))[0];
		}
		// Fallback: nearest row whose end is <= selectedEnd.
		const nearby = trajectoryRows
			.filter((r) => r.window_end <= selEnd + 'T23:59:59')
			.sort((a, b) => (b.window_end || '').localeCompare(a.window_end || ''));
		return nearby[0] || null;
	});

	// Chronicle for selected window
	let chronicle = $state<any>(null);
	let chronicleLoading = $state(false);
	let arcData = $state<any>(null);

	function selectPoint(i: number, freq: any[]) {
		const f = freq[i];
		if (selectedWindow?.idx === i && selectedWindow?.end === f.window_end) {
			selectedWindow = null;
			chronicle = null;
		} else {
			selectedWindow = { start: f.window_start, end: f.window_end, idx: i };
			fetchChronicle(f.window_start, f.window_end);
		}
	}

	async function fetchChronicle(start: string, end: string) {
		chronicleLoading = true;
		chronicle = null;
		try {
			const res = await api(`/portal/vitality/chronicle/by-window?start=${start}&end=${end}&granularity=${granularity}`);
			if (res.ok) {
				const d = await res.json();
				chronicle = d.chronicle;
			}
		} catch { /* silent */ }
		chronicleLoading = false;
	}

	async function fetchArc() {
		try {
			const res = await api('/portal/vitality/arc');
			if (res.ok) {
				const d = await res.json();
				arcData = d.arc;
			}
		} catch { /* silent */ }
	}

	// Reset selection when granularity changes
	$effect(() => { granularity; selectedWindow = null; chronicle = null; });

	// Load arc on mount
	onMount(() => { fetchArc(); });

	const signatureColors: Record<string, string> = {
		exploring: '#f59e0b', synthesizing: '#8b5cf6', consolidating: '#06b6d4',
		fragmenting: '#f87171', steady: '#4ade80', quiet: '#6B6B75', dormant: '#4B4B55',
	};

	const stateColors: Record<string, string> = {
		growing: '#4ade80', steady: '#f59e0b', stuck: '#f87171',
	};
</script>

<svelte:head><title>Vitality</title></svelte:head>

<div class="page">
	<div class="tab-bar" role="tablist" aria-label="Vitality view">
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'vitality'}
			class="tab-btn"
			class:active={activeTab === 'vitality'}
			onclick={() => (activeTab = 'vitality')}
		>
			Vitality
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'cognitive-shape'}
			class="tab-btn"
			class:active={activeTab === 'cognitive-shape'}
			onclick={() => (activeTab = 'cognitive-shape')}
		>
			Cognitive shape
		</button>
	</div>

	{#if activeTab === 'cognitive-shape'}
		<div class="tab-content">
			<CognitiveShapeTab />
		</div>
	{:else if loading}
		<div class="loading"><div class="spinner"></div></div>
	{:else if !data}
		<div class="empty">
			<div class="empty-icon">~</div>
			<h2>No vitality data yet</h2>
			<p>Import conversations and generate your mindscape. Cognitive measurements emerge as your data grows.</p>
		</div>
	{:else}
		<!-- ═══ Section 1: Landscape State (Hero) ═══ -->
		<section class="landscape" style="background: linear-gradient(135deg, {landscape.gradient}, transparent 70%);">
			<div class="landscape-inner">
				<span class="landscape-label" style="color: {landscape.color}">{landscape.state}</span>
				<p class="landscape-narrative">{landscape.narrative}</p>
				{#if filteredFreq?.[0]}
					{@const f = filteredFreq[0]}
					<div class="landscape-pills">
						{#if f.coherence != null}<span class="pill">coherence {fmt(f.coherence, 2)}</span>{/if}
						{#if f.entropy != null}<span class="pill">entropy {fmt(f.entropy, 2)}</span>{/if}
						{#if f.compression != null}<span class="pill">TCR {fmt(f.compression, 2)}</span>{/if}
						{#if f.learning_rate != null}<span class="pill">learning rate {fmt(f.learning_rate, 3)}</span>{/if}
						{#if f.territory_count}<span class="pill">{f.territory_count} territories</span>{/if}
					</div>
				{/if}
			</div>
		</section>

		<!-- ═══ Section 2: Cognitive Profile (Radar) ═══ -->
		{#if data.fingerprint}
			{@const fp = data.fingerprint}
			<section class="card profile-row">
				<div class="radar-container">
					<svg viewBox="0 0 200 200" class="radar-svg">
						{#each [0.25, 0.5, 0.75, 1.0] as ring}
							<polygon points={radarPoints([ring, ring, ring, ring], 65, 100, 100)} fill="none" stroke="var(--color-border)" stroke-width="0.5" opacity={ring === 1 ? 0.4 : 0.2} />
						{/each}
						{#each radarLabels as _, i}
							{@const end = radarAxisEnd(i, 4, 65, 100, 100)}
							<line x1="100" y1="100" x2={end.x} y2={end.y} stroke="var(--color-border)" stroke-width="0.5" opacity="0.3" />
						{/each}
						<polygon points={radarPoints(radarScores, 65, 100, 100)} fill="rgba(6,182,212,0.15)" stroke="#06b6d4" stroke-width="1.5" class="radar-shape" />
						{#each radarScores as score, i}
							{@const end = radarAxisEnd(i, 4, score * 65, 100, 100)}
							<circle cx={end.x} cy={end.y} r="3" fill="#06b6d4" />
						{/each}
						{#each radarLabels as label, i}
							{@const end = radarAxisEnd(i, 4, 85, 100, 100)}
							{@const anchor = i === 1 ? 'start' : i === 3 ? 'end' : 'middle'}
							<text x={end.x} y={end.y} text-anchor={anchor} dominant-baseline="middle" fill="var(--color-text-tertiary)" font-size="8.5">{label} <tspan fill="var(--color-text-secondary)" font-family="var(--font-mono)" font-size="7.5">{fmt(radarScores[i], 2)}</tspan></text>
						{/each}
					</svg>
				</div>
				<div class="profile-stats">
					<div class="stat"><span class="stat-value">{fp.territory_count || 0}</span><span class="stat-label">territories</span></div>
					<div class="stat"><span class="stat-value">{fp.realm_count || 0}</span><span class="stat-label">realms</span></div>
					<div class="stat"><span class="stat-value">{(fp.message_count || 0).toLocaleString()}</span><span class="stat-label">messages</span></div>
					{#if filteredFreq?.[0]}
						{@const latest = filteredFreq[0]}
						<div class="stat-divider"></div>
						{#if latest.learning_rate != null}<div class="stat"><span class="stat-value dyn" style="color:#4ade80">{fmt(latest.learning_rate, 3)}</span><span class="stat-label">learning rate</span></div>{/if}
						{#if latest.entropy != null}<div class="stat"><span class="stat-value dyn" style="color:#f59e0b">{fmt(latest.entropy, 3)}</span><span class="stat-label">entropy</span></div>{/if}
						{#if latest.gradient_signal != null}<div class="stat"><span class="stat-value dyn" style="color:#f87171">{fmt(latest.gradient_signal, 3)}</span><span class="stat-label">gradient</span></div>{/if}
						{#if latest.compression != null}<div class="stat"><span class="stat-value dyn" style="color:#06b6d4">{fmt(latest.compression, 3)}</span><span class="stat-label">compression</span></div>{/if}
					{/if}
				</div>
			</section>
		{/if}

		<!-- ═══ Section 2b: Cognitive Movement (Fisher Trajectory) ═══ -->
		{#if trajectorySummary}
			<section class="card movement-card">
				<div class="movement-header">
					<h2 class="section-title">
						Cognitive Movement
						<span class="title-sub">Fisher trajectory · past month · {trajectoryLevel}</span>
						<MetricFreshnessBadge tables={['fisher_trajectory', 'fisher_milestones']} />
					</h2>
					<div class="movement-controls">
						<div class="level-switcher" role="tablist" aria-label="Trajectory hierarchy level">
							<button
								role="tab"
								class:active={trajectoryLevel === 'realm'}
								onclick={() => trajectoryLevel = 'realm'}
								title="Realms — most stable headline"
							>realm</button>
							<button
								role="tab"
								class:active={trajectoryLevel === 'theme'}
								onclick={() => trajectoryLevel = 'theme'}
								title="Semantic themes — mid-grain patterns"
							>theme</button>
							<button
								role="tab"
								class:active={trajectoryLevel === 'territory'}
								onclick={() => trajectoryLevel = 'territory'}
								title="Territories — fine-grained movement"
							>territory</button>
						</div>
						<span class="phase-badge" style="background: {landscape.color}; color: var(--color-bg);">
							{trajectorySummary.phase_recent ?? trajectorySummary.phase}
						</span>
					</div>
				</div>
				<div class="movement-stats">
					{#if (trajectorySummary.R_recent ?? trajectorySummary.exploration_ratio) != null}
						<div class="stat" title="Exploration ratio: D/L. R≈1 = transforming (straight-line). R≈0 = cycling (returns to start). 0.3–0.7 = exploring (productive wandering).">
							<span class="stat-value" style="color:{landscape.color}">{fmt(trajectorySummary.R_recent ?? trajectorySummary.exploration_ratio, 2)}</span>
							<span class="stat-label">exploration ratio</span>
						</div>
					{/if}
					<div class="stat" title="Total Fisher distance traveled in the period (cumulative L).">
						<span class="stat-value">{fmt(trajectorySummary.total_distance, 2)}</span>
						<span class="stat-label">distance L</span>
					</div>
					<div class="stat" title="Geodesic from period start to end (D).">
						<span class="stat-value">{fmt(trajectorySummary.displacement, 2)}</span>
						<span class="stat-label">displacement D</span>
					</div>
					{#if trajectorySummary.avg_velocity_z != null}
						<div class="stat" title="Average velocity z-score over the period — how many σ above the sampling-noise floor.">
							<span class="stat-value">{fmt(trajectorySummary.avg_velocity_z, 1)}σ</span>
							<span class="stat-label">avg z-score</span>
						</div>
					{/if}
					{#if trajectorySummary.peak_velocity?.value != null}
						<div class="stat" title="Peak weekly velocity — biggest single-week movement.">
							<span class="stat-value">{fmt(trajectorySummary.peak_velocity.value, 3)}</span>
							<span class="stat-label">peak velocity</span>
						</div>
					{/if}
				</div>
				{#if trajectorySummary.top_movers?.length}
					<div class="movement-movers">
						<h3 class="movers-title">Top movers this week</h3>
						{#each trajectorySummary.top_movers.slice(0, 5) as m}
							<div class="mover">
								<span class="mover-dir" style="color: {m.direction === '+' ? '#4ade80' : '#f87171'}">
									{m.direction === '+' ? '↑' : '↓'}
								</span>
								<span class="mover-name">{m.name || m.id}</span>
								{#if m.pct != null}<span class="mover-pct">{Math.round(m.pct * 100)}%</span>{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if milestones.length > 0}
					<div class="movement-milestones">
						{#each milestones as ms}
							<div class="milestone-row">
								<span class="milestone-rule">{ms.rule_type.replace(/_/g, ' ')}</span>
								<span class="milestone-headline">{ms.headline}</span>
								<button class="milestone-dismiss" onclick={() => dismissMilestone(ms.id)} title="Dismiss">×</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		<!-- ═══ Split layout: charts + context panel ═══ -->
		<div class="freq-split">
		<div class="freq-charts">

		<!-- ═══ Section 3: Cognitive Dynamics (Per-Metric Charts) ═══ -->
		{#if data.vitality?.length > 1}
			{@const freq = (data.vitality as any[]).filter((f: any) => f.granularity === granularity).sort((a: any, b: any) => (a.window_end || '').localeCompare(b.window_end || ''))}
			{@const metrics = [
				{ key: 'coherence', label: 'Coherence', color: '#8b5cf6', info: 'How integrated is your thinking? Measures similarity between territory centroids. High = your ideas connect across domains. Low = fragmented, siloed thinking.' },
				{ key: 'entropy', label: 'Entropy', color: '#f59e0b', info: 'How broadly is your attention distributed? High = engaging many territories equally. Low = concentrated on a few topics. Neither is better — it depends on your phase.' },
				{ key: 'compression', label: 'Compression', color: '#06b6d4', info: 'How information-dense is your language? Measured via gzip compression ratio. Higher = more novel content. Lower = more repetitive patterns. Drops often precede breakthroughs.' },
				{ key: 'learning_rate', label: 'Learning Rate', color: '#4ade80', info: 'How fast is your topic distribution shifting? Measures divergence between consecutive time windows. High = rapid exploration. Low = stable focus. Spikes correlate with new territory formation.' },
				{ key: 'gradient_signal', label: 'Gradient Signal', color: '#f87171', info: 'How far have you drifted from where you started? Measures cumulative exploration distance. Even circular journeys register — it tracks the furthest point you reached, not just the endpoint.' },
			]}

			<div class="dynamics-controls">
				<div class="gran-toggle">
					<button class:active={granularity === 'day'} onclick={() => granularity = 'day'}>Daily</button>
					<button class:active={granularity === 'week'} onclick={() => granularity = 'week'}>Weekly</button>
					<button class:active={granularity === 'month'} onclick={() => granularity = 'month'}>Monthly</button>
				</div>
			</div>

			{#if freq.length > 1}
				{#each metrics as ml}
					{@const vals = freq.map((f: any) => f[ml.key]).filter((v): v is number => v != null)}
					{#if vals.length > 1}
						{@const vMin = Math.max(0, Math.min(...vals) - (Math.max(...vals) - Math.min(...vals)) * 0.15)}
						{@const vMax = Math.min(1.0, Math.max(...vals) + (Math.max(...vals) - Math.min(...vals)) * 0.15)}
						{@const vRange = vMax - vMin || 0.05}
						{@const labelStep = Math.max(1, Math.ceil(freq.length / 12))}
						{@const points = freq.map((f, i) => ({ x: 2 + (i / Math.max(1, freq.length - 1)) * 496, y: 5 + (1 - ((f[ml.key] ?? vMin) - vMin) / vRange) * 95 }))}
						<section class="card metric-chart-card">
							<div class="metric-chart-header">
								<span class="metric-chart-label" style="color: {ml.color}">{ml.label}</span>
								<span class="metric-chart-value" style="color: {ml.color}">{fmt(vals[vals.length - 1], 3)}</span>
								<span class="metric-info-wrap">
								<span class="metric-info">?</span>
								<span class="metric-tooltip">{ml.info}</span>
							</span>
							</div>
							<svg viewBox="0 0 500 125" class="metric-chart-svg">
								{#each [0, 0.5, 1.0] as frac}
									{@const yVal = vMin + frac * vRange}
									<line x1="0" y1={5 + (1 - frac) * 95} x2="500" y2={5 + (1 - frac) * 95} stroke="var(--color-border)" stroke-width="0.5" opacity="0.1" />
								{/each}
								<path d={areaPath(points, 500, 120, 100)} fill={ml.color} opacity="0.08" />
								<path d={linePath(points)} fill="none" stroke={ml.color} stroke-width="2" opacity="0.9" />
								{#each points as p, i}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<g class="chart-point-group" onclick={() => selectPoint(i, freq)}>
										<circle cx={p.x} cy={p.y} r="12" fill="transparent" class="chart-hit" />
										<circle cx={p.x} cy={p.y} r={selectedWindow?.idx === i ? 5 : 3} fill={ml.color} opacity={selectedWindow?.idx === i ? 1 : 0.7} class="chart-dot" />
										<title>{freq[i].window_end}: {fmt(freq[i][ml.key], 4)}</title>
									</g>
								{/each}
								{#if selectedWindow && selectedWindow.idx < points.length}
									<line x1={points[selectedWindow.idx].x} y1="0" x2={points[selectedWindow.idx].x} y2="110" stroke="var(--color-accent)" stroke-width="1" stroke-dasharray="3 2" opacity="0.4" />
								{/if}
								{#each freq as f, i}
									{#if i % labelStep === 0 || i === freq.length - 1}
										<text x={points[i].x} y="118" text-anchor={i === 0 ? 'start' : i === freq.length - 1 ? 'end' : 'middle'} fill="var(--color-text-tertiary)" font-size="7">{f.window_end?.slice(2, 7) || ''}</text>
									{/if}
								{/each}
							</svg>
						</section>
					{/if}
				{/each}
			{:else}
				<section class="card"><p class="chart-hint">Not enough data at this granularity yet.</p></section>
			{/if}
		{/if}

		<!-- ═══ Section 3b: Insights ═══ -->
		{#if insights.length}
			<section class="card insights-card">
				{#each insights as insight}
					<p class="insight">{insight}</p>
				{/each}
			</section>
		{/if}

		<!-- ═══ Section 4: Territory Vitality ═══ -->
		{#if data.territories?.length}
			<section class="card">
				<h2 class="section-title">
					Territory Vitality
					<MetricFreshnessBadge tables={['territory_vitality', 'territory_cofire']} />
				</h2>
				<div class="territory-list">
					{#each data.territories as t}
						{@const stateColor = stateColors[t.growth_state] || '#6B6B75'}
						<div class="territory-card" style="border-left-color: {stateColor}">
							<div class="terr-header">
								<span class="terr-name">{t.name || `Territory ${t.territory_id}`}</span>
								{#if t.archetype_type}<span class="terr-archetype">{t.archetype_type}</span>{/if}
								<span class="terr-count">{t.message_count || 0}</span>
							</div>
							{#if t.essence}<p class="terr-essence">{t.essence}</p>{/if}
							<div class="terr-bar-track">
								<div class="terr-bar-fill" style="width: {pct(t.energy)}%; background: {stateColor}"></div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ═══ Section 5: Complexity Landscape ═══ -->
		{#if complexityPoints().length > 1}
			{@const pts = complexityPoints()}
			<section class="card">
				<h2 class="section-title">
					Complexity <span class="title-sub">Lempel-Ziv novelty</span>
					<MetricFreshnessBadge tables={['complexity_snapshots']} />
				</h2>
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="area-chart">
					<defs>
						<linearGradient id="cx-grad" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stop-color="#06b6d4" stop-opacity="0.3" />
							<stop offset="100%" stop-color="#06b6d4" stop-opacity="0" />
						</linearGradient>
					</defs>
					<path d={areaPath(pts, 100, 100, 100)} fill="url(#cx-grad)" />
					<path d={linePath(pts)} fill="none" stroke="#06b6d4" stroke-width="1.5" vector-effect="non-scaling-stroke" />
					{#each pts as p}
						<circle cx={p.x} cy={p.y} r="1.5" fill="#06b6d4" opacity="0.6">
							<title>{p.date}: {fmt(p.raw, 3)}</title>
						</circle>
					{/each}
				</svg>
				<p class="chart-hint">Higher = novel thinking patterns. Lower = repetitive loops.</p>
			</section>
		{/if}

		<!-- ═══ Section 6: Emotional Rhythm ═══ -->
		{#if sentimentPoints().points.length > 1}
			{@const sp = sentimentPoints()}
			<section class="card">
				<h2 class="section-title">Emotional Rhythm</h2>
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="area-chart">
					<!-- Zero line -->
					<line x1="0" y1="50" x2="100" y2="50" stroke="var(--color-border)" stroke-width="0.5" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" />
					<!-- Volume area -->
					{#each sp.points as p}
						<rect x={p.x - 1} y={100 - p.volumeH - 4} width="2" height={p.volumeH} fill="var(--color-border)" opacity="0.15" rx="0.5" />
					{/each}
					<!-- Valence line -->
					<path d={linePath(sp.points)} fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"
						stroke={sp.points.reduce((a: number, p: any) => a + (p.valence || 0), 0) / sp.points.length > 0 ? '#4ade80' : '#f87171'} />
					{#each sp.points as p}
						<circle cx={p.x} cy={p.y} r="1.5" fill={p.valence > 0.05 ? '#4ade80' : p.valence < -0.05 ? '#f87171' : '#6B6B75'} opacity="0.7">
							<title>{p.date}: {fmt(p.valence, 2)} ({p.volume} msgs)</title>
						</circle>
					{/each}
				</svg>
				<p class="chart-hint">Line: emotional valence. Bars: message volume. Green = positive, red = negative.</p>
			</section>
		{/if}

		<!-- ═══ Section 7: Semantic Growth Timeline ═══ -->
		{#if data.growthEvents?.length}
			<section class="card">
				<h2 class="section-title">Semantic Growth</h2>
				<div class="timeline">
					{#each data.growthEvents.slice(0, 10) as event, i}
						{@const color = growthColors[event.event_type] || '#6B6B75'}
						<div class="timeline-item">
							<div class="timeline-track">
								<div class="timeline-dot" style="background: {color}"></div>
								{#if i < Math.min(data.growthEvents.length, 10) - 1}<div class="timeline-line"></div>{/if}
							</div>
							<div class="timeline-content">
								<div class="timeline-header">
									<span class="timeline-name">{event.territory_name || event.description || `#${event.cluster_id}`}</span>
									<span class="timeline-badge" style="color: {color}">{event.event_type}</span>
								</div>
								{#if event.territory_essence}<p class="timeline-essence">{event.territory_essence}</p>{/if}
								<div class="timeline-meta">
									{#if event.point_count}<span>{event.point_count} pts</span>{/if}
									<span>{new Date(event.created_at).toLocaleDateString()}</span>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if !data.fingerprint && !data.vitality?.length && !data.territories?.length}
			<div class="empty">
				<div class="empty-icon">~</div>
				<h2>Building your vitality profile...</h2>
				<p>Cognitive measurements are computed as your mindscape grows. Import more conversations to enrich your profile.</p>
			</div>
		{/if}

		</div><!-- end .freq-charts -->

		<!-- ═══ Context Panel ═══ -->
		<aside class="freq-panel" style="width: {panelWidth}px;">
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="panel-resizer"
				class:dragging={panelDragging}
				onpointerdown={startPanelDrag}
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize period detail panel"
				title="Drag to resize"
			></div>
			{#if selectedFreq}
				<div class="panel-header">
					<span class="panel-dates">{selectedFreq.window_start?.slice(0, 10)} — {selectedFreq.window_end?.slice(0, 10)}</span>
					<button class="panel-close" onclick={() => { selectedWindow = null; chronicle = null; }}>&times;</button>
				</div>

				{#if selectedFisherRow}
					<div class="panel-section panel-fisher">
						<h3 class="panel-title">
							Movement
							{#if (selectedFisherRow.phase_recent ?? selectedFisherRow.phase)}
								<span class="phase-tag" style="background: {PHASE_TO_LANDSCAPE[selectedFisherRow.phase_recent ?? selectedFisherRow.phase]?.color || '#6B6B75'}; color: var(--color-bg);">{selectedFisherRow.phase_recent ?? selectedFisherRow.phase}</span>
							{/if}
						</h3>
						<div class="panel-metrics">
							{#if selectedFisherRow.fisher_velocity != null}
								<div class="pm"><span class="pm-dot" style="background:#06b6d4"></span>Velocity<span class="pm-val">{fmt(selectedFisherRow.fisher_velocity, 3)}</span></div>
							{/if}
							{#if selectedFisherRow.fisher_velocity_z != null}
								<div class="pm"><span class="pm-dot" style="background:#8b5cf6"></span>z-score<span class="pm-val">{fmt(selectedFisherRow.fisher_velocity_z, 1)}σ</span></div>
							{/if}
							{#if (selectedFisherRow.R_recent ?? selectedFisherRow.exploration_ratio) != null}
								<div class="pm"><span class="pm-dot" style="background:#E5B84C"></span>R{selectedFisherRow.R_recent != null ? '_recent' : ' = D/L'}<span class="pm-val">{fmt(selectedFisherRow.R_recent ?? selectedFisherRow.exploration_ratio, 2)}</span></div>
							{/if}
							{#if selectedFisherRow.fisher_displacement != null}
								<div class="pm"><span class="pm-dot" style="background:#4ade80"></span>Displacement<span class="pm-val">{fmt(selectedFisherRow.fisher_displacement, 2)}</span></div>
							{/if}
						</div>
						{#if selectedFisherRow.top_contributors?.length}
							<div class="panel-movers">
								{#each selectedFisherRow.top_contributors.slice(0, 3) as m}
									<div class="mover-row">
										<span class="mover-dir" style="color: {m.direction === '+' ? '#4ade80' : '#f87171'}">{m.direction === '+' ? '↑' : '↓'}</span>
										<span class="mover-name">{m.name || m.id}</span>
										{#if m.pct != null}<span class="mover-pct">{Math.round(m.pct * 100)}%</span>{/if}
									</div>
								{/each}
							</div>
						{/if}
						{#if selectedFisherRow.low_confidence}
							<div class="panel-note">low_confidence — insufficient data, advisory only</div>
						{/if}
					</div>
				{/if}

				{#if chronicleLoading}
					<div class="panel-loading">Loading chronicle...</div>
				{:else if chronicle}
					{#if chronicle.theme}
						<div class="panel-theme">{chronicle.theme}</div>
					{/if}
					{#if chronicle.signature}
						<span class="panel-sig" style="background:{signatureColors[chronicle.signature] || '#6B6B75'}">{chronicle.signature}</span>
					{/if}
					{#if chronicle.narrative}
						<div class="panel-narrative">{chronicle.narrative}</div>
					{/if}

					{#if chronicle.top_territories}
						{@const terrs = typeof chronicle.top_territories === 'string' ? (() => { try { return JSON.parse(chronicle.top_territories); } catch { return []; } })() : chronicle.top_territories}
						{#if terrs?.length}
							<div class="panel-section">
								<h3 class="panel-title">Territories</h3>
								{#each terrs.slice(0, 5) as t}
									<div class="panel-terr"><span class="panel-terr-name">{t.name || `T${t.id}`}</span><span class="panel-terr-pct">{t.pct}%</span></div>
								{/each}
							</div>
						{/if}
					{/if}

					{#if chronicle.top_contacts}
						{@const contacts = typeof chronicle.top_contacts === 'string' ? (() => { try { return JSON.parse(chronicle.top_contacts); } catch { return []; } })() : chronicle.top_contacts}
						{#if contacts?.length}
							<div class="panel-section">
								<h3 class="panel-title">Contacts</h3>
								{#each contacts.slice(0, 5) as c}
									<div class="panel-terr"><span class="panel-terr-name">{c.name}</span><span class="panel-terr-pct">{c.count}</span></div>
								{/each}
							</div>
						{/if}
					{/if}

					{#if chronicle.key_moments}
						{@const moments = typeof chronicle.key_moments === 'string' ? (() => { try { return JSON.parse(chronicle.key_moments); } catch { return []; } })() : chronicle.key_moments}
						{#if moments?.length}
							<div class="panel-section">
								<h3 class="panel-title">Key Moments</h3>
								{#each moments.slice(0, 5) as m}
									<div class="panel-moment"><span class="panel-moment-date">{m.date}</span> {m.description}</div>
								{/each}
							</div>
						{/if}
					{/if}

					{#if selectedEvents.length}
						<div class="panel-section">
							<h3 class="panel-title">Growth Events</h3>
							<div class="panel-events">
								{#each selectedEvents.slice(0, 8) as event}
									{@const color = growthColors[event.event_type] || '#6B6B75'}
									<div class="pe">
										<span class="pe-dot" style="background:{color}"></span>
										<span class="pe-name">{event.territory_name || `#${event.cluster_id}`}</span>
										<span class="pe-type" style="color:{color}">{event.event_type}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{:else}
					<div class="panel-section">
						<h3 class="panel-title">Metrics</h3>
						<div class="panel-metrics">
							{#if selectedFreq.coherence != null}<div class="pm"><span class="pm-dot" style="background:#8b5cf6"></span>Coherence<span class="pm-val">{fmt(selectedFreq.coherence, 3)}</span></div>{/if}
							{#if selectedFreq.entropy != null}<div class="pm"><span class="pm-dot" style="background:#f59e0b"></span>Entropy<span class="pm-val">{fmt(selectedFreq.entropy, 3)}</span></div>{/if}
							{#if selectedFreq.compression != null}<div class="pm"><span class="pm-dot" style="background:#06b6d4"></span>Compression<span class="pm-val">{fmt(selectedFreq.compression, 3)}</span></div>{/if}
							{#if selectedFreq.learning_rate != null}<div class="pm"><span class="pm-dot" style="background:#4ade80"></span>Learning Rate<span class="pm-val">{fmt(selectedFreq.learning_rate, 3)}</span></div>{/if}
							{#if selectedFreq.gradient_signal != null}<div class="pm"><span class="pm-dot" style="background:#f87171"></span>Gradient<span class="pm-val">{fmt(selectedFreq.gradient_signal, 3)}</span></div>{/if}
						</div>
					</div>
					<div class="panel-section">
						<h3 class="panel-title">Volume</h3>
						<div class="panel-stats">
							{#if selectedFreq.message_count}<span>{selectedFreq.message_count} messages</span>{/if}
							{#if selectedFreq.point_count}<span>{selectedFreq.point_count} points</span>{/if}
							{#if selectedFreq.territory_count}<span>{selectedFreq.territory_count} territories</span>{/if}
						</div>
					</div>
					{#if selectedEvents.length}
						<div class="panel-section">
							<h3 class="panel-title">Growth Events</h3>
							<div class="panel-events">
								{#each selectedEvents.slice(0, 8) as event}
									{@const color = growthColors[event.event_type] || '#6B6B75'}
									<div class="pe">
										<span class="pe-dot" style="background:{color}"></span>
										<span class="pe-name">{event.territory_name || `#${event.cluster_id}`}</span>
										<span class="pe-type" style="color:{color}">{event.event_type}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
					<div class="panel-note">Chronicle not yet generated for this period.</div>
				{/if}
			{:else}
				<div class="panel-empty">
					{#if arcData?.narrative}
						<div class="arc-banner">
							{#if arcData.theme}<div class="arc-theme">{arcData.theme}</div>{/if}
							<div class="arc-narrative">{arcData.narrative}</div>
						</div>
					{:else}
						<p>Click a data point to see what was happening during that period.</p>
					{/if}
				</div>
			{/if}
		</aside>

		</div><!-- end .freq-split -->
	{/if}
</div>

<style>
	.page { flex: 1; overflow-y: auto; padding: 0; background: var(--color-bg); }
	.loading { display: flex; justify-content: center; align-items: center; height: 100%; }
	.spinner { width: 24px; height: 24px; border: 2px solid var(--color-border); border-top-color: #06b6d4; border-radius: 50%; animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Workstream C tab bar — sits at the top of the page above both
	   the existing Vitality content and the new Cognitive Shape tab. */
	.tab-bar {
		display: flex;
		gap: 0.3rem;
		padding: 0.7rem 1.5rem 0;
		border-bottom: 1px solid var(--color-border, #1c1f28);
		background: var(--color-bg);
	}
	.tab-btn {
		padding: 0.55rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: #94a3b8;
		font-size: 0.88rem;
		font-weight: 500;
		cursor: pointer;
		transition: color 0.15s ease, border-color 0.15s ease;
		margin-bottom: -1px;
	}
	.tab-btn:hover { color: #cbd5e1; }
	.tab-btn.active {
		color: #e5b84c;
		border-bottom-color: #e5b84c;
	}
	.tab-content { padding: 0 1.5rem 2rem; }

	.empty { text-align: center; padding: 6rem 2rem; }
	.empty-icon { font-size: 2rem; color: #06b6d4; opacity: 0.5; margin-bottom: 1rem; font-family: var(--font-mono); }
	.empty h2 { font-size: 1rem; font-weight: 500; color: var(--color-text-primary); margin-bottom: 0.5rem; }
	.empty p { font-size: 0.8rem; color: var(--color-text-secondary); max-width: 360px; margin: 0 auto; line-height: 1.6; }

	/* ── Landscape Hero ── */
	.landscape {
		padding: 2rem 2rem 1.5rem;
		border-bottom: 1px solid var(--color-border);
		animation: landscape-breathe 6s ease-in-out infinite;
	}
	@keyframes landscape-breathe {
		0%, 100% { opacity: 0.9; }
		50% { opacity: 1; }
	}
	.landscape-inner { max-width: 600px; }
	.landscape-label { font-size: 1.5rem; font-weight: 600; display: block; margin-bottom: 0.4rem; }
	.landscape-narrative { font-size: 0.8rem; color: var(--color-text-secondary); line-height: 1.6; margin-bottom: 0.75rem; }
	.landscape-pills { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.pill {
		font-size: 0.6rem; font-weight: 500; font-family: var(--font-mono);
		padding: 0.2rem 0.5rem; border-radius: 100px;
		background: var(--color-surface); border: 1px solid var(--color-border);
		color: var(--color-text-secondary); text-transform: capitalize;
	}

	/* ── Cards ── */
	.card { margin: 0.75rem 1.5rem; padding: 1.25rem; background: var(--color-surface); border-radius: 12px; border: 1px solid var(--color-border); }
	.section-title { font-size: 0.7rem; font-weight: 600; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
	.title-sub { font-weight: 400; text-transform: none; letter-spacing: 0; }

	/* ── Radar ── */
	.radar-container { display: flex; justify-content: center; padding: 0.5rem 0; }
	.radar-svg { width: 220px; height: 220px; }
	.radar-shape { animation: radar-pulse 4s ease-in-out infinite; transform-origin: center; }
	@keyframes radar-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.015); } }
	.profile-row { display: flex; gap: 1.5rem; align-items: center; }
	.profile-stats { display: flex; flex-direction: column; gap: 0.5rem; }
	.stat { display: flex; align-items: baseline; gap: 0.4rem; }
	.stat-value { font-size: 1rem; font-weight: 600; color: var(--color-text-primary); font-family: var(--font-mono); }
	.stat-label { font-size: 0.6rem; color: var(--color-text-tertiary); }
	.stat-divider { height: 1px; background: var(--color-border); margin: 0.3rem 0; width: 100%; }
	.stat-value.dyn { font-size: 0.85rem; }
	@media (max-width: 640px) { .profile-row { flex-direction: column; } }

	/* ── Gauges ── */
	/* ── Dynamics controls + per-metric charts ── */
	.dynamics-controls { display: flex; justify-content: flex-end; margin: 0.75rem 1.5rem 0.25rem; }
	.gran-toggle { display: flex; gap: 2px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 6px; padding: 2px; }
	.gran-toggle button { padding: 4px 12px; border: none; background: transparent; color: var(--color-text-tertiary); font-size: 0.65rem; font-weight: 500; border-radius: 4px; cursor: pointer; transition: all 0.15s; }
	.gran-toggle button.active { background: var(--color-accent); color: var(--color-bg); }
	/* ── Split layout ── */
	.freq-split { display: flex; gap: 0; min-height: 0; flex: 1; }
	.freq-charts { flex: 1; min-width: 0; overflow-y: auto; }
	.freq-panel { flex-shrink: 0; border-left: 1px solid var(--color-border); background: var(--color-surface); position: sticky; top: 0; height: 100%; overflow-y: auto; padding: 0.75rem 0.75rem 0.75rem 1.1rem; font-size: 0.7rem; }
	.panel-resizer { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; background: transparent; transition: background 0.15s; z-index: 2; }
	.panel-resizer:hover, .panel-resizer.dragging { background: var(--color-accent); opacity: 0.4; }
	.freq-panel { position: relative; }  /* anchor for absolutely-positioned resizer */
	@media (max-width: 900px) { .freq-panel { display: none; } .freq-split { flex-direction: column; } }

	/* ── Movement card (Fisher trajectory) ── */
	.movement-card { padding: 1rem 1.25rem; }
	.movement-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; gap: 0.75rem; flex-wrap: wrap; }
	.movement-controls { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
	.level-switcher { display: inline-flex; gap: 0; border: 1px solid var(--color-border); border-radius: 999px; overflow: hidden; }
	.level-switcher button {
		background: transparent; border: none; color: var(--color-text-tertiary);
		font-size: 0.65rem; font-weight: 500; text-transform: lowercase;
		letter-spacing: 0.04em; padding: 0.25rem 0.7rem; cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.level-switcher button:hover { color: var(--color-text-primary); background: rgba(255,255,255,0.04); }
	.level-switcher button.active {
		background: var(--color-text-primary); color: var(--color-bg); font-weight: 600;
	}
	.phase-badge { padding: 0.2rem 0.7rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; text-transform: capitalize; letter-spacing: 0.03em; }
	.phase-tag { padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.55rem; font-weight: 700; text-transform: capitalize; margin-left: 0.4rem; vertical-align: middle; }
	.movement-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0.6rem; padding: 0.5rem 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); margin-bottom: 0.75rem; }
	.movement-stats .stat { display: flex; flex-direction: column; gap: 0.15rem; padding: 0 0.5rem; }
	.movement-stats .stat-value { font-size: 1rem; font-weight: 700; font-family: var(--font-mono); color: var(--color-text-primary); }
	.movement-stats .stat-label { font-size: 0.55rem; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
	.movement-movers { padding-top: 0.4rem; }
	.movers-title { font-size: 0.6rem; font-weight: 600; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
	.mover { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; padding: 0.15rem 0; }
	.mover-dir { font-weight: 700; min-width: 1ch; }
	.mover-name { color: var(--color-text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mover-pct { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-text-primary); }
	.mover-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.65rem; padding: 0.1rem 0; }
	.movement-milestones { padding-top: 0.6rem; border-top: 1px solid var(--color-border); margin-top: 0.6rem; }
	.milestone-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--color-border); }
	.milestone-row:last-child { border-bottom: none; }
	.milestone-rule { font-size: 0.55rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-accent); padding: 0.15rem 0.45rem; border: 1px solid var(--color-accent); border-radius: 999px; flex-shrink: 0; }
	.milestone-headline { font-size: 0.75rem; color: var(--color-text-secondary); flex: 1; line-height: 1.4; }
	.milestone-dismiss { background: none; border: none; color: var(--color-text-tertiary); font-size: 1rem; cursor: pointer; padding: 0 4px; flex-shrink: 0; }
	.milestone-dismiss:hover { color: var(--color-text-primary); }
	.panel-fisher { padding: 0.6rem 0.5rem; background: var(--color-surface-elevated, rgba(255,255,255,0.02)); border-radius: 4px; border-left: 2px solid var(--color-accent); }
	.panel-movers { padding-top: 0.4rem; margin-top: 0.4rem; border-top: 1px dashed var(--color-border); }
	.panel-note { font-size: 0.6rem; color: var(--color-text-tertiary); font-style: italic; margin-top: 0.3rem; }

	/* ── Panel content ── */
	.panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
	.panel-dates { font-size: 0.75rem; font-weight: 600; color: var(--color-text-primary); }
	.panel-close { background: none; border: none; color: var(--color-text-tertiary); font-size: 1.2rem; cursor: pointer; padding: 0 4px; }
	.panel-section { margin-bottom: 1rem; }
	.panel-title { font-size: 0.6rem; font-weight: 600; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
	.panel-metrics { display: flex; flex-direction: column; gap: 0.3rem; }
	.pm { display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; color: var(--color-text-secondary); }
	.pm-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
	.pm-val { margin-left: auto; font-family: var(--font-mono); font-size: 0.65rem; color: var(--color-text-primary); }
	.panel-stats { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.65rem; color: var(--color-text-secondary); }
	.panel-events { display: flex; flex-direction: column; gap: 0.25rem; }
	.pe { display: flex; align-items: center; gap: 0.4rem; font-size: 0.65rem; }
	.pe-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
	.pe-name { color: var(--color-text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pe-type { font-weight: 600; font-size: 0.55rem; text-transform: uppercase; }
	.panel-empty { display: flex; align-items: center; justify-content: center; height: 100%; flex-direction: column; }
	.panel-empty p { font-size: 0.7rem; color: var(--color-text-tertiary); text-align: center; line-height: 1.5; max-width: 200px; }
	.panel-loading { font-size: 0.7rem; color: var(--color-text-tertiary); padding: 1rem 0; }
	.panel-theme { font-size: 0.85rem; font-weight: 600; color: var(--color-accent); margin-bottom: 0.4rem; line-height: 1.3; }
	.panel-sig { display: inline-block; font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #0A0A0C; padding: 2px 8px; border-radius: 10px; margin-bottom: 0.6rem; }
	.panel-narrative { font-size: 0.7rem; line-height: 1.65; color: var(--color-text-secondary); margin-bottom: 0.75rem; white-space: pre-wrap; }
	.panel-terr { display: flex; justify-content: space-between; align-items: center; font-size: 0.65rem; padding: 0.15rem 0; }
	.panel-terr-name { color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.panel-terr-pct { font-family: var(--font-mono); color: var(--color-text-tertiary); font-size: 0.6rem; flex-shrink: 0; }
	.panel-moment { font-size: 0.65rem; color: var(--color-text-secondary); padding: 0.15rem 0; line-height: 1.4; }
	.panel-moment-date { font-family: var(--font-mono); color: var(--color-text-tertiary); font-size: 0.6rem; margin-right: 0.3rem; }
	.panel-note { font-size: 0.6rem; color: var(--color-text-tertiary); font-style: italic; margin-top: 0.5rem; }
	.arc-banner { text-align: left; padding: 0.5rem 0; }
	.arc-theme { font-size: 0.8rem; font-weight: 600; color: var(--color-accent); margin-bottom: 0.4rem; }
	.arc-narrative { font-size: 0.7rem; line-height: 1.6; color: var(--color-text-secondary); }

	/* ── Chart interaction ── */
	.chart-point-group { cursor: pointer; }
	.chart-point-group:hover .chart-dot { r: 5; opacity: 1; }

	.metric-chart-card { padding: 0.5rem 0 !important; margin: 0 !important; border-radius: 0 !important; border-left: none !important; border-right: none !important; border-top: none !important; }
	.metric-chart-header { padding: 0 0.75rem; }
	.metric-chart-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
	.metric-chart-label { font-size: 0.75rem; font-weight: 600; }
	.metric-chart-value { font-size: 0.7rem; font-family: var(--font-mono); opacity: 0.7; }
	.metric-info-wrap { position: relative; margin-left: auto; }
	.metric-info { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; font-size: 0.55rem; font-weight: 600; color: var(--color-text-tertiary); border: 1px solid var(--color-border); cursor: help; }
	.metric-tooltip { display: none; position: absolute; right: 0; top: 24px; width: 280px; padding: 0.65rem 0.75rem; background: var(--color-elevated); border: 1px solid var(--color-border); border-radius: 8px; font-size: 0.65rem; line-height: 1.5; color: var(--color-text-secondary); z-index: 20; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
	.metric-info-wrap:hover .metric-tooltip { display: block; }
	.metric-chart-svg { width: 100%; height: 150px; display: block; }

	/* ── Insights ── */
	.insights-card { padding: 1rem 1.25rem; }
	.insight { font-size: 0.75rem; color: var(--color-text-secondary); line-height: 1.6; padding: 0.3rem 0; border-bottom: 1px solid var(--color-border); }
	.insight:last-child { border-bottom: none; }

	/* ── Territory Vitality ── */
	.territory-list { display: flex; flex-direction: column; gap: 0.4rem; }
	.territory-card {
		padding: 0.75rem 1rem;
		border-radius: 8px;
		background: var(--color-bg);
		border-left: 3px solid var(--color-border);
		transition: border-color 0.15s;
	}
	.terr-header { display: flex; align-items: center; gap: 0.5rem; }
	.terr-name { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); flex: 1; }
	.terr-archetype { font-size: 0.55rem; color: var(--color-text-tertiary); background: var(--color-surface); padding: 0.1rem 0.4rem; border-radius: 4px; }
	.terr-count { font-size: 0.6rem; color: var(--color-text-tertiary); font-family: var(--font-mono); }
	.terr-essence { font-size: 0.7rem; color: var(--color-text-secondary); margin: 0.3rem 0; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.terr-bar-track { height: 3px; background: var(--color-border); border-radius: 2px; margin-top: 0.4rem; }
	.terr-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

	/* ── Area Charts ── */
	.area-chart { width: 100%; height: 120px; display: block; }
	.chart-hint { font-size: 0.6rem; color: var(--color-text-tertiary); margin-top: 0.5rem; }

	/* ── Timeline ── */
	.timeline { display: flex; flex-direction: column; }
	.timeline-item { display: flex; gap: 0.75rem; min-height: 0; }
	.timeline-track { display: flex; flex-direction: column; align-items: center; width: 12px; flex-shrink: 0; }
	.timeline-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
	.timeline-line { width: 1px; flex: 1; background: var(--color-border); margin: 2px 0; }
	.timeline-content { flex: 1; padding-bottom: 1rem; min-width: 0; }
	.timeline-header { display: flex; align-items: center; gap: 0.5rem; }
	.timeline-name { font-size: 0.75rem; font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.timeline-badge { font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
	.timeline-essence { font-size: 0.65rem; color: var(--color-text-tertiary); margin-top: 0.15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.timeline-meta { display: flex; gap: 0.75rem; font-size: 0.6rem; color: var(--color-text-tertiary); margin-top: 0.15rem; }

	/* ── Responsive ── */
	@media (max-width: 640px) {
		.landscape { padding: 1.5rem 1.25rem 1rem; }
		.card { margin: 0.5rem 1rem; padding: 1rem; }
		.radar-svg { width: 180px; height: 180px; }
	}

	/* ── Reduced motion ── */
	@media (prefers-reduced-motion: reduce) {
		.landscape { animation: none; }
		.radar-shape { animation: none; }
		.terr-bar-fill { transition: none; }
	}
</style>
