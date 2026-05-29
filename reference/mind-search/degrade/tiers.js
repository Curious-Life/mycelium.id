/**
 * Tier orchestrator — the resilience model.
 *
 * Picks the highest-quality tier the current health state can support,
 * runs that tier's op, and on failure falls through to the next tier
 * down. Never returns silent empty — if every tier fails, throws
 * `MindSearchError(class='all_tiers_exhausted')`.
 *
 * Tier table (also documented in mind-search/README.md):
 *
 *   Tier 0   embed + ANN + BM25 + temporal + Haiku rerank   (precision='high')
 *   Tier 1   embed + ANN + BM25 + temporal                  (default)
 *   Tier 2   BM25 + temporal (no semantic)                  (embed down)
 *   Tier 3   BM25 on hot subset                             (index partial)
 *   Tier 4   SQL LIKE on last N messages                    (index unavailable)
 *
 * For PR 9 we wire Tiers 0, 1, 2, 4. Tier 3 is selected only when the
 * caller explicitly signals a partial-index state (the InvertedIndex
 * doesn't currently model that — PR 8 will once the rebuild path is
 * wired).
 *
 * Determinism contract (test-enforced):
 *   • For any health snapshot, `chooseTier` returns the same tier number.
 *   • Tier-op throws → log a `mind_search.tier_fallback` event and try
 *     the next tier. Never bubbles the inner error to the caller; the
 *     orchestrator surfaces only `MindSearchError(all_tiers_exhausted)`
 *     when even Tier 4 fails.
 *   • Tier-op returning [] is success, not failure. The result carries
 *     `degraded` (true if actual tier > target tier or actual tier ≥ 2),
 *     and a `reason` when degradation happened.
 *
 * No content flows through this module. Logs and result fields carry
 * tier numbers, error classes, and timing — never tokens or hits.
 */

import { MindSearchError } from '../errors.js';

/**
 * @typedef {0|1|2|3|4} Tier
 *
 * @typedef {object} TierOpResult
 * @property {Array<{ id: string, score: number }>} hits
 *
 * @typedef {(query: object) => Promise<Array<{ id: string, score: number }>>} TierOp
 *
 * @typedef {object} TierOps
 * @property {TierOp} [tier0]
 * @property {TierOp} [tier1]
 * @property {TierOp} [tier2]
 * @property {TierOp} [tier3]
 * @property {TierOp} [tier4]
 *
 * @typedef {object} TierResult
 * @property {Array<{ id: string, score: number }>} hits
 * @property {boolean} degraded
 * @property {Tier} tier
 * @property {string} [reason]
 * @property {number} takenMs
 *
 * @typedef {object} HealthSnapshot
 * @property {boolean} embedHealthy
 * @property {boolean} indexLoaded
 * @property {boolean} d1Healthy
 * @property {boolean} [indexPartial]   optional; if true and !indexLoaded, prefer Tier 3
 *
 * @typedef {object} RunTieredDeps
 * @property {{ snapshot: () => Promise<HealthSnapshot>, invalidate: (name?: string) => void }} probe
 * @property {object} [logger]
 */

/**
 * Pick a target tier from a health snapshot + caller's precision.
 *
 * Returns null if the floor (Tier 4) is also unavailable — caller
 * should throw `MindSearchError(all_tiers_exhausted)`.
 *
 * @param {HealthSnapshot} health
 * @param {{ precision?: 'normal'|'high' }} [opts]
 * @returns {Tier|null}
 */
export function chooseTier(health, opts = {}) {
  const precision = opts.precision ?? 'normal';
  if (precision === 'high' && health.embedHealthy && health.indexLoaded) return 0;
  if (health.embedHealthy && health.indexLoaded) return 1;
  if (health.indexLoaded) return 2;
  if (health.indexPartial) return 3;
  if (health.d1Healthy) return 4;
  return null;
}

/**
 * Run the tier orchestrator.
 *
 * @param {object} query
 * @param {TierOps} ops
 * @param {RunTieredDeps} deps
 * @returns {Promise<TierResult>}
 */
export async function runTiered(query, ops, deps) {
  if (!ops || typeof ops !== 'object') {
    throw new TypeError('runTiered: ops required');
  }
  if (!deps || !deps.probe || typeof deps.probe.snapshot !== 'function') {
    throw new TypeError('runTiered: deps.probe.snapshot required');
  }
  const logger = deps.logger ?? null;
  const precision = (query && query.precision) === 'high' ? 'high' : 'normal';

  const startedAt = nowMs();
  const health = await deps.probe.snapshot();
  const target = chooseTier(health, { precision });

  if (target === null) {
    throw new MindSearchError('all tiers exhausted: no probe-passing tier available', {
      cls: 'all_tiers_exhausted',
      meta: { health },
    });
  }

  // Walk down from target. Skip tiers without an op (caller didn't supply one).
  let lastError = null;
  for (let t = target; t <= 4; t++) {
    const op = ops[`tier${t}`];
    if (typeof op !== 'function') continue;
    try {
      const tierStartedAt = nowMs();
      const hits = await op(query);
      const tookMs = nowMs() - startedAt;
      if (!Array.isArray(hits)) {
        throw new MindSearchError(`tier ${t} op returned non-array`, {
          cls: 'tier_contract_violation',
          meta: { tier: t, returnedType: typeof hits },
        });
      }
      const fallback = t > target;
      const degraded = fallback || t >= 2;
      const result = {
        hits,
        degraded,
        tier: /** @type {Tier} */ (t),
        takenMs: tookMs,
      };
      if (degraded) {
        result.reason = fallback
          ? `fallback_from_tier_${target}_to_${t}`
          : `tier_${t}_below_semantic`;
      }
      logger?.debug?.({
        evt: 'mind_search.tier.complete',
        tier: t,
        target,
        degraded,
        hitCount: hits.length,
        tierMs: nowMs() - tierStartedAt,
      });
      return result;
    } catch (err) {
      lastError = err;
      // Drop probe caches so the next query re-checks live state.
      // The tier op failed despite the probe saying "good" — assume the
      // probe was stale.
      try { deps.probe.invalidate(); } catch { /* probe invalidate is best-effort */ }
      logger?.warn?.({
        evt: 'mind_search.tier.fallback',
        fromTier: t,
        targetTier: target,
        errorClass: err && err.class ? err.class : 'unknown',
      });
      // continue to next tier
    }
  }

  // Nothing succeeded. Surface a typed error so the caller (LocalBackend
  // in PR 8) can convert into an HTTP 503-equivalent for the agent.
  throw new MindSearchError('all tiers exhausted: every available tier failed', {
    cls: 'all_tiers_exhausted',
    meta: {
      target,
      lastErrorClass: lastError && lastError.class ? lastError.class : 'unknown',
    },
    cause: lastError ?? undefined,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function nowMs() {
  // performance.now() is monotonic; Date.now() is wall-clock and can jump.
  // For latency measurement we want monotonic.
  return performance.now();
}
