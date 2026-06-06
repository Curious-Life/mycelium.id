<script lang="ts">
	// Curious Life — the human-facing analytics surface. An Apple-Health-style
	// overview of the cognitive-measurement plane: high-level summary cards you can
	// tap to explore. Honest by construction — sparse / low-confidence signals say
	// so rather than fabricating a number. Surfaces EVERY metric family the
	// measurement plane actually computes: vitality, Fisher movement, harmonics,
	// LZ-complexity, cognitive frequency, topology + co-firing, and milestones —
	// plus a "what's measured" freshness strip.
	//
	// Aesthetic: pure-CSS atmosphere (drifting radial gradients), no WebGL / no
	// backdrop-filter (both misbehave in the desktop WKWebView — see app.css
	// `html.is-tauri`). All charts are hand-rolled SVG.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';
	import { apiGet } from '$lib/api';
	import Ring from '$lib/curious/Ring.svelte';
	import Spark from '$lib/curious/Spark.svelte';
	import TimeSeries from '$lib/curious/TimeSeries.svelte';

	type Any = Record<string, any>;

	let loading = $state(true);
	let active = $state<string | null>(null); // null = overview, else pillar key

	let vitality = $state<Any | null>(null);
	let audit = $state<Any | null>(null);
	let movement = $state<Any | null>(null); // trajectory/summary.summary
	let current = $state<Any | null>(null); // trajectory/current.current (level=all → {realm,theme,territory})
	let milestones = $state<Any[]>([]);
	let trajectory = $state<Any[]>([]); // weekly_step rows
	let rhythmByGran = $state<Record<string, Any | null>>({ alpha: null, theta: null, delta: null });
	let complexity = $state<Any | null>(null);
	let cofire = $state<Any | null>(null);
	let frequency = $state<Any | null>(null);
	let freshness = $state<Any | null>(null);

	let gran = $state<'alpha' | 'theta' | 'delta'>('theta');

	// Temporal series
	let freqSeries = $state<Any[]>([]);
	let rhythmSeries = $state<Any | null>(null); // { metric, series }
	let rhythmMetric = $state('total_spectral_energy_gamma');
	let freqMetric = $state('coherence');
	let moveMetric = $state<'fisher_velocity' | 'fisher_trajectory_length' | 'activation_entropy' | 'fisher_displacement'>('fisher_velocity');

	const apiBase = '/portal';
	async function loadRhythmSeries() {
		const r = await apiGet<Any>(`${apiBase}/metrics/series?metric=${rhythmMetric}&granularity=${gran}&limit=120`).catch(() => null);
		rhythmSeries = r ?? null;
	}

	const fmt = (v: any, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
	const pct = (v: any) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Math.round(Number(v) * 100)}%`);
	const cap = (s: any) => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : '—');

	onMount(async () => {
		navigationState.setPrimaryView('curious-life');
		const g = (p: string) => apiGet<Any>(p).catch(() => null);
		const [v, a, m, c, ms, tr, rA, rT, rD, cx, cf, fq, fr] = await Promise.all([
			g('/portal/vitality/snapshot'),
			g('/portal/vitality/audit'),
			g('/portal/trajectory/summary?period=quarter&level=realm'),
			g('/portal/trajectory/current?level=all'),
			g('/portal/trajectory/milestones'),
			g('/portal/trajectory?level=realm&window_type=weekly_step&limit=200'),
			g('/portal/metrics/window?granularity=alpha'),
			g('/portal/metrics/window?granularity=theta'),
			g('/portal/metrics/window?granularity=delta'),
			g('/portal/complexity'),
			g('/portal/cofire?limit=18'),
			g('/portal/frequency'),
			g('/portal/metric-freshness'),
		]);
		vitality = v;
		audit = a?.audit ?? null;
		movement = m?.summary ?? null;
		current = c?.current ?? null;
		milestones = ms?.milestones ?? [];
		trajectory = tr?.trajectory ?? [];
		rhythmByGran = { alpha: rA, theta: rT, delta: rD };
		complexity = cx ?? null;
		cofire = cf ?? null;
		frequency = fq?.snapshot ?? null;
		freshness = fr ?? null;
		loading = false;
		// Temporal series (non-blocking; charts fill in once back).
		const fs = await g(`/portal/frequency/series?granularity=${frequency?.granularity ?? 'day'}`);
		freqSeries = fs?.series ?? [];
		await loadRhythmSeries();
	});

	// Build a labelled series from the weekly_step trajectory rows.
	const moveSeries = $derived(trajectory.map((r) => {
		const v = r[moveMetric];
		return v == null || Number.isNaN(Number(v)) ? null : Number(v);
	}));
	const moveLabels = $derived(trajectory.map((r) => (r.window_end ?? '').slice(0, 10)));
	const moveMetricOpts = [
		{ key: 'fisher_velocity', label: 'velocity' },
		{ key: 'fisher_trajectory_length', label: 'path length' },
		{ key: 'activation_entropy', label: 'activation entropy' },
		{ key: 'fisher_displacement', label: 'displacement' },
	];
	const rhythmSeriesVals = $derived((rhythmSeries?.series ?? []).map((p: Any) => {
		const v = p.value;
		return v == null || Number.isNaN(Number(v)) ? null : Number(v);
	}));
	const rhythmSeriesLabels = $derived(
		(rhythmSeries?.series ?? []).map((p: Any) => (p.window_end ?? p.window_start ?? '').slice(0, 10)),
	);
	// The 41 metric keys, grouped for the selector.
	const HARMONIC_METRICS = [
		...['gamma', 'beta', 'alpha', 'theta', 'delta'].flatMap((b) => [1, 2, 3].map((k) => `harmonic_amplitude_${b}_k${k}`)),
		...['mean_crossing_rate', 'slope_sign_change_rate', 'autocorrelation_lag1', 'variance', 'total_spectral_energy'].flatMap((f) => ['gamma', 'beta', 'alpha', 'theta', 'delta'].map((b) => `${f}_${b}`)),
		'topology_h0_persistence_entropy',
	];
	function freqCol(key: string): (number | null)[] {
		return freqSeries.map((r) => (r[key] == null || Number.isNaN(Number(r[key])) ? null : Number(r[key])));
	}
	const freqLabels = $derived(freqSeries.map((r) => (r.window_end ?? '').slice(0, 10)));

	// ── Derived headlines ────────────────────────────────────────────────────
	const vSummary = $derived(vitality?.summary ?? null);
	const phaseOrder = ['anchor', 'active', 'sparse'];
	const phaseColor: Record<string, string> = {
		anchor: 'var(--color-accent-aurum)',
		active: 'var(--color-accent-jade)',
		sparse: 'var(--color-text-tertiary)',
	};
	const territories = $derived(
		[...(vitality?.territories ?? [])].sort((a, b) => (b.vitality ?? 0) - (a.vitality ?? 0)),
	);
	// Per-territory vitality sub-scalar averages (the 5 components behind `vitality`).
	const subScalars = [
		{ key: 'entropy_diversification', label: 'diversification' },
		{ key: 'connection_growth_rate', label: 'connection growth' },
		{ key: 'reach', label: 'reach' },
		{ key: 'cofire_partner_diversity', label: 'partner diversity' },
		{ key: 'engagement_depth_normalized', label: 'engagement depth' },
	];
	const subAvgs = $derived.by(() => {
		const ts = vitality?.territories ?? [];
		return subScalars.map((s) => {
			const xs = ts.map((t: Any) => t[s.key]).filter((x: any) => x != null && !Number.isNaN(Number(x)));
			return { ...s, avg: xs.length ? xs.reduce((a: number, b: number) => a + Number(b), 0) / xs.length : null };
		});
	});

	const velocities = $derived(trajectory.map((r) => Number(r.fisher_velocity) || 0));
	const curRealm = $derived(current?.realm ?? current ?? null);
	const moveLowConf = $derived(Boolean(curRealm?.low_confidence ?? movement == null));
	const levelPhases = $derived(
		['realm', 'theme', 'territory'].map((lv) => ({ level: lv, row: current?.[lv] ?? null })),
	);

	// ── Rhythm (harmonics) ───────────────────────────────────────────────────
	const BANDS = ['gamma', 'beta', 'alpha', 'theta', 'delta'];
	const rhythm = $derived(rhythmByGran[gran] ?? rhythmByGran.theta ?? null);
	const rhythmValues = $derived(rhythm?.values ?? {});
	const granWithSignal = $derived(
		(['theta', 'alpha', 'delta'] as const).find(
			(gk) => rhythmByGran[gk]?.values && Object.values(rhythmByGran[gk]!.values).some((v) => v != null && Number(v) !== 0),
		) ?? 'theta',
	);
	const overviewRhythm = $derived(rhythmByGran[granWithSignal]?.values ?? {});
	const rhythmHasSignal = $derived(
		Object.values(overviewRhythm).some((v) => v != null && Number(v) !== 0),
	);
	// The 9 feature rows × 5 bands grid (the 41 harmonic columns made legible).
	const FEATURES = [
		{ key: 'harmonic_amplitude', suffix: '_k1', label: 'amplitude k1' },
		{ key: 'harmonic_amplitude', suffix: '_k2', label: 'amplitude k2' },
		{ key: 'harmonic_amplitude', suffix: '_k3', label: 'amplitude k3' },
		{ key: 'mean_crossing_rate', suffix: '', label: 'crossing rate' },
		{ key: 'slope_sign_change_rate', suffix: '', label: 'slope changes' },
		{ key: 'autocorrelation_lag1', suffix: '', label: 'autocorrelation' },
		{ key: 'variance', suffix: '', label: 'variance' },
		{ key: 'total_spectral_energy', suffix: '', label: 'spectral energy' },
	];
	const cellVal = (feat: Any, band: string) => {
		const k = `${feat.key}_${band}${feat.suffix}`;
		const v = rhythmValues[k];
		return v == null || Number.isNaN(Number(v)) ? null : Number(v);
	};

	// ── Complexity / Frequency / Co-firing ───────────────────────────────────
	const cxGlobal = $derived(complexity?.global ?? null);
	const cxTerr = $derived(
		[...(complexity?.territories ?? [])].sort((a, b) => (b.lz_complexity ?? 0) - (a.lz_complexity ?? 0)),
	);
	const freq = $derived(frequency);
	const freqStats = [
		{ key: 'coherence', label: 'coherence', hint: 'how aligned your active territories are' },
		{ key: 'entropy', label: 'spread', hint: 'how evenly attention is distributed' },
		{ key: 'compression', label: 'compressibility', hint: 'text compression ratio' },
		{ key: 'learning_rate', label: 'learning rate', hint: 'change between consecutive windows' },
		{ key: 'gradient_signal', label: 'drift', hint: 'distance from where you began' },
	];
	const cofireEdges = $derived(cofire?.edges ?? []);
	const cofireScales = [
		{ key: 'immediate', label: 'hour' },
		{ key: 'session', label: 'session' },
		{ key: 'daily', label: 'day' },
		{ key: 'weekly', label: 'week' },
	];

	// ── Freshness ("what's measured") ────────────────────────────────────────
	const FRESH_LABELS: Record<string, string> = {
		fisher_trajectory: 'Movement',
		fisher_milestones: 'Milestones',
		territory_vitality: 'Vitality',
		territory_cofire: 'Co-firing',
		complexity_snapshots: 'Complexity',
		topology_audit_snapshots: 'Topology',
		frequency_snapshots: 'Frequency',
		cognitive_metrics_harmonic: 'Harmonics',
	};
	const freshColor: Record<string, string> = {
		fresh: 'var(--color-accent-jade)',
		stale: 'var(--color-accent-coral)',
		empty: 'var(--color-text-tertiary)',
		missing: 'var(--color-text-tertiary)',
	};
	const freshList = $derived(freshness?.metrics ?? []);

	function openMindscape() {
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}

	const pillars = [
		{ key: 'vitality', label: 'Vitality', accent: 'jade', tagline: 'How alive your territories are' },
		{ key: 'movement', label: 'Movement', accent: 'azure', tagline: 'How your mind is moving' },
		{ key: 'rhythm', label: 'Rhythm', accent: 'amethyst', tagline: 'The cadence of your thinking' },
		{ key: 'complexity', label: 'Complexity', accent: 'teal', tagline: 'How varied your patterns are' },
		{ key: 'growth', label: 'Growth', accent: 'rose', tagline: 'How your thinking consolidates' },
		{ key: 'mindscape', label: 'Mindscape', accent: 'aurum', tagline: 'The shape of your inner world' },
		{ key: 'milestones', label: 'Milestones', accent: 'coral', tagline: 'Moments your mind turned' },
	];
	const accentVar: Record<string, string> = {
		jade: 'var(--color-accent-jade)',
		azure: 'var(--color-accent)',
		amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)',
		coral: 'var(--color-accent-coral)',
		teal: 'var(--color-accent-teal)',
		rose: 'var(--color-accent-rose)',
	};
	const accentRgb: Record<string, string> = {
		jade: 'var(--color-accent-jade-rgb)',
		azure: 'var(--color-accent-rgb)',
		amethyst: 'var(--color-accent-amethyst-rgb)',
		aurum: 'var(--color-accent-aurum-rgb)',
		coral: 'var(--color-accent-coral-rgb)',
		teal: 'var(--color-accent-teal-rgb)',
		rose: 'var(--color-accent-rose-rgb)',
	};
</script>

<svelte:head><title>Curious Life · Mycelium</title></svelte:head>

<div class="curious">
	<div class="aurora" aria-hidden="true">
		<span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span>
	</div>

	<div class="inner">
		{#if !active}
			<!-- ── OVERVIEW ─────────────────────────────────────────────────── -->
			<header class="hero">
				<p class="overline">Curious Life</p>
				<h1 class="title">Where your mind stands today.</h1>
				<p class="lede">A living read of how your thinking moves, gathers, and grows — drawn from your own conversations.</p>
			</header>

			{#if loading}
				<div class="grid">
					{#each pillars as _}<div class="card skeleton"></div>{/each}
				</div>
			{:else}
				<div class="grid">
					<!-- VITALITY -->
					<button class="card" style="--rgb:{accentRgb.jade};" onclick={() => (active = 'vitality')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.jade}"></span><span class="ctitle">Vitality</span><span class="chev">›</span></div>
						<div class="card-body two">
							<Ring value={vSummary?.avg_vitality ?? 0} max={1} color={accentVar.jade}
								center={fmt(vSummary?.avg_vitality, 2)} sub="avg" size={84} />
							<div class="col">
								<div class="big">{vSummary?.territory_count ?? '—'} <span class="unit">territories</span></div>
								<div class="phasebar">
									{#each phaseOrder as ph}
										{@const n = vSummary?.phases?.[ph] ?? 0}
										{#if n > 0}<span class="seg" style="flex:{n};background:{phaseColor[ph]}" title="{n} {ph}"></span>{/if}
									{/each}
								</div>
								<div class="legend">
									{#each phaseOrder as ph}
										{#if (vSummary?.phases?.[ph] ?? 0) > 0}
											<span><i style="background:{phaseColor[ph]}"></i>{vSummary.phases[ph]} {ph}</span>
										{/if}
									{/each}
								</div>
							</div>
						</div>
						<p class="tagline">How alive your territories are</p>
					</button>

					<!-- MOVEMENT -->
					<button class="card" style="--rgb:{accentRgb.azure};" onclick={() => (active = 'movement')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.azure}"></span><span class="ctitle">Movement</span>{#if moveLowConf}<span class="lc">early signal</span>{/if}<span class="chev">›</span></div>
						<div class="card-body">
							<div class="phase-badge" style="--rgb:{accentRgb.azure}">{cap(curRealm?.phase ?? movement?.phase)}</div>
							<div class="spark-row"><Spark points={velocities} color={accentVar.azure} width={150} height={42} /></div>
							<div class="ministats">
								<span><b>{fmt(movement?.exploration_ratio, 2)}</b> exploration</span>
								<span><b>{fmt(movement?.avg_velocity, 3)}</b> velocity</span>
							</div>
						</div>
						<p class="tagline">How your mind is moving</p>
					</button>

					<!-- RHYTHM -->
					<button class="card" style="--rgb:{accentRgb.amethyst};" onclick={() => (active = 'rhythm')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.amethyst}"></span><span class="ctitle">Rhythm</span>{#if !rhythmHasSignal}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
						<div class="card-body">
							{#if rhythmHasSignal}
								<div class="bands">
									{#each BANDS as band}
										{@const v = Number(overviewRhythm[`harmonic_amplitude_${band}_k1`]) || 0}
										<div class="band"><span class="bandbar" style="height:{Math.min(100, v * 600)}%;background:{accentVar.amethyst}"></span></div>
									{/each}
								</div>
								<p class="muted">Harmonic signature across timescales</p>
							{:else}
								<div class="empty-rhythm">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 12h3l2-6 4 14 3-10 2 4h4" /></svg>
									<p class="muted">Your rhythm sharpens as you keep capturing. A few more active days and the bands light up.</p>
								</div>
							{/if}
						</div>
						<p class="tagline">The cadence of your thinking</p>
					</button>

					<!-- COMPLEXITY -->
					<button class="card" style="--rgb:{accentRgb.teal};" onclick={() => (active = 'complexity')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.teal}"></span><span class="ctitle">Complexity</span><span class="chev">›</span></div>
						<div class="card-body two">
							<Ring value={cxGlobal?.lz_complexity ?? 0} max={1} color={accentVar.teal}
								center={fmt(cxGlobal?.lz_complexity, 2)} sub="LZ" size={84} />
							<div class="col">
								<div class="big">{cxGlobal?.alphabet_size ?? '—'} <span class="unit">territories in play</span></div>
								<div class="ministats wrap">
									<span><b>{cxGlobal?.sequence_length ?? '—'}</b> steps</span>
									<span><b>{cxGlobal?.raw_complexity ?? '—'}</b> patterns</span>
								</div>
							</div>
						</div>
						<p class="tagline">How varied your thinking sequences are</p>
					</button>

					<!-- GROWTH (frequency) -->
					<button class="card" style="--rgb:{accentRgb.rose};" onclick={() => (active = 'growth')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.rose}"></span><span class="ctitle">Growth</span>{#if !freq}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
						<div class="card-body">
							{#if freq}
								<div class="ministats wrap">
									<span><b>{pct(freq.coherence)}</b> coherence</span>
									<span><b>{pct(freq.entropy)}</b> spread</span>
									<span><b>{pct(freq.learning_rate)}</b> learning</span>
								</div>
								<p class="muted">Window of {freq.message_count ?? '—'} messages · {freq.granularity ?? ''}</p>
							{:else}
								<p class="muted">Growth metrics resolve once a few windows of activity accrue.</p>
							{/if}
						</div>
						<p class="tagline">How your thinking consolidates and changes</p>
					</button>

					<!-- MINDSCAPE -->
					<button class="card" style="--rgb:{accentRgb.aurum};" onclick={() => (active = 'mindscape')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.aurum}"></span><span class="ctitle">Mindscape</span><span class="chev">›</span></div>
						<div class="card-body">
							<div class="big">{audit?.total_territories ?? '—'} <span class="unit">territories</span></div>
							<div class="ministats wrap">
								<span><b>{audit?.total_connections ?? '—'}</b> links</span>
								<span><b>{fmt(audit?.m2_entropy, 2)}</b> spread</span>
								<span><b>{audit?.orphan_count ?? 0}</b> orphans</span>
								<span><b>{audit?.bridge_count ?? 0}</b> bridges</span>
							</div>
						</div>
						<p class="tagline">The shape of your inner world</p>
					</button>

					<!-- MILESTONES -->
					<button class="card wide" style="--rgb:{accentRgb.coral};" onclick={() => (active = 'milestones')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.coral}"></span><span class="ctitle">Milestones</span><span class="count">{milestones.length}</span><span class="chev">›</span></div>
						<div class="card-body">
							{#if milestones.length}
								<p class="headline">{milestones[0].headline}</p>
								<p class="muted">{(milestones[0].window_start ?? '').slice(0, 10)} · {milestones.length} moment{milestones.length > 1 ? 's' : ''} your mind turned</p>
							{:else}
								<p class="muted">No turning points detected yet — they appear when your focus shifts decisively.</p>
							{/if}
						</div>
						<p class="tagline">Moments your mind turned</p>
					</button>
				</div>

				<!-- WHAT'S MEASURED — freshness strip -->
				{#if freshList.length}
					<div class="freshness">
						<span class="fresh-title">What's measured</span>
						<div class="fresh-row">
							{#each freshList as f}
								<span class="fresh-chip" title="{f.description} · {f.verdict}{f.cadence ? ' · ' + f.cadence : ''}">
									<i style="background:{freshColor[f.verdict] ?? 'var(--color-text-tertiary)'}"></i>
									{FRESH_LABELS[f.table] ?? f.table}
								</span>
							{/each}
						</div>
					</div>
				{/if}

				<p class="footnote">Computed from {vSummary?.territory_count ?? 0} territories across your conversations. Signals marked “early” / “gathering” are advisory until more data accrues.</p>
			{/if}
		{:else}
			<!-- ── DETAIL ───────────────────────────────────────────────────── -->
			{@const p = pillars.find((x) => x.key === active)!}
			<button class="back" onclick={() => (active = null)}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
				Overview
			</button>
			<header class="detail-head" style="--rgb:{accentRgb[p.accent]}">
				<span class="dot lg" style="background:{accentVar[p.accent]}"></span>
				<div><h1>{p.label}</h1><p>{p.tagline}</p></div>
			</header>

			{#if active === 'vitality'}
				<div class="detail-grid">
					<div class="panel center-panel">
						<Ring value={vSummary?.avg_vitality ?? 0} max={1} color={accentVar.jade} center={fmt(vSummary?.avg_vitality, 2)} sub="avg vitality" size={120} stroke={11} />
						<div class="phase-counts">
							{#each phaseOrder as ph}
								<div class="pc"><span class="pc-n" style="color:{phaseColor[ph]}">{vSummary?.phases?.[ph] ?? 0}</span><span class="pc-l">{ph}</span></div>
							{/each}
						</div>
					</div>
					<div class="panel">
						<h3>Territories by vitality</h3>
						<ul class="terr-list">
							{#each territories.slice(0, 16) as t}
								<li>
									<span class="t-phase" style="background:{phaseColor[t.phase] ?? 'var(--color-text-tertiary)'}"></span>
									<span class="t-id">{t.territory_name ?? `Territory ${t.territory_id}`}</span>
									<span class="t-bar"><span style="width:{Math.round((t.vitality ?? 0) * 100)}%;background:{phaseColor[t.phase] ?? 'var(--color-text-tertiary)'}"></span></span>
									<span class="t-val">{fmt(t.vitality, 2)}</span>
								</li>
							{/each}
						</ul>
					</div>
				</div>
				<div class="panel">
					<h3>What feeds vitality</h3>
					<div class="subscalars">
						{#each subAvgs as s}
							<div class="ss">
								<div class="ss-bar"><span style="width:{Math.round((s.avg ?? 0) * 100)}%;background:{accentVar.jade}"></span></div>
								<div class="ss-meta"><span class="ss-l">{s.label}</span><span class="ss-v">{fmt(s.avg, 2)}</span></div>
							</div>
						{/each}
					</div>
					<p class="muted sm">Averaged across your territories. Vitality is a blend of these five signals.</p>
				</div>

			{:else if active === 'movement'}
				<div class="detail-grid one">
					<div class="panel">
						<div class="row-between">
							<div><div class="phase-badge lg" style="--rgb:{accentRgb.azure}">{cap(curRealm?.phase)}</div>{#if curRealm?.phase_recent && curRealm.phase_recent !== curRealm.phase}<span class="muted sm">recently {curRealm.phase_recent}</span>{/if}</div>
							{#if moveLowConf}<span class="lc">early signal · advisory</span>{/if}
						</div>
						<div class="row-between" style="margin:0.4rem 0 0.2rem">
							<span class="muted sm">Over {trajectory.length} weekly windows</span>
							<div class="seg-toggle az">
								{#each moveMetricOpts as o}
									<button class:on={moveMetric === o.key} onclick={() => (moveMetric = o.key as any)}>{o.label}</button>
								{/each}
							</div>
						</div>
						<div class="big-spark"><TimeSeries points={moveSeries} labels={moveLabels} color={accentVar.azure} height={150} /></div>
						<p class="muted sm">How your {moveMetricOpts.find((o) => o.key === moveMetric)?.label} changed week by week — drawn from your full history. Flat-zero stretches are weeks with little activity.</p>
					</div>
					<div class="stat-row">
						<div class="stat"><span class="s-v">{fmt(movement?.exploration_ratio, 2)}</span><span class="s-l">exploration ratio</span></div>
						<div class="stat"><span class="s-v">{fmt(movement?.avg_velocity, 3)}</span><span class="s-l">avg velocity</span></div>
						<div class="stat"><span class="s-v">{fmt(curRealm?.activation_entropy, 2)}</span><span class="s-l">activation entropy</span></div>
						<div class="stat"><span class="s-v">{movement?.R_recent != null ? fmt(movement?.R_recent, 2) : '—'}</span><span class="s-l">recent reach (R)</span></div>
					</div>
					<div class="panel">
						<h3>Phase by level</h3>
						<div class="level-chips">
							{#each levelPhases as lp}
								<div class="lchip">
									<span class="lchip-l">{lp.level}</span>
									{#if lp.row}
										<span class="phase-badge sm" style="--rgb:{accentRgb.azure}">{cap(lp.row.phase)}</span>
										<span class="muted sm">v {fmt(lp.row.fisher_velocity, 3)}</span>
									{:else}
										<span class="muted sm">no window yet</span>
									{/if}
								</div>
							{/each}
						</div>
						<p class="muted sm">Movement is read at three nested scales — realms, themes, and territories — which can move at different speeds.</p>
					</div>
				</div>

			{:else if active === 'rhythm'}
				<div class="panel">
					<div class="row-between">
						<h3>Harmonic signature</h3>
						<div class="seg-toggle">
							{#each ['alpha', 'theta', 'delta'] as gk}
								<button class:on={gran === gk} onclick={() => { gran = gk as any; loadRhythmSeries(); }}>{gk}</button>
							{/each}
						</div>
					</div>
					{#if Object.values(rhythmValues).some((v) => v != null && Number(v) !== 0)}
						<div class="metric-grid">
							<div class="mg-row mg-head">
								<span class="mg-feat"></span>
								{#each BANDS as band}<span class="mg-band">{band}</span>{/each}
							</div>
							{#each FEATURES as feat}
								<div class="mg-row">
									<span class="mg-feat">{feat.label}</span>
									{#each BANDS as band}
										{@const v = cellVal(feat, band)}
										<span class="mg-cell" class:null={v == null} style={v != null ? `--m:${Math.min(1, Math.abs(v))}` : ''}>
											{v == null ? '·' : fmt(v, 2)}
										</span>
									{/each}
								</div>
							{/each}
						</div>
						<div class="h0">
							<span class="s-l">topology persistence entropy (H0)</span>
							<span class="s-v">{fmt(rhythmValues.topology_h0_persistence_entropy, 3)}</span>
						</div>
						<p class="muted sm">Bands are temporal aggregation scales, not EEG frequencies — gamma = per-message, delta = monthly. {rhythm?.low_confidence ? 'Low-confidence: based on a small window.' : ''}</p>
					{:else}
						<div class="empty-lg">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 12h4l2.5-7 4.5 16 3-12 2 3h4" /></svg>
							<h3>No {gran} window yet</h3>
							<p class="muted">The harmonic signature reads the cadence of your thinking across timescales. This granularity needs a denser stretch of activity to resolve — try another, or keep capturing.</p>
						</div>
					{/if}
				</div>

				<div class="panel">
					<div class="row-between">
						<h3>One metric over time</h3>
						<select class="m-select" bind:value={rhythmMetric} onchange={loadRhythmSeries}>
							{#each HARMONIC_METRICS as mk}<option value={mk}>{mk.replace(/_/g, ' ')}</option>{/each}
						</select>
					</div>
					{#if rhythmSeriesVals.some((v) => v != null)}
						<TimeSeries points={rhythmSeriesVals} labels={rhythmSeriesLabels} color={accentVar.amethyst} height={150} />
						<p class="muted sm">{rhythmMetric.replace(/_/g, ' ')} across {rhythmSeriesLabels.length} {gran} windows. Gaps are windows it couldn't be computed for.</p>
					{:else}
						<p class="muted sm">No time series for this metric at {gran} granularity yet — try another metric or granularity.</p>
					{/if}
				</div>

			{:else if active === 'complexity'}
				<div class="detail-grid">
					<div class="panel center-panel">
						<Ring value={cxGlobal?.lz_complexity ?? 0} max={1} color={accentVar.teal} center={fmt(cxGlobal?.lz_complexity, 2)} sub="global LZ" size={120} stroke={11} />
						<div class="phase-counts">
							<div class="pc"><span class="pc-n" style="color:{accentVar.teal}">{cxGlobal?.sequence_length ?? '—'}</span><span class="pc-l">steps</span></div>
							<div class="pc"><span class="pc-n" style="color:{accentVar.teal}">{cxGlobal?.raw_complexity ?? '—'}</span><span class="pc-l">patterns</span></div>
							<div class="pc"><span class="pc-n" style="color:{accentVar.teal}">{cxGlobal?.alphabet_size ?? '—'}</span><span class="pc-l">symbols</span></div>
						</div>
					</div>
					<div class="panel">
						<h3>Complexity by territory</h3>
						{#if cxTerr.length}
							<ul class="terr-list">
								{#each cxTerr.slice(0, 16) as t}
									<li>
										<span class="t-phase" style="background:{accentVar.teal}"></span>
										<span class="t-id">{t.level_name ?? `Territory ${t.level_id}`}</span>
										<span class="t-bar"><span style="width:{Math.round((t.lz_complexity ?? 0) * 100)}%;background:{accentVar.teal}"></span></span>
										<span class="t-val">{fmt(t.lz_complexity, 2)}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="muted">Per-territory complexity resolves once territories have enough sequence to measure.</p>
						{/if}
					</div>
				</div>
				<p class="muted sm">LZ76 complexity measures how compressible the sequence of territories you move through is — higher means more varied, less repetitive thinking. Window {cxGlobal?.window_start ?? ''} → {cxGlobal?.window_end ?? ''}.</p>

			{:else if active === 'growth'}
				{#if freq}
					<div class="stat-row five">
						{#each freqStats as s}
							<div class="stat" title={s.hint}><span class="s-v">{pct(freq[s.key])}</span><span class="s-l">{s.label}</span></div>
						{/each}
					</div>
					<div class="panel">
						<h3>How your thinking is consolidating</h3>
						<div class="subscalars">
							{#each freqStats as s}
								<div class="ss">
									<div class="ss-bar"><span style="width:{Math.round((Number(freq[s.key]) || 0) * 100)}%;background:{accentVar.rose}"></span></div>
									<div class="ss-meta"><span class="ss-l">{s.label}</span><span class="ss-v">{fmt(freq[s.key], 3)}</span></div>
								</div>
							{/each}
						</div>
						<p class="muted sm">Over a window of {freq.message_count ?? '—'} messages across {freq.territory_count ?? '—'} territories ({freq.granularity ?? ''}). Coherence + spread describe the present; learning-rate + drift describe change.</p>
					</div>
					{#if freqSeries.length > 1}
						<div class="panel">
							<div class="row-between">
								<h3>Over time</h3>
								<div class="seg-toggle rose">
									{#each freqStats as s}
										<button class:on={freqMetric === s.key} onclick={() => (freqMetric = s.key)}>{s.label}</button>
									{/each}
								</div>
							</div>
							<TimeSeries points={freqCol(freqMetric)} labels={freqLabels} color={accentVar.rose} height={150} yMin={0} yMax={1} unit="" />
							<p class="muted sm">{freqStats.find((s) => s.key === freqMetric)?.label} across {freqSeries.length} {freqSeries[0]?.granularity ?? ''} windows — {freqStats.find((s) => s.key === freqMetric)?.hint}.</p>
						</div>
					{/if}
				{:else}
					<div class="panel"><div class="empty-lg"><h3>Growth is still forming</h3><p class="muted">These windowed metrics — coherence, spread, compressibility, learning-rate and drift — need a few windows of activity to resolve.</p></div></div>
				{/if}

			{:else if active === 'mindscape'}
				<div class="stat-row four">
					<div class="stat"><span class="s-v">{audit?.total_territories ?? '—'}</span><span class="s-l">territories</span></div>
					<div class="stat"><span class="s-v">{audit?.total_connections ?? '—'}</span><span class="s-l">connections</span></div>
					<div class="stat"><span class="s-v">{fmt(audit?.m2_entropy, 2)}</span><span class="s-l">spread (M2 entropy)</span></div>
					<div class="stat"><span class="s-v">{fmt(audit?.degree_gini, 2)}</span><span class="s-l">concentration (Gini)</span></div>
					<div class="stat"><span class="s-v">{fmt(audit?.mean_degree, 2)}</span><span class="s-l">mean degree</span></div>
					<div class="stat"><span class="s-v">{audit?.orphan_count ?? 0}</span><span class="s-l">orphans</span></div>
					<div class="stat"><span class="s-v">{audit?.bridge_count ?? 0}</span><span class="s-l">bridges</span></div>
					<div class="stat"><span class="s-v">{cap(audit?.m2_trend)}</span><span class="s-l">trend</span></div>
				</div>
				{#if cofireEdges.length}
					<div class="panel">
						<h3>Strongest co-firing pairs</h3>
						<ul class="cofire-list">
							<li class="cf-head"><span></span><span></span>{#each cofireScales as sc}<span class="cf-sl">{sc.label}</span>{/each}</li>
							{#each cofireEdges as e}
								<li>
									<span class="cf-pair">T{e.a}</span>
									<span class="cf-pair b">T{e.b}</span>
									{#each cofireScales as sc}
										<span class="cf-cell"><i style="opacity:{Math.min(1, (e[sc.key] ?? 0))};background:{accentVar.aurum}"></i>{fmt(e[sc.key], 2)}</span>
									{/each}
								</li>
							{/each}
						</ul>
						<p class="muted sm">Which territories light up together, across four decay timescales — from the same hour to the same week. {cofire?.total_edges ?? 0} active pair{(cofire?.total_edges ?? 0) === 1 ? '' : 's'} total.</p>
					</div>
				{/if}
				<div class="panel cta-panel">
					<div><h3>Walk your mindscape</h3><p class="muted">See your territories laid out in space — what clusters, what bridges, what drifts alone.</p></div>
					<button class="cta" onclick={openMindscape}>Open the 3D map <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg></button>
				</div>

			{:else if active === 'milestones'}
				<div class="panel">
					{#if milestones.length}
						<ul class="mile-list">
							{#each milestones as m}
								<li>
									<span class="m-node" style="background:{accentVar.coral}"></span>
									<div class="m-body">
										<p class="m-head">{m.headline}</p>
										<p class="muted sm">{(m.window_start ?? '').slice(0, 10)} · {m.rule_type?.replace('_', ' ')}{#if m.phase_from} · {m.phase_from} → {m.phase_to}{/if}</p>
									</div>
								</li>
							{/each}
						</ul>
					{:else}
						<div class="empty-lg"><h3>No turning points yet</h3><p class="muted">Milestones mark the weeks your focus shifted decisively — a phase change, or an unusually fast move. They surface as your story accrues.</p></div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.curious { position: relative; height: 100%; overflow-y: auto; overflow-x: hidden; background: var(--color-bg); color: var(--color-text-primary); }
	.aurora { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
	.blob { position: absolute; width: 56vmax; height: 56vmax; border-radius: 50%; opacity: 0.4; will-change: transform; }
	.b1 { top: -24vmax; left: -16vmax; background: radial-gradient(circle, rgb(var(--color-accent-rgb) / 0.16), transparent 60%); animation: drift1 38s ease-in-out infinite; }
	.b2 { bottom: -28vmax; right: -18vmax; background: radial-gradient(circle, rgb(var(--color-accent-amethyst-rgb) / 0.16), transparent 60%); animation: drift2 46s ease-in-out infinite; }
	.b3 { top: 24%; left: 40%; width: 40vmax; height: 40vmax; background: radial-gradient(circle, rgb(var(--color-accent-aurum-rgb) / 0.10), transparent 62%); animation: drift3 54s ease-in-out infinite; }

	.inner { position: relative; z-index: 1; max-width: 64rem; margin: 0 auto; padding: clamp(2rem, 5vh, 3.5rem) clamp(1.1rem, 4vw, 2.5rem) 4rem; }

	.hero { text-align: center; max-width: 40rem; margin: 0 auto clamp(2rem, 4vh, 3rem); }
	.overline { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.4em; text-transform: uppercase; color: var(--color-accent-aurum); margin-bottom: 1rem; }
	.title { font-size: clamp(1.9rem, 4.5vw, 3rem); line-height: 1.06; letter-spacing: -0.025em; font-weight: 600; background: linear-gradient(112deg, var(--color-text-emphasis) 22%, var(--color-accent-aurum) 70%, var(--color-accent-amethyst) 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.lede { margin-top: 1rem; font-size: clamp(0.95rem, 1.4vw, 1.1rem); line-height: 1.6; color: var(--color-text-secondary); }

	/* ── Overview grid ── */
	.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: clamp(0.8rem, 1.6vw, 1.1rem); }
	.card.wide { grid-column: 1 / -1; }
	.card {
		position: relative; text-align: left; display: flex; flex-direction: column; gap: 0.85rem;
		padding: 1.25rem 1.35rem 1.1rem; border-radius: var(--radius-lg);
		background: linear-gradient(160deg, rgb(var(--rgb) / 0.07), var(--color-surface) 62%);
		border: 1px solid var(--color-border); cursor: pointer; color: inherit;
		transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
	}
	.card:hover { transform: translateY(-2px); border-color: rgb(var(--rgb) / 0.5); box-shadow: 0 12px 32px rgb(var(--rgb) / 0.12); }
	.card:focus-visible { outline: 2px solid rgb(var(--rgb) / 0.8); outline-offset: 2px; }
	.card.skeleton { min-height: 168px; cursor: default; animation: pulse 1.5s ease-in-out infinite; }
	.card.skeleton:hover { transform: none; box-shadow: none; border-color: var(--color-border); }

	.card-head { display: flex; align-items: center; gap: 0.55rem; }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 10px currentColor; }
	.dot.lg { width: 12px; height: 12px; }
	.ctitle { font-size: 0.92rem; font-weight: 600; letter-spacing: -0.01em; color: var(--color-text-emphasis); }
	.chev { margin-left: auto; color: var(--color-text-tertiary); font-size: 1.2rem; line-height: 1; }
	.count, .lc { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.05em; }
	.count { margin-left: auto; padding: 0.1rem 0.5rem; border-radius: var(--radius-full); background: rgb(var(--rgb) / 0.16); color: var(--color-text-emphasis); }
	.card-head .count + .chev { margin-left: 0.4rem; }
	.lc { margin-left: auto; text-transform: uppercase; color: var(--color-text-tertiary); padding: 0.12rem 0.5rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); }
	.card-head .lc + .chev { margin-left: 0.4rem; }

	.card-body { display: flex; flex-direction: column; gap: 0.6rem; min-height: 92px; }
	.card-body.two { flex-direction: row; align-items: center; gap: 1.1rem; }
	.col { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; }
	.big { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.03em; color: var(--color-text-emphasis); }
	.big .unit { font-size: 0.8rem; font-weight: 400; color: var(--color-text-tertiary); letter-spacing: 0; }
	.tagline { font-size: 0.78rem; color: var(--color-text-tertiary); margin-top: auto; }

	.phasebar { display: flex; height: 9px; border-radius: var(--radius-full); overflow: hidden; gap: 2px; }
	.seg { display: block; border-radius: 2px; }
	.legend { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 0.35rem; vertical-align: middle; }

	.phase-badge { align-self: flex-start; padding: 0.3rem 0.8rem; border-radius: var(--radius-full); font-size: 0.85rem; font-weight: 600; color: var(--color-text-emphasis); background: rgb(var(--rgb) / 0.16); border: 1px solid rgb(var(--rgb) / 0.4); }
	.phase-badge.lg { font-size: 1.1rem; padding: 0.4rem 1rem; }
	.phase-badge.sm { font-size: 0.74rem; padding: 0.2rem 0.6rem; }
	.spark-row { padding: 0.2rem 0; }
	.ministats { display: flex; gap: 1.1rem; font-size: 0.78rem; color: var(--color-text-secondary); }
	.ministats.wrap { flex-wrap: wrap; gap: 0.5rem 1.1rem; }
	.ministats b { color: var(--color-text-emphasis); font-weight: 600; }

	.bands { display: flex; align-items: flex-end; gap: 6px; height: 56px; }
	.band { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 4px; }
	.bandbar { width: 100%; max-width: 22px; border-radius: 3px 3px 0 0; min-height: 3px; transition: height 0.6s var(--ease-out); }
	.empty-rhythm { display: flex; align-items: center; gap: 0.8rem; color: var(--color-text-tertiary); }
	.empty-rhythm svg { width: 2rem; height: 2rem; flex: none; opacity: 0.6; }

	.headline { font-size: 1.05rem; font-weight: 500; color: var(--color-text-primary); line-height: 1.4; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; line-height: 1.5; }
	.muted.sm { font-size: 0.76rem; }
	.footnote { margin-top: 1.5rem; text-align: center; font-size: 0.72rem; color: var(--color-text-tertiary); }

	/* ── What's measured ── */
	.freshness { margin-top: 1.6rem; padding: 1rem 1.2rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
	.fresh-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--color-text-tertiary); }
	.fresh-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.7rem; }
	.fresh-chip { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.74rem; color: var(--color-text-secondary); padding: 0.25rem 0.6rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); }
	.fresh-chip i { width: 7px; height: 7px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }

	/* ── Detail ── */
	.back { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.7rem 0.4rem 0.45rem; margin-bottom: 1.2rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-secondary); font-size: 0.82rem; cursor: pointer; transition: border-color var(--duration-fast), color var(--duration-fast); }
	.back:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
	.back svg { width: 1rem; height: 1rem; }
	.detail-head { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.5rem; }
	.detail-head h1 { font-size: 1.8rem; font-weight: 600; letter-spacing: -0.02em; }
	.detail-head p { color: var(--color-text-tertiary); font-size: 0.88rem; margin-top: 0.15rem; }

	.detail-grid { display: grid; grid-template-columns: 1fr 1.5fr; gap: 1rem; margin-bottom: 1rem; }
	.detail-grid.one { grid-template-columns: 1fr; }
	.panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 1.4rem; margin-bottom: 1rem; }
	.panel:last-child { margin-bottom: 0; }
	.panel h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 1rem; color: var(--color-text-emphasis); }
	.center-panel { display: flex; flex-direction: column; align-items: center; gap: 1.4rem; justify-content: center; }
	.phase-counts { display: flex; gap: 1.5rem; }
	.pc { text-align: center; } .pc-n { display: block; font-size: 1.6rem; font-weight: 600; } .pc-l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-tertiary); }

	.terr-list { display: flex; flex-direction: column; gap: 0.5rem; }
	.terr-list li { display: grid; grid-template-columns: 10px 1fr 1fr auto; align-items: center; gap: 0.7rem; font-size: 0.82rem; }
	.t-phase { width: 8px; height: 8px; border-radius: 50%; }
	.t-id { color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.t-bar { height: 6px; border-radius: var(--radius-full); background: rgb(255 255 255 / 0.06); overflow: hidden; }
	.t-bar span { display: block; height: 100%; border-radius: var(--radius-full); }
	.t-val { font-variant-numeric: tabular-nums; color: var(--color-text-emphasis); font-weight: 500; }

	/* sub-scalars (vitality / growth breakdowns) */
	.subscalars { display: flex; flex-direction: column; gap: 0.8rem; margin-bottom: 0.8rem; }
	.ss { display: flex; flex-direction: column; gap: 0.3rem; }
	.ss-bar { height: 7px; border-radius: var(--radius-full); background: rgb(255 255 255 / 0.06); overflow: hidden; }
	.ss-bar span { display: block; height: 100%; border-radius: var(--radius-full); transition: width 0.5s var(--ease-out); }
	.ss-meta { display: flex; justify-content: space-between; font-size: 0.76rem; }
	.ss-l { color: var(--color-text-secondary); text-transform: capitalize; }
	.ss-v { color: var(--color-text-emphasis); font-weight: 500; font-variant-numeric: tabular-nums; }

	.row-between { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
	.big-spark { margin: 0.5rem 0 0.8rem; }
	.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7rem; margin-bottom: 1rem; }
	.stat-row.four { grid-template-columns: repeat(4, 1fr); }
	.stat-row.five { grid-template-columns: repeat(5, 1fr); }
	.stat { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.9rem 1rem; text-align: center; }
	.s-v { display: block; font-size: 1.3rem; font-weight: 600; letter-spacing: -0.02em; color: var(--color-text-emphasis); font-variant-numeric: tabular-nums; }
	.s-l { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-tertiary); margin-top: 0.2rem; display: block; }

	/* level chips (movement) */
	.level-chips { display: flex; flex-wrap: wrap; gap: 0.7rem; margin-bottom: 0.8rem; }
	.lchip { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
	.lchip-l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-tertiary); }

	/* segmented toggle (rhythm granularity) */
	.seg-toggle { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-full); overflow: hidden; }
	.seg-toggle button { padding: 0.3rem 0.8rem; font-size: 0.74rem; background: transparent; color: var(--color-text-tertiary); border: none; cursor: pointer; text-transform: capitalize; transition: background var(--duration-fast), color var(--duration-fast); }
	.seg-toggle button.on { background: rgb(var(--color-accent-amethyst-rgb) / 0.18); color: var(--color-text-emphasis); }
	.seg-toggle.az button.on { background: rgb(var(--color-accent-rgb) / 0.18); }
	.seg-toggle.rose button.on { background: rgb(var(--color-accent-rose-rgb) / 0.18); }
	.m-select { font-size: 0.74rem; background: var(--color-surface); color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.3rem 0.5rem; max-width: 16rem; cursor: pointer; }

	/* harmonic metric grid */
	.metric-grid { display: flex; flex-direction: column; gap: 3px; margin-bottom: 1rem; overflow-x: auto; }
	.mg-row { display: grid; grid-template-columns: 7.5rem repeat(5, 1fr); gap: 3px; align-items: center; min-width: 26rem; }
	.mg-head .mg-band { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); text-align: center; }
	.mg-feat { font-size: 0.72rem; color: var(--color-text-secondary); white-space: nowrap; }
	.mg-cell { font-size: 0.72rem; font-variant-numeric: tabular-nums; text-align: center; padding: 0.3rem 0; border-radius: var(--radius-sm); color: var(--color-text-emphasis); background: rgb(var(--color-accent-amethyst-rgb) / calc(var(--m, 0) * 0.5 + 0.04)); }
	.mg-cell.null { color: var(--color-text-tertiary); background: rgb(255 255 255 / 0.02); }
	.h0 { display: flex; align-items: baseline; justify-content: space-between; padding: 0.8rem 0 0; border-top: 1px solid var(--color-border); }
	.h0 .s-v { display: inline; font-size: 1.05rem; }

	/* co-firing list */
	.cofire-list { display: flex; flex-direction: column; gap: 0.4rem; }
	.cofire-list li { display: grid; grid-template-columns: 2.4rem 2.4rem repeat(4, 1fr); gap: 0.5rem; align-items: center; font-size: 0.76rem; }
	.cf-head { color: var(--color-text-tertiary); }
	.cf-sl { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; text-align: center; }
	.cf-pair { font-weight: 600; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
	.cf-pair.b { color: var(--color-text-tertiary); }
	.cf-cell { display: flex; align-items: center; gap: 0.35rem; justify-content: center; font-variant-numeric: tabular-nums; color: var(--color-text-emphasis); }
	.cf-cell i { width: 8px; height: 8px; border-radius: 50%; flex: none; }

	.cta-panel { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; }
	.cta { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.7rem 1.3rem; border-radius: var(--radius-full); border: 1px solid rgb(var(--color-accent-aurum-rgb) / 0.4); background: rgb(var(--color-accent-aurum-rgb) / 0.12); color: var(--color-text-emphasis); font-size: 0.88rem; font-weight: 500; cursor: pointer; white-space: nowrap; transition: transform var(--duration-fast), border-color var(--duration-fast); }
	.cta:hover { transform: translateY(-1px); border-color: rgb(var(--color-accent-aurum-rgb) / 0.7); }
	.cta svg { width: 1rem; height: 1rem; }

	.mile-list { display: flex; flex-direction: column; gap: 0; }
	.mile-list li { display: grid; grid-template-columns: 14px 1fr; gap: 0.9rem; padding: 0.7rem 0; position: relative; }
	.mile-list li:not(:last-child)::before { content: ''; position: absolute; left: 6px; top: 1.4rem; bottom: -0.2rem; width: 1px; background: var(--color-border); }
	.m-node { width: 11px; height: 11px; border-radius: 50%; margin-top: 0.3rem; box-shadow: 0 0 10px currentColor; z-index: 1; }
	.m-head { font-size: 0.95rem; font-weight: 500; color: var(--color-text-primary); }

	.empty-lg { text-align: center; padding: 2rem 1rem; }
	.empty-lg svg { width: 3rem; height: 3rem; color: var(--color-accent-amethyst); opacity: 0.5; margin-bottom: 1rem; }
	.empty-lg h3 { font-size: 1.1rem; margin-bottom: 0.6rem; }
	.empty-lg p { max-width: 30rem; margin: 0 auto; }

	@keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6vmax,4vmax) scale(1.08); } }
	@keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-5vmax,-3vmax) scale(1.1); } }
	@keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-4vmax,5vmax) scale(0.92); } }
	@keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 0.8; } }

	@media (max-width: 760px) {
		.grid { grid-template-columns: 1fr; }
		.detail-grid { grid-template-columns: 1fr; }
		.stat-row, .stat-row.four, .stat-row.five { grid-template-columns: repeat(2, 1fr); }
	}
	@media (prefers-reduced-motion: reduce) { .blob { animation: none; } .card.skeleton { animation: none; } }
</style>
