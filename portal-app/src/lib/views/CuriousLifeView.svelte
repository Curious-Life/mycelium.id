<script lang="ts">
	// Curious Life — the human-facing analytics surface. An Apple-Health-style
	// read of the cognitive-measurement plane, built on a PRECISION LADDER:
	//   Layer 1 (glance)  — a plain-language summary band + at-a-glance stats.
	//   Layer 2 (scan)    — metric cards grouped into "how you think / your world /
	//                       turning points", each pairing one number with meaning.
	//   Layer 3 (study)   — detail views with the precise metrics, charts, exact
	//                       names + math, and a "what we measure" glossary with
	//                       honest rigor labels (validated / heuristic / experimental).
	// Honest by construction — sparse / low-confidence signals say so. Surfaces every
	// metric family the plane computes, incl. the previously-hidden Routine
	// (behavioral) and Early signals (criticality) families.
	//
	// Aesthetic: pure-CSS atmosphere (drifting radial gradients), no WebGL / no
	// backdrop-filter (both misbehave in the desktop WKWebView). Hand-rolled SVG charts.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';
	import { apiGet } from '$lib/api';
	import Ring from '$lib/curious/Ring.svelte';
	import Spark from '$lib/curious/Spark.svelte';
	import TimeSeries from '$lib/curious/TimeSeries.svelte';
	import TerritoryRiver from '$lib/curious/TerritoryRiver.svelte';
	import CrossCheckQuadrant from '$lib/curious/CrossCheckQuadrant.svelte';
	import { METRIC_FAMILIES, RIGOR_LABEL, RIGOR_ACCENT, RIGOR_BLURB, type Rigor } from '$lib/curious/metricsCatalog';
	import FigureDrawer from '$lib/curious/FigureDrawer.svelte';

	type Any = Record<string, any>;

	let loading = $state(true);
	let active = $state<string | null>(null); // null = overview, else pillar key

	let vitality = $state<Any | null>(null);
	let audit = $state<Any | null>(null);
	let movement = $state<Any | null>(null); // trajectory/summary.summary
	let current = $state<Any | null>(null); // trajectory/current.current (level=all → {realm,theme,territory})
	let moveFresh = $state<Any | null>(null); // P2: fisher_trajectory freshness verdict ({verdict, age_ms, budget_ms})
	let movementCrossCheck = $state<Any | null>(null); // P3b: 2x2 honesty quadrant (Fisher × basis-free embedding)
	let xcHedge = $state<string | null>(null); // P3b: embedding_trajectory freshness hedge (top-level of the response)
	let milestones = $state<Any[]>([]);
	let trajectory = $state<Any[]>([]); // weekly_step rows
	let rhythmByGran = $state<Record<string, Any | null>>({ alpha: null, theta: null, delta: null });
	let complexity = $state<Any | null>(null);
	let cofire = $state<Any | null>(null);
	let frequency = $state<Any | null>(null);
	let freshness = $state<Any | null>(null);
	let behavioral = $state<Any | null>(null);
	let criticality = $state<Any[]>([]); // per-level latest rows
	let events = $state<Any[]>([]);
	let river = $state<Any | null>(null); // territory-river: anchor bands + active count over time
	let resonance = $state<Any | null>(null); // Kindred minds: server-computed figure resonance ({top, byTerritory, constellationAffinity})
	// Figure detail drawer — opened by clicking any kindred figure.
	let figOpen = $state(false);
	let figName = $state('');
	let figAff = $state<number | null>(null);
	let figAccent = $state('amethyst');
	const anchorCountVals = $derived((river?.anchor_count ?? []).map((p: Any) => (p.count == null ? null : Number(p.count))));
	const anchorCountLabels = $derived((river?.anchor_count ?? []).map((p: Any) => (p.end ?? '').slice(0, 10)));
	const hasAnchorCount = $derived(anchorCountVals.some((v: number | null) => v != null));

	let gran = $state<'alpha' | 'theta' | 'delta'>('theta');

	// Temporal series
	let freqSeries = $state<Any[]>([]);
	let rhythmSeries = $state<Any | null>(null); // { metric, series }
	let rhythmMetric = $state('total_spectral_energy_gamma');
	let freqMetric = $state('coherence');
	// Cumulative columns (fisher_trajectory_length / fisher_displacement) are RETIRED from the
	// chart toggle — plotted over time they grow/saturate with history depth, not with this
	// week's change, and read as "weird numbers". They remain as internal/archival columns.
	let moveMetric = $state<'fisher_velocity' | 'activation_entropy'>('fisher_velocity');

	const apiBase = '/portal';
	async function loadRhythmSeries() {
		const r = await apiGet<Any>(`${apiBase}/metrics/series?metric=${rhythmMetric}&granularity=${gran}&limit=120`).catch(() => null);
		rhythmSeries = r ?? null;
	}

	const fmt = (v: any, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
	const pct = (v: any) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Math.round(Number(v) * 100)}%`);
	const cap = (s: any) => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : '—');

	// Plain-language relabelling — kill the bands/granularity jargon at the surface.
	// Bands are temporal aggregation scales, NOT EEG frequencies. Granularities are
	// window sizes. Exact names live only in the Layer-3 "show detail" expanders.
	const BAND_LABEL: Record<string, string> = { gamma: 'per-message', beta: 'hourly', alpha: 'daily', theta: 'weekly', delta: 'monthly' };
	const GRAN_LABEL: Record<string, string> = { alpha: 'daily', theta: 'weekly', delta: 'monthly' };
	const hourPart = (h: number | null) => {
		if (h == null || Number.isNaN(h)) return null;
		const x = ((Math.round(h) % 24) + 24) % 24;
		if (x >= 5 && x < 12) return 'Morning';
		if (x >= 12 && x < 17) return 'Afternoon';
		if (x >= 17 && x < 22) return 'Evening';
		return 'Night';
	};

	onMount(async () => {
		navigationState.setPrimaryView('curious-life');
		const g = (p: string) => apiGet<Any>(p).catch(() => null);
		const [v, a, m, c, ms, tr, rA, rT, rD, cx, cf, fq, fr, bh, cr, ev] = await Promise.all([
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
			g('/portal/behavioral'),
			g('/portal/criticality?window_type=weekly_step'),
			g('/portal/events?limit=12'),
		]);
		vitality = v;
		audit = a?.audit ?? null;
		movement = m?.summary ?? null;
		current = c?.current ?? null;
		moveFresh = m?.freshness ?? c?.freshness ?? null;
		// P3b: non-blocking basis-free cross-check (realm-F live altitude).
		g('/portal/trajectory/cross-check?level=realm').then((xc) => { movementCrossCheck = xc?.cross_check ?? null; xcHedge = xc?.freshness_hedge ?? null; });
		milestones = ms?.milestones ?? [];
		trajectory = tr?.trajectory ?? [];
		rhythmByGran = { alpha: rA, theta: rT, delta: rD };
		complexity = cx ?? null;
		cofire = cf ?? null;
		frequency = fq?.snapshot ?? null;
		freshness = fr ?? null;
		behavioral = bh?.behavioral ?? null;
		criticality = cr?.levels ?? [];
		events = ev?.events ?? [];
		loading = false;
		// Temporal series (non-blocking; charts fill in once back). The frequency
		// series + rhythm series have no inter-dependency, so run them concurrently
		// rather than as a serial waterfall (loadRhythmSeries uses static gran/metric).
		g('/portal/territory-river').then((rv) => { river = rv ?? null; });
		g('/portal/curious/resonance').then((rr) => { resonance = rr?.available ? rr : null; });
		await Promise.all([
			g(`/portal/frequency/series?granularity=${frequency?.granularity ?? 'day'}`)
				.then((fs) => { freqSeries = fs?.series ?? []; }),
			loadRhythmSeries(),
		]);
	});

	// Build a labelled series from the weekly_step trajectory rows.
	const moveSeries = $derived(trajectory.map((r) => {
		const v = r[moveMetric];
		return v == null || Number.isNaN(Number(v)) ? null : Number(v);
	}));
	const moveLabels = $derived(trajectory.map((r) => (r.window_end ?? '').slice(0, 10)));
	const moveMetricOpts = [
		{ key: 'fisher_velocity', label: 'velocity' },
		{ key: 'activation_entropy', label: 'activation entropy' },
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
	const activeTerritories = $derived(
		curRealm?.active_territory_count ?? movement?.active_territory_count ?? null,
	);

	// ── Honest relative context — only when a genuine comparison is available ──
	// Movement: latest velocity vs the median of the weekly series (needs ≥6 windows).
	const moveRelative = $derived.by(() => {
		const xs = velocities.filter((x) => x > 0);
		if (xs.length < 6) return null;
		const sorted = [...xs].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)];
		const latest = velocities[velocities.length - 1];
		if (!median || latest == null) return null;
		if (latest > median * 1.2) return { tone: 'up', text: 'moving more than usual' };
		if (latest < median * 0.8) return { tone: 'down', text: 'quieter than usual' };
		return { tone: 'flat', text: 'a typical pace' };
	});

	// ── Honest movement headline — baseline-relative z ("unusual for ME"), with the
	// pooled-null avg_velocity_z as the CONFIDENCE GATE ("above measurement noise"). The
	// baseline-z fails closed server-side (degenerate near-constant history → low_confidence),
	// so a flat writer never gets a fabricated σ; here that surfaces as "building your baseline".
	const moveBaseline = $derived.by(() => {
		const z = movement?.velocity_baseline_z;
		const low = movement?.velocity_baseline_low_confidence ?? true;
		if (low || z == null || Number.isNaN(Number(z))) return { sigma: null, tone: 'flat', text: 'building your baseline' };
		const mag = Math.abs(Number(z));
		if (mag < 1) return { sigma: Number(z), tone: 'flat', text: 'a typical week for you' };
		if (Number(z) > 0) return { sigma: Number(z), tone: 'up', text: `${mag.toFixed(1)}σ — a big week for you` };
		return { sigma: Number(z), tone: 'down', text: `${mag.toFixed(1)}σ quieter than your normal` };
	});
	// Confidence gate: is the latest movement even above measurement noise (|pooled-z| ≥ 2)?
	const moveAboveNoise = $derived(
		movement?.avg_velocity_z != null ? Math.abs(Number(movement.avg_velocity_z)) >= 2 : null,
	);
	const entBaselineLabel = $derived(
		movement?.entropy_baseline_low_confidence || movement?.entropy_baseline_z == null
			? '—'
			: `${Number(movement.entropy_baseline_z).toFixed(1)}σ`,
	);
	// P2 — family freshness hedge: a stale movement family must not read as authoritative.
	const moveStale = $derived(moveFresh?.verdict && moveFresh.verdict !== 'fresh' ? moveFresh.verdict : null);
	const moveStaleText = $derived.by(() => {
		if (!moveStale) return null;
		if (moveStale === 'missing' || moveStale === 'empty') return 'Movement hasn’t been measured yet — treat these as provisional.';
		const h = moveFresh?.age_ms != null ? Math.round(moveFresh.age_ms / 3_600_000) : null;
		const age = h == null ? 'a while' : h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
		return `These numbers may lag — the pipeline last measured movement ${age} ago.`;
	});
	// P3b: visual accent per quadrant state (calm vs attention vs muted).
	const xcAccent = $derived.by(() => {
		switch (movementCrossCheck?.state) {
			case 'corroborated': return accentVar.jade;
			case 'hidden_drift': return accentVar.amethyst;
			case 'basis_suspect': return accentVar.azure;
			default: return 'var(--hairline, #8883)';
		}
	});
	// P3b honesty gate: the cross-check qualifies the HEADLINE σ only when its aligned week
	// is the current one (is_current). The endpoint computes is_current over the SAME Fisher
	// series the headline uses → is_current ⇒ fisher_velocity_z === velocity_baseline_z. When
	// the embedding stage lags (is_current false) we must NOT vouch for the on-screen number.
	const xcCurrent = $derived(Boolean(movementCrossCheck?.is_current));
	const xcActionable = $derived(['corroborated', 'basis_suspect', 'hidden_drift'].includes(movementCrossCheck?.state));
	const headlineTrust = $derived.by(() => {
		if (!movementCrossCheck || !xcCurrent || !xcActionable) return null;
		switch (movementCrossCheck.state) {
			case 'corroborated': return { text: 'corroborated', tone: 'jade', mark: '✓' };
			case 'basis_suspect': return { text: 'map effect?', tone: 'azure', mark: '⚠' };
			case 'hidden_drift': return { text: 'drift your map missed', tone: 'amethyst', mark: '•' };
			default: return null;
		}
	});
	// Honest "as of {date}" when the cross-check trails the displayed week.
	const xcLag = $derived(
		movementCrossCheck && !xcCurrent && movementCrossCheck.state !== 'insufficient'
			? (movementCrossCheck.window_start || '').slice(0, 10)
			: null,
	);
	const xcMovers = $derived(
		movementCrossCheck?.state === 'basis_suspect' && Array.isArray(movementCrossCheck?.top_movers)
			? movementCrossCheck.top_movers.filter(Boolean)
			: [],
	);

	// ── Narrative summary (Layer 1) ───────────────────────────────────────────
	const summary = $derived.by(() => {
		if (loading) return '';
		const phase = curRealm?.phase ?? movement?.phase ?? null;
		const parts: string[] = [];
		if (phase) {
			let s = `Your thinking is in a ${phase} phase`;
			if (moveRelative && moveRelative.tone !== 'flat') s += ` — ${moveRelative.text}`;
			parts.push(s + '.');
		}
		if (activeTerritories != null) {
			parts.push(`Right now ${activeTerritories} territor${activeTerritories === 1 ? 'y is' : 'ies are'} active.`);
		} else if (vSummary?.territory_count) {
			parts.push(`Drawn from your territories across every conversation.`);
		}
		if (milestones.length) {
			const d = (milestones[0].window_start ?? '').slice(0, 10);
			parts.push(`Your latest turning point${d ? ` (${d})` : ''}: ${milestones[0].headline}`);
		}
		if (!parts.length) return 'Your measurements are still gathering. A few more active days and this fills in.';
		return parts.join(' ');
	});

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
	// The 8 feature rows × 5 bands grid (the 41 harmonic columns made legible).
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
	// Primary = embedding-novelty (Tier-1; robust at low n). Show only territories with
	// a CONFIDENT novelty value; LZ is the cross-check (greyed when its own gate fires).
	const cxTerr = $derived(
		[...(complexity?.territories ?? [])]
			.filter((t) => t.embedding_novelty != null && !t.embedding_novelty_low_conf)
			.sort((a, b) => (b.embedding_novelty ?? 0) - (a.embedding_novelty ?? 0)),
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

	// ── Routine (behavioral) ──────────────────────────────────────────────────
	const diurnalHist = $derived<(number | null)[]>(
		Array.isArray(behavioral?.diurnal_hist) ? behavioral!.diurnal_hist : [],
	);
	const diurnalMax = $derived(Math.max(1, ...diurnalHist.map((v) => Number(v) || 0)));
	const peakPart = $derived(hourPart(behavioral?.diurnal_peak_hour ?? null));
	const hasRoutine = $derived(behavioral != null && (behavioral.diurnal_peak_hour != null || behavioral.session_count != null));

	// ── Early signals (criticality) ──────────────────────────────────────────
	const critStirring = $derived(
		criticality.some((c) => (Number(c.early_warning_joint) || 0) > 0 || (Number(c.flickering_score) || 0) > 0.5),
	);
	const hasCrit = $derived(criticality.length > 0);

	// ── Freshness ("what's measured") ────────────────────────────────────────
	const freshColor: Record<string, string> = {
		fresh: 'var(--color-accent-jade)',
		stale: 'var(--color-accent-coral)',
		empty: 'var(--color-text-tertiary)',
		missing: 'var(--color-text-tertiary)',
	};
	const freshByTable = $derived.by(() => {
		const map: Record<string, Any> = {};
		for (const f of (freshness?.metrics ?? [])) map[f.table] = f;
		return map;
	});

	function openMindscape() {
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}
	// Inner States lives inside Curious Life (no standalone sidebar item); its card
	// deep-links to the full /inner-states teaching+validation surface.
	function openInnerStates() {
		navigationState.setPrimaryView('inner-states');
		goto('/inner-states');
	}

	// ── Pillars + groups ──────────────────────────────────────────────────────
	const pillars = [
		{ key: 'movement', label: 'Movement', accent: 'azure', tagline: 'How your mind is moving' },
		{ key: 'rhythm', label: 'Rhythm', accent: 'amethyst', tagline: 'The cadence of your thinking' },
		{ key: 'complexity', label: 'Complexity', accent: 'teal', tagline: 'How varied your patterns are' },
		{ key: 'resonance', label: 'Kindred minds', accent: 'amethyst', tagline: 'Figures your mind is reminiscent of' },
		{ key: 'inner-states', label: 'Inner States', accent: 'rose', tagline: 'The language of your moods and modes' },
		{ key: 'growth', label: 'Growth', accent: 'rose', tagline: 'How your thinking consolidates' },
		{ key: 'vitality', label: 'Vitality', accent: 'jade', tagline: 'How alive your territories are' },
		{ key: 'mindscape', label: 'Mindscape', accent: 'aurum', tagline: 'The shape of your inner world' },
		{ key: 'milestones', label: 'Milestones', accent: 'coral', tagline: 'Moments your mind turned' },
		{ key: 'routine', label: 'Routine', accent: 'teal', tagline: 'When you write, and how regularly' },
		{ key: 'early-signals', label: 'Early signals', accent: 'aurum', tagline: 'Faint hints a shift may be near' },
	];
	const GROUPS = [
		{ key: 'think', label: 'How you think' },
		{ key: 'world', label: 'Your world' },
		{ key: 'turning', label: 'Turning points' },
	];
	const groupOf: Record<string, string> = {
		movement: 'think', rhythm: 'think', complexity: 'think', resonance: 'think', 'inner-states': 'think', growth: 'think',
		vitality: 'world', mindscape: 'world',
		milestones: 'turning', routine: 'turning', 'early-signals': 'turning',
	};
	const familyById = $derived.by(() => {
		const map: Record<string, Any> = {};
		for (const f of METRIC_FAMILIES) map[f.id] = f;
		return map;
	});
	const pillarRigor = (key: string): Rigor | null => (familyById[key]?.rigor ?? null) as Rigor | null;

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
	// Resonance: color each figure by its DOMAIN (4 families → 4 accents).
	const CON_ACCENT: Record<string, string> = {
		'The Logician': 'azure', 'The Watchmaker': 'azure', 'The Strategist': 'azure', 'The Cartographer': 'azure',
		'The Mystic': 'amethyst', 'The Explorer': 'amethyst', 'The Rebel': 'amethyst', 'The Alchemist': 'amethyst',
		'The Guardian': 'aurum', 'The Architect': 'aurum', 'The Commander': 'aurum', 'The Healer': 'aurum',
		'The Sage': 'jade', 'The Nurturer': 'jade', 'The Storyteller': 'jade', 'The Bridge': 'jade',
	};
	const conAccent = (c: string | null | undefined) => CON_ACCENT[c ?? ''] ?? 'amethyst';
	const openFigure = (n: string, affinity: number | null | undefined, constellation: string | null | undefined) => {
		if (!n) return; figName = n; figAff = affinity ?? null; figAccent = conAccent(constellation); figOpen = true;
	};

	// Glossary state
	let glossaryOpen = $state(false);
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
				<h1 class="title">Who you're becoming</h1>
				<p class="hero-sub">The shape of a curious mind — how you think, what moves you, and the minds you're kin to.</p>
			</header>

			{#if loading}
				<div class="summary-band skeleton-band"></div>
				<div class="grid">
					{#each pillars as _}<div class="card skeleton"></div>{/each}
				</div>
			{:else}
				<!-- LAYER 1 — narrative summary + glance -->
				<div class="summary-band">
					<p class="summary-text">{summary}</p>
				</div>
				<div class="glance">
					<div class="glance-stat">
						<span class="g-l">Phase</span>
						<span class="g-v">{cap(curRealm?.phase ?? movement?.phase)}</span>
					</div>
					<div class="glance-stat">
						<span class="g-l">Vitality</span>
						<span class="g-v">{fmt(vSummary?.avg_vitality, 2)}{#if moveRelative && moveRelative.tone === 'up'}<span class="g-rel up"> ↑</span>{/if}</span>
					</div>
					<div class="glance-stat">
						<span class="g-l">Active territories</span>
						<span class="g-v">{activeTerritories ?? '—'}</span>
					</div>
					<div class="glance-stat">
						<span class="g-l">Milestones</span>
						<span class="g-v">{milestones.length}</span>
					</div>
				</div>

				<!-- THE RIVER — how your topics change over time (the reliable spine) -->
				<section class="river-section">
					<div class="river-head">
						<h2 class="group-head">How your topics move over time</h2>
						<span class="river-note">territory level · drawn from activation counts, not Fisher</span>
					</div>
					<TerritoryRiver data={river} />
					{#if hasAnchorCount}
						<div class="anchor-count">
							<div class="ac-head"><span class="ac-title">Anchor topics over time</span><span class="river-note">your stable core — count of persistent topics</span></div>
							<TimeSeries points={anchorCountVals} labels={anchorCountLabels} color={accentVar.aurum} height={120} format={(v) => String(Math.round(v))} />
							<p class="muted sm">How many <b>anchor</b> topics you're holding at once — a topic counts as an anchor once it's stayed active across most of the last ~6 months.</p>
						</div>
					{/if}
				</section>

				<!-- LAYER 2 — grouped pillar cards -->
				{#each GROUPS as grp}
					<h2 class="group-head">{grp.label}</h2>
					<div class="grid">
						{#each pillars.filter((p) => groupOf[p.key] === grp.key) as p (p.key)}
							{#if p.key === 'movement'}
								<button class="card" style="--rgb:{accentRgb.azure};" onclick={() => (active = 'movement')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.azure}"></span><span class="ctitle">Movement</span>{#if moveLowConf}<span class="lc">early signal</span>{/if}<span class="chev">›</span></div>
									<div class="card-body">
										<div class="phase-badge" style="--rgb:{accentRgb.azure}">{cap(curRealm?.phase ?? movement?.phase)}</div>
										<div class="spark-row"><Spark points={velocities} color={accentVar.azure} width={150} height={42} /></div>
										<span class="rel-chip {moveBaseline.tone}">{moveBaseline.text}</span>
									</div>
									<p class="tagline">How far and fast your focus travels</p>
								</button>

							{:else if p.key === 'rhythm'}
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
											<p class="muted">Pattern strength, per-message → monthly</p>
										{:else}
											<div class="empty-rhythm">
												<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 12h3l2-6 4 14 3-10 2 4h4" /></svg>
												<p class="muted">Your rhythm sharpens as you keep capturing. A few more active days and the bands light up.</p>
											</div>
										{/if}
									</div>
									<p class="tagline">The cadence of your thinking</p>
								</button>

							{:else if p.key === 'complexity'}
								<button class="card" style="--rgb:{accentRgb.teal};" onclick={() => (active = 'complexity')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.teal}"></span><span class="ctitle">Complexity</span><span class="chev">›</span></div>
									<div class="card-body two">
										<Ring value={cxGlobal?.lz_complexity ?? 0} max={1} color={accentVar.teal}
											center={fmt(cxGlobal?.lz_complexity, 2)} sub="LZ" size={84} />
										<div class="col">
											<div class="big">{cxGlobal?.alphabet_size ?? '—'} <span class="unit">territories in play</span></div>
											<div class="ministats wrap">
												<span><b>{cxGlobal?.sequence_length ?? '—'}</b> steps</span>
											</div>
										</div>
									</div>
									<p class="tagline">How varied your thinking sequences are</p>
								</button>

							{:else if p.key === 'resonance'}
								<button class="card" style="--rgb:{accentRgb.amethyst};" onclick={() => (active = 'resonance')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.amethyst}"></span><span class="ctitle">Kindred minds</span>{#if !resonance}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
									<div class="card-body">
										{#if resonance?.top?.[0]}<div class="big">{resonance.top[0].name} <span class="unit">{resonance.top[0].affinity}%</span></div>{:else}<p class="muted sm">Forms once your topics are mapped.</p>{/if}
									</div>
									<p class="tagline">Figures your mind is reminiscent of</p>
								</button>

							{:else if p.key === 'inner-states'}
								<button class="card" style="--rgb:{accentRgb.rose};" onclick={openInnerStates}>
									<div class="card-head"><span class="dot" style="background:{accentVar.rose}"></span><span class="ctitle">Inner States</span><span class="chev">›</span></div>
									<div class="card-body">
										<p class="muted sm">A read on the language of your moods and modes — leaning, never a verdict. Teach it, then validate.</p>
									</div>
									<p class="tagline">The language of your moods and modes</p>
								</button>

							{:else if p.key === 'growth'}
								<button class="card" style="--rgb:{accentRgb.rose};" onclick={() => (active = 'growth')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.rose}"></span><span class="ctitle">Growth</span>{#if !freq}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
									<div class="card-body">
										{#if freq}
											<div class="ministats wrap">
												<span><b>{pct(freq.coherence)}</b> coherence</span>
												<span><b>{pct(freq.entropy)}</b> spread</span>
												<span><b>{pct(freq.learning_rate)}</b> learning</span>
											</div>
											<p class="muted">Window of {freq.message_count ?? '—'} messages</p>
										{:else}
											<p class="muted">Growth metrics resolve once a few windows of activity accrue.</p>
										{/if}
									</div>
									<p class="tagline">How your thinking consolidates and changes</p>
								</button>

							{:else if p.key === 'vitality'}
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

							{:else if p.key === 'mindscape'}
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

							{:else if p.key === 'milestones'}
								<button class="card" style="--rgb:{accentRgb.coral};" onclick={() => (active = 'milestones')}>
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

							{:else if p.key === 'routine'}
								<button class="card" style="--rgb:{accentRgb.teal};" onclick={() => (active = 'routine')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.teal}"></span><span class="ctitle">Routine</span><span class="badge-new">new</span>{#if !hasRoutine}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
									<div class="card-body">
										{#if hasRoutine}
											<div class="big">{peakPart ?? '—'} <span class="unit">peak</span></div>
											<div class="ministats wrap">
												<span><b>{behavioral?.session_count != null ? Math.round(Number(behavioral.session_count)) : '—'}</b> sessions</span>
												<span><b>{pct(behavioral?.diurnal_concentration)}</b> concentration</span>
											</div>
										{:else}
											<p class="muted">Your daily rhythm resolves once you've written across a range of hours.</p>
										{/if}
									</div>
									<p class="tagline">When you write, and how regularly</p>
								</button>

							{:else if p.key === 'early-signals'}
								<button class="card" style="--rgb:{accentRgb.aurum};" onclick={() => (active = 'early-signals')}>
									<div class="card-head"><span class="dot" style="background:{accentVar.aurum}"></span><span class="ctitle">Early signals</span><span class="lc">advisory</span><span class="chev">›</span></div>
									<div class="card-body">
										{#if hasCrit}
											<div class="big">{critStirring ? 'Stirring' : 'Quiet'}</div>
											<p class="muted">Faint hints only — low-sensitivity by nature, never a prediction.</p>
										{:else}
											<p class="muted">Early-warning signals need a longer stretch of weekly movement to read.</p>
										{/if}
									</div>
									<p class="tagline">Faint hints a shift may be near</p>
								</button>
							{/if}
						{/each}
					</div>
				{/each}

				<!-- LAYER 3 entry — What we measure (glossary) -->
				<div class="glossary">
					<button class="glossary-toggle" onclick={() => (glossaryOpen = !glossaryOpen)} aria-expanded={glossaryOpen}>
						<span class="fresh-title">What we measure</span>
						<span class="g-sub">Every signal, in plain words, with an honest rigor label</span>
						<span class="chev" style="transform:rotate({glossaryOpen ? 90 : 0}deg)">›</span>
					</button>
					{#if glossaryOpen}
						<div class="glossary-body">
							{#each METRIC_FAMILIES as fam}
								{@const fr = fam.freshTable ? freshByTable[fam.freshTable] : null}
								<div class="gloss-fam">
									<div class="gloss-fam-head">
										<span class="gf-name">{fam.name}</span>
										{#if fr}<i class="gf-fresh" style="background:{freshColor[fr.verdict] ?? 'var(--color-text-tertiary)'}" title="{fr.verdict}"></i>{/if}
										{#if !fam.surfaced}<span class="gf-hidden">not shown</span>{/if}
										<span class="gf-rigor" style="--rg:{RIGOR_ACCENT[fam.rigor]}" title={RIGOR_BLURB[fam.rigor]}>{RIGOR_LABEL[fam.rigor]}</span>
									</div>
									<p class="gloss-tag">{fam.tagline}</p>
									<ul class="gloss-metrics">
										{#each fam.metrics as mt}
											<li><span class="gm-name">{mt.name}</span><span class="gm-mean">{mt.meaning}</span></li>
										{/each}
									</ul>
								</div>
							{/each}
							<p class="muted sm gloss-foot">Rigor: <b>validated math</b> = a canonical computation · <b>heuristic</b> = a sensible signal, not a verdict · <b>experimental</b> = suggestive only, never a diagnosis or prediction. Bands (per-message → monthly) are time-scales, not EEG frequencies.</p>
						</div>
					{/if}
				</div>

				<p class="footnote">Computed locally from your own conversations, encrypted at rest. Signals marked “early” / “gathering” / “advisory” are suggestive until more data accrues.</p>
			{/if}
		{:else}
			<!-- ── DETAIL ───────────────────────────────────────────────────── -->
			{@const p = pillars.find((x) => x.key === active)!}
			{@const rg = pillarRigor(active)}
			<button class="back" onclick={() => (active = null)}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
				Overview
			</button>
			<header class="detail-head" style="--rgb:{accentRgb[p.accent]}">
				<span class="dot lg" style="background:{accentVar[p.accent]}"></span>
				<div class="dh-text"><h1>{p.label}</h1><p>{p.tagline}</p></div>
				{#if rg}<span class="rigor-badge" style="--rg:{RIGOR_ACCENT[rg]}" title={RIGOR_BLURB[rg]}>{RIGOR_LABEL[rg]}</span>{/if}
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
						<p class="lead">How far and fast your focus is travelling between ideas, read on the Fisher-Rao geometry of your territory distribution.</p>
						<div class="row-between">
							<div><div class="phase-badge lg" style="--rgb:{accentRgb.azure}">{cap(curRealm?.phase)}</div>{#if curRealm?.phase_recent && curRealm.phase_recent !== curRealm.phase}<span class="muted sm">recently {curRealm.phase_recent}</span>{/if}</div>
							{#if moveLowConf}<span class="lc">early signal · advisory</span>{:else if moveStale}<span class="lc">stale · advisory</span>{/if}
						</div>
						{#if moveStaleText}<p class="muted sm">{moveStaleText}</p>{/if}
						<div class="row-between" style="margin:0.4rem 0 0.2rem">
							<span class="muted sm">Over {trajectory.length} weekly windows</span>
							<div class="seg-toggle az">
								{#each moveMetricOpts as o}
									<button class:on={moveMetric === o.key} onclick={() => (moveMetric = o.key as any)}>{o.label}</button>
								{/each}
							</div>
						</div>
						<div class="big-spark"><TimeSeries points={moveSeries} labels={moveLabels} color={accentVar.azure} height={150} /></div>
						<p class="muted sm">How your {moveMetricOpts.find((o) => o.key === moveMetric)?.label} changed week by week. Flat-zero stretches are weeks with little activity.</p>
					</div>
					<div class="stat-row">
						<div class="stat"><span class="s-v">{moveBaseline.sigma != null ? `${moveBaseline.sigma.toFixed(1)}σ` : '—'}</span><span class="s-l">vs your normal</span>{#if headlineTrust}<span class="trust" style="background:rgb({accentRgb[headlineTrust.tone]} / 0.16); color:{accentVar[headlineTrust.tone]}">{headlineTrust.mark} {headlineTrust.text}</span>{/if}</div>
						<div class="stat"><span class="s-v">{entBaselineLabel}</span><span class="s-l">attention spread (σ)</span></div>
						<div class="stat"><span class="s-v">{movement?.R_recent != null ? fmt(movement?.R_recent, 2) : '—'}</span><span class="s-l">recent reach (R)</span></div>
						<div class="stat"><span class="s-v">{fmt(movement?.exploration_ratio, 2)}</span><span class="s-l">exploration ratio</span></div>
					</div>
					{#if moveAboveNoise === false}<p class="muted sm">This week's movement is within your measurement noise — read the σ as advisory.</p>{/if}
						{#if movementCrossCheck && movementCrossCheck.state !== 'insufficient'}
							<div class="panel xc-panel">
								<div class="row-between">
									<h3>Cross-check — a second, basis-free witness</h3>
									{#if xcLag}<span class="lc">as of {xcLag}</span>{/if}
								</div>
								{#if xcHedge}<p class="muted sm">{xcHedge}</p>{/if}
								<div class="xc-grid">
									<CrossCheckQuadrant
										f={movementCrossCheck.fisher_velocity_z}
										e={movementCrossCheck.centroid_drift_z}
										state={movementCrossCheck.state}
										accent={xcAccent} />
									<div class="xc-copy">
										<p style="border-left:2px solid {xcAccent}; padding-left:0.6rem"><b>{movementCrossCheck.label}.</b> <span class="muted">{movementCrossCheck.detail}</span></p>
										{#if xcLag}<p class="muted sm">Compared on the most recent week confident in both signals — your semantic-center reading is still catching up to the latest week, so this doesn't yet qualify the σ above.</p>{/if}
										{#if xcMovers.length}<p class="muted sm">Fisher pins this on {xcMovers.join(', ')} — but your semantic center held, so it may be a topic-map effect.</p>{/if}
									</div>
								</div>
							</div>
						{/if}
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
					<p class="lead">The cadence of your thinking across timescales. Each value summarises a signal built from how consecutive messages move.</p>
					<div class="row-between">
						<h3>Harmonic signature</h3>
						<div class="seg-toggle">
							{#each ['alpha', 'theta', 'delta'] as gk}
								<button class:on={gran === gk} onclick={() => { gran = gk as any; loadRhythmSeries(); }}>{GRAN_LABEL[gk]}</button>
							{/each}
						</div>
					</div>
					{#if Object.values(rhythmValues).some((v) => v != null && Number(v) !== 0)}
						<div class="band-key">
							{#each BANDS as band}<span><i style="background:{accentVar.amethyst}"></i>{BAND_LABEL[band]}</span>{/each}
						</div>
						<details class="jargon">
							<summary>Show the full metric grid</summary>
							<div class="metric-grid">
								<div class="mg-row mg-head">
									<span class="mg-feat"></span>
									{#each BANDS as band}<span class="mg-band">{BAND_LABEL[band]}</span>{/each}
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
							<p class="muted sm">Columns are temporal aggregation scales (gamma=per-message … delta=monthly), not EEG frequencies. {rhythm?.low_confidence ? 'Low-confidence: based on a small window.' : ''}</p>
						</details>
					{:else}
						<div class="empty-lg">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 12h4l2.5-7 4.5 16 3-12 2 3h4" /></svg>
							<h3>No {GRAN_LABEL[gran]} window yet</h3>
							<p class="muted">The harmonic signature reads the cadence of your thinking across timescales. This window size needs a denser stretch of activity to resolve — try another, or keep capturing.</p>
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
					{#if rhythmSeriesVals.some((v: unknown) => v != null)}
						<TimeSeries points={rhythmSeriesVals} labels={rhythmSeriesLabels} color={accentVar.amethyst} height={150} />
						<p class="muted sm">{rhythmMetric.replace(/_/g, ' ')} across {rhythmSeriesLabels.length} {GRAN_LABEL[gran]} windows. Gaps are windows it couldn't be computed for.</p>
					{:else}
						<p class="muted sm">No time series for this metric at {GRAN_LABEL[gran]} window size yet — try another metric or window.</p>
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
						<h3>Novelty by territory <span class="muted" style="font-weight:400">· embedding-native (LZ cross-check)</span></h3>
						{#if cxTerr.length}
							<ul class="terr-list">
								{#each cxTerr.slice(0, 16) as t}
									<li>
										<span class="t-phase" style="background:{accentVar.teal}"></span>
										<span class="t-id">{t.level_name ?? `Territory ${t.level_id}`}</span>
										<span class="t-bar"><span style="width:{Math.round((t.embedding_novelty ?? 0) * 100)}%;background:{accentVar.teal}"></span></span>
										<span class="t-val">{fmt(t.embedding_novelty, 2)}</span>
										<span class="t-val muted" title="LZ compressibility cross-check{t.low_confidence ? ' — low confidence (short sequence)' : ''}" style={t.low_confidence ? 'opacity:0.35' : 'opacity:0.6'}>LZ {fmt(t.lz_complexity, 2)}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="muted">Novelty resolves once territories have a few messages to compare.</p>
						{/if}
					</div>
				</div>
				<p class="muted sm">LZ76 complexity measures how compressible the sequence of territories you move through is — higher means more varied, less repetitive thinking. Window {cxGlobal?.window_start ?? ''} → {cxGlobal?.window_end ?? ''}.</p>

			{:else if active === 'resonance'}
				<p class="lead">Figures across history, myth and letters whose concerns and cast of mind are <em>reminiscent of</em> yours — drawn from your own topics, computed on your machine. A mirror, not a verdict.</p>
				{#if resonance?.top?.length}
					<div class="kindred-grid">
						{#each resonance.top as f}
							<button type="button" class="kindred-card" style="--rgb:{accentRgb[conAccent(f.constellation)]}" onclick={() => openFigure(f.name, f.affinity, f.constellation)} title="See how you resonate with {f.name}">
								<Ring value={f.affinity} max={100} size={62} stroke={6} color={accentVar[conAccent(f.constellation)]} center={`${f.affinity}`} sub="match" />
								<div class="kc-body">
									<div class="kc-name">{f.name}</div>
									<div class="kc-con"><span class="dot" style="background:{accentVar[conAccent(f.constellation)]}"></span>{(f.constellation || '').replace('The ', '')}</div>
									{#if f.via?.length}<div class="kc-via">via {f.via.join(' · ')}</div>{/if}
								</div>
								<span class="kc-go" aria-hidden="true">›</span>
							</button>
						{/each}
					</div>
				{:else}
					<p class="muted">Your kindred minds form once a few topics are mapped from your conversations.</p>
				{/if}
				{#if resonance?.constellationAffinity?.length}
					<div class="panel">
						<h3>Archetype affinity</h3>
						{#each resonance.constellationAffinity.slice(0, 8) as a}
							<div class="ss"><div class="ss-bar"><span style="width:{a.affinity}%;background:{accentVar[conAccent(a.constellation)]}"></span></div><div class="ss-meta"><span class="ss-l">{a.constellation.replace('The ', '')}</span><span class="ss-v">{a.affinity}%</span></div></div>
						{/each}
					</div>
				{/if}
				{#if resonance?.realms?.length}
					<div class="panel">
						<h3>Your path of resonance</h3>
						<p class="muted sm">How resonance runs through your mind — realm → theme → topic. Open one to follow it down.</p>
						{#each resonance.realms as r}
							<details class="rpath">
								<summary><span class="rp-name">{r.name ?? `Realm ${r.realm_id}`}</span><span class="rp-figs">{r.figures.slice(0, 2).map((f: Any) => f.name).join(' · ')}</span></summary>
								{#each r.themes as th}
									<details class="rpath rpath-theme">
										<summary><span class="rp-name">{th.name ?? 'theme'}</span><span class="rp-figs">{th.figures.slice(0, 2).map((f: Any) => f.name).join(' · ')}</span></summary>
										<ul class="rp-terr">
											{#each th.territories.slice(0, 14) as t}
												<li><span class="t-id">{t.name ?? `Topic ${t.territory_id}`}</span>{#if t.figure?.name}<button type="button" class="t-fig t-fig-btn" onclick={() => openFigure(t.figure.name, t.figure.affinity, t.figure.constellation)}>{t.figure.name}</button>{:else}<span class="t-fig">—</span>{/if}</li>
											{/each}
										</ul>
									</details>
								{/each}
							</details>
						{/each}
					</div>
				{/if}
				<p class="footnote">From a 2,000-figure atlas across history, myth and letters. Proximity in meaning, not identity — “reminiscent of”, never “you are”. Computed on your machine; nothing leaves it.</p>

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
						<p class="muted sm">Over a window of {freq.message_count ?? '—'} messages across {freq.territory_count ?? '—'} territories. Coherence + spread describe the present; learning-rate + drift describe change.</p>
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
							<p class="muted sm">{freqStats.find((s) => s.key === freqMetric)?.label} across {freqSeries.length} windows — {freqStats.find((s) => s.key === freqMetric)?.hint}.</p>
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

			{:else if active === 'routine'}
				<p class="lead">When you tend to write, and how regular your sessions are — read from message timestamps only (no content). Descriptive, not a clinical circadian measure.</p>
				{#if hasRoutine}
					<div class="stat-row four">
						<div class="stat"><span class="s-v">{peakPart ?? '—'}</span><span class="s-l">peak time</span></div>
						<div class="stat"><span class="s-v">{pct(behavioral?.diurnal_concentration)}</span><span class="s-l">time concentration</span></div>
						<div class="stat"><span class="s-v">{behavioral?.session_count != null ? Math.round(Number(behavioral.session_count)) : '—'}</span><span class="s-l">sessions</span></div>
						<div class="stat"><span class="s-v">{pct(behavioral?.intersession_entropy)}</span><span class="s-l">cadence regularity</span></div>
					</div>
					{#if diurnalHist.length === 24}
						<div class="panel">
							<h3>When you write</h3>
							<div class="diurnal">
								{#each diurnalHist as v, h}
									<div class="dh-col" title="{h}:00 · {v ?? 0}">
										<span class="dh-bar" style="height:{Math.round(((Number(v) || 0) / diurnalMax) * 100)}%;background:{accentVar.teal}"></span>
										{#if h % 6 === 0}<span class="dh-h">{h}</span>{/if}
									</div>
								{/each}
							</div>
							<p class="muted sm">Messages by hour of day (local). Peak around {behavioral?.diurnal_peak_hour != null ? `${Math.round(Number(behavioral.diurnal_peak_hour))}:00` : '—'}.</p>
						</div>
					{/if}
				{:else}
					<div class="panel"><div class="empty-lg"><h3>Your routine is still forming</h3><p class="muted">Diurnal rhythm and session cadence resolve once you've written across a range of hours and days.</p></div></div>
				{/if}

			{:else if active === 'early-signals'}
				<div class="advisory-note">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.5"/></svg>
					<p>These are <b>faint, advisory hints</b> — the kind of "critical slowing" pattern that can precede a shift. Real-world sensitivity is <b>low</b>; treat as a gentle prompt to reflect, never as a prediction or warning.</p>
				</div>
				{#if hasCrit}
					<div class="panel">
						<h3>By level</h3>
						<ul class="crit-list">
							<li class="crit-head"><span>level</span><span>critical slowing</span><span>variance</span><span>flickering</span></li>
							{#each criticality as c}
								<li>
									<span class="crit-lv">{c.level}</span>
									<span class="crit-v" class:warn={(Number(c.ar1_autocorrelation) || 0) > 0.3}>{fmt(c.ar1_autocorrelation, 2)}</span>
									<span class="crit-v">{fmt(c.rolling_variance, 3)}</span>
									<span class="crit-v" class:warn={(Number(c.flickering_score) || 0) > 0.5}>{fmt(c.flickering_score, 2)}</span>
								</li>
							{/each}
						</ul>
						<p class="muted sm">Critical slowing (lag-1 autocorrelation) rising alongside variance is the textbook early-warning pattern. Every reading is low-confidence by design.</p>
					</div>
				{:else}
					<div class="panel"><div class="empty-lg"><h3>Nothing to flag</h3><p class="muted">Early-warning signals need a longer run of weekly movement before they can be read.</p></div></div>
				{/if}
				{#if events.length}
					<div class="panel">
						<h3>Notable events</h3>
						<ul class="mile-list">
							{#each events as ev}
								<li>
									<span class="m-node" style="background:{accentVar.aurum}"></span>
									<div class="m-body">
										<p class="m-head">{ev.headline ?? cap(ev.event_type)}</p>
										<p class="muted sm">{(ev.window_end ?? '').slice(0, 10)}{ev.severity ? ` · ${ev.severity}` : ''}{ev.level ? ` · ${ev.level}` : ''}</p>
									</div>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>

<FigureDrawer open={figOpen} name={figName} accent={figAccent} seedAffinity={figAff} onClose={() => (figOpen = false)} />

<style>
	.curious { position: relative; height: 100%; overflow-y: auto; overflow-x: hidden; background: var(--color-bg); color: var(--color-text-primary); }
	.aurora { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
	.blob { position: absolute; width: 56vmax; height: 56vmax; border-radius: 50%; opacity: 0.4; will-change: transform; }
	.b1 { top: -24vmax; left: -16vmax; background: radial-gradient(circle, rgb(var(--color-accent-rgb) / 0.16), transparent 60%); animation: drift1 38s ease-in-out infinite; }
	.b2 { bottom: -28vmax; right: -18vmax; background: radial-gradient(circle, rgb(var(--color-accent-amethyst-rgb) / 0.16), transparent 60%); animation: drift2 46s ease-in-out infinite; }
	.b3 { top: 24%; left: 40%; width: 40vmax; height: 40vmax; background: radial-gradient(circle, rgb(var(--color-accent-aurum-rgb) / 0.10), transparent 62%); animation: drift3 54s ease-in-out infinite; }

	.inner { position: relative; z-index: 1; max-width: 64rem; margin: 0 auto; padding: clamp(2rem, 5vh, 3.5rem) clamp(1.1rem, 4vw, 2.5rem) 4rem; }

	.hero { text-align: center; max-width: 40rem; margin: 0 auto clamp(1.6rem, 3vh, 2.4rem); }
	.title { font-size: clamp(1.9rem, 4.5vw, 3rem); line-height: 1.06; letter-spacing: -0.025em; font-weight: 600; background: linear-gradient(112deg, var(--color-text-emphasis) 22%, var(--color-accent-aurum) 70%, var(--color-accent-amethyst) 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.hero-sub { margin: 0.65rem 0 0; font-size: clamp(0.95rem, 1.5vw, 1.1rem); line-height: 1.55; color: var(--color-text-secondary); }

	/* ── Layer 1: summary band + glance ── */
	.summary-band { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: linear-gradient(150deg, rgb(var(--color-accent-rgb) / 0.08), var(--color-surface) 70%); padding: clamp(1rem, 2.5vw, 1.5rem) clamp(1.1rem, 3vw, 1.7rem); margin-bottom: 1rem; }
	.summary-text { font-size: clamp(1rem, 1.6vw, 1.18rem); line-height: 1.6; color: var(--color-text-primary); margin: 0; }
	.skeleton-band { min-height: 84px; animation: pulse 1.5s ease-in-out infinite; }

	.glance { display: grid; grid-template-columns: repeat(4, 1fr); gap: clamp(0.6rem, 1.4vw, 1rem); margin-bottom: 1.8rem; }
	.glance-stat { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.8rem 1rem; }
	.g-l { display: block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--color-text-tertiary); margin-bottom: 0.25rem; }
	.g-v { font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; color: var(--color-text-emphasis); font-variant-numeric: tabular-nums; }
	.g-rel.up { color: var(--color-accent-jade); font-size: 0.9rem; }

	.group-head { font-size: 0.74rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--color-text-tertiary); margin: 1.6rem 0 0.7rem; }

	/* The river (hero spine) */
	.river-section { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: linear-gradient(160deg, rgb(var(--color-accent-jade-rgb) / 0.05), var(--color-surface) 60%); padding: clamp(1rem, 2.4vw, 1.5rem); margin-top: 0.4rem; }
	.river-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.river-head .group-head { margin: 0 0 0.8rem; }
	.river-note { font-size: 0.68rem; color: var(--color-text-tertiary); }
	.anchor-count { margin-top: 1.4rem; padding-top: 1.2rem; border-top: 1px solid var(--color-border); }
	.ac-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
	.ac-title { font-size: 0.82rem; font-weight: 600; color: var(--color-text-emphasis); }

	/* ── Overview grid ── */
	.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: clamp(0.8rem, 1.6vw, 1.1rem); }
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
	.chev { margin-left: auto; color: var(--color-text-tertiary); font-size: 1.2rem; line-height: 1; transition: transform var(--duration-fast) var(--ease-out); }
	.count, .lc { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.05em; }
	.count { margin-left: auto; padding: 0.1rem 0.5rem; border-radius: var(--radius-full); background: rgb(var(--rgb) / 0.16); color: var(--color-text-emphasis); }
	.card-head .count + .chev { margin-left: 0.4rem; }
	.lc { margin-left: auto; text-transform: uppercase; color: var(--color-text-tertiary); padding: 0.12rem 0.5rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); }
	.card-head .lc + .chev, .card-head .badge-new + .chev { margin-left: 0.4rem; }
	.badge-new { font-size: 0.58rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: rgb(var(--rgb)); padding: 0.1rem 0.45rem; border-radius: var(--radius-full); background: rgb(var(--rgb) / 0.14); }
	.card-head .badge-new + .lc { margin-left: 0.4rem; }

	.card-body { display: flex; flex-direction: column; gap: 0.6rem; min-height: 92px; }
	.card-body.two { flex-direction: row; align-items: center; gap: 1.1rem; }
	.col { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; }
	.big { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.03em; color: var(--color-text-emphasis); }
	.big .unit { font-size: 0.8rem; font-weight: 400; color: var(--color-text-tertiary); letter-spacing: 0; }
	.tagline { font-size: 0.78rem; color: var(--color-text-tertiary); margin-top: auto; }

	.rel-chip { align-self: flex-start; font-size: 0.7rem; padding: 0.15rem 0.6rem; border-radius: var(--radius-full); background: rgb(255 255 255 / 0.05); color: var(--color-text-secondary); border: 1px solid var(--color-border); }
	.rel-chip.up { color: var(--color-accent-jade); border-color: rgb(var(--color-accent-jade-rgb) / 0.4); }
	.rel-chip.down { color: var(--color-accent-coral); border-color: rgb(var(--color-accent-coral-rgb) / 0.4); }

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
	.lead { font-size: 0.92rem; line-height: 1.55; color: var(--color-text-secondary); margin-bottom: 1rem; }
	.footnote { margin-top: 1.5rem; text-align: center; font-size: 0.72rem; color: var(--color-text-tertiary); }

	/* ── Glossary ── */
	.glossary { margin-top: 1.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); overflow: hidden; }
	.glossary-toggle { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 1rem 1.2rem; background: transparent; border: none; cursor: pointer; text-align: left; color: inherit; }
	.fresh-title { font-size: 0.82rem; font-weight: 600; color: var(--color-text-emphasis); }
	.g-sub { font-size: 0.74rem; color: var(--color-text-tertiary); }
	.glossary-toggle .chev { margin-left: auto; }
	.glossary-body { padding: 0 1.2rem 1.2rem; display: flex; flex-direction: column; gap: 1.1rem; }
	.gloss-fam { border-top: 1px solid var(--color-border); padding-top: 0.9rem; }
	.gloss-fam-head { display: flex; align-items: center; gap: 0.55rem; }
	.gf-name { font-size: 0.88rem; font-weight: 600; color: var(--color-text-emphasis); }
	.gf-fresh { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.gf-hidden { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0.08rem 0.45rem; }
	.gf-rigor { margin-left: auto; font-size: 0.64rem; font-weight: 600; text-transform: lowercase; letter-spacing: 0.02em; color: var(--rg); border: 1px solid color-mix(in srgb, var(--rg) 40%, transparent); border-radius: var(--radius-full); padding: 0.12rem 0.55rem; }
	.gloss-tag { font-size: 0.78rem; color: var(--color-text-secondary); margin: 0.3rem 0 0.6rem; }
	.gloss-metrics { display: flex; flex-direction: column; gap: 0.4rem; }
	.gloss-metrics li { display: grid; grid-template-columns: 9rem 1fr; gap: 0.8rem; font-size: 0.78rem; align-items: baseline; }
	.gm-name { color: var(--color-text-emphasis); font-weight: 500; }
	.gm-mean { color: var(--color-text-secondary); line-height: 1.45; }
	.gloss-foot { margin-top: 0.4rem; }

	/* ── Detail ── */
	.back { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.7rem 0.4rem 0.45rem; margin-bottom: 1.2rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-secondary); font-size: 0.82rem; cursor: pointer; transition: border-color var(--duration-fast), color var(--duration-fast); }
	.back:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
	.back svg { width: 1rem; height: 1rem; }
	.detail-head { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.5rem; }
	.detail-head .dh-text { flex: 1; }
	.detail-head h1 { font-size: 1.8rem; font-weight: 600; letter-spacing: -0.02em; }
	.detail-head p { color: var(--color-text-tertiary); font-size: 0.88rem; margin-top: 0.15rem; }
	.rigor-badge { font-size: 0.66rem; font-weight: 600; color: var(--rg); border: 1px solid color-mix(in srgb, var(--rg) 45%, transparent); background: color-mix(in srgb, var(--rg) 10%, transparent); border-radius: var(--radius-full); padding: 0.22rem 0.7rem; white-space: nowrap; }

	.detail-grid { display: grid; grid-template-columns: 1fr 1.5fr; gap: 1rem; margin-bottom: 1rem; }
	.detail-grid.one { grid-template-columns: 1fr; }
	.t-fig { color: var(--color-accent-amethyst); font-size: 0.82rem; margin-left: auto; }
	.t-fig-btn { border: none; background: none; font: inherit; cursor: pointer; padding: 0; }
	.t-fig-btn:hover { text-decoration: underline; }
	.t-fig-btn:focus-visible { outline: 2px solid var(--color-accent-amethyst); outline-offset: 2px; border-radius: 2px; }
	.kindred-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 0.7rem; margin: 0.5rem 0 1.3rem; }
	.kindred-card { display: flex; align-items: center; gap: 0.75rem; padding: 0.7rem 0.85rem; border: 1px solid var(--color-border); border-left: 3px solid rgb(var(--rgb)); border-radius: var(--radius-md); background: var(--color-elevated); width: 100%; text-align: left; font: inherit; cursor: pointer; transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out), transform 0.1s var(--ease-out); }
	.kindred-card:hover { background: color-mix(in srgb, rgb(var(--rgb)) 8%, var(--color-elevated)); border-color: color-mix(in srgb, rgb(var(--rgb)) 45%, var(--color-border)); }
	.kindred-card:active { transform: scale(0.99); }
	.kindred-card:focus-visible { outline: 2px solid rgb(var(--rgb)); outline-offset: 2px; }
	.kc-go { margin-left: auto; color: var(--color-text-tertiary); font-size: 1.1rem; flex: none; transition: transform 0.15s var(--ease-out); }
	.kindred-card:hover .kc-go { transform: translateX(2px); color: rgb(var(--rgb)); }
	.kindred-card :global(.ring-wrap) { flex: none; }
	.kc-body { min-width: 0; display: flex; flex-direction: column; gap: 0.18rem; }
	.kc-name { font-weight: 600; color: var(--color-text-emphasis); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.kc-con { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.kc-con .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
	.kc-via { font-size: 0.68rem; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rpath { border-top: 1px solid var(--color-border); }
	.rpath > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8rem; padding: 0.5rem 0.1rem; cursor: pointer; list-style: none; }
	.rpath > summary::-webkit-details-marker { display: none; }
	.rpath > summary::before { content: '›'; color: var(--color-text-tertiary); margin-right: 0.5rem; display: inline-block; transition: transform 0.15s var(--ease-out); }
	.rpath[open] > summary::before { transform: rotate(90deg); }
	.rp-name { color: var(--color-text-emphasis); font-weight: 500; }
	.rp-figs { color: var(--color-text-tertiary); font-size: 0.74rem; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rpath-theme { margin-left: 1.1rem; border-top: 1px dashed var(--color-border); }
	.rpath-theme > summary { padding: 0.35rem 0.1rem; }
	.rpath-theme .rp-name { font-weight: 400; color: var(--color-text-secondary); }
	.rp-terr { list-style: none; margin: 0 0 0.4rem 1.6rem; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
	.rp-terr li { display: flex; justify-content: space-between; gap: 0.6rem; align-items: baseline; font-size: 0.8rem; }
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
	/* P3b cross-check: trust pill on the σ stat + the 2×2 quadrant panel */
	.trust { display: inline-block; margin-top: 0.35rem; font-size: 0.6rem; font-weight: 600; letter-spacing: 0.03em; padding: 0.1rem 0.45rem; border-radius: var(--radius-full); white-space: nowrap; }
	.xc-panel { margin-top: 0.6rem; }
	.xc-grid { display: flex; flex-wrap: wrap; align-items: center; gap: 1.1rem; }
	.xc-grid :global(.xc) { flex: 0 0 auto; }
	.xc-copy { flex: 1 1 12rem; min-width: 12rem; }
	.xc-copy p { margin: 0 0 0.5rem; font-size: 0.82rem; line-height: 1.45; }
	.xc-copy p:last-child { margin-bottom: 0; }

	.level-chips { display: flex; flex-wrap: wrap; gap: 0.7rem; margin-bottom: 0.8rem; }
	.lchip { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
	.lchip-l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-tertiary); }

	.seg-toggle { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-full); overflow: hidden; }
	.seg-toggle button { padding: 0.3rem 0.8rem; font-size: 0.74rem; background: transparent; color: var(--color-text-tertiary); border: none; cursor: pointer; text-transform: capitalize; transition: background var(--duration-fast), color var(--duration-fast); }
	.seg-toggle button.on { background: rgb(var(--color-accent-amethyst-rgb) / 0.18); color: var(--color-text-emphasis); }
	.seg-toggle.az button.on { background: rgb(var(--color-accent-rgb) / 0.18); }
	.seg-toggle.rose button.on { background: rgb(var(--color-accent-rose-rgb) / 0.18); }
	.m-select { font-size: 0.74rem; background: var(--color-surface); color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.3rem 0.5rem; max-width: 16rem; cursor: pointer; }

	/* jargon expander */
	.jargon { margin-top: 0.6rem; }
	.jargon summary { cursor: pointer; font-size: 0.76rem; color: var(--color-text-secondary); padding: 0.4rem 0; user-select: none; }
	.jargon summary:hover { color: var(--color-text-primary); }
	.band-key { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; font-size: 0.72rem; color: var(--color-text-secondary); margin-bottom: 0.6rem; }
	.band-key i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 0.35rem; vertical-align: middle; }

	.metric-grid { display: flex; flex-direction: column; gap: 3px; margin: 0.6rem 0 1rem; overflow-x: auto; }
	.mg-row { display: grid; grid-template-columns: 7.5rem repeat(5, 1fr); gap: 3px; align-items: center; min-width: 26rem; }
	.mg-head .mg-band { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); text-align: center; }
	.mg-feat { font-size: 0.72rem; color: var(--color-text-secondary); white-space: nowrap; }
	.mg-cell { font-size: 0.72rem; font-variant-numeric: tabular-nums; text-align: center; padding: 0.3rem 0; border-radius: var(--radius-sm); color: var(--color-text-emphasis); background: rgb(var(--color-accent-amethyst-rgb) / calc(var(--m, 0) * 0.5 + 0.04)); }
	.mg-cell.null { color: var(--color-text-tertiary); background: rgb(255 255 255 / 0.02); }
	.h0 { display: flex; align-items: baseline; justify-content: space-between; padding: 0.8rem 0 0; border-top: 1px solid var(--color-border); }
	.h0 .s-v { display: inline; font-size: 1.05rem; }

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

	/* routine: diurnal histogram */
	.diurnal { display: flex; align-items: flex-end; gap: 2px; height: 96px; padding-bottom: 1rem; position: relative; }
	.dh-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; position: relative; }
	.dh-bar { width: 100%; max-width: 14px; border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.5s var(--ease-out); }
	.dh-h { position: absolute; bottom: -1rem; font-size: 0.6rem; color: var(--color-text-tertiary); }

	/* early signals */
	.advisory-note { display: flex; gap: 0.8rem; align-items: flex-start; padding: 0.9rem 1.1rem; border: 1px solid rgb(var(--color-accent-aurum-rgb) / 0.35); background: rgb(var(--color-accent-aurum-rgb) / 0.08); border-radius: var(--radius-lg); margin-bottom: 1rem; }
	.advisory-note svg { width: 1.4rem; height: 1.4rem; flex: none; color: var(--color-accent-aurum); margin-top: 0.1rem; }
	.advisory-note p { font-size: 0.84rem; line-height: 1.55; color: var(--color-text-secondary); margin: 0; }
	.crit-list { display: flex; flex-direction: column; gap: 0.4rem; }
	.crit-list li { display: grid; grid-template-columns: 1fr repeat(3, 1fr); gap: 0.5rem; align-items: center; font-size: 0.8rem; }
	.crit-head { color: var(--color-text-tertiary); font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; }
	.crit-lv { color: var(--color-text-secondary); text-transform: capitalize; }
	.crit-v { text-align: center; font-variant-numeric: tabular-nums; color: var(--color-text-emphasis); }
	.crit-v.warn { color: var(--color-accent-coral); font-weight: 600; }

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
		.glance { grid-template-columns: repeat(2, 1fr); }
		.stat-row, .stat-row.four, .stat-row.five { grid-template-columns: repeat(2, 1fr); }
		.gloss-metrics li { grid-template-columns: 1fr; gap: 0.1rem; }
	}
	@media (prefers-reduced-motion: reduce) { .blob { animation: none; } .card.skeleton, .skeleton-band { animation: none; } }
</style>
