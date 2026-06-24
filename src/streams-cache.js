// Per-process, (userId, windowDays)-keyed SWR cache for the Streams source
// spectrum (db.streams.spectrum).
//
// `GET /portal/streams/spectrum` recomputes an 8-query GROUP-BY-source aggregate
// across messages + documents + health_daily + tasks on EVERY Streams open — a
// measured 7–12s on a multi-GB at-rest SQLCipher vault (full-table page scans).
// The 0027 covering indexes cut the cold compute to sub-second; this cache makes
// the common case (repeat opens, the 2.5s activity poller, fast section switches)
// near-instant.
//
// FRESHNESS — TTL, not explicit bust. The spectrum is a RECENCY view (which
// sources are active, a daily-bucket sparkline, today's counts). Its inputs
// change continuously as messages are ingested, so an explicit bust would fire on
// the ingest hot path for negligible gain: 60s of staleness is invisible here (a
// new source appears in the filter bar within a minute; the daily sparkline can't
// even resolve sub-minute). So the TTL IS the coalescing — no coupling into
// capture.js / documents.js. (This refines the design doc's "coalesced bust":
// the bust degenerated to the TTL once we accepted recency-staleness.)
// `bustSpectrum` is still exported for explicit invalidation (e.g. tests, or a
// future hard-refresh), but is intentionally not wired into ingest.
//
// In-memory only; never persisted; keyed by userId for cross-user isolation
// (V1 is single-user, keyed defensively). Mirrors src/mindscape-cache.js.

const TTL_MS = 60 * 1000; // recency view — 60s staleness is invisible

const _cache = new Map();    // `${userId}:${windowDays}` -> { value, at }
const _inFlight = new Map(); // key -> Promise
let _gen = 0;                // bumped on every bust

/**
 * Serve the cached spectrum for (userId, windowDays), recomputing via `computeFn`
 * when missing or older than TTL. Single-flight per key; serves stale instantly
 * while revalidating in the background (only the cold start awaits the compute).
 * @param {string} userId
 * @param {number} windowDays
 * @param {() => Promise<any>} computeFn  produces the spectrum (the slow scan)
 */
export async function getSpectrumCached(userId, windowDays, computeFn) {
  const key = `${userId}:${windowDays}`;
  const cached = _cache.get(key);
  if (cached && (Date.now() - cached.at) < TTL_MS) return cached.value;

  let inFlight = _inFlight.get(key);
  if (!inFlight) {
    const genAtStart = _gen;
    inFlight = Promise.resolve()
      .then(computeFn)
      .then((value) => {
        // Drop the result if a bust raced this recompute.
        if (genAtStart === _gen) _cache.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => { _inFlight.delete(key); });
    _inFlight.set(key, inFlight);
  }

  if (cached) return cached.value; // serve stale instantly while revalidating
  return inFlight;                 // cold start only: await the first compute once
}

/**
 * Invalidate cached spectra. Omit `userId` to clear all; otherwise clears every
 * windowDays variant for that user. Bumps the generation so an in-flight recompute
 * can't write back stale data.
 * @param {string} [userId]
 */
export function bustSpectrum(userId) {
  _gen++;
  if (userId == null) { _cache.clear(); return; }
  const prefix = `${userId}:`;
  for (const key of _cache.keys()) if (key.startsWith(prefix)) _cache.delete(key);
}
