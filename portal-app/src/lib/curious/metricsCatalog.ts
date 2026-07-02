// Single source of truth for the "What we measure" glossary on the Curious Life
// page AND the human-readable reference doc (docs/CURIOUS-LIFE-METRICS-CATALOG.md).
// Keep them in sync: edit here, then mirror into the doc.
//
// Honesty is the contract (CLAUDE.md §"honest by construction" + src/metrics/
// contracts.js). Every family carries a `rigor` label so we never present a
// heuristic as if it were validated, and CVP-pending embedding-anchor families
// are listed as `experimental` rather than promoted. `preferred_vocab` mirrors
// the voice words in src/metrics/contracts.js (what to say — and what NOT to).

export type Rigor = 'validated-math' | 'validated-clinical' | 'heuristic' | 'experimental';

export interface MetricDef {
	/** The raw column/metric key as computed by the pipeline (Layer-3 precision). */
	key: string;
	/** Human-facing name. */
	name: string;
	/** One-line plain-language meaning. */
	meaning: string;
}

export interface FamilyDef {
	/** Pillar key (matches the overview card / detail `active` key where applicable). */
	id: string;
	/** Human-facing family name. */
	name: string;
	/** Plain one-liner shown under the name. */
	tagline: string;
	/** Rigor of the family as a whole (worst-case across its metrics). */
	rigor: Rigor;
	/** Freshness `table` key from /portal/metric-freshness, when one maps. */
	freshTable?: string;
	/** Whether this family has a card on the page (vs glossary-only). */
	surfaced: boolean;
	/** Voice words to favour / avoid (from src/metrics/contracts.js). */
	vocab?: string;
	/** The precise metrics inside the family (Layer-3). */
	metrics: MetricDef[];
}

export const RIGOR_LABEL: Record<Rigor, string> = {
	'validated-math': 'validated math',
	'validated-clinical': 'validated (clinical)',
	heuristic: 'heuristic',
	experimental: 'experimental',
};

// Maps a rigor level to a design-token accent (see app tokens). jade=trusted,
// azure=informational, amethyst=heuristic, coral=experimental/caution.
export const RIGOR_ACCENT: Record<Rigor, string> = {
	'validated-math': 'var(--color-accent-jade)',
	'validated-clinical': 'var(--color-accent-jade)',
	heuristic: 'var(--color-accent)',
	experimental: 'var(--color-accent-coral)',
};

export const RIGOR_BLURB: Record<Rigor, string> = {
	'validated-math': 'A mathematical quantity computed by a canonical, well-defined method.',
	'validated-clinical': 'Validated in clinical studies — though journaling use is an extrapolation.',
	heuristic: 'Literature-grounded but not validated for this use — read as a sensible signal, not a verdict.',
	experimental: 'A novel, unvalidated application. Suggestive only — never a diagnosis or prediction.',
};

export const METRIC_FAMILIES: FamilyDef[] = [
	{
		id: 'vitality',
		name: 'Vitality',
		tagline: 'How alive your territories are',
		rigor: 'heuristic',
		freshTable: 'territory_vitality',
		surfaced: true,
		metrics: [
			{ key: 'vitality', name: 'Vitality', meaning: 'A blend of the five signals below — overall aliveness of a territory.' },
			{ key: 'entropy_diversification', name: 'Diversification', meaning: 'How varied a territory’s connections are, rather than clustered in one place.' },
			{ key: 'connection_growth_rate', name: 'Connection growth', meaning: 'How quickly a territory is forming new links.' },
			{ key: 'reach', name: 'Reach', meaning: 'How far across your mindscape a territory connects.' },
			{ key: 'cofire_partner_diversity', name: 'Partner diversity', meaning: 'The variety of other territories that light up alongside it.' },
			{ key: 'engagement_depth_normalized', name: 'Engagement depth', meaning: 'How deeply you engage with a territory, not just how often.' },
		],
	},
	{
		id: 'movement',
		name: 'Movement',
		tagline: 'How far and fast your focus travels between ideas',
		rigor: 'validated-math',
		freshTable: 'fisher_trajectory',
		surfaced: true,
		vocab: 'movement / direction / phase',
		metrics: [
			{ key: 'fisher_velocity', name: 'Velocity', meaning: 'Speed of change in what you’re focused on, week to week (Fisher-Rao geodesic distance per unit time).' },
			{ key: 'fisher_displacement', name: 'Displacement', meaning: 'How far your focus has moved from where it started.' },
			{ key: 'fisher_trajectory_length', name: 'Path length', meaning: 'The total distance your focus has travelled, including back-and-forth.' },
			{ key: 'exploration_ratio', name: 'Exploration ratio', meaning: 'Displacement ÷ path length — near 1 you’re striking out in a direction; near 0 you’re circling.' },
			{ key: 'activation_entropy', name: 'Activation entropy', meaning: 'Whether your focus is concentrated on a few territories or spread across many.' },
			{ key: 'phase', name: 'Phase', meaning: 'A four-state read of your movement: stable, cycling, exploring, or transforming.' },
		],
	},
	{
		id: 'rhythm',
		name: 'Rhythm',
		tagline: 'The cadence of your thinking, from per-message to monthly',
		rigor: 'heuristic',
		freshTable: 'cognitive_metrics_harmonic',
		surfaced: true,
		vocab: 'rhythm / pattern / movement (bands are time-scales, NOT EEG Hz)',
		metrics: [
			{ key: 'harmonic_amplitude', name: 'Harmonic amplitude', meaning: 'The strength of repeating patterns in your message-to-message signal, at each time-scale. (Fourier regression — validated math.)' },
			{ key: 'mean_crossing_rate', name: 'Crossing rate', meaning: 'How often the signal swings across its own average — a measure of oscillation.' },
			{ key: 'slope_sign_change_rate', name: 'Slope changes', meaning: 'How jagged vs smooth the signal is.' },
			{ key: 'autocorrelation_lag1', name: 'Autocorrelation', meaning: 'How much each step resembles the one before — the inertia of your thinking.' },
			{ key: 'variance', name: 'Variance', meaning: 'How volatile the signal is within a time-scale.' },
			{ key: 'total_spectral_energy', name: 'Spectral energy', meaning: 'The overall amount of structure in the signal across all frequencies.' },
			{ key: 'topology_h0_persistence_entropy', name: 'Persistence entropy', meaning: 'How uniform vs hierarchical the shape of a window’s ideas is (topological data analysis — validated math).' },
		],
	},
	{
		id: 'complexity',
		name: 'Complexity',
		tagline: 'How varied, vs repetitive, the path of your thinking is',
		rigor: 'validated-math',
		freshTable: 'complexity_snapshots',
		surfaced: true,
		metrics: [
			{ key: 'lz_complexity', name: 'LZ complexity', meaning: 'How compressible the sequence of territories you move through is — higher means less repetitive (Lempel-Ziv 76).' },
			{ key: 'raw_complexity', name: 'Distinct patterns', meaning: 'The count of distinct sub-patterns in the sequence.' },
			{ key: 'sequence_length', name: 'Steps', meaning: 'How many moves are in the measured sequence.' },
			{ key: 'alphabet_size', name: 'Territories in play', meaning: 'How many distinct territories appear in the sequence.' },
		],
	},
	{
		id: 'growth',
		name: 'Growth',
		tagline: 'How your thinking consolidates and changes',
		rigor: 'heuristic',
		freshTable: 'frequency_snapshots',
		surfaced: true,
		metrics: [
			{ key: 'coherence', name: 'Coherence', meaning: 'How aligned your active territories are with each other right now.' },
			{ key: 'entropy', name: 'Spread', meaning: 'How evenly your attention is distributed across territories.' },
			{ key: 'compression', name: 'Compressibility', meaning: 'How structured vs novel your text is (gzip ratio of plaintext).' },
			{ key: 'learning_rate', name: 'Learning rate', meaning: 'How much your focus changed from the previous window (Jensen-Shannon divergence²).' },
			{ key: 'gradient_signal', name: 'Drift', meaning: 'How far your focus has drifted from where the window began.' },
		],
	},
	{
		id: 'mindscape',
		name: 'Mindscape',
		tagline: 'The shape of your inner world',
		rigor: 'heuristic',
		freshTable: 'topology_audit_snapshots',
		surfaced: true,
		metrics: [
			{ key: 'total_territories', name: 'Territories', meaning: 'The number of distinct idea-regions in your mindscape.' },
			{ key: 'total_connections', name: 'Connections', meaning: 'How many links join those regions.' },
			{ key: 'm2_entropy', name: 'Spread (M2 entropy)', meaning: 'How evenly your structure is distributed vs concentrated.' },
			{ key: 'degree_gini', name: 'Concentration (Gini)', meaning: 'Whether a few territories dominate the connections.' },
			{ key: 'mean_degree', name: 'Mean degree', meaning: 'The average number of connections per territory.' },
			{ key: 'orphan_count', name: 'Orphans', meaning: 'Territories with no connections at all.' },
			{ key: 'bridge_count', name: 'Bridges', meaning: 'Territories that link otherwise-separate regions together.' },
			{ key: 'cofire', name: 'Co-firing', meaning: 'Which territories light up together, across four timescales (hour → week).' },
		],
	},
	{
		id: 'milestones',
		name: 'Milestones',
		tagline: 'Moments your mind turned',
		rigor: 'heuristic',
		freshTable: 'fisher_milestones',
		surfaced: true,
		metrics: [
			{ key: 'phase_shift', name: 'Phase shift', meaning: 'A week your movement phase changed decisively.' },
			{ key: 'velocity_spike', name: 'Velocity spike', meaning: 'An unusually fast move through idea-space.' },
		],
	},
	{
		id: 'routine',
		name: 'Routine',
		tagline: 'When you write, and how regular your sessions are',
		rigor: 'heuristic',
		freshTable: 'cognitive_metrics_behavioral',
		surfaced: true,
		vocab: 'routine / rhythm-of-day / weekly cycle (descriptive — NOT clinical circadian diagnosis)',
		metrics: [
			{ key: 'diurnal_peak_hour', name: 'Peak hour', meaning: 'The hour of day you write most.' },
			{ key: 'peak_weekday', name: 'Busiest day', meaning: 'The day of the week you write most.' },
			{ key: 'weekday_hour_hist', name: 'Day × hour map', meaning: 'A heat-map of which weekday-and-hour you tend to write in — your week’s shape, not just the clock.' },
			{ key: 'weekday_concentration', name: 'Weekday concentration', meaning: 'How concentrated your writing is on certain days vs spread evenly across the week.' },
			{ key: 'dominant_cycle_days', name: 'Activity cycle', meaning: 'The strongest repeating rhythm in how much you write — found by autocorrelation (e.g. a ~7-day weekly cycle). Descriptive, never a prescription.' },
			{ key: 'weekly_cycle_strength', name: 'Weekly rhythm strength', meaning: 'How strongly your activity repeats on a 7-day cycle [0–1].' },
			{ key: 'session_count', name: 'Sessions', meaning: 'How many distinct writing sessions you’ve had (gaps over 30 min split them).' },
			{ key: 'intersession_entropy', name: 'Cadence regularity', meaning: 'How regular vs erratic the gaps between sessions are.' },
			{ key: 'intersession_cv', name: 'Cadence variation', meaning: 'The variability of those gaps (coefficient of variation).' },
		],
	},
	{
		id: 'early-signals',
		name: 'Early signals',
		tagline: 'Faint hints a shift may be near — advisory, never a prediction',
		rigor: 'experimental',
		freshTable: 'cognitive_metrics_criticality',
		surfaced: true,
		vocab: 'hint / signal (NEVER "prediction", NEVER "warning of crisis")',
		metrics: [
			{ key: 'ar1_autocorrelation', name: 'Critical slowing', meaning: 'Whether your movement is becoming more self-similar — a textbook (but low-sensitivity) early-warning sign.' },
			{ key: 'rolling_variance', name: 'Rolling variance', meaning: 'Whether the variability of your movement is rising — the companion signal to critical slowing.' },
			{ key: 'early_warning_joint', name: 'Joint signal', meaning: 'Fires only when both critical slowing and rising variance appear together.' },
			{ key: 'flickering_score', name: 'Flickering', meaning: 'Back-and-forth alternation between two phases before one settles in.' },
		],
	},
	// ── Glossary-only: computed but NOT surfaced as validated ──────────────────
	{
		id: 'embedding-anchors',
		name: 'Affective & insight tone',
		tagline: 'Embedding-based proximity signals — experimental, never clinical',
		rigor: 'experimental',
		surfaced: false,
		vocab: 'proximity / leaning / variation (NOT "insight detected", NOT mood/affect)',
		metrics: [
			{ key: 'insight_embedding_proximity', name: 'Insight proximity', meaning: 'How close your messages sit to an “insight” seed-phrase — a heuristic, not a measured insight.' },
			{ key: 'reflective_embedding_density', name: 'Reflective density', meaning: 'How often your messages lean toward a “reflection” anchor.' },
			{ key: 'inner_territory_presence', name: 'Inner presence', meaning: 'Average proximity to the reflection anchor.' },
			{ key: 'affective_volatility_within_window', name: 'Affective variation', meaning: 'Spread of an embedding-based positive-minus-negative proxy. Not a clinical or diagnostic affect measure.' },
		],
	},
];

export const SURFACED_FAMILIES = METRIC_FAMILIES.filter((f) => f.surfaced);
