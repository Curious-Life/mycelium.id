// Per-process, userId-keyed SWR cache for the Mindscape aggregate response.
//
// `GET /portal/mindscape` recomputes the whole 3D scene from a decrypting scan of
// the entire clustering-point corpus (tens of thousands of rows on a multi-GB
// at-rest SQLCipher vault) on EVERY open — multi-second, uncached. The aggregate
// only changes when:
//   - a clustering (Generate) or measurement (Measure) job completes, or
//   - chronicle narration writes territory/realm narrative, or
//   - clustering_points are deleted out-of-band (document delete, message
//     forget, message edit — see src/db/{documents,messages}.js).
// So we serve it from a per-user cache and bust on exactly those events, with a
// long TTL purely as a safety net. In-memory only; never persisted; keyed by
// userId for cross-user isolation (V1 is single-user, but keyed defensively).
// Mirrors the serve-stale-while-revalidate latch of db.messages.embedBacklogCached.
//
// A generation counter guards the write-back: if a bust fires while a recompute
// is in flight, that recompute (which may have read pre-mutation state) is barred
// from poisoning the cache, and the next read recomputes fresh.

const TTL_MS = 5 * 60 * 1000; // safety net only — explicit busts keep it fresh

const _cache = new Map();    // userId -> { value, at }
const _inFlight = new Map(); // userId -> Promise
let _gen = 0;                // bumped on every bust

/**
 * Serve the cached aggregate for `userId`, recomputing via `computeFn` when the
 * entry is missing or older than TTL. Single-flight per user: concurrent callers
 * share one recompute. Serves stale instantly while revalidating in the
 * background (only the cold start awaits the first scan).
 * @param {string} userId
 * @param {() => Promise<any>} computeFn  produces the aggregate (the slow scan)
 */
export async function getMindscapeCached(userId, computeFn) {
  const cached = _cache.get(userId);
  if (cached && (Date.now() - cached.at) < TTL_MS) return cached.value;

  let inFlight = _inFlight.get(userId);
  if (!inFlight) {
    const genAtStart = _gen;
    inFlight = Promise.resolve()
      .then(computeFn)
      .then((value) => {
        // Drop the result if a bust raced this recompute — it may be stale.
        if (genAtStart === _gen) _cache.set(userId, { value, at: Date.now() });
        return value;
      })
      .finally(() => { _inFlight.delete(userId); });
    _inFlight.set(userId, inFlight);
  }

  if (cached) return cached.value; // serve stale instantly while revalidating
  return inFlight;                 // cold start only: await the first scan once
}

/**
 * Invalidate the cached aggregate. Call after any mutation of the source data
 * (job completion, chronicle write, clustering_points delete). Bumps the
 * generation so an in-flight recompute can't write back stale data.
 * @param {string} [userId]  omit/null to clear all users
 */
export function bustMindscape(userId) {
  _gen++;
  if (userId == null) _cache.clear();
  else _cache.delete(userId);
}
