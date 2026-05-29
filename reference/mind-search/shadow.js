/**
 * Shadow comparator — side-by-side retrieval comparison.
 *
 * Given two ranked-result lists from two retrieval backends, computes
 * three metrics that measure how similarly they rank the same query:
 *
 *   • jaccard@K   — set similarity of the top-K id sets
 *                   |A_K ∩ B_K| / |A_K ∪ B_K|
 *
 *   • spearman    — rank correlation over ids that appear in BOTH lists.
 *                   ρ = 1 - 6Σd² / (n(n²-1)), where d is rank difference.
 *                   Returns null when fewer than 2 ids overlap (undefined).
 *
 *   • latencyDelta — shadow.takenMs - primary.takenMs (ms; signed).
 *
 * Used at two boundaries:
 *
 *   1. Test / bench mode: `runShadow(query, { primary, shadow, ... })`
 *      runs both backends, awaits both, emits the comparison event.
 *
 *   2. Production hot path: `compareToShadow(query, primaryResult, { shadow, ... })`
 *      takes a primary result the caller already has, runs ONLY the
 *      shadow backend, emits the event. Caller invokes fire-and-forget
 *      so the primary's user-visible latency is unaffected.
 *
 * Logged event shape (`mind_search.shadow.compare`):
 *
 *   {
 *     evt: 'mind_search.shadow.compare',
 *     k: 5,
 *     jaccard_at_k: number,
 *     spearman: number | null,
 *     latency_delta_ms: number,
 *     primary_tier: number | null,
 *     shadow_tier: number | null,
 *     primary_hits: number,
 *     shadow_hits: number,
 *     overlap: number,                  // |A ∩ B|
 *   }
 *
 * Per CLAUDE.md §1, NOTHING content-shaped flows here — the metrics are
 * derived from id sets and timing only. Hits are passed in by id; the
 * shadow runner never sees query text or document text in its log path.
 *
 * Failure modes:
 *
 *   • Either backend throws → caller's responsibility for the awaited
 *     `runShadow`; for `compareToShadow` we log a `mind_search.shadow.error`
 *     event and return null. Shadow failures NEVER bubble to user-facing
 *     code paths.
 */

const DEFAULT_K = 5;

/**
 * @typedef {{ id: string, score?: number }} Hit
 *
 * @typedef {{ hits: Hit[], tier?: number | null, takenMs?: number }} BackendResult
 *
 * @typedef {object} ShadowMetrics
 * @property {number} jaccard_at_k
 * @property {number | null} spearman
 * @property {number} latency_delta_ms
 * @property {number | null} primary_tier
 * @property {number | null} shadow_tier
 * @property {number} primary_hits
 * @property {number} shadow_hits
 * @property {number} overlap
 * @property {number} k
 */

// ── Pure metrics ────────────────────────────────────────────────────────

/**
 * Jaccard similarity over two arbitrary id sets.
 *
 *   J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Both empty → 1 (vacuous match; convention).
 * One empty → 0.
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Jaccard@K — Jaccard over top-K of two ranked lists.
 *
 * @param {string[]} listA   ranked ids from one backend
 * @param {string[]} listB   ranked ids from the other backend
 * @param {number} [k=5]
 * @returns {number}
 */
export function jaccardAtK(listA, listB, k = DEFAULT_K) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) {
    throw new TypeError('jaccardAtK: list args must be arrays');
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new TypeError('jaccardAtK: k must be a positive integer');
  }
  return jaccard(listA.slice(0, k), listB.slice(0, k));
}

/**
 * Spearman rank correlation over the ids that appear in BOTH lists.
 *
 *   ρ = 1 - (6 Σ d²) / (n (n² - 1))
 *
 * d_i is the rank difference for id i.  n is the count of shared ids.
 * Returns null when n < 2 (undefined for fewer than two pairs).
 *
 * Ranks are computed among shared ids only — i.e., for each list we
 * take the subsequence of shared ids in their original order, and
 * assign ranks 1..n to that subsequence. This is necessary because
 * Spearman's closed-form ρ only stays in [-1, 1] when both rank
 * vectors are permutations of 1..n. Using absolute list-position
 * ranks across non-overlapping lists violates that and lets ρ blow
 * past the bounds.
 *
 * Within-list duplicates take their FIRST occurrence's relative rank
 * — well-defined if they ever appear, though we don't expect them in
 * retrieval output.
 *
 * @param {string[]} listA
 * @param {string[]} listB
 * @returns {number | null}      in [-1, 1] when defined; null otherwise
 */
export function spearmanByIds(listA, listB) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) {
    throw new TypeError('spearmanByIds: list args must be arrays');
  }
  // First-occurrence position in each list (still in absolute index space).
  const firstA = new Map();
  for (let i = 0; i < listA.length; i++) {
    if (!firstA.has(listA[i])) firstA.set(listA[i], i);
  }
  const firstB = new Map();
  for (let i = 0; i < listB.length; i++) {
    if (!firstB.has(listB[i])) firstB.set(listB[i], i);
  }
  // Shared ids — collected in order of first appearance in A so the
  // re-ranking step below assigns deterministic ranks.
  const shared = [];
  for (const id of firstA.keys()) {
    if (firstB.has(id)) shared.push(id);
  }
  const n = shared.length;
  if (n < 2) return null;

  // Re-rank the shared subsequence within each list (1..n).
  const sharedSorted = [...shared].sort((x, y) => firstA.get(x) - firstA.get(y));
  const relRankA = new Map();
  sharedSorted.forEach((id, i) => relRankA.set(id, i + 1));

  const sharedSortedB = [...shared].sort((x, y) => firstB.get(x) - firstB.get(y));
  const relRankB = new Map();
  sharedSortedB.forEach((id, i) => relRankB.set(id, i + 1));

  let sumDiffSq = 0;
  for (const id of shared) {
    const d = relRankA.get(id) - relRankB.get(id);
    sumDiffSq += d * d;
  }
  return 1 - (6 * sumDiffSq) / (n * (n * n - 1));
}

// ── Shadow runners ──────────────────────────────────────────────────────

/**
 * @typedef {object} ShadowDeps
 * @property {{ query: (q: object) => Promise<BackendResult> }} primary
 * @property {{ query: (q: object) => Promise<BackendResult> }} shadow
 * @property {object} [logger]
 * @property {number} [k=5]
 */

/**
 * Run BOTH backends concurrently, await both, emit the comparison event,
 * return the metrics. Used in tests and the bench harness.
 *
 * Throws if either backend throws — caller should catch (or use
 * compareToShadow which is more forgiving).
 *
 * @param {object} query
 * @param {ShadowDeps} deps
 * @returns {Promise<ShadowMetrics>}
 */
export async function runShadow(query, deps) {
  validateDeps(deps, 'runShadow');
  const [primaryResult, shadowResult] = await Promise.all([
    deps.primary.query(query),
    deps.shadow.query(query),
  ]);
  return emitComparison(primaryResult, shadowResult, deps);
}

/**
 * Production hot-path variant. Caller has already run the primary; we
 * just run shadow, compare, log. Errors from the shadow backend are
 * caught and logged as `mind_search.shadow.error`; we never bubble.
 *
 * Designed to be called fire-and-forget:
 *
 *   const result = await primary.query(q);
 *   compareToShadow(q, result, { shadow, logger }).catch(() => {});
 *   return result;
 *
 * @param {object} query
 * @param {BackendResult} primaryResult
 * @param {{ shadow: { query: (q: object) => Promise<BackendResult> }, logger?: object, k?: number }} deps
 * @returns {Promise<ShadowMetrics | null>}
 */
export async function compareToShadow(query, primaryResult, deps) {
  if (!deps || !deps.shadow || typeof deps.shadow.query !== 'function') {
    throw new TypeError('compareToShadow: deps.shadow.query required');
  }
  let shadowResult;
  try {
    shadowResult = await deps.shadow.query(query);
  } catch (err) {
    emit(deps.logger, 'warn', 'shadow.error', {
      errorClass: err && err.class ? err.class : 'unknown',
    });
    return null;
  }
  return emitComparison(primaryResult, shadowResult, deps);
}

// ── Internal: shape + emit ─────────────────────────────────────────────

function emitComparison(primaryResult, shadowResult, deps) {
  const k = Number.isInteger(deps.k) && deps.k >= 1 ? deps.k : DEFAULT_K;
  const primaryIds = idList(primaryResult);
  const shadowIds  = idList(shadowResult);

  // Compute overlap once and reuse for jaccard.
  const setA = new Set(primaryIds.slice(0, k));
  const setB = new Set(shadowIds.slice(0, k));
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  const jaccard_at_k = (setA.size === 0 && setB.size === 0) ? 1
                     : (union === 0 ? 1 : inter / union);

  const metrics = {
    k,
    jaccard_at_k,
    spearman: spearmanByIds(primaryIds, shadowIds),
    latency_delta_ms: (numOr(shadowResult.takenMs, 0)) - (numOr(primaryResult.takenMs, 0)),
    primary_tier: tierOrNull(primaryResult),
    shadow_tier:  tierOrNull(shadowResult),
    primary_hits: primaryIds.length,
    shadow_hits:  shadowIds.length,
    overlap: inter,
  };

  emit(deps.logger, 'info', 'shadow.compare', metrics);
  return metrics;
}

function idList(result) {
  if (!result || !Array.isArray(result.hits)) return [];
  const ids = [];
  for (const h of result.hits) {
    if (h && typeof h.id === 'string' && h.id.length > 0) ids.push(h.id);
  }
  return ids;
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function tierOrNull(result) {
  return (result && (result.tier ?? null) !== null) ? result.tier : null;
}

function validateDeps(deps, fnName) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError(`${fnName}: deps required`);
  }
  if (!deps.primary || typeof deps.primary.query !== 'function') {
    throw new TypeError(`${fnName}: deps.primary.query required`);
  }
  if (!deps.shadow || typeof deps.shadow.query !== 'function') {
    throw new TypeError(`${fnName}: deps.shadow.query required`);
  }
}

function emit(logger, level, event, labels) {
  if (!logger) return;
  const child = typeof logger.child === 'function'
    ? logger.child({ mod: 'mind-search.shadow' })
    : logger;
  const fn = child[level] ?? child.info;
  if (typeof fn !== 'function') return;
  fn.call(child, { evt: `mind_search.${event}`, ...labels });
}
