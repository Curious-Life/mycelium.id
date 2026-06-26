// Character Resonance — seed roster for the Curious Life federation surface.
//
// 128 historical, literary, and mythological figures arranged into 16 archetypal
// CONSTELLATIONS, themselves grouped into 4 DOMAINS (Architects / Seekers /
// Builders / Weavers). Each figure carries a full, computable profile on a 0–1
// scale — NEO-PI-R (30 facets), Schwartz values (10), and 8 cognitive dimensions
// — so a user's measured profile can resonate with the nearest figures by cosine
// similarity in the shared dimension space.
//
// Source of truth for the human-readable list: docs/CHARACTER-RESONANCE-SEED-ROSTER.md
// Source of the profiles: Ada (research-agent) historical-figure-profiles-batch1–4.
// The raw data lives in ./characterResonanceSeed.json; this module is the typed
// accessor over it (mirrors the metricsCatalog.ts single-source-of-truth pattern).

import seed from './characterResonanceSeed.json';

export type FigureType = 'historical' | 'literary';
export type Domain = 'Architects' | 'Seekers' | 'Builders' | 'Weavers';

/** Big Five (NEO-PI-R) — 5 traits × 6 facets, all 0–1. */
export interface BigFive {
	openness: Record<string, number>;
	conscientiousness: Record<string, number>;
	extraversion: Record<string, number>;
	agreeableness: Record<string, number>;
	neuroticism: Record<string, number>;
}

/** The 8 cognitive dimensions that drive the resonance match (radar chart space). */
export interface CognitiveDimensions {
	integrative_complexity: number;
	abstraction_level: number;
	epistemic_breadth: number;
	systematic_rigor: number;
	creative_latitude: number;
	metacognitive_awareness: number;
	agency: number;
	emotional_register: number;
}

export interface FigureProfile {
	name: string;
	constellation: string;
	domain: Domain;
	type: FigureType;
	era: string;
	birth_year: number | null;
	death_year: number | null;
	primary_domain: string;
	gender: string;
	region: string;
	big_five: BigFive;
	schwartz_values: Record<string, number>;
	cognitive_dimensions: CognitiveDimensions;
}

interface Seed {
	version: string;
	source: string;
	count: number;
	figures: FigureProfile[];
}

const data = seed as unknown as Seed;

/** All 128 figures in roster order (domain → constellation → 1..8). */
export const FIGURES: FigureProfile[] = data.figures;

/** Seed metadata (version + provenance). */
export const RESONANCE_SEED_META = { version: data.version, source: data.source, count: data.count };

/** Fixed domain order for display. */
export const DOMAINS: Domain[] = ['Architects', 'Seekers', 'Builders', 'Weavers'];

/** The 16 constellation names, in roster order. */
export const CONSTELLATIONS: string[] = [...new Set(FIGURES.map((f) => f.constellation))];

/** Figures in one domain. */
export function figuresByDomain(domain: Domain): FigureProfile[] {
	return FIGURES.filter((f) => f.domain === domain);
}

/** Figures in one constellation (8 each). */
export function figuresByConstellation(constellation: string): FigureProfile[] {
	return FIGURES.filter((f) => f.constellation === constellation);
}

/** Look up a single figure by exact name. */
export function figureByName(name: string): FigureProfile | undefined {
	return FIGURES.find((f) => f.name === name);
}

/** The cognitive-dimension vector, in the canonical order used for similarity. */
export const COGNITIVE_AXES: (keyof CognitiveDimensions)[] = [
	'integrative_complexity',
	'abstraction_level',
	'epistemic_breadth',
	'systematic_rigor',
	'creative_latitude',
	'metacognitive_awareness',
	'agency',
	'emotional_register',
];

/** Extract a figure's 8-D cognitive vector in COGNITIVE_AXES order. */
export function cognitiveVector(f: FigureProfile): number[] {
	return COGNITIVE_AXES.map((k) => f.cognitive_dimensions[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resonance matching — port of Ada's figure-similarity method
// (research-agent: lumensis-archetype-evolution-and-figure-matching.md §Part 2 /
// "Similarity Matching Function"): build a normalized metric vector for the user
// and each figure, rank by COSINE similarity, return top-N with the dimensions
// that drive each match. Two refinements over raw cosine:
//   1) per-dimension STANDARDIZATION (z-score vs the roster) so matches are
//      discriminative — raw cosine on all-positive 0–1 vectors flatters everyone.
//   2) explicit match DRIVERS (which dimensions most pushed the similarity up),
//      per Ada's "show which specific metrics drive the match".
// Voice discipline: surface as "reminiscent of" / "resonates with", never
// "identical to" (Ada §UX; mirrors src/metrics/contracts.js honesty contracts).

/** The 30 Big-Five facets in a fixed order (trait.facet). */
export const BIGFIVE_FACETS: string[] = (
	[
		['openness', ['fantasy', 'aesthetics', 'feelings', 'actions', 'ideas', 'values']],
		['conscientiousness', ['competence', 'order', 'dutifulness', 'achievement_striving', 'self_discipline', 'deliberation']],
		['extraversion', ['warmth', 'gregariousness', 'assertiveness', 'activity', 'excitement_seeking', 'positive_emotions']],
		['agreeableness', ['trust', 'straightforwardness', 'altruism', 'compliance', 'modesty', 'tender_mindedness']],
		['neuroticism', ['anxiety', 'angry_hostility', 'depression', 'self_consciousness', 'impulsiveness', 'vulnerability']],
	] as [keyof BigFive, string[]][]
).flatMap(([trait, facets]) => facets.map((f) => `${trait}.${f}`));

export const SCHWARTZ_KEYS: string[] = [
	'self_direction', 'stimulation', 'hedonism', 'achievement', 'power',
	'security', 'conformity', 'tradition', 'benevolence', 'universalism',
];

/** Which dimension space to match in. `cognitive` = the 8 radar dims (default,
 *  most interpretable); `full` = 8 cognitive + 30 Big-Five facets + 10 Schwartz. */
export type ResonanceSpace = 'cognitive' | 'full';

/** A user's measured profile. cognitive_dimensions is required; big_five +
 *  schwartz_values are only needed for the `full` space. */
export interface UserProfile {
	cognitive_dimensions: CognitiveDimensions;
	big_five?: BigFive;
	schwartz_values?: Record<string, number>;
}

export interface MatchDriver {
	/** Human-readable axis label, e.g. "creative_latitude" or "openness.ideas". */
	axis: string;
	/** Signed contribution to the (standardized) cosine — positive = pulls the match together. */
	contribution: number;
}

export interface ResonanceMatch {
	figure: FigureProfile;
	/** Cosine similarity of the standardized vectors, in [-1, 1]. */
	similarity: number;
	/** A friendlier 0–100 affinity (cosine remapped from [-1,1] → [0,100]). */
	affinity: number;
	/** Top dimensions that drive this match (most positive contributions first). */
	drivers: MatchDriver[];
}

/** Ordered axis labels for a space. */
function axesFor(space: ResonanceSpace): string[] {
	return space === 'full' ? [...COGNITIVE_AXES, ...BIGFIVE_FACETS, ...SCHWARTZ_KEYS] : [...COGNITIVE_AXES];
}

function figureVector(f: FigureProfile, space: ResonanceSpace): number[] {
	const cog = COGNITIVE_AXES.map((k) => f.cognitive_dimensions[k]);
	if (space === 'cognitive') return cog;
	const bf = BIGFIVE_FACETS.map((tf) => {
		const [t, fc] = tf.split('.') as [keyof BigFive, string];
		return f.big_five[t][fc];
	});
	const sw = SCHWARTZ_KEYS.map((k) => f.schwartz_values[k] ?? 0.5);
	return [...cog, ...bf, ...sw];
}

function profileVector(p: UserProfile, space: ResonanceSpace): number[] {
	const cog = COGNITIVE_AXES.map((k) => p.cognitive_dimensions[k]);
	if (space === 'cognitive') return cog;
	if (!p.big_five || !p.schwartz_values) {
		throw new Error('resonanceMatch: `full` space requires big_five and schwartz_values on the user profile');
	}
	const bf = BIGFIVE_FACETS.map((tf) => {
		const [t, fc] = tf.split('.') as [keyof BigFive, string];
		return p.big_five![t][fc];
	});
	const sw = SCHWARTZ_KEYS.map((k) => p.schwartz_values![k] ?? 0.5);
	return [...cog, ...bf, ...sw];
}

// Roster mean/std per dimension, memoized per space (computed once over FIGURES).
const _stats: Partial<Record<ResonanceSpace, { mean: number[]; std: number[] }>> = {};
function rosterStats(space: ResonanceSpace): { mean: number[]; std: number[] } {
	const cached = _stats[space];
	if (cached) return cached;
	const vecs = FIGURES.map((f) => figureVector(f, space));
	const n = vecs.length;
	const dim = vecs[0].length;
	const mean = new Array(dim).fill(0);
	for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] / n;
	const std = new Array(dim).fill(0);
	for (const v of vecs) for (let i = 0; i < dim; i++) std[i] += (v[i] - mean[i]) ** 2;
	for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / n) || 1; // guard zero-variance
	const out = { mean, std };
	_stats[space] = out;
	return out;
}

function standardize(v: number[], s: { mean: number[]; std: number[] }): number[] {
	return v.map((x, i) => (x - s.mean[i]) / s.std[i]);
}

function dot(a: number[], b: number[]): number {
	let d = 0;
	for (let i = 0; i < a.length; i++) d += a[i] * b[i];
	return d;
}

/**
 * Rank the roster by resonance with a user profile.
 * @param profile  the user's measured profile (cognitive_dimensions required).
 * @param opts.topN     how many matches to return (default 5).
 * @param opts.space    'cognitive' (default) or 'full'.
 * @param opts.standardizeDims  z-score vs roster before cosine (default true).
 * @param opts.driverCount      how many drivers to list per match (default 3).
 * @param opts.pool     restrict the candidate pool (e.g. one constellation).
 */
export function resonanceMatch(
	profile: UserProfile,
	opts: {
		topN?: number;
		space?: ResonanceSpace;
		standardizeDims?: boolean;
		driverCount?: number;
		pool?: FigureProfile[];
	} = {},
): ResonanceMatch[] {
	const space = opts.space ?? 'cognitive';
	const topN = opts.topN ?? 5;
	const driverCount = opts.driverCount ?? 3;
	const useZ = opts.standardizeDims ?? true;
	const pool = opts.pool ?? FIGURES;
	const axes = axesFor(space);
	const stats = rosterStats(space);

	const uRaw = profileVector(profile, space);
	const u = useZ ? standardize(uRaw, stats) : uRaw;
	const uNorm = Math.sqrt(dot(u, u)) || 1;

	const scored = pool.map((f) => {
		const fRaw = figureVector(f, space);
		const v = useZ ? standardize(fRaw, stats) : fRaw;
		const vNorm = Math.sqrt(dot(v, v)) || 1;
		const sim = dot(u, v) / (uNorm * vNorm);
		// per-axis contribution to the cosine (so Σ drivers ≈ similarity)
		const drivers = axes
			.map((axis, i) => ({ axis, contribution: (u[i] * v[i]) / (uNorm * vNorm) }))
			.sort((a, b) => b.contribution - a.contribution)
			.slice(0, driverCount);
		return {
			figure: f,
			similarity: sim,
			affinity: Math.round(((sim + 1) / 2) * 100),
			drivers,
		};
	});

	scored.sort((a, b) => b.similarity - a.similarity);
	return scored.slice(0, topN);
}

/** Mean resonance per constellation — "which archetype do you resonate with?".
 *  Returns constellations sorted by mean similarity (descending). */
export function resonanceByConstellation(
	profile: UserProfile,
	opts: { space?: ResonanceSpace; standardizeDims?: boolean } = {},
): { constellation: string; domain: Domain; meanSimilarity: number; affinity: number }[] {
	const all = resonanceMatch(profile, { ...opts, topN: FIGURES.length, driverCount: 0 });
	const acc = new Map<string, { domain: Domain; sum: number; n: number }>();
	for (const m of all) {
		const c = m.figure.constellation;
		const e = acc.get(c) ?? { domain: m.figure.domain, sum: 0, n: 0 };
		e.sum += m.similarity;
		e.n += 1;
		acc.set(c, e);
	}
	return [...acc.entries()]
		.map(([constellation, e]) => ({
			constellation,
			domain: e.domain,
			meanSimilarity: e.sum / e.n,
			affinity: Math.round(((e.sum / e.n + 1) / 2) * 100),
		}))
		.sort((a, b) => b.meanSimilarity - a.meanSimilarity);
}

/** Mean resonance per domain (the 4 high-level styles), sorted descending. */
export function resonanceByDomain(
	profile: UserProfile,
	opts: { space?: ResonanceSpace; standardizeDims?: boolean } = {},
): { domain: Domain; meanSimilarity: number; affinity: number }[] {
	const byCon = resonanceByConstellation(profile, opts);
	const acc = new Map<Domain, { sum: number; n: number }>();
	for (const c of byCon) {
		const e = acc.get(c.domain) ?? { sum: 0, n: 0 };
		e.sum += c.meanSimilarity;
		e.n += 1;
		acc.set(c.domain, e);
	}
	return DOMAINS.map((domain) => {
		const e = acc.get(domain) ?? { sum: 0, n: 1 };
		const mean = e.sum / e.n;
		return { domain, meanSimilarity: mean, affinity: Math.round(((mean + 1) / 2) * 100) };
	}).sort((a, b) => b.meanSimilarity - a.meanSimilarity);
}

/** The constellation a profile resonates with most (single best). */
export function dominantConstellation(profile: UserProfile, opts: { space?: ResonanceSpace } = {}): string {
	return resonanceByConstellation(profile, opts)[0]?.constellation ?? CONSTELLATIONS[0];
}

export interface AreaResonance {
	/** The life-area label (e.g. a realm name like "Work" or "Relationships"). */
	area: string;
	/** Top figure matches within this area's centroid. */
	top: ResonanceMatch[];
	/** Which archetype this area leans toward. */
	dominantConstellation: string;
}

/**
 * "Different selves in different rooms" — match per life-area centroid.
 * @param profilesByArea  one user profile per area (e.g. per realm).
 * Areas with no profile are skipped. Returns areas in input order.
 */
export function matchAreas(
	profilesByArea: Record<string, UserProfile>,
	opts: { topN?: number; space?: ResonanceSpace } = {},
): AreaResonance[] {
	const topN = opts.topN ?? 3;
	return Object.entries(profilesByArea).map(([area, profile]) => ({
		area,
		top: resonanceMatch(profile, { topN, space: opts.space }),
		dominantConstellation: dominantConstellation(profile, { space: opts.space }),
	}));
}

export interface TimelineWindow {
	/** Window label (e.g. "2024-Q1", an era name, or a month). */
	label: string;
	top: ResonanceMatch[];
	dominantConstellation: string;
	dominantDomain: Domain;
}

export interface ResonanceTimeline {
	windows: TimelineWindow[];
	/** Dominant constellation per window, in order (for a stream/sparkline). */
	dominantSeries: string[];
	/** Coarse drift summary: did the dominant archetype move start→end? */
	drift: { from: string; to: string; changed: boolean };
}

/**
 * Resonance trajectory over time — windowed matching → archetype evolution.
 * @param windows  ordered {label, profile} per time-window (era or month).
 * Drift is purely descriptive movement (start vs end dominant), never "progress".
 */
export function matchTimeline(
	windows: { label: string; profile: UserProfile }[],
	opts: { topN?: number; space?: ResonanceSpace } = {},
): ResonanceTimeline {
	const topN = opts.topN ?? 3;
	const out: TimelineWindow[] = windows.map(({ label, profile }) => {
		const byCon = resonanceByConstellation(profile, { space: opts.space });
		const top1 = byCon[0];
		return {
			label,
			top: resonanceMatch(profile, { topN, space: opts.space }),
			dominantConstellation: top1?.constellation ?? CONSTELLATIONS[0],
			dominantDomain: (top1?.domain ?? DOMAINS[0]) as Domain,
		};
	});
	const series = out.map((w) => w.dominantConstellation);
	const from = series[0] ?? CONSTELLATIONS[0];
	const to = series[series.length - 1] ?? from;
	return { windows: out, dominantSeries: series, drift: { from, to, changed: from !== to } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Substrate B (content) + C (shape) — resonance on the actual CONTENTS and SHAPE
// of the mindscape, not just computed cognitive style. See design §1b.
//   B: the user's topic-cluster (territory/realm) embedding centroids vs each
//      figure's semantic-fingerprint embedding (same Nomic 768-D space).
//   C: the mindscape's structure → constellation distribution + topology→dims.
// Figure embeddings are PUBLIC construct data (ship as an asset); user topic
// centroids are intimate (CLAUDE.md §7) — never log, match in the secure layer.

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** A topic cluster from the user's mindscape (a territory or realm). */
export interface TopicCentroid {
	label: string;
	/** 768-D embedding centroid (mean of the cluster's message embeddings). */
	vector: number[];
	/** Relative importance (vitality / message share). Default 1. */
	weight?: number;
}

/** Figure semantic-fingerprint embeddings, keyed by exact figure name (768-D). */
export type FigureEmbeddings = Record<string, number[]>;

function rawCosine(a: number[], b: number[]): number {
	let d = 0, na = 0, nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}
function meanVector(vs: number[][]): number[] {
	const dim = vs[0]?.length ?? 0;
	const m = new Array(dim).fill(0);
	for (const v of vs) for (let i = 0; i < dim; i++) m[i] += v[i] / vs.length;
	return m;
}
const subVec = (a: number[], m: number[] | null) => (m ? a.map((x, i) => x - m[i]) : a);

export interface ContentResonanceResult {
	/** Figures ranked by aggregate content overlap with the mindscape. */
	figureScores: { name: string; score: number; affinity: number }[];
	/** Per topic cluster: the nearest figures (the direct "your topics → figures" read). */
	byTopic: { topic: string; weight: number; top: { name: string; similarity: number }[] }[];
}

/**
 * Content resonance — match the user's topic-cluster centroids against figure
 * fingerprint embeddings. "What you think about ≈ what this figure was about."
 * @param opts.center  mean-center against the figure-embedding centroid first
 *   (removes anisotropy bias). Default true.
 * @param opts.aggregate  per-figure score across topics: 'weightedMean' (default,
 *   overall concern overlap) or 'max' (best single-topic hit).
 */
export function contentResonance(
	topics: TopicCentroid[],
	embeddings: FigureEmbeddings,
	opts: { topN?: number; perTopic?: number; center?: boolean; aggregate?: 'weightedMean' | 'max' } = {},
): ContentResonanceResult {
	const names = Object.keys(embeddings);
	if (!topics.length || !names.length) return { figureScores: [], byTopic: [] };
	const center = opts.center ?? true;
	const mean = center ? meanVector(names.map((n) => embeddings[n])) : null;
	const fvec = (n: string) => subVec(embeddings[n], mean);
	const tvec = (t: TopicCentroid) => subVec(t.vector, mean);
	const perTopic = opts.perTopic ?? 3;
	const agg = opts.aggregate ?? 'weightedMean';

	const byTopic = topics.map((t) => {
		const tv = tvec(t);
		const sims = names.map((n) => ({ name: n, similarity: rawCosine(tv, fvec(n)) }))
			.sort((a, b) => b.similarity - a.similarity);
		return { topic: t.label, weight: t.weight ?? 1, top: sims.slice(0, perTopic) };
	});

	const totalW = topics.reduce((s, t) => s + (t.weight ?? 1), 0) || 1;
	const figureScores = names.map((n) => {
		const fv = fvec(n);
		const score = agg === 'max'
			? Math.max(...topics.map((t) => rawCosine(tvec(t), fv)))
			: topics.reduce((s, t) => s + (t.weight ?? 1) * rawCosine(tvec(t), fv), 0) / totalW;
		return { name: n, score, affinity: Math.round(((score + 1) / 2) * 100) };
	}).sort((a, b) => b.score - a.score);

	return { figureScores: figureScores.slice(0, opts.topN ?? figureScores.length), byTopic };
}

/** The user's archetype distribution induced by their topics — substrate C input.
 *  Each topic votes (by weight) for its nearest figure's constellation. */
export function constellationDistributionFromTopics(
	topics: TopicCentroid[],
	embeddings: FigureEmbeddings,
	opts: { center?: boolean } = {},
): Record<string, number> {
	const res = contentResonance(topics, embeddings, { perTopic: 1, center: opts.center });
	const dist: Record<string, number> = {};
	for (const bt of res.byTopic) {
		const fig = bt.top[0] ? figureByName(bt.top[0].name) : undefined;
		if (fig) dist[fig.constellation] = (dist[fig.constellation] ?? 0) + bt.weight;
	}
	return dist;
}

/** Mindscape topology descriptors (all 0–1), from the existing mindscape metrics. */
export interface MindscapeShape {
	/** Territory spread / breadth (e.g. normalized M2 entropy). */
	breadth?: number;
	/** Cross-territory bridge density / mean degree. */
	integration?: number;
	/** Exploration ratio / novelty. */
	exploration?: number;
}

/** Map mindscape shape → the cognitive dimensions structure informs (design §1b/C-1).
 *  Returns a partial vector to MERGE with text-derived dims (caller decides blend). */
export function shapeToCognitive(s: MindscapeShape): Partial<CognitiveDimensions> {
	const out: Partial<CognitiveDimensions> = {};
	if (s.breadth != null) out.epistemic_breadth = clamp01(s.breadth);
	if (s.integration != null) out.integrative_complexity = clamp01(s.integration);
	if (s.exploration != null) out.creative_latitude = clamp01(s.exploration);
	return out;
}

export interface CompositeMatch {
	figure: FigureProfile;
	/** Blended score in [0,1]. */
	score: number;
	affinity: number;
	/** Per-substrate components (each 0–1), present only when that substrate ran. */
	parts: { cognitive?: number; content?: number; shape?: number };
}

/**
 * Composite resonance — triangulate cognitive STYLE (A) + semantic CONTENT (B)
 * + mindscape SHAPE (C). Weights renormalize over whichever substrates are
 * supplied (cold-start = A only; full = A+B+C). Each `parts` component is kept
 * so the UI can explain *why* a figure resonates across all three.
 */
export function compositeResonance(opts: {
	profile?: UserProfile;
	topics?: TopicCentroid[];
	embeddings?: FigureEmbeddings;
	/** Archetype distribution for the shape bonus (see constellationDistributionFromTopics). */
	constellationWeights?: Record<string, number>;
	weights?: { cognitive?: number; content?: number; shape?: number };
	topN?: number;
	space?: ResonanceSpace;
}): CompositeMatch[] {
	const haveCog = !!opts.profile;
	const haveContent = !!(opts.topics?.length && opts.embeddings && Object.keys(opts.embeddings).length);
	const haveShape = !!(opts.constellationWeights && Object.keys(opts.constellationWeights).length);

	let wA = haveCog ? (opts.weights?.cognitive ?? 1.0) : 0;
	let wB = haveContent ? (opts.weights?.content ?? 1.2) : 0;
	let wC = haveShape ? (opts.weights?.shape ?? 0.5) : 0;
	const wsum = wA + wB + wC || 1;
	wA /= wsum; wB /= wsum; wC /= wsum;

	const cogMap = new Map<string, number>();
	if (haveCog) {
		for (const m of resonanceMatch(opts.profile!, { topN: FIGURES.length, driverCount: 0, space: opts.space })) {
			cogMap.set(m.figure.name, (m.similarity + 1) / 2); // [-1,1] → [0,1]
		}
	}
	const contentMap = new Map<string, number>();
	if (haveContent) {
		for (const fs of contentResonance(opts.topics!, opts.embeddings!).figureScores) {
			contentMap.set(fs.name, (fs.score + 1) / 2);
		}
	}
	const cmax = haveShape ? Math.max(1e-9, ...Object.values(opts.constellationWeights!)) : 1;

	const scored = FIGURES.map((f) => {
		const cognitive = haveCog ? (cogMap.get(f.name) ?? 0) : undefined;
		const content = haveContent ? (contentMap.get(f.name) ?? 0) : undefined;
		const shape = haveShape ? (opts.constellationWeights![f.constellation] ?? 0) / cmax : undefined;
		const score = wA * (cognitive ?? 0) + wB * (content ?? 0) + wC * (shape ?? 0);
		return { figure: f, score, affinity: Math.round(score * 100), parts: { cognitive, content, shape } };
	}).sort((a, b) => b.score - a.score);

	return scored.slice(0, opts.topN ?? 5);
}
