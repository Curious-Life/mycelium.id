// Per-process, userId-keyed SWR caches for the Mindscape response.
//
// `GET /portal/mindscape` recomputes the whole 3D scene. Measured on a 70k-point
// at-rest SQLCipher vault, the cost splits sharply:
//   - the POINTS (3D geometry: getPoints — plaintext landscape_x/y/z over the
//     whole corpus) are ~234 ms — the dominant cost, AND the single biggest
//     payload (the render-loop input);
//   - the TEXT (territory/theme profiles — decrypting essence/story/chronicle) is
//     only ~50 ms (a few hundred rows).
// The two also change on DIFFERENT events:
//   - points change ONLY when clustering re-runs (Generate) or points are deleted
//     out-of-band (document delete, message forget/edit);
//   - text changes additionally on chronicle/narrative writes — which fire
//     CONSTANTLY during background enrichment, yet never move a single point.
// A single cache busted on narrative writes therefore threw away the expensive
// geometry on (almost) every open. So we keep TWO caches: a DURABLE points cache
// that narrative busts do NOT touch, and the full-aggregate cache that does. The
// frontend renders points first (warm → instant) and fills text in after.
//
// Each cache is serve-stale-while-revalidate with a per-cache generation counter:
// if a bust fires while a recompute is in flight, that recompute (which may have
// read pre-mutation state) is barred from poisoning the cache. In-memory only;
// never persisted; keyed by userId (V1 single-user, keyed defensively).

const TTL_MS = 5 * 60 * 1000; // safety net only — explicit busts keep it fresh

/** One independent SWR cache (its own store, in-flight latch, generation). */
function makeSwrCache() {
  const _cache = new Map();    // userId -> { value, at }
  const _inFlight = new Map(); // userId -> Promise
  let _gen = 0;                // bumped on every bust of THIS cache

  async function get(userId, computeFn) {
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

  function bust(userId) {
    _gen++;
    if (userId == null) _cache.clear();
    else _cache.delete(userId);
  }

  return { get, bust };
}

const _points = makeSwrCache(); // durable: only point-mutating events bust it
const _full = makeSwrCache();   // full aggregate: narrative writes bust this one

/**
 * Serve the cached FULL aggregate (points + text). Recomputes on miss/TTL.
 * @param {string} userId
 * @param {() => Promise<any>} computeFn  produces the full aggregate
 */
export async function getMindscapeCached(userId, computeFn) {
  return _full.get(userId, computeFn);
}

/**
 * Serve the cached POINTS-only payload ({ nodes, meta }) — the 3D geometry. This
 * cache is DURABLE: narrative/chronicle busts (bustMindscape) do NOT drop it; only
 * a real point change (bustMindscapePoints) does. So the visuals stay warm across
 * the enrichment cycles that constantly rewrite text.
 * @param {string} userId
 * @param {() => Promise<any>} computeFn  produces { nodes, meta }
 */
export async function getMindscapePointsCached(userId, computeFn) {
  return _points.get(userId, computeFn);
}

/**
 * Invalidate the FULL aggregate only (the text/narrative changed). Points stay
 * cached. Call after chronicle/narrative writes. Bumps the full-cache generation.
 * @param {string} [userId]  omit/null to clear all users
 */
export function bustMindscape(userId) {
  _full.bust(userId);
}

/**
 * Invalidate the points (and, transitively, the full aggregate that embeds them).
 * Call ONLY when points actually change — clustering re-ran, or a point was
 * deleted out-of-band (document delete, message forget/edit).
 * @param {string} [userId]  omit/null to clear all users
 */
export function bustMindscapePoints(userId) {
  _points.bust(userId);
  _full.bust(userId);
}
