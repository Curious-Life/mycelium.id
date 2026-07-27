// src/mindscape-territory-universe.js — the ONE answer to "which territories are on the map?".
//
// WHY THIS FILE EXISTS (QA9, operator 2026-07-27: "naming territories is still getting territory
// 1089 etc as the names … looks like there is some error in the name saving").
//
// There was no error in the name saving. THREE code paths asked "which territories exist?" and the
// renderer disagreed with the other two:
//
//   naming-status (the count)   DISTINCT territory_id FROM clustering_points  portal-mindscape.js:786-792
//   describe-clusters (writer)  DISTINCT territory_id FROM clustering_points  describe-clusters.js:214-217
//   the renderer                territory_profiles WHERE dissolved_at IS NULL db/mindscape.js:80 — NO JOIN
//
// A profile row that is not dissolved but has no surviving points was RENDERED, never visited by
// the naming job, and never counted. It showed as `Territory {id}` forever while the naming card
// truthfully reported "all named" — both true, about different sets. (1089, against ~50 areas, is
// an orphan from an earlier clustering generation.)
//
// ⚠️ NOT fixable in cluster.py, though that was the first plan. cluster.py ALREADY dissolves
// point-less territories (:1951-1970) — but DEFERS the whole prune whenever a re-embed backlog
// exists (:1946-1950), deliberately, so a re-import window cannot dissolve a territory whose
// points are transiently absent. On an importing vault that deferral can hold indefinitely.
// Dissolution is correct AND permanently incomplete; the renderer cannot rely on it.
//
// Nor can such a territory simply be NAMED instead: describe-clusters samples its members from
// clustering_points, so a territory with no points has nothing to describe. It is not a place on
// the map — no geometry, no members, no content.
//
// The predicates live HERE, as pure functions, for the reason this repo keeps relearning: a rule
// embedded in a route can only be gated by string-matching the route, and a gate that pins a
// string REDs on a harmless refactor while proving nothing about behaviour.

/**
 * Can this points bundle be trusted to decide territory liveness?
 *
 * BOTH guards are §3.2a — "a failed read is 'couldn't look', never 'it's empty'". Getting either
 * wrong DELETES a user's areas from their own map:
 *   · empty bundle     — we cannot distinguish "no map yet" from "the points read failed"
 *   · truncated bundle — getPoints caps at POINTS_LIMIT, so a territory may be absent from the
 *                        bundle only because the fetch stopped before reaching its points
 * When either holds we do not filter at all: showing a stale orphan is a far smaller harm than
 * hiding every real area.
 *
 * @param {Record<string|number, {count:number}>} territoryCentroids  per-territory live point tallies
 * @param {number} total  points in the bundle
 * @param {number} limit  the fetch cap (POINTS_LIMIT)
 * @returns {boolean}
 */
export function isBundleUsable(territoryCentroids, total, limit) {
  const n = Number(total) || 0;
  const cap = Number(limit) || 0;
  if (cap > 0 && n >= cap) return false;                       // truncated
  return Object.keys(territoryCentroids || {}).length > 0;     // non-empty
}

/**
 * Is this territory a place on the map?
 *
 * ⚠️ `count > 0`, NOT `centroid != null`. A centroid ENTRY can exist with a zero count, and
 * presence-of-an-entry is not evidence of points — the same presence-is-not-liveness mistake that
 * produced D-014 ("connected" inferred from a token's existence).
 *
 * @param {{count:number}|undefined|null} centroidEntry  territoryCentroids[territory_id]
 * @param {boolean} bundleUsable  from isBundleUsable — false ⇒ render everything (fail open)
 * @returns {boolean}
 */
export function isRenderableTerritory(centroidEntry, bundleUsable) {
  if (!bundleUsable) return true;                              // cannot judge ⇒ do not delete
  return centroidEntry != null && Number(centroidEntry.count) > 0;
}
