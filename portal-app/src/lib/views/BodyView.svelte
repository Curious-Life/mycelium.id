<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface BodyDay {
		date: string; sleep_duration_min: number | null; sleep_efficiency: number | null;
		sleep_deep_min: number | null; sleep_rem_min: number | null; sleep_core_min: number | null;
		hrv_avg: number | null; resting_hr: number | null; steps: number | null;
		active_energy_kcal: number | null; workout_minutes: number | null; mindful_minutes: number | null;
	}
	interface BodySummary {
		today: BodyDay | null;
		averages: Record<string, number | null>;
		trends: Record<string, string>;
		anomalies: Array<{ date: string; metric: string; value: number; baseline: number }>;
		days: BodyDay[];
	}

	let summary = $state<BodySummary | null>(null);
	let loading = $state(true);
	let range = $state<7 | 14 | 30 | 90>(7);

	const today = new Date().toISOString().split('T')[0];

	const metricLabel: Record<string, string> = {
		sleep_duration_min: 'Sleep', hrv_avg: 'HRV', resting_hr: 'Resting HR',
		steps: 'Steps', active_energy_kcal: 'Energy', mindful_minutes: 'Mindful',
		workout_minutes: 'Workouts', sleep_efficiency: 'Efficiency',
	};
	const trendArrow: Record<string, string> = { improving: '↗', declining: '↘', stable: '→' };

	async function loadSummary() {
		try {
			const res = await api(`/portal/health/summary?days=${range}`);
			if (res.ok) summary = await res.json();
		} catch { /* silent */ }
		loading = false;
	}
	function switchRange(r: 7 | 14 | 30 | 90) {
		if (r === range) return;
		range = r; loading = true; loadSummary();
	}
	onMount(() => { loadSummary(); });

	// Latest reading = today if present, else the most recent synced day.
	const latest = $derived.by<BodyDay | null>(() => {
		if (!summary) return null;
		if (summary.today) return summary.today;
		const d = summary.days;
		return d && d.length ? d[d.length - 1] : null;
	});
	const latestIsToday = $derived(latest?.date === today);
	const hasData = $derived(!!(summary && (summary.today || summary.days?.length)));

	function fmtDate(d: string): string {
		const dt = new Date(d + 'T00:00:00');
		return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
	function sleepHM(min: number | null): string {
		if (min == null) return '—';
		return `${Math.floor(min / 60)}h ${Math.round(min % 60).toString().padStart(2, '0')}m`;
	}

	// Smooth-ish SVG sparkline (line + area) over a 300×60 viewBox.
	function spark(days: BodyDay[], key: keyof BodyDay) {
		const series = days.map((d) => d[key] as number | null);
		const idx = series.map((v, i) => [i, v] as const).filter(([, v]) => v != null && Number.isFinite(v as number));
		if (idx.length < 2) return null;
		const W = 300, H = 60, pad = 6;
		const vals = idx.map(([, v]) => v as number);
		const min = Math.min(...vals), max = Math.max(...vals);
		const span = max - min || 1;
		const n = series.length;
		const pts = idx.map(([i, v]) => {
			const x = n === 1 ? W / 2 : (i / (n - 1)) * (W - 2 * pad) + pad;
			const y = H - pad - (((v as number) - min) / span) * (H - 2 * pad);
			return [x, y] as const;
		});
		const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
		const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
		return { line, area, last: pts[pts.length - 1] };
	}
</script>

<svelte:head><title>Body</title></svelte:head>

<div class="page">
	<div class="header">
		<div class="title-wrap">
			<h1>Body</h1>
			{#if hasData && latest}
				<span class="as-of">{latestIsToday ? 'Today' : `as of ${fmtDate(latest.date)}`}</span>
			{/if}
		</div>
		<div class="range-toggle">
			{#each [7, 14, 30, 90] as r}
				<button class:active={range === r} onclick={() => switchRange(r as 7 | 14 | 30 | 90)}>{r}d</button>
			{/each}
		</div>
	</div>

	{#if loading}
		<div class="loading"><div class="spinner"></div></div>
	{:else if !hasData}
		<div class="empty">
			<div class="empty-orb"></div>
			<h2>No health data in this window</h2>
			<p>Open the Mycelium iOS app, long-press the action button and choose <strong>Sync Apple Health</strong> to bring your sleep, heart, and movement here. If you've synced before, try a longer range.</p>
		</div>
	{:else if summary}
		{@const hs = summary}
		{@const l = latest}

		<!-- Hero: the three signals that matter most -->
		{#if l}
			<div class="hero">
				<div class="hero-card sleep">
					<span class="hero-label">Sleep</span>
					<span class="hero-value">{sleepHM(l.sleep_duration_min)}</span>
					<span class="hero-sub">
						{#if l.sleep_efficiency != null}{Math.round(l.sleep_efficiency * 100)}% efficiency{:else}—{/if}
					</span>
				</div>
				<div class="hero-card hrv">
					<span class="hero-label">HRV</span>
					<span class="hero-value">{l.hrv_avg != null ? Math.round(l.hrv_avg) : '—'}<small>ms</small></span>
					<span class="hero-sub">{hs.averages?.hrv_avg ? `avg ${Math.round(hs.averages.hrv_avg)}` : ''}</span>
				</div>
				<div class="hero-card rhr">
					<span class="hero-label">Resting HR</span>
					<span class="hero-value">{l.resting_hr != null ? Math.round(l.resting_hr) : '—'}<small>bpm</small></span>
					<span class="hero-sub">{hs.averages?.resting_hr ? `avg ${Math.round(hs.averages.resting_hr)}` : ''}</span>
				</div>
			</div>
		{/if}

		<!-- Movement strip -->
		{#if l}
			<div class="vitals">
				{#if l.steps != null}
					<div class="vital steps"><span class="v-label">Steps</span><span class="v-value">{l.steps.toLocaleString()}</span></div>
				{/if}
				{#if l.active_energy_kcal != null}
					<div class="vital energy"><span class="v-label">Energy</span><span class="v-value">{Math.round(l.active_energy_kcal)}<small>kcal</small></span></div>
				{/if}
				{#if l.workout_minutes != null && l.workout_minutes > 0}
					<div class="vital workout"><span class="v-label">Workouts</span><span class="v-value">{Math.round(l.workout_minutes)}<small>min</small></span></div>
				{/if}
				{#if l.mindful_minutes != null && l.mindful_minutes > 0}
					<div class="vital mindful"><span class="v-label">Mindful</span><span class="v-value">{Math.round(l.mindful_minutes)}<small>min</small></span></div>
				{/if}
			</div>
		{/if}

		<!-- Sleep stages -->
		{#if hs.days?.some((d) => d.sleep_duration_min != null)}
			{@const sleepDays = hs.days.filter((d) => d.sleep_duration_min != null)}
			{@const maxSleep = Math.max(...sleepDays.map((x) => x.sleep_duration_min || 0))}
			<div class="card">
				<div class="card-head"><h2>Sleep</h2>
					<div class="legend">
						<span><i class="dot deep"></i>Deep</span><span><i class="dot rem"></i>REM</span><span><i class="dot core"></i>Core</span>
					</div>
				</div>
				<div class="bars">
					{#each sleepDays as d}
						{@const barH = maxSleep > 0 ? ((d.sleep_duration_min || 0) / maxSleep) * 100 : 0}
						{@const deep = d.sleep_deep_min || 0}{@const rem = d.sleep_rem_min || 0}{@const core = d.sleep_core_min || 0}
						{@const total = deep + rem + core || 1}
						<div class="bar-col" title="{fmtDate(d.date)}: {sleepHM(d.sleep_duration_min)}">
							<div class="bar" style="height:{barH}%">
								<div class="seg core" style="height:{(core / total) * 100}%"></div>
								<div class="seg rem" style="height:{(rem / total) * 100}%"></div>
								<div class="seg deep" style="height:{(deep / total) * 100}%"></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Heart + movement trends as elegant sparklines -->
		<div class="spark-grid">
			{#each [ {key:'hrv_avg', label:'HRV', unit:'ms', cls:'hrv'}, {key:'resting_hr', label:'Resting HR', unit:'bpm', cls:'rhr'}, {key:'steps', label:'Steps', unit:'', cls:'steps'} ] as m}
				{@const sp = spark(hs.days || [], m.key as keyof BodyDay)}
				{#if sp}
					<div class="card spark-card {m.cls}">
						<div class="card-head"><h2>{m.label}{#if m.unit}<span class="unit">{m.unit}</span>{/if}</h2>
							{#if hs.trends?.[m.key] && hs.trends[m.key] !== 'insufficient'}
								<span class="trend {hs.trends[m.key]}">{trendArrow[hs.trends[m.key]]} {hs.trends[m.key]}</span>
							{/if}
						</div>
						<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none">
							<defs>
								<linearGradient id="grad-{m.cls}" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" class="grad-top" />
									<stop offset="100%" class="grad-bot" />
								</linearGradient>
							</defs>
							<path d={sp.area} fill="url(#grad-{m.cls})" />
							<path d={sp.line} fill="none" class="spark-line" vector-effect="non-scaling-stroke" />
							<circle cx={sp.last[0]} cy={sp.last[1]} r="3" class="spark-dot" />
						</svg>
					</div>
				{/if}
			{/each}
		</div>

		<!-- Notable -->
		{#if hs.anomalies?.length}
			<div class="card">
				<div class="card-head"><h2>Notable</h2></div>
				{#each hs.anomalies.slice(0, 5) as a}
					<div class="anomaly">
						<span class="a-date">{fmtDate(a.date)}</span>
						<span class="a-text">{metricLabel[a.metric] || a.metric} · {Math.round(a.value)} <em>(usually {Math.round(a.baseline)})</em></span>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.page { flex: 1; overflow-y: auto; padding: 1.5rem clamp(1rem, 4vw, 2.25rem) 3rem; background: var(--color-bg); }

	.header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1.5rem; }
	.title-wrap { display: flex; align-items: baseline; gap: 0.7rem; }
	.header h1 { font-size: 1.5rem; font-weight: 300; letter-spacing: 0.01em; color: var(--color-text-primary); }
	.as-of { font-size: 0.72rem; color: var(--color-text-tertiary); }
	.range-toggle { display: flex; gap: 2px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 999px; padding: 3px; }
	.range-toggle button { padding: 5px 12px; border: none; background: transparent; color: var(--color-text-tertiary); font-size: 0.72rem; font-weight: 500; border-radius: 999px; cursor: pointer; transition: all 0.18s ease; }
	.range-toggle button.active { background: rgba(var(--color-accent-aurum-rgb), 0.18); color: rgb(var(--color-accent-aurum-rgb)); }

	.loading { display: flex; justify-content: center; padding: 5rem; }
	.spinner { width: 26px; height: 26px; border: 2px solid var(--color-border); border-top-color: rgb(var(--color-accent-aurum-rgb)); border-radius: 50%; animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	.empty { text-align: center; padding: 4rem 2rem; max-width: 460px; margin: 2rem auto; }
	.empty-orb { width: 72px; height: 72px; margin: 0 auto 1.5rem; border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, rgba(var(--color-accent-amethyst-rgb), 0.55), rgba(var(--color-accent-coral-rgb), 0.25) 60%, transparent 75%);
		filter: blur(2px); animation: pulse 4s ease-in-out infinite; }
	@keyframes pulse { 0%,100% { opacity: 0.7; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
	.empty h2 { font-size: 1.05rem; font-weight: 400; margin-bottom: 0.6rem; color: var(--color-text-primary); }
	.empty p { font-size: 0.82rem; color: var(--color-text-secondary); line-height: 1.65; }
	.empty strong { color: rgb(var(--color-accent-aurum-rgb)); font-weight: 500; }

	/* Hero */
	.hero { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.85rem; margin-bottom: 0.85rem; }
	@media (max-width: 560px) { .hero { grid-template-columns: 1fr; } }
	.hero-card { position: relative; overflow: hidden; padding: 1.25rem 1.35rem; border-radius: 16px;
		background: linear-gradient(160deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
		border: 1px solid var(--glass-border); display: flex; flex-direction: column; gap: 0.35rem; }
	.hero-card::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.5;
		background: radial-gradient(120% 80% at 100% 0%, var(--glow), transparent 60%); }
	.hero-card.sleep { --glow: rgba(var(--color-accent-amethyst-rgb), 0.22); }
	.hero-card.hrv { --glow: rgba(var(--color-accent-jade-rgb), 0.20); }
	.hero-card.rhr { --glow: rgba(var(--color-accent-coral-rgb), 0.20); }
	.hero-label { font-size: 0.7rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-text-tertiary); }
	.hero-value { font-size: 2rem; font-weight: 300; line-height: 1.05; color: var(--color-text-primary); }
	.hero-value small { font-size: 0.85rem; font-weight: 400; color: var(--color-text-tertiary); margin-left: 3px; }
	.hero-sub { font-size: 0.72rem; color: var(--color-text-tertiary); min-height: 1em; }
	.hero-card.sleep .hero-value { color: rgb(var(--color-accent-amethyst-rgb)); }
	.hero-card.hrv .hero-value { color: rgb(var(--color-accent-jade-rgb)); }
	.hero-card.rhr .hero-value { color: rgb(var(--color-accent-coral-rgb)); }

	/* Movement strip */
	.vitals { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 0.6rem; margin-bottom: 0.85rem; }
	.vital { padding: 0.85rem 0.95rem; border-radius: 13px; background: var(--color-surface); border: 1px solid var(--color-border);
		display: flex; flex-direction: column; gap: 0.25rem; }
	.v-label { font-size: 0.66rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-text-tertiary); }
	.v-value { font-size: 1.25rem; font-weight: 400; color: var(--color-text-primary); }
	.v-value small { font-size: 0.66rem; color: var(--color-text-tertiary); margin-left: 2px; }
	.vital.steps .v-value { color: rgb(var(--color-accent-teal-rgb)); }
	.vital.energy .v-value { color: rgb(var(--color-accent-aurum-rgb)); }
	.vital.workout .v-value { color: rgb(var(--color-accent-jade-rgb)); }
	.vital.mindful .v-value { color: rgb(var(--color-accent-amethyst-rgb)); }

	/* Cards */
	.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 16px; padding: 1.1rem 1.3rem; margin-bottom: 0.85rem; }
	.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.9rem; }
	.card-head h2 { font-size: 0.82rem; font-weight: 500; color: var(--color-text-secondary); }
	.card-head .unit { font-weight: 400; font-size: 0.66rem; color: var(--color-text-tertiary); margin-left: 4px; }
	.legend { display: flex; gap: 0.8rem; }
	.legend span { display: flex; align-items: center; gap: 5px; font-size: 0.64rem; color: var(--color-text-tertiary); }
	.dot { width: 8px; height: 8px; border-radius: 3px; }
	.dot.deep { background: rgb(var(--color-accent-amethyst-rgb)); }
	.dot.rem { background: rgba(var(--color-accent-amethyst-rgb), 0.6); }
	.dot.core { background: rgba(var(--color-accent-rgb), 0.4); }

	/* Sleep bars */
	.bars { display: flex; align-items: flex-end; gap: 4px; height: 8rem; }
	.bar-col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
	.bar { width: 100%; min-height: 3px; border-radius: 5px; overflow: hidden; display: flex; flex-direction: column; transition: opacity 0.15s; }
	.bar:hover { opacity: 0.82; }
	.seg { width: 100%; }
	.seg.deep { background: rgb(var(--color-accent-amethyst-rgb)); }
	.seg.rem { background: rgba(var(--color-accent-amethyst-rgb), 0.6); }
	.seg.core { background: rgba(var(--color-accent-rgb), 0.4); }

	/* Sparklines */
	.spark-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; margin-bottom: 0.85rem; }
	@media (max-width: 640px) { .spark-grid { grid-template-columns: 1fr; } }
	.spark-grid .spark-card:first-child { grid-column: 1 / -1; }
	.spark { width: 100%; height: 60px; display: block; }
	.spark-line { stroke-width: 2; }
	.spark-card.hrv { --c: var(--color-accent-jade-rgb); }
	.spark-card.rhr { --c: var(--color-accent-coral-rgb); }
	.spark-card.steps { --c: var(--color-accent-teal-rgb); }
	.spark-card .spark-line { stroke: rgb(var(--c)); }
	.spark-card .spark-dot { fill: rgb(var(--c)); }
	.spark-card .grad-top { stop-color: rgb(var(--c)); stop-opacity: 0.28; }
	.spark-card .grad-bot { stop-color: rgb(var(--c)); stop-opacity: 0; }

	.trend { font-size: 0.66rem; padding: 0.2rem 0.55rem; border-radius: 999px; }
	.trend.improving { color: rgb(var(--color-accent-jade-rgb)); background: rgba(var(--color-accent-jade-rgb), 0.12); }
	.trend.declining { color: rgb(var(--color-accent-coral-rgb)); background: rgba(var(--color-accent-coral-rgb), 0.12); }
	.trend.stable { color: var(--color-text-tertiary); background: var(--color-elevated); }

	/* Anomalies */
	.anomaly { display: flex; gap: 0.85rem; padding: 0.45rem 0; font-size: 0.76rem; border-top: 1px solid var(--color-border); }
	.anomaly:first-of-type { border-top: none; }
	.a-date { color: var(--color-text-tertiary); white-space: nowrap; min-width: 3.2rem; }
	.a-text { color: var(--color-text-secondary); }
	.a-text em { color: var(--color-text-tertiary); font-style: normal; }
</style>
