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
	let range = $state<7 | 14 | 30>(7);

	const metricLabel: Record<string, string> = {
		sleep_duration_min: 'Sleep', hrv_avg: 'HRV', resting_hr: 'RHR',
		steps: 'Steps', active_energy_kcal: 'Energy', mindful_minutes: 'Mindful',
		workout_minutes: 'Workouts', sleep_efficiency: 'Sleep efficiency',
	};
	const trendArrow: Record<string, string> = { improving: '\u2197', declining: '\u2198', stable: '\u2192' };
	const trendColor: Record<string, string> = { improving: 'text-green-400', declining: 'text-red-400', stable: 'text-[var(--color-text-tertiary)]' };

	async function loadSummary() {
		try {
			const res = await api(`/portal/health/summary?days=${range}`);
			if (res.ok) summary = await res.json();
		} catch { /* silent */ }
		loading = false;
	}

	function switchRange(r: 7 | 14 | 30) {
		range = r;
		loading = true;
		loadSummary();
	}

	onMount(() => { loadSummary(); });
</script>

<svelte:head><title>Body</title></svelte:head>

<div class="page">
	<!-- Header -->
	<div class="header">
		<h1>Body</h1>
		<div class="range-toggle">
			<button class:active={range === 7} onclick={() => switchRange(7)}>7 days</button>
			<button class:active={range === 14} onclick={() => switchRange(14)}>14 days</button>
			<button class:active={range === 30} onclick={() => switchRange(30)}>30 days</button>
		</div>
	</div>

	{#if loading}
		<div class="loading"><div class="spinner"></div></div>
	{:else if !summary || (!summary.today && !summary.days?.length)}
		<div class="empty">
			<h2>No health data yet</h2>
			<p>Connect Apple Body from the Mycelium iOS app to see your sleep, HRV, activity, and wellness trends here.</p>
		</div>
	{:else}
		{@const hs = summary}

		<!-- Today's vitals -->
		{#if hs.today}
			{@const t = hs.today}
			<div class="vitals-grid">
				{#if t.sleep_duration_min != null}
					{@const h = Math.floor(t.sleep_duration_min / 60)}
					{@const m = Math.round(t.sleep_duration_min % 60)}
					<div class="vital-card">
						<div class="vital-label">Sleep</div>
						<div class="vital-value sleep">{h}h{m.toString().padStart(2,'0')}m</div>
						{#if t.sleep_efficiency != null}<div class="vital-sub">{Math.round(t.sleep_efficiency * 100)}% efficiency</div>{/if}
					</div>
				{/if}
				{#if t.hrv_avg != null}
					<div class="vital-card">
						<div class="vital-label">HRV</div>
						<div class="vital-value hrv">{Math.round(t.hrv_avg)}<span class="vital-unit">ms</span></div>
						{#if hs.averages?.hrv_avg}<div class="vital-sub">avg {Math.round(hs.averages.hrv_avg)}</div>{/if}
					</div>
				{/if}
				{#if t.resting_hr != null}
					<div class="vital-card">
						<div class="vital-label">Resting HR</div>
						<div class="vital-value rhr">{Math.round(t.resting_hr)}<span class="vital-unit">bpm</span></div>
						{#if hs.averages?.resting_hr}<div class="vital-sub">avg {Math.round(hs.averages.resting_hr)}</div>{/if}
					</div>
				{/if}
				{#if t.steps != null}
					<div class="vital-card">
						<div class="vital-label">Steps</div>
						<div class="vital-value steps">{t.steps.toLocaleString()}</div>
						{#if hs.averages?.steps}<div class="vital-sub">avg {Math.round(hs.averages.steps).toLocaleString()}</div>{/if}
					</div>
				{/if}
				{#if t.active_energy_kcal != null}
					<div class="vital-card">
						<div class="vital-label">Active Energy</div>
						<div class="vital-value energy">{Math.round(t.active_energy_kcal)}<span class="vital-unit">kcal</span></div>
					</div>
				{/if}
				{#if t.workout_minutes != null && t.workout_minutes > 0}
					<div class="vital-card">
						<div class="vital-label">Workouts</div>
						<div class="vital-value workout">{Math.round(t.workout_minutes)}<span class="vital-unit">min</span></div>
					</div>
				{/if}
				{#if t.mindful_minutes != null && t.mindful_minutes > 0}
					<div class="vital-card">
						<div class="vital-label">Mindfulness</div>
						<div class="vital-value mindful">{Math.round(t.mindful_minutes)}<span class="vital-unit">min</span></div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Sleep analysis -->
		{#if hs.days?.some(d => d.sleep_duration_min != null)}
			{@const sleepDays = hs.days.filter(d => d.sleep_duration_min != null)}
			{@const maxSleep = Math.max(...sleepDays.map(x => x.sleep_duration_min || 0))}
			<div class="chart-card">
				<h2 class="chart-title">Sleep</h2>
				<div class="bar-chart">
					{#each sleepDays as d}
						{@const barH = maxSleep > 0 ? ((d.sleep_duration_min || 0) / maxSleep) * 100 : 0}
						{@const deep = d.sleep_deep_min || 0}
						{@const rem = d.sleep_rem_min || 0}
						{@const core = d.sleep_core_min || 0}
						{@const total = deep + rem + core || 1}
						<div class="bar-col" title="{d.date}: {Math.round((d.sleep_duration_min || 0) / 60)}h{Math.round((d.sleep_duration_min || 0) % 60)}m">
							<div class="bar-stack" style="height: {barH}%; min-height: 2px;">
								<div class="bar-seg deep" style="height: {(deep/total)*100}%"></div>
								<div class="bar-seg rem" style="height: {(rem/total)*100}%"></div>
								<div class="bar-seg core" style="height: {(core/total)*100}%"></div>
							</div>
							<span class="bar-label">{d.date.slice(5)}</span>
						</div>
					{/each}
				</div>
				<div class="legend">
					<span class="legend-item"><span class="legend-dot deep"></span>Deep</span>
					<span class="legend-item"><span class="legend-dot rem"></span>REM</span>
					<span class="legend-item"><span class="legend-dot core"></span>Core</span>
				</div>
			</div>
		{/if}

		<!-- Heart: HRV + RHR -->
		{#if hs.days?.some(d => d.hrv_avg != null || d.resting_hr != null)}
			<div class="heart-grid">
				{#if hs.days.some(d => d.hrv_avg != null)}
					{@const hrvDays = hs.days.filter(d => d.hrv_avg != null)}
					{@const maxHrv = Math.max(...hrvDays.map(d => d.hrv_avg || 0))}
					<div class="chart-card">
						<h2 class="chart-title">HRV <span class="chart-unit">ms</span></h2>
						<div class="spark-chart">
							{#each hrvDays as d}
								<div class="spark-bar hrv" style="height: {maxHrv > 0 ? ((d.hrv_avg || 0) / maxHrv) * 100 : 0}%; min-height: 1px;" title="{d.date}: {Math.round(d.hrv_avg || 0)}ms"></div>
							{/each}
						</div>
					</div>
				{/if}
				{#if hs.days.some(d => d.resting_hr != null)}
					{@const rhrDays = hs.days.filter(d => d.resting_hr != null)}
					{@const maxRhr = Math.max(...rhrDays.map(d => d.resting_hr || 0))}
					<div class="chart-card">
						<h2 class="chart-title">Resting HR <span class="chart-unit">bpm</span></h2>
						<div class="spark-chart">
							{#each rhrDays as d}
								<div class="spark-bar rhr" style="height: {maxRhr > 0 ? ((d.resting_hr || 0) / maxRhr) * 100 : 0}%; min-height: 1px;" title="{d.date}: {Math.round(d.resting_hr || 0)}bpm"></div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Steps + Energy -->
		{#if hs.days?.some(d => d.steps != null)}
			{@const stepDays = hs.days.filter(d => d.steps != null)}
			{@const maxSteps = Math.max(...stepDays.map(d => d.steps || 0))}
			<div class="chart-card">
				<h2 class="chart-title">Steps</h2>
				<div class="spark-chart wide">
					{#each stepDays as d}
						<div class="spark-bar steps" style="height: {maxSteps > 0 ? ((d.steps || 0) / maxSteps) * 100 : 0}%; min-height: 1px;" title="{d.date}: {(d.steps || 0).toLocaleString()}"></div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Trends -->
		{#if hs.trends && Object.values(hs.trends).some(v => v && v !== 'insufficient')}
			<div class="chart-card">
				<h2 class="chart-title">Trends</h2>
				<div class="trends">
					{#each Object.entries(hs.trends) as [key, val]}
						{#if val && val !== 'insufficient' && metricLabel[key]}
							<span class="trend-pill {trendColor[val] || ''}">
								{trendArrow[val] || ''} {metricLabel[key]} {val}
							</span>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<!-- Anomalies -->
		{#if hs.anomalies?.length}
			<div class="chart-card">
				<h2 class="chart-title">Notable</h2>
				{#each hs.anomalies.slice(0, 5) as a}
					<div class="anomaly">
						<span class="anomaly-date">{a.date}</span>
						<span class="anomaly-text">{metricLabel[a.metric] || a.metric}: {Math.round(a.value)} (baseline {Math.round(a.baseline)})</span>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.page {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem 2rem;
		background: var(--color-bg);
	}
	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
	}
	.header h1 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}
	.range-toggle {
		display: flex;
		gap: 2px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 2px;
	}
	.range-toggle button {
		padding: 5px 12px;
		border: none;
		background: transparent;
		color: var(--color-text-tertiary);
		font-size: 0.7rem;
		font-weight: 500;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
	}
	.range-toggle button.active {
		background: var(--color-accent);
		color: var(--color-bg);
	}
	.loading {
		display: flex;
		justify-content: center;
		padding: 4rem;
	}
	.spinner {
		width: 24px; height: 24px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.empty {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--color-text-secondary);
	}
	.empty h2 { font-size: 1rem; font-weight: 500; margin-bottom: 0.5rem; color: var(--color-text-primary); }
	.empty p { font-size: 0.8rem; max-width: 400px; margin: 0 auto; line-height: 1.6; }

	/* Vitals grid */
	.vitals-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.25rem;
	}
	.vital-card {
		background: var(--color-surface);
		border-radius: 10px;
		padding: 1rem;
		text-align: center;
	}
	.vital-label { font-size: 0.65rem; color: var(--color-text-tertiary); margin-bottom: 0.25rem; }
	.vital-value { font-size: 1.4rem; font-weight: 600; }
	.vital-unit { font-size: 0.7rem; font-weight: 400; color: var(--color-text-tertiary); margin-left: 2px; }
	.vital-sub { font-size: 0.6rem; color: var(--color-text-tertiary); margin-top: 2px; }
	.vital-value.sleep { color: #818cf8; }
	.vital-value.hrv { color: #4ade80; }
	.vital-value.rhr { color: #f87171; }
	.vital-value.steps { color: #fb923c; }
	.vital-value.energy { color: #facc15; }
	.vital-value.workout { color: #34d399; }
	.vital-value.mindful { color: #a78bfa; }

	/* Charts */
	.chart-card {
		background: var(--color-surface);
		border-radius: 10px;
		padding: 1rem 1.25rem;
		margin-bottom: 0.75rem;
	}
	.chart-title {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-tertiary);
		margin-bottom: 0.75rem;
	}
	.chart-unit { font-weight: 400; font-size: 0.65rem; }
	.bar-chart {
		display: flex;
		align-items: flex-end;
		gap: 3px;
		height: 7rem;
	}
	.bar-col {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		justify-content: flex-end;
		gap: 4px;
	}
	.bar-stack {
		width: 100%;
		border-radius: 3px 3px 0 0;
		position: relative;
		display: flex;
		flex-direction: column-reverse;
	}
	.bar-seg { width: 100%; }
	.bar-seg.deep { background: #4f46e5; border-radius: 0 0 3px 3px; }
	.bar-seg.rem { background: rgba(168, 85, 247, 0.7); }
	.bar-seg.core { background: rgba(96, 165, 250, 0.5); border-radius: 3px 3px 0 0; }
	.bar-label { font-size: 0.5rem; color: var(--color-text-tertiary); }
	.legend { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
	.legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.6rem; color: var(--color-text-tertiary); }
	.legend-dot { width: 8px; height: 8px; border-radius: 2px; }
	.legend-dot.deep { background: #4f46e5; }
	.legend-dot.rem { background: rgba(168, 85, 247, 0.7); }
	.legend-dot.core { background: rgba(96, 165, 250, 0.5); }

	.heart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem; }
	@media (max-width: 640px) { .heart-grid { grid-template-columns: 1fr; } }

	.spark-chart {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 4.5rem;
	}
	.spark-chart.wide { height: 5rem; }
	.spark-bar {
		flex: 1;
		border-radius: 2px 2px 0 0;
		transition: opacity 0.15s;
	}
	.spark-bar:hover { opacity: 0.8; }
	.spark-bar.hrv { background: rgba(74, 222, 128, 0.6); }
	.spark-bar.rhr { background: rgba(248, 113, 113, 0.6); }
	.spark-bar.steps { background: rgba(251, 146, 60, 0.5); }

	/* Trends */
	.trends { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.trend-pill {
		font-size: 0.65rem;
		padding: 0.3rem 0.6rem;
		border-radius: 6px;
		background: var(--color-bg);
	}

	/* Anomalies */
	.anomaly {
		display: flex;
		gap: 0.75rem;
		padding: 0.3rem 0;
		font-size: 0.7rem;
	}
	.anomaly-date { color: var(--color-text-tertiary); white-space: nowrap; }
	.anomaly-text { color: var(--color-text-secondary); }
</style>
