<script lang="ts">
	import { onMount } from 'svelte';
	import { apiGet } from '$lib/api';

	// ── Types ──────────────────────────────────────────────────────────────

	interface Session {
		id: string; app_bundle: string; app_name: string; window_title: string | null;
		url: string | null; category: string; productivity: number;
		started_at: string; ended_at: string | null; duration_s: number; idle: number; date: string;
	}
	interface TopApp { app_name: string; app_bundle: string; category: string; total_s: number; sessions: number; }
	interface TopDomain { domain: string; category: string; total_s: number; sessions: number; productivity_avg: number; }
	interface CategoryStat { category: string; total_s: number; sessions: number; productivity_avg: number; }
	interface DaySummary { date: string; total_s: number; active_s: number; idle_s: number; productivity_avg: number; sessions: number; }
	interface TodayData {
		date: string; sessions: Session[]; topApps: TopApp[]; topDomains: TopDomain[];
		categories: CategoryStat[];
		totals: { activeSeconds: number; idleSeconds: number; productivityScore: number };
	}
	interface MsgDay { day: string; count: number; imported: number; discord: number; telegram: number; portal: number; other: number; }
	interface MsgWeek { weekStart: string; label: string; total: number; imported: number; live: number; discord: number; telegram: number; portal: number; other: number; }

	const catColors: Record<string, string> = {
		dev: '#4CAF50', design: '#E91E63', pm: '#9C27B0', writing: '#00BCD4',
		ref: '#FF9800', biz: '#795548', comm: '#2196F3', browser: '#607D8B',
		util: '#78909C', news: '#FF7043', social: '#FF5722', shop: '#8D6E63',
		media: '#F44336', gaming: '#D32F2F', idle: '#424242', other: '#9E9E9E',
	};
	const catNames: Record<string, string> = {
		dev: 'Development', design: 'Design', pm: 'Project Mgmt', writing: 'Writing',
		ref: 'Reference', biz: 'Business', comm: 'Communication', browser: 'Browser',
		util: 'Utilities', news: 'News', social: 'Social', shop: 'Shopping',
		media: 'Entertainment', gaming: 'Gaming', idle: 'Idle', other: 'Other',
	};

	// ── State ──────────────────────────────────────────────────────────────

	let loading = $state(true);
	let granularity = $state<'day' | 'week' | 'all'>('day');
	let selectedDate = $state(new Date().toISOString().split('T')[0]);

	// Desktop
	let todayData = $state<TodayData | null>(null);
	let daySummaries = $state<DaySummary[]>([]);
	let weekDetail = $state<{ topApps: TopApp[]; topDomains: TopDomain[]; categories: CategoryStat[]; totals: { activeSeconds: number; idleSeconds: number } } | null>(null);

	// Messages
	let msgDays = $state<MsgDay[]>([]);
	let msgWeeks = $state<MsgWeek[]>([]);
	let totalMessages = $state(0);

	// Health
	interface HealthDay {
		date: string; sleep_duration_min: number | null; sleep_efficiency: number | null;
		sleep_deep_min: number | null; sleep_rem_min: number | null; sleep_core_min: number | null;
		hrv_avg: number | null; resting_hr: number | null; steps: number | null;
		active_energy_kcal: number | null; workout_minutes: number | null; mindful_minutes: number | null;
	}
	interface HealthSummary {
		today: HealthDay | null;
		averages: Record<string, number | null>;
		trends: Record<string, string>;
		anomalies: Array<{ date: string; metric: string; value: number; baseline: number }>;
		days: HealthDay[];
	}
	let healthSummary = $state<HealthSummary | null>(null);

	// ── Data Loading ──────────────────────────────────────────────────────

	async function loadDesktopDay(date: string) {
		try {
			todayData = await apiGet<TodayData>('/portal/activity/today', { date });
		} catch { todayData = null; }
	}

	async function loadDesktopSummary() {
		try {
			const data = await apiGet<{ summary: DaySummary[] }>('/portal/activity/summary', {
				from: '2025-01-01', to: new Date().toISOString().split('T')[0],
			});
			daySummaries = data.summary || [];
		} catch { daySummaries = []; }
	}

	async function loadWeekDetail(weekStart: string) {
		try {
			const end = new Date(weekStart); end.setDate(end.getDate() + 6);
			weekDetail = await apiGet<typeof weekDetail>('/portal/activity/range', {
				from: weekStart, to: end.toISOString().split('T')[0],
			});
		} catch { weekDetail = null; }
	}

	async function loadMessages() {
		try {
			const data = await apiGet<{ days: MsgDay[] }>('/portal/activity/messages');
			const days = data.days || [];
			msgDays = days;

			const weekMap = new Map<string, MsgWeek>();
			let total = 0;
			for (const d of days) {
				const date = new Date(d.day);
				const dow = date.getDay();
				const monday = new Date(date);
				monday.setDate(monday.getDate() - (dow === 0 ? 6 : dow - 1));
				const key = monday.toISOString().split('T')[0];
				const live = (d.discord||0) + (d.telegram||0) + (d.portal||0) + (d.other||0);
				if (!weekMap.has(key)) {
					weekMap.set(key, { weekStart: key, label: monday.toLocaleDateString([], { month: 'short', day: 'numeric' }), total: 0, imported: 0, live: 0, discord: 0, telegram: 0, portal: 0, other: 0 });
				}
				const w = weekMap.get(key)!;
				w.total += d.count; w.imported += d.imported||0; w.live += live;
				w.discord += d.discord||0; w.telegram += d.telegram||0; w.portal += d.portal||0; w.other += d.other||0;
				total += d.count;
			}
			msgWeeks = [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
			totalMessages = total;
		} catch { msgDays = []; msgWeeks = []; }
	}

	async function loadHealth() {
		try {
			healthSummary = await apiGet<HealthSummary>('/portal/health/summary', { days: '14' });
		} catch { healthSummary = null; }
	}

	onMount(async () => {
		await Promise.all([loadDesktopDay(selectedDate), loadDesktopSummary(), loadMessages(), loadHealth()]);
		loading = false;
	});

	// ── Navigation ────────────────────────────────────────────────────────

	function navigate(dir: -1 | 1) {
		const d = new Date(selectedDate);
		if (granularity === 'day') {
			d.setDate(d.getDate() + dir);
		} else {
			d.setDate(d.getDate() + dir * 7);
		}
		selectedDate = d.toISOString().split('T')[0];
		loadDesktopDay(selectedDate);
		if (granularity === 'week') loadWeekDetail(currentWeekStart);
	}

	function goToday() {
		selectedDate = new Date().toISOString().split('T')[0];
		granularity = 'day';
	}

	// ── Derived: Current Period ───────────────────────────────────────────

	const isToday = $derived(selectedDate === new Date().toISOString().split('T')[0]);

	const periodLabel = $derived((() => {
		const d = new Date(selectedDate);
		if (granularity === 'all') return 'All Time';
		if (granularity === 'day') {
			if (isToday) return 'Today';
			const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
			if (selectedDate === yesterday.toISOString().split('T')[0]) return 'Yesterday';
			return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
		}
		// week
		const end = new Date(d); end.setDate(end.getDate() + 6);
		return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
	})());

	// Week start for current selectedDate
	const currentWeekStart = $derived((() => {
		const d = new Date(selectedDate);
		const dow = d.getDay();
		d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
		return d.toISOString().split('T')[0];
	})());

	// ── Derived: Desktop ──────────────────────────────────────────────────

	const sessions = $derived(todayData?.sessions ?? []);
	const topApps = $derived(todayData?.topApps ?? []);
	const topDomains = $derived(todayData?.topDomains ?? []);
	const categories = $derived(todayData?.categories ?? []);
	const totals = $derived(todayData?.totals ?? { activeSeconds: 0, idleSeconds: 0, productivityScore: 50 });
	const hasDesktopToday = $derived(sessions.length > 0);
	const selectedDaySummary = $derived(daySummaries.find(s => s.date === selectedDate));
	const hasDesktopForDay = $derived(isToday ? hasDesktopToday : !!selectedDaySummary);

	const weekDaySummaries = $derived((() => {
		const days: { date: string; label: string; active: number; idle: number; score: number }[] = [];
		const ws = new Date(currentWeekStart);
		for (let i = 0; i < 7; i++) {
			const d = new Date(ws); d.setDate(d.getDate() + i);
			const dateStr = d.toISOString().split('T')[0];
			const match = daySummaries.find(s => s.date === dateStr);
			days.push({
				date: dateStr, label: d.toLocaleDateString([], { weekday: 'short' }),
				active: match?.active_s || 0, idle: match?.idle_s || 0,
				score: match ? Math.round(match.productivity_avg) : 0,
			});
		}
		return days;
	})());
	const hasDesktopWeek = $derived(weekDaySummaries.some(d => d.active > 0 || d.idle > 0));
	const maxDayActive = $derived(Math.max(...weekDaySummaries.map(d => d.active + d.idle), 1));
	const weekTotalActive = $derived(weekDaySummaries.reduce((s, d) => s + d.active, 0));
	const weekTotalIdle = $derived(weekDaySummaries.reduce((s, d) => s + d.idle, 0));

	const scoreColor = $derived(totals.productivityScore >= 80 ? '#4CAF50' : totals.productivityScore >= 50 ? '#E5B84C' : '#F44336');

	const timelineSegments = $derived((() => {
		if (sessions.length === 0) return [];
		const sorted = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at));
		const earliest = new Date(sorted[0].started_at).getTime();
		const latest = Math.max(...sorted.map(s => new Date(s.ended_at || s.started_at).getTime()), Date.now());
		const span = latest - earliest || 1;
		return sorted.map(s => {
			const start = new Date(s.started_at).getTime();
			const end = new Date(s.ended_at || s.started_at).getTime();
			return {
				left: ((start - earliest) / span) * 100,
				width: Math.max(((end - start) / span) * 100, 0.3),
				color: s.idle ? '#424242' : (catColors[s.category] || '#9E9E9E'),
				app: s.app_name, title: s.window_title,
				duration: s.duration_s,
				time: new Date(s.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
			};
		});
	})());

	// ── Derived: Messages ─────────────────────────────────────────────────

	const dayMessages = $derived(msgDays.find(d => d.day === selectedDate));

	const weekMessages = $derived((() => {
		const ws = currentWeekStart;
		const we = new Date(ws); we.setDate(we.getDate() + 7);
		const weStr = we.toISOString().split('T')[0];
		return msgDays.filter(d => d.day >= ws && d.day < weStr);
	})());

	const weekMsgTotal = $derived(weekMessages.reduce((s, d) => s + d.count, 0));
	const weekMsgLive = $derived(weekMessages.reduce((s, d) => s + (d.discord||0) + (d.telegram||0) + (d.portal||0) + (d.other||0), 0));
	const weekMsgImported = $derived(weekMessages.reduce((s, d) => s + (d.imported||0), 0));
	const maxWeekMsgDay = $derived(Math.max(...weekMessages.map(d => d.count), 1));

	// All-time chart
	const maxAllWeek = $derived(Math.max(...msgWeeks.map(w => w.total), 1));
	const allStats = $derived((() => {
		if (msgWeeks.length === 0) return null;
		const live = msgWeeks.reduce((s, w) => s + w.live, 0);
		const imported = msgWeeks.reduce((s, w) => s + w.imported, 0);
		const telegram = msgWeeks.reduce((s, w) => s + w.telegram, 0);
		const discord = msgWeeks.reduce((s, w) => s + w.discord, 0);
		const portal = msgWeeks.reduce((s, w) => s + w.portal, 0);
		const avg = Math.round(totalMessages / msgWeeks.length);
		const peak = msgWeeks.reduce((max, w) => w.total > max.total ? w : max, msgWeeks[0]);
		return { live, imported, telegram, discord, portal, avg, peak };
	})());

	const xLabels = $derived((() => {
		if (msgWeeks.length < 2) return [];
		const labels: { pos: number; text: string }[] = [];
		const step = Math.max(1, Math.floor(msgWeeks.length / 6));
		for (let i = 0; i < msgWeeks.length; i += step) {
			labels.push({ pos: (i / msgWeeks.length) * 100, text: new Date(msgWeeks[i].weekStart).toLocaleDateString([], { month: 'short', year: '2-digit' }) });
		}
		return labels;
	})());

	// ── Helpers ────────────────────────────────────────────────────────────

	function fmt(s: number) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : '<1m'; }
	function fmtK(n: number) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n); }
	function pct(v: number, t: number) { return t > 0 ? Math.round((v/t)*100) : 0; }

	// Health helpers
	const healthMetricLabel: Record<string, string> = { sleep_duration_min: 'Sleep', hrv_avg: 'HRV', resting_hr: 'RHR', steps: 'Steps', active_energy_kcal: 'Energy', mindful_minutes: 'Mindful' };
	const trendArrow: Record<string, string> = { improving: '\u2197', declining: '\u2198', stable: '\u2192' };
	const trendColor: Record<string, string> = { improving: 'text-green-400', declining: 'text-red-400', stable: 'text-[var(--color-text-tertiary)]' };
</script>

<div class="flex-1 overflow-y-auto p-6 lg:p-8 bg-[var(--color-bg)]">
	<!-- ═══ Header + Navigation ═══ -->
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-2xl font-semibold text-[var(--color-text-primary)]">Activity</h1>
			{#if totalMessages > 0}
				<p class="text-sm text-[var(--color-text-tertiary)] mt-0.5">{totalMessages.toLocaleString()} messages total</p>
			{/if}
		</div>

		<!-- Granularity toggle -->
		<div class="flex gap-1 bg-[var(--color-surface)] rounded-lg p-1 border border-[var(--color-border)]">
			{#each [['day', 'Day'], ['week', 'Week'], ['all', 'All Time']] as [key, label]}
				<button
					onclick={() => { granularity = key as typeof granularity; if (key !== 'all') { selectedDate = new Date().toISOString().split('T')[0]; if (key === 'week') loadWeekDetail(currentWeekStart); else loadDesktopDay(selectedDate); } }}
					class="px-3 py-1.5 text-xs font-medium rounded-md transition-all
						{granularity === key
						? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
						: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
				>{label}</button>
			{/each}
		</div>
	</div>

	<!-- Date navigator (day/week mode) -->
	{#if granularity !== 'all'}
		<div class="flex items-center justify-center gap-4 mb-6">
			<button onclick={() => navigate(-1)} class="p-2 rounded-lg hover:bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
			</button>
			<button onclick={goToday} class="text-sm font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)] transition-colors min-w-48 text-center">
				{periodLabel}
			</button>
			<button onclick={() => navigate(1)} class="p-2 rounded-lg hover:bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors" disabled={isToday && granularity === 'day'}>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
			</button>
		</div>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center py-24">
			<div class="animate-pulse text-[var(--color-text-tertiary)]">Loading...</div>
		</div>
	{:else}

		<!-- ═══════════════════════════════════════════════════════════ -->
		<!-- DAY VIEW                                                   -->
		<!-- ═══════════════════════════════════════════════════════════ -->
		{#if granularity === 'day'}

			<!-- Desktop Activity -->
			<!-- Desktop stats (today: full detail, past: summary) -->
			{#if hasDesktopForDay}
				{@const dActive = isToday ? totals.activeSeconds : (selectedDaySummary?.active_s || 0)}
				{@const dIdle = isToday ? totals.idleSeconds : (selectedDaySummary?.idle_s || 0)}
				{@const dScore = isToday ? totals.productivityScore : Math.round(selectedDaySummary?.productivity_avg || 50)}
				{@const dScoreColor = dScore >= 80 ? '#4CAF50' : dScore >= 50 ? '#E5B84C' : '#F44336'}
				<div class="grid grid-cols-4 gap-3 mb-5">
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold" style="color: {dScoreColor}">{dScore}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Productivity</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[#4CAF50]">{fmt(dActive)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Active</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-text-tertiary)]">{fmt(dIdle)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Idle</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-accent)]">{dayMessages?.count || 0}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Messages</div>
					</div>
				</div>

				<!-- Timeline -->
				{#if timelineSegments.length > 0}
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 mb-5">
						<div class="relative h-8 bg-[var(--color-elevated)] rounded-lg overflow-hidden">
							{#each timelineSegments as seg}
								<div
									class="absolute top-0 h-full rounded-sm opacity-85 hover:opacity-100 transition-opacity"
									style="left: {seg.left}%; width: {seg.width}%; background: {seg.color};"
									title="{seg.app}{seg.title ? ' — ' + seg.title : ''} ({fmt(seg.duration)})"
								></div>
							{/each}
						</div>
						<div class="flex justify-between mt-1.5 text-[10px] text-[var(--color-text-tertiary)]">
							<span>{timelineSegments[0]?.time}</span>
							<span>{timelineSegments[timelineSegments.length - 1]?.time}</span>
						</div>
					</div>
				{/if}

				<!-- Apps, Sites, Categories -->
				{#if topApps.length > 0 || topDomains.length > 0}
					<div class="grid grid-cols-2 gap-4 mb-5">
						{#if topApps.length > 0}
							<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
								<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Top Apps</h3>
								<div class="space-y-2.5">
									{#each topApps.slice(0, 6) as app}
										{@const appPct = pct(app.total_s, totals.activeSeconds)}
										<div class="flex items-center gap-2">
											<div class="w-20 text-xs text-[var(--color-text-primary)] truncate">{app.app_name}</div>
											<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
												<div class="h-full rounded-full" style="width: {appPct}%; background: {catColors[app.category] || '#9E9E9E'};"></div>
											</div>
											<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(app.total_s)}</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
						{#if topDomains.length > 0}
							<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
								<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Top Sites</h3>
								<div class="space-y-2.5">
									{#each topDomains.slice(0, 6) as site}
										{@const sitePct = pct(site.total_s, totals.activeSeconds)}
										<div class="flex items-center gap-2">
											<div class="w-24 text-xs text-[var(--color-text-primary)] truncate">{site.domain.replace(/^www\./, '')}</div>
											<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
												<div class="h-full rounded-full" style="width: {sitePct}%; background: {catColors[site.category] || '#9E9E9E'};"></div>
											</div>
											<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(site.total_s)}</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
						{#if categories.length > 0}
							<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 col-span-2">
								<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Categories</h3>
								<div class="grid grid-cols-2 gap-x-6 gap-y-2">
									{#each categories as cat}
										{@const catPct = pct(cat.total_s, totals.activeSeconds + totals.idleSeconds)}
										<div class="flex items-center gap-2">
											<div class="w-2 h-2 rounded-full flex-shrink-0" style="background: {catColors[cat.category] || '#9E9E9E'};"></div>
											<div class="w-20 text-xs text-[var(--color-text-primary)] truncate">{catNames[cat.category] || cat.category}</div>
											<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
												<div class="h-full rounded-full" style="width: {catPct}%; background: {catColors[cat.category] || '#9E9E9E'}; opacity: 0.7;"></div>
											</div>
											<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(cat.total_s)}</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{:else}
				<!-- Day view — messages only (no desktop data) -->
				<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-5 mb-5 text-center">
					<div class="text-3xl font-bold text-[var(--color-accent)]">{dayMessages?.count || 0}</div>
					<div class="text-xs text-[var(--color-text-tertiary)] mt-1">Messages</div>
					{#if dayMessages}
						<div class="flex justify-center gap-4 mt-3 text-xs text-[var(--color-text-tertiary)]">
							{#if dayMessages.telegram}<span>{dayMessages.telegram} Telegram</span>{/if}
							{#if dayMessages.discord}<span>{dayMessages.discord} Discord</span>{/if}
							{#if dayMessages.portal}<span>{dayMessages.portal} Portal</span>{/if}
							{#if dayMessages.imported}<span>{dayMessages.imported} imported</span>{/if}
						</div>
					{/if}
				</div>
			{/if}

		<!-- ═══════════════════════════════════════════════════════════ -->
		<!-- WEEK VIEW                                                  -->
		<!-- ═══════════════════════════════════════════════════════════ -->
		{:else if granularity === 'week'}

			<!-- Week stats -->
			<div class="grid grid-cols-4 gap-3 mb-5">
				<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
					<div class="text-2xl font-bold text-[var(--color-accent)]">{weekMsgTotal}</div>
					<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Messages</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
					<div class="text-2xl font-bold text-[#4CAF50]">{weekMsgLive}</div>
					<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Live</div>
				</div>
				<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
					<div class="text-2xl font-bold text-[var(--color-text-secondary)]">{weekMsgImported}</div>
					<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Imported</div>
				</div>
				{#if hasDesktopWeek}
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[#4CAF50]">{fmt(weekTotalActive)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Screen Time</div>
					</div>
				{:else}
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-text-tertiary)]">{Math.round(weekMsgTotal / 7)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Avg / Day</div>
					</div>
				{/if}
			</div>

			<!-- Daily breakdown chart -->
			<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 mb-5">
				<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Daily Breakdown</h3>
				<div class="flex items-end gap-3 h-36">
					{#each weekDaySummaries as day, i}
						{@const msgDay = weekMessages.find(m => m.day === day.date)}
						{@const msgCount = msgDay?.count || 0}
						{@const desktopH = hasDesktopWeek ? ((day.active + day.idle) / maxDayActive) * 50 : 0}
						{@const msgH = maxWeekMsgDay > 0 ? (msgCount / maxWeekMsgDay) * 50 : 0}
						{@const isSelected = day.date === selectedDate}
						<button
							onclick={() => { selectedDate = day.date; granularity = 'day'; loadDesktopDay(day.date); }}
							class="flex-1 flex flex-col items-center gap-1 group"
						>
							<!-- Stacked: desktop (top) + messages (bottom) -->
							<div class="w-full flex flex-col items-center justify-end" style="height: 110px;">
								{#if desktopH > 0}
									<div
										class="w-full rounded-t transition-all {isSelected ? 'opacity-100' : 'opacity-60 group-hover:opacity-80'}"
										style="height: {Math.max(desktopH, 2)}%; background: {day.score >= 80 ? '#4CAF50' : day.score >= 50 ? '#E5B84C' : '#F44336'};"
									></div>
								{/if}
								{#if msgH > 0}
									<div
										class="w-full {desktopH > 0 ? '' : 'rounded-t'} rounded-b transition-all {isSelected ? 'opacity-100' : 'opacity-50 group-hover:opacity-70'}"
										style="height: {Math.max(msgH, 2)}%; background: #E5B84C;"
									></div>
								{/if}
							</div>
							<span class="text-[10px] {isSelected ? 'text-[var(--color-accent)] font-medium' : 'text-[var(--color-text-tertiary)]'}">{day.label}</span>
							<span class="text-[9px] text-[var(--color-text-tertiary)]">{msgCount > 0 ? msgCount : ''}</span>
						</button>
					{/each}
				</div>
				{#if hasDesktopWeek}
					<div class="flex items-center gap-4 mt-3 text-[10px] text-[var(--color-text-tertiary)]">
						<div class="flex items-center gap-1"><div class="w-2 h-2 rounded-sm bg-[#4CAF50]/70"></div><span>Screen time</span></div>
						<div class="flex items-center gap-1"><div class="w-2 h-2 rounded-sm" style="background: #E5B84C; opacity: 0.6;"></div><span>Messages</span></div>
					</div>
				{/if}
			</div>

			<!-- Week: Apps, Sites, Categories -->
			{#if weekDetail && (weekDetail.topApps.length > 0 || weekDetail.topDomains.length > 0)}
				<div class="grid grid-cols-2 gap-4 mb-5">
					{#if weekDetail.topApps.length > 0}
						<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
							<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Top Apps</h3>
							<div class="space-y-2.5">
								{#each weekDetail.topApps.slice(0, 6) as app}
									{@const appPct = pct(app.total_s, weekDetail.totals.activeSeconds)}
									<div class="flex items-center gap-2">
										<div class="w-20 text-xs text-[var(--color-text-primary)] truncate">{app.app_name}</div>
										<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
											<div class="h-full rounded-full" style="width: {appPct}%; background: {catColors[app.category] || '#9E9E9E'};"></div>
										</div>
										<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(app.total_s)}</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
					{#if weekDetail.topDomains.length > 0}
						<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
							<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Top Sites</h3>
							<div class="space-y-2.5">
								{#each weekDetail.topDomains.slice(0, 6) as site}
									{@const sitePct = pct(site.total_s, weekDetail.totals.activeSeconds)}
									<div class="flex items-center gap-2">
										<div class="w-24 text-xs text-[var(--color-text-primary)] truncate">{site.domain.replace(/^www\./, '')}</div>
										<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
											<div class="h-full rounded-full" style="width: {sitePct}%; background: {catColors[site.category] || '#9E9E9E'};"></div>
										</div>
										<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(site.total_s)}</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
					{#if weekDetail.categories.length > 0}
						<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 col-span-2">
							<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">Categories</h3>
							<div class="grid grid-cols-2 gap-x-6 gap-y-2">
								{#each weekDetail.categories as cat}
									{@const catPct = pct(cat.total_s, weekDetail.totals.activeSeconds + weekDetail.totals.idleSeconds)}
									<div class="flex items-center gap-2">
										<div class="w-2 h-2 rounded-full flex-shrink-0" style="background: {catColors[cat.category] || '#9E9E9E'};"></div>
										<div class="w-20 text-xs text-[var(--color-text-primary)] truncate">{catNames[cat.category] || cat.category}</div>
										<div class="flex-1 h-1.5 bg-[var(--color-elevated)] rounded-full overflow-hidden">
											<div class="h-full rounded-full" style="width: {catPct}%; background: {catColors[cat.category] || '#9E9E9E'}; opacity: 0.7;"></div>
										</div>
										<div class="text-[10px] text-[var(--color-text-secondary)] font-mono w-12 text-right">{fmt(cat.total_s)}</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}

		<!-- ═══════════════════════════════════════════════════════════ -->
		<!-- ALL TIME VIEW                                              -->
		<!-- ═══════════════════════════════════════════════════════════ -->
		{:else}

			<!-- All-time stats -->
			{#if allStats}
				<div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-accent)]">{fmtK(totalMessages)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Total</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-text-secondary)]">{allStats.avg}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Avg / Week</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[#4CAF50]">{fmtK(allStats.telegram)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Telegram</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[#7289DA]">{fmtK(allStats.discord)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Discord</div>
					</div>
					<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
						<div class="text-2xl font-bold text-[var(--color-text-tertiary)]">{fmtK(allStats.imported)}</div>
						<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">Imported</div>
					</div>
				</div>
			{/if}

			<!-- All-time weekly chart -->
			<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 mb-5">
				<div class="flex items-center justify-between mb-3">
					<h3 class="text-xs font-medium text-[var(--color-text-tertiary)]">Messages per Week</h3>
					{#if allStats?.peak}
						<span class="text-[10px] text-[var(--color-text-tertiary)]">Peak: {allStats.peak.total.toLocaleString()} ({allStats.peak.label})</span>
					{/if}
				</div>

				<div class="relative h-40 flex items-end gap-px">
					{#each msgWeeks as week}
						{@const barH = (week.total / maxAllWeek) * 100}
						{@const liveR = week.total > 0 ? (week.live / week.total) * 100 : 0}
						<div class="flex-1 min-w-0 relative group cursor-pointer" style="height: 100%;"
							onclick={() => { selectedDate = week.weekStart; granularity = 'week'; loadDesktopDay(week.weekStart); }}
						>
							<div class="absolute bottom-0 w-full" style="height: {Math.max(barH, 0.5)}%;">
								<div class="absolute bottom-0 w-full rounded-t" style="height: 100%; background: #E5B84C; opacity: 0.2;"></div>
								{#if liveR > 0}
									<div class="absolute bottom-0 w-full rounded-t" style="height: {liveR}%; background: #E5B84C; opacity: 0.75;"></div>
								{/if}
							</div>
							<div class="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] whitespace-nowrap z-20 shadow-lg pointer-events-none">
								<div class="font-medium">{week.label}</div>
								<div class="text-[var(--color-text-tertiary)]">{week.total} msgs</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="relative h-4 mt-1">
					{#each xLabels as lbl}
						<span class="absolute text-[9px] text-[var(--color-text-tertiary)] -translate-x-1/2" style="left: {lbl.pos}%;">{lbl.text}</span>
					{/each}
				</div>

				<div class="flex items-center gap-4 mt-2 text-[10px] text-[var(--color-text-tertiary)]">
					<div class="flex items-center gap-1"><div class="w-2 h-2 rounded-sm" style="background: #E5B84C; opacity: 0.75;"></div><span>Live</span></div>
					<div class="flex items-center gap-1"><div class="w-2 h-2 rounded-sm" style="background: #E5B84C; opacity: 0.2;"></div><span>Imported</span></div>
					<span class="ml-auto">Click a week to drill in</span>
				</div>
			</div>

			<!-- Channel split -->
			{#if allStats && totalMessages > 0}
				{@const channels = [
					{ name: 'Imported', count: allStats.imported, color: 'rgba(229,184,76,0.2)' },
					{ name: 'Telegram', count: allStats.telegram, color: '#4CAF50' },
					{ name: 'Discord', count: allStats.discord, color: '#7289DA' },
					{ name: 'Portal', count: allStats.portal, color: '#E5B84C' },
				].filter(c => c.count > 0)}
				<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
					<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-3">By Channel</h3>
					<div class="h-5 rounded-lg overflow-hidden flex">
						{#each channels as ch}
							<div style="width: {(ch.count / totalMessages) * 100}%; background: {ch.color}; opacity: 0.7;" title="{ch.name}: {ch.count.toLocaleString()}"></div>
						{/each}
					</div>
					<div class="flex flex-wrap gap-x-4 gap-y-1 mt-2">
						{#each channels as ch}
							<div class="flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)]">
								<div class="w-2 h-2 rounded-full" style="background: {ch.color}; opacity: 0.7;"></div>
								<span>{ch.name} ({fmtK(ch.count)})</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}

		<!-- Empty state -->
		{#if granularity !== 'all' && !hasDesktopToday && !dayMessages && weekMsgTotal === 0}
			<div class="text-center py-12 text-sm text-[var(--color-text-tertiary)]">
				No activity for this {granularity === 'day' ? 'day' : 'week'}
			</div>
		{/if}
	{/if}

	<!-- ── Body State (Health) ──────────────────────────────────────── -->
	{#if healthSummary && (healthSummary.today || healthSummary.days?.length)}
		{@const hs = healthSummary}
		<div class="mt-8 border-t border-[var(--color-border)] pt-6">
			<h2 class="text-sm font-semibold text-[var(--color-text-primary)] mb-4">Body State</h2>

			<!-- Today stats -->
			{#if hs.today}
				{@const t = hs.today}
				<div class="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-4">
					{#if t.sleep_duration_min != null}
						{@const h = Math.floor(t.sleep_duration_min / 60)}
						{@const m = Math.round(t.sleep_duration_min % 60)}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">Sleep</div>
							<div class="text-lg font-semibold text-indigo-400">{h}h{m.toString().padStart(2,'0')}m</div>
							{#if t.sleep_efficiency != null}<div class="text-[0.55rem] text-[var(--color-text-tertiary)]">{Math.round(t.sleep_efficiency * 100)}% eff</div>{/if}
						</div>
					{/if}
					{#if t.hrv_avg != null}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">HRV</div>
							<div class="text-lg font-semibold text-green-400">{Math.round(t.hrv_avg)}ms</div>
						</div>
					{/if}
					{#if t.resting_hr != null}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">RHR</div>
							<div class="text-lg font-semibold text-red-400">{Math.round(t.resting_hr)}</div>
							<div class="text-[0.55rem] text-[var(--color-text-tertiary)]">bpm</div>
						</div>
					{/if}
					{#if t.steps != null}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">Steps</div>
							<div class="text-lg font-semibold text-orange-400">{t.steps.toLocaleString()}</div>
						</div>
					{/if}
					{#if t.active_energy_kcal != null}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">Energy</div>
							<div class="text-lg font-semibold text-yellow-400">{Math.round(t.active_energy_kcal)}</div>
							<div class="text-[0.55rem] text-[var(--color-text-tertiary)]">kcal</div>
						</div>
					{/if}
					{#if t.mindful_minutes != null && t.mindful_minutes > 0}
						<div class="bg-[var(--color-surface)] rounded-lg p-3 text-center">
							<div class="text-[0.6rem] text-[var(--color-text-tertiary)]">Mindful</div>
							<div class="text-lg font-semibold text-cyan-400">{Math.round(t.mindful_minutes)}m</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Sleep chart -->
			{#if hs.days?.some(d => d.sleep_duration_min != null)}
				{@const sleepDays = hs.days.filter(d => d.sleep_duration_min != null)}
				{@const maxSleep = Math.max(...sleepDays.map(x => x.sleep_duration_min || 0))}
				<div class="bg-[var(--color-surface)] rounded-lg p-4 mb-3">
					<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-2">Sleep</h3>
					<div class="flex items-end gap-1 h-24">
						{#each sleepDays as d}
							{@const barH = maxSleep > 0 ? ((d.sleep_duration_min || 0) / maxSleep) * 100 : 0}
							{@const deep = d.sleep_deep_min || 0}
							{@const rem = d.sleep_rem_min || 0}
							{@const core = d.sleep_core_min || 0}
							{@const total = deep + rem + core || 1}
							<div class="flex-1 flex flex-col items-center gap-0.5">
								<div class="w-full rounded-t relative" style="height: {barH}%; min-height: 2px;">
									<div class="absolute bottom-0 w-full rounded-t bg-indigo-600" style="height: {(deep/total)*100}%"></div>
									<div class="absolute w-full bg-purple-500/70" style="bottom: {(deep/total)*100}%; height: {(rem/total)*100}%"></div>
									<div class="absolute w-full rounded-t bg-blue-400/50" style="bottom: {((deep+rem)/total)*100}%; height: {(core/total)*100}%"></div>
								</div>
								<span class="text-[0.45rem] text-[var(--color-text-tertiary)]">{d.date.slice(5)}</span>
							</div>
						{/each}
					</div>
					<div class="flex gap-3 mt-2">
						<span class="flex items-center gap-1 text-[0.5rem] text-[var(--color-text-tertiary)]"><span class="w-2 h-2 rounded-sm bg-indigo-600"></span>Deep</span>
						<span class="flex items-center gap-1 text-[0.5rem] text-[var(--color-text-tertiary)]"><span class="w-2 h-2 rounded-sm bg-purple-500/70"></span>REM</span>
						<span class="flex items-center gap-1 text-[0.5rem] text-[var(--color-text-tertiary)]"><span class="w-2 h-2 rounded-sm bg-blue-400/50"></span>Core</span>
					</div>
				</div>
			{/if}

			<!-- HRV + RHR sparklines -->
			{#if hs.days?.some(d => d.hrv_avg != null || d.resting_hr != null)}
				<div class="grid grid-cols-2 gap-3 mb-3">
					{#if hs.days.some(d => d.hrv_avg != null)}
						{@const hrvDays = hs.days.filter(d => d.hrv_avg != null)}
						{@const maxHrv = Math.max(...hrvDays.map(d => d.hrv_avg || 0))}
						<div class="bg-[var(--color-surface)] rounded-lg p-4">
							<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-2">HRV (ms)</h3>
							<div class="flex items-end gap-0.5 h-16">
								{#each hrvDays as d}
									<div class="flex-1 bg-green-500/60 rounded-t" style="height: {maxHrv > 0 ? ((d.hrv_avg || 0) / maxHrv) * 100 : 0}%; min-height: 1px;" title="{d.date}: {Math.round(d.hrv_avg || 0)}ms"></div>
								{/each}
							</div>
						</div>
					{/if}
					{#if hs.days.some(d => d.resting_hr != null)}
						{@const rhrDays = hs.days.filter(d => d.resting_hr != null)}
						{@const maxRhr = Math.max(...rhrDays.map(d => d.resting_hr || 0))}
						<div class="bg-[var(--color-surface)] rounded-lg p-4">
							<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-2">RHR (bpm)</h3>
							<div class="flex items-end gap-0.5 h-16">
								{#each rhrDays as d}
									<div class="flex-1 bg-red-500/60 rounded-t" style="height: {maxRhr > 0 ? ((d.resting_hr || 0) / maxRhr) * 100 : 0}%; min-height: 1px;" title="{d.date}: {Math.round(d.resting_hr || 0)}bpm"></div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Trends -->
			{#if hs.trends && Object.values(hs.trends).some(v => v && v !== 'insufficient')}
				<div class="flex gap-2 flex-wrap mb-3">
					{#each Object.entries(hs.trends) as [key, val]}
						{#if val && val !== 'insufficient' && healthMetricLabel[key]}
							<span class="text-[0.6rem] px-2 py-1 rounded bg-[var(--color-surface)] {trendColor[val] || ''}">
								{trendArrow[val] || ''} {healthMetricLabel[key]} {val}
							</span>
						{/if}
					{/each}
				</div>
			{/if}

			<!-- Anomalies -->
			{#if hs.anomalies?.length}
				<div class="bg-[var(--color-surface)] rounded-lg p-3">
					<h3 class="text-xs font-medium text-[var(--color-text-tertiary)] mb-1">Notable</h3>
					{#each hs.anomalies.slice(0, 3) as a}
						<div class="text-[0.6rem] text-[var(--color-text-secondary)]">
							{a.date} — {healthMetricLabel[a.metric] || a.metric}: {Math.round(a.value)} (baseline {Math.round(a.baseline)})
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
