// src/claims/route.js — query-conditioned level routing (PersonaTree §3.6).
// Classify a query to the abstraction level it needs, then map that to the
// support-path render depth. v1 is a cheap lexical heuristic (no model call on
// the hot path); an optional model upgrade is a documented deferral.
//
//   event   → a concrete fact/episode ("when did I…", "last week")  → depth 2 (leaves)
//   pattern → a recurring habit / state ("lately", "I usually…")     → depth 1 (mid)
//   claim   → a durable trait / value / why ("what do I value…")     → depth 0 (root)
//
// Additive only: routing never removes recall — it picks how DEEP to render the
// support path, while the existing flat layers are still searched.
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.7.

const EVENT = /\b(when|what time|which day|date|yesterday|today|last (week|month|night|time)|did i|where did|who did|how many)\b/i;
const CLAIM = /\b(why|values?|believe|principles?|boundar\w+|character|personality|identity|care about|motivat\w*|stand for|matter to me|who am i|tend to be)\b/i;
const PATTERN = /\b(usually|often|lately|these days|recently|habit|prefer|routine|typically|most of the time|trend)\b/i;

const LEVEL_DEPTH = Object.freeze({ event: 2, pattern: 1, claim: 0 });

/**
 * @param {string} query
 * @returns {{ level:'event'|'pattern'|'claim', depth:0|1|2 }}
 */
export function routeLevel(query) {
  const q = (query ?? '').toString();
  // Claim cues are the most specific signal (why/values/boundary) → check first.
  // Event cues (when/did i/date) next. Pattern is the default middle ground.
  let level;
  if (CLAIM.test(q)) level = 'claim';
  else if (EVENT.test(q)) level = 'event';
  else if (PATTERN.test(q)) level = 'pattern';
  else level = 'pattern'; // default: recurring states are the common retrieval need
  return { level, depth: LEVEL_DEPTH[level] };
}

export default { routeLevel };
