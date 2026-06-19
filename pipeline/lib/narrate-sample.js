// pipeline/lib/narrate-sample.js — shared narration sampler for describe-clusters
// + describe-chronicles. Replaces the old "5 most-recent messages, messages-only,
// 300-char" draw with the canonical-grade, user-specified sampler:
//
//   • TIMELINE-STRATIFIED: ~20 members spread across the cluster's WHOLE date
//     range (ordered by date), never recency-biased. A 1,000-message territory is
//     named from a representative spread, not its newest tail.
//   • ALL SOURCE TYPES: message / document / transcript / image_description, so
//     clusters made of docs or media still get real samples (not placeholders).
//   • 5,000 chars/snippet (was 300/400) — fuller context per sample.
//   • TOP TAGS + ENTITIES aggregated across ALL members → extra naming signal.
//   • INCREMENTAL COVERAGE (territory_seen_points): bias the draw toward UNSEEN
//     content while keeping a few already-seen anchors for continuity, so repeated
//     passes accumulate coverage ("fuller and fuller understanding") and we can
//     report % described. Realms/themes have no per-entity seen table — they draw
//     a plain stratified spread and roll up child coverage (the CASCADE).
//
// Pure-ish: callers pass a `query(sql, params) → rows[]` adapter (the auto-
// encrypting db.rawQuery passthrough, which decrypts content transparently).

export const MAX_SAMPLE_CHARS = 5000;
export const DEFAULT_SAMPLE_N = 20;
// Total prompt budget across the sampled snippets. 20 × 5k = ~100k chars (~25k
// tokens) makes models return prose/refusals instead of JSON and is slow + costly
// (measured: a 98k-char prompt to a 27B model = 64s and NO usable JSON). We keep
// 20 timeline-stratified samples + the 5k per-message cap, but trim each to its
// fair share of this budget when the sum would blow the context. Env-tunable for
// large-context providers.
export const TOTAL_BUDGET_CHARS = Number(process.env.MYCELIUM_NARRATE_BUDGET_CHARS) || 16000;
const ALLOWED_COLS = new Set(['territory_id', 'realm_id', 'theme_id']);

/**
 * Even pick across an ORDERED list — keeps the first and last and spreads the
 * rest uniformly, so the sample covers the whole timeline. Deterministic.
 */
export function stratifiedPick(arr, n) {
  const L = arr.length;
  if (L <= n) return arr.slice();
  const out = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i * (L - 1)) / (n - 1));
    if (!used.has(idx)) { used.add(idx); out.push(arr[idx]); }
  }
  return out;
}

const memberSql = (column) => `
  SELECT cp.source_id AS id, cp.source_type AS source_type, cp.created_at AS created_at,
    CASE cp.source_type
      WHEN 'message' THEN m.content
      WHEN 'document' THEN d.content
      WHEN 'transcript' THEN a.transcript
      WHEN 'image_description' THEN a.description
    END AS content,
    m.tags AS tags, m.entities AS entities
  FROM clustering_points cp
  LEFT JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message' AND m.user_id = cp.user_id
  LEFT JOIN documents d ON d.id = cp.source_id AND cp.source_type = 'document' AND d.user_id = cp.user_id
  LEFT JOIN attachments a ON a.id = cp.source_id AND cp.source_type IN ('transcript','image_description') AND a.user_id = cp.user_id
  WHERE cp.user_id = ? AND cp.${column} = ?
  ORDER BY cp.created_at ASC, cp.source_id ASC`;

function aggregateTagsEntities(rows) {
  const tagCount = Object.create(null);
  const entitySet = new Set();
  for (const r of rows) {
    try {
      const t = typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags;
      if (Array.isArray(t)) for (const x of t) if (x) tagCount[x] = (tagCount[x] || 0) + 1;
    } catch { /* tags optional */ }
    try {
      const e = typeof r.entities === 'string' ? JSON.parse(r.entities) : r.entities;
      if (e && typeof e === 'object') for (const arr of Object.values(e)) if (Array.isArray(arr)) for (const x of arr) if (x) entitySet.add(x);
    } catch { /* entities optional */ }
  }
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
  return { topTags, entities: [...entitySet].slice(0, 12) };
}

/**
 * Load every member of a cluster (with non-trivial content), date-ordered, across
 * all source types. The id order is deterministic so signatures don't flap.
 */
export async function loadMembers(query, userId, column, value) {
  if (!ALLOWED_COLS.has(column)) throw new Error(`narrate-sample: unsupported column "${column}"`);
  const rows = await query(memberSql(column), [userId, value]);
  return (rows || []).filter((r) => r && typeof r.content === 'string' && r.content.trim().length > 10);
}

/**
 * Min/max created_at over a member list → the time-span it covers. Members carry
 * ISO 8601 `created_at` (plaintext, lexicographically orderable). Returns null for
 * an empty list. The narration Context Capsule uses this to state "prior essence
 * covered X–Y" and "new content spans A–B".
 * @param {Array<{created_at?:string}>} members
 * @returns {{start:string,end:string,points:number}|null}
 */
export function memberRange(members) {
  let min = null, max = null, n = 0;
  for (const m of (members || [])) {
    const c = m && m.created_at; if (!c) continue;
    const s = String(c);
    if (min === null || s < min) min = s;
    if (max === null || s > max) max = s;
    n += 1;
  }
  return min === null ? null : { start: min, end: max, points: n };
}

/**
 * Build a narration sample from preloaded members.
 * @param {Array} members  output of loadMembers (date-ordered, content present)
 * @param {{ n?:number, maxChars?:number, seenIds?:Set<string>|null }} opts
 *   seenIds → incremental mode: ≈70% UNSEEN + ≈30% already-seen anchors (so the
 *   model refines with new content but keeps continuity). Omit for a plain spread.
 * @returns {{ samples:{id,content,created_at}[], topTags, entities, totalPoints,
 *             sampledIds:string[], unseenRemaining:number,
 *             coveredRange:{start,end,points}|null, newRange:{start,end,points}|null }}
 *   coveredRange = span of already-SEEN members (the prior description's basis);
 *   newRange = span of UNSEEN members (what this pass folds in). With no seenIds:
 *   coveredRange=null, newRange = full member span (a first/plain description).
 */
export function sampleMembers(members, { n = DEFAULT_SAMPLE_N, maxChars = MAX_SAMPLE_CHARS, seenIds = null, totalBudgetChars = TOTAL_BUDGET_CHARS } = {}) {
  let picked;
  let unseenRemaining = 0;
  let coveredRange = null, newRange = null;
  if (seenIds && seenIds.size) {
    const unseen = members.filter((m) => !seenIds.has(m.id));
    const seen = members.filter((m) => seenIds.has(m.id));
    unseenRemaining = unseen.length;
    coveredRange = memberRange(seen);
    newRange = memberRange(unseen);
    if (unseen.length === 0) {
      picked = stratifiedPick(seen, n);                       // fully covered → representative refresh
    } else {
      const kNew = Math.min(unseen.length, Math.max(1, Math.ceil(n * 0.7)));
      const kOld = Math.max(0, n - kNew);
      picked = [...stratifiedPick(unseen, kNew), ...stratifiedPick(seen, kOld)]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    }
  } else {
    unseenRemaining = members.length;
    newRange = memberRange(members);
    picked = stratifiedPick(members, n);
  }
  const { topTags, entities } = aggregateTagsEntities(members);   // aggregate over ALL members, not just the picked sample
  // Per-snippet cap = min(5k, fair share of the total budget) so the WHOLE prompt
  // fits the model context (else the model returns prose, not JSON — see TOTAL_BUDGET_CHARS).
  const perCap = Math.max(400, Math.min(maxChars, Math.floor(totalBudgetChars / Math.max(1, picked.length))));
  return {
    samples: picked.map((m) => ({ id: m.id, content: String(m.content).slice(0, perCap), created_at: m.created_at })),
    topTags,
    entities,
    totalPoints: members.length,
    sampledIds: picked.map((m) => m.id),
    unseenRemaining,
    coveredRange,
    newRange,
  };
}

// ── Coverage (territory-level; keyed by territory_seen_points) ────────────────

/** The set of source_ids already folded into a territory's narration. */
export async function getSeenIds(query, userId, territoryId) {
  const rows = await query(
    `SELECT source_id FROM territory_seen_points WHERE user_id = ? AND territory_id = ?`,
    [userId, territoryId],
  ).catch(() => []);
  return new Set((rows || []).map((r) => r.source_id));
}

/** Record the just-narrated sample as seen (idempotent). pass_number = monotonic. */
export async function recordSeen(query, userId, territoryId, sourceIds, passNumber = 0) {
  for (const sid of sourceIds) {
    await query(
      `INSERT OR IGNORE INTO territory_seen_points (territory_id, user_id, source_id, pass_number, seen_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [territoryId, userId, sid, passNumber],
    ).catch(() => { /* coverage is best-effort */ });
  }
}

/** explored % = distinct seen / total narratable members (0 when empty). */
export function exploredPercent(seenCount, totalPoints) {
  if (!totalPoints || totalPoints <= 0) return 0;
  return Math.min(100, Math.round((100 * seenCount) / totalPoints));
}

/** Highest pass_number recorded for a territory (so the next pass increments). */
export async function lastPassNumber(query, userId, territoryId) {
  const rows = await query(
    `SELECT MAX(pass_number) AS p FROM territory_seen_points WHERE user_id = ? AND territory_id = ?`,
    [userId, territoryId],
  ).catch(() => []);
  return Number((rows || [])[0]?.p ?? 0) || 0;
}
