// src/mindscape-freshness.js — the ONE owner of "is the mindscape still current?".
//
// WHY THIS FILE EXISTS (defect D-004, recurrence ↻1).
// POST /mycelium/generate carried a debounce that skipped a rebuild whenever ANY
// clustering_points row existed (portal-mindscape.js, pre-fix :637-644). The debounce
// itself is NECESSARY — MindscapeView auto-POSTs generate on every load, and re-clustering
// the full set on every app launch blanks the map for minutes — but it had NO STALENESS
// CONDITION, so once a map existed it could never catch up. The operator reported the
// three visible faces of that one line:
//   1. "i have 2510 points byt the mycelium and map that is shown ... only has 369 points"
//   2. "it shows me a text saying map already built; pass ?force=1 to rebuild. this i cant
//      do from the UI as a user"
//   3. "the cluster names dont show, they say territory 2 etc.... not the actual name"
// (3) is downstream of the same line: pipeline/describe-clusters.js is the only writer of
// realms.name / territory_profiles.name and runs as Generate step 3/16 — the step the skip
// never reached. `Territory {id}` is the NULL-name fallback (portal-measurement.js:1133).
//
// THE PREDICATE. Two inputs, in priority order:
//
//   A. `builtAtEmbedded` — the embedded-message count recorded when the last real
//      clustering run COMPLETED (src/jobs.js close handler → generate-stats.js). This is
//      the authoritative baseline: drift = embedded_now − builtAtEmbedded is exactly "how
//      much the vault grew since the map was made", and after a rebuild it is 0 BY
//      CONSTRUCTION. That self-zeroing is what keeps the debounce's real property intact —
//      a fresh map is skipped on every subsequent load, forever, with no rebuild loop.
//
//   B. `mapped` (clustering_points with landscape_x) vs `embedded` — the FALLBACK, used
//      only when no baseline has been recorded (a map built by a build that predates this
//      file — precisely the operator's vault, and the only way their 369/2510 map can ever
//      be diagnosed as stale). ⚠️ This comparison is deliberately NOT the primary: cluster.py
//      does not necessarily emit one point per embedded message, so a systematic mapped <
//      embedded gap would re-trigger forever if it governed the steady state. It cannot:
//      the FIRST rebuild it causes writes a baseline, and rule A governs from then on. So
//      the fallback is bounded at ONE rebuild per vault, then it is never consulted again.
//
// TOLERANCE. Stale requires BOTH a relative and an absolute margin to be exceeded:
//   drift >= MIN_ABS_DRIFT  AND  drift / embedded > DRIFT_TOLERANCE
// The relative test alone would churn a small vault on a handful of new messages; the
// absolute test alone would churn a large one. Both together mean "a meaningful fraction
// AND a meaningful number" — a normal day's messages never trip it, a 2141-message gap
// always does.

/** Below this many unmapped messages, a rebuild is never worth blanking the map for. */
export const MIN_ABS_DRIFT = 10;
/** Fraction of the embedded corpus that may be missing from the map before it is STALE. */
export const DRIFT_TOLERANCE = 0.10;

/**
 * @param {{ embedded:number, mapped:number, builtAtEmbedded:number|null }} input
 * @returns {{ embedded:number, mapped:number, builtAtEmbedded:number|null, basis:'baseline'|'mapped',
 *             drift:number, driftPct:number, stale:boolean, built:boolean }}
 */
export function evaluateFreshness({ embedded, mapped, builtAtEmbedded }) {
  const emb = Math.max(0, Number(embedded) || 0);
  const map = Math.max(0, Number(mapped) || 0);
  // ⚠️ `builtAtEmbedded == null` is checked FIRST and explicitly. `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so a finiteness test alone silently promotes "no baseline
  // recorded" into "the map was built when 0 messages were embedded" — which makes every
  // vault permanently stale (drift = embedded − 0) and re-clusters on every app launch. The
  // gate caught exactly this (S2/S3 red on the first run of this file).
  const base = builtAtEmbedded == null || !Number.isFinite(Number(builtAtEmbedded)) || Number(builtAtEmbedded) < 0
    ? null : Number(builtAtEmbedded);
  const built = map > 0;

  // No map yet ⇒ nothing to be stale about; the caller generates (first-run path, unchanged).
  if (!built) {
    return { embedded: emb, mapped: map, builtAtEmbedded: base, basis: base != null ? 'baseline' : 'mapped', drift: 0, driftPct: 0, stale: false, built: false };
  }

  const basis = base != null ? 'baseline' : 'mapped';
  const reference = base != null ? base : map;
  const drift = Math.max(0, emb - reference);
  const driftPct = emb > 0 ? drift / emb : 0;
  const stale = drift >= MIN_ABS_DRIFT && driftPct > DRIFT_TOLERANCE;
  return { embedded: emb, mapped: map, builtAtEmbedded: base, basis, drift, driftPct, stale, built: true };
}

/**
 * Count the points that actually carry geometry (a row without landscape_x is not ON the map).
 * @returns {Promise<number>}
 */
export async function countMappedPoints(db, userId) {
  const r = await db.rawQuery(
    'SELECT COUNT(*) AS c FROM clustering_points WHERE user_id = ? AND landscape_x IS NOT NULL',
    [userId],
  );
  const rows = Array.isArray(r) ? r : (r?.results || []);
  return Number(rows[0]?.c ?? 0);
}
