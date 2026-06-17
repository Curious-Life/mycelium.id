// pipeline/lib/narrate-context.js — the narration "Context Capsule".
//
// ONE assembler that gives any narrator (today's batch describe, the future agent
// walk, and the getEntityContext MCP/REST tool) the same rich, deterministic briefing
// about a mindscape entity BEFORE it writes a description:
//
//   • IDENTITY      — current name/essence (so it refines, not restarts).
//   • TEMPORAL      — what time-span the PRIOR description covered (described_period_*)
//                     vs. the span of NEW content being folded in, + % described.
//   • ACTIVITY      — a month-by-month histogram + sparkline of when this entity was
//                     active across its WHOLE timeline (from clustering_points.created_at,
//                     plaintext + SQL-groupable). Persisted into activity_timeline.
//   • NEIGHBOURHOOD — what it's connected to, BY NAME: parent realm / child territories,
//                     nearest by meaning (centroid cosine — works even when the
//                     behavioural cofire tables are empty), co-activating territories
//                     (when populated), and what it descended from (lineage).
//
// Pure-ish: callers pass `query` (the auto-decrypting db.rawQuery passthrough) and `db`
// (for the topology namespace). Every external lookup is fail-soft → the capsule
// degrades gracefully (e.g. cofire tables empty → centroid neighbours still present)
// and NEVER throws into the narration loop. Never logs content (CLAUDE.md §1).

import { memberRange } from './narrate-sample.js';

const COL = { territory: 'territory_id', realm: 'realm_id', theme: 'theme_id' };
const BARS = '▁▂▃▄▅▆▇█';

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
const day = (s) => (s ? String(s).slice(0, 10) : '?');

/** Month histogram of activity for an entity, from clustering_points.created_at. */
async function activityHistogram(query, userId, column, value) {
  const rows = await safe(() => query(
    `SELECT substr(created_at, 1, 7) AS period, COUNT(DISTINCT source_id) AS count
       FROM clustering_points
      WHERE user_id = ? AND ${column} = ? AND created_at IS NOT NULL AND created_at != ''
      GROUP BY period ORDER BY period ASC`,
    [userId, value],
  ), []);
  return (rows || []).map((r) => ({ period: r.period, count: Number(r.count) || 0 }));
}

/** ▁▃█-style sparkline over the histogram counts (peak-normalized). */
export function sparkline(hist) {
  if (!hist || !hist.length) return '';
  const max = Math.max(...hist.map((h) => h.count)) || 1;
  return hist.map((h) => BARS[Math.min(BARS.length - 1, Math.round((h.count / max) * (BARS.length - 1)))]).join('');
}

/** The month with the most activity (for "peak <month>"). */
function peakPeriod(hist) {
  let best = null;
  for (const h of (hist || [])) if (!best || h.count > best.count) best = h;
  return best?.period || null;
}

/** Span of members created strictly after `afterIso` (the new-content window). */
function rangeAfter(members, afterIso) {
  if (!afterIso) return memberRange(members);
  return memberRange(members.filter((m) => String(m.created_at) > afterIso));
}

/** Connected entities, BY NAME — degrades gracefully across data availability. */
async function buildNeighbourhood(query, db, userId, kind, id) {
  if (kind === 'territory') {
    const [parent] = await safe(() => query(
      `SELECT r.realm_id, r.name FROM territory_profiles tp
         JOIN realms r ON r.realm_id = tp.realm_id AND r.user_id = tp.user_id
        WHERE tp.user_id = ? AND tp.territory_id = ?`, [userId, id]), []);
    // Nearest BY MEANING via plaintext centroid_256 cosine — present even when the
    // behavioural cofire/neighbour tables are empty (Generate-only).
    const nearest = await safe(() => db.topology.getOrphanGaps(
      { p_user_id: userId, p_territory_id: id, p_limit: 5, p_min_similarity: 0.5 }), []);
    // Behavioural co-activation — populated only after a Generate run; empty → omitted.
    const cofiring = await safe(() => db.topology.getCoFiring(
      { p_user_id: userId, p_territory_id: id, p_scale: 'weekly', p_min_strength: 0.1, p_limit: 5 }), []);
    // Lineage — what this (possibly re-clustered) territory descended from.
    const ancestors = await safe(() => db.topology.getAncestors(
      { p_user_id: userId, p_territory_id: id }), []);
    return {
      parentRealm: parent ? { id: parent.realm_id, name: parent.name } : null,
      nearest: (nearest || []).filter((n) => n.name).map((n) => ({ id: n.territory_id, name: n.name, similarity: n.similarity })),
      cofiring: (cofiring || []).filter((n) => n.name).map((n) => ({ id: n.territory_id, name: n.name, strength: n.cofire_strength })),
      descendedFrom: (ancestors || []).filter((a) => a.old_name).map((a) => ({ id: a.old_territory_id, name: a.old_name })).slice(0, 5),
    };
  }
  if (kind === 'realm') {
    const kids = await safe(() => query(
      `SELECT territory_id, name, message_count FROM territory_profiles
        WHERE user_id = ? AND realm_id = ? AND dissolved_at IS NULL AND name IS NOT NULL
        ORDER BY message_count DESC LIMIT 8`, [userId, id]), []);
    return { children: (kids || []).map((k) => ({ id: k.territory_id, name: k.name })) };
  }
  return {};
}

/** Per-entity measured "shape" from the analysis engine (v4). All fail-soft: a
 *  metric the engine hasn't computed yet → null → omitted from the prompt. So the
 *  capsule works pre-analysis (Phase 1) and gets richer once the engine has run
 *  (the design runs the metric stages BEFORE describe). current_phase is plaintext
 *  post-gift-fix (null until vitality runs); current_vitality/coherence decrypt via
 *  the rawQuery passthrough. fisher phase = latest trajectory window at this level. */
async function buildMetrics(query, userId, kind, id) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const out = { vitality: null, phase: null, fisherPhase: null, coherence: null, recurrence: null };
  // Fisher movement is a LEVEL-wide signal (per-id proportions live inside
  // activation_vector JSON, not a column) — take the latest window's phase at this
  // entity's level. phase_recent (smoothed) preferred over the raw step phase.
  const level = kind === 'realm' ? 'realm' : kind === 'theme' ? 'theme' : 'territory';
  const [fisher] = await safe(() => query(
    `SELECT phase, phase_recent FROM fisher_trajectory WHERE user_id = ? AND level = ?
      ORDER BY window_end DESC LIMIT 1`, [userId, level]), []);
  out.fisherPhase = fisher?.phase_recent || fisher?.phase || null;
  if (kind === 'territory') {
    const [tp] = await safe(() => query(
      `SELECT current_vitality, current_phase, coherence FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
      [userId, id]), []);
    if (tp) {
      out.vitality = num(tp.current_vitality);
      out.phase = ['sparse', 'active', 'anchor'].includes(tp.current_phase) ? tp.current_phase : null;
      out.coherence = num(tp.coherence);
    }
    const [rec] = await safe(() => query(
      `SELECT recurrence_interval FROM cognitive_metrics_per_territory WHERE user_id = ? AND territory_id = ?
        ORDER BY window_end DESC LIMIT 1`, [userId, id]), []);
    out.recurrence = rec ? num(rec.recurrence_interval) : null;
  }
  return out;
}

/**
 * Build the Context Capsule for an entity.
 * @param {object} args
 * @param {Function} args.query    db.rawQuery passthrough (sql, params) → rows[]
 * @param {object}   args.db       wired db (for db.topology)
 * @param {string}   args.userId
 * @param {'territory'|'realm'|'theme'} args.kind
 * @param {number}   args.id
 * @param {Array}    args.members  loadMembers() output (date-ordered, content present)
 * @param {Set<string>|null} [args.seenIds]  coverage ledger (territories)
 * @param {object|null} [args.stored]  existing row: { name, essence, described_period_start,
 *                                       described_period_end } — authoritative covered span
 * @returns {Promise<object>} capsule (see renderCapsule)
 */
export async function buildContextCapsule({ query, db, userId, kind, id, members = [], seenIds = null, stored = null }) {
  const column = COL[kind] || 'territory_id';
  const histogram = await activityHistogram(query, userId, column, id);
  const lifespan = memberRange(members);

  // Covered span: the stored described_period_* is authoritative (it's literally what
  // the last description was based on). Fall back to the already-seen members' span
  // (territories with a coverage ledger). Null → never described.
  let coveredRange = null;
  if (stored?.described_period_start) {
    coveredRange = { start: stored.described_period_start, end: stored.described_period_end || stored.described_period_start };
  } else if (seenIds && seenIds.size) {
    coveredRange = memberRange(members.filter((m) => seenIds.has(m.id)));
  }
  // New span: content after the covered end (or everything if first description).
  const newRange = rangeAfter(members, coveredRange?.end || null);
  const exploredPercent = (seenIds && members.length)
    ? Math.min(100, Math.round((100 * members.filter((m) => seenIds.has(m.id)).length) / members.length))
    : null;

  const neighbourhood = await buildNeighbourhood(query, db, userId, kind, id);
  const metrics = await buildMetrics(query, userId, kind, id);

  return {
    kind,
    id,
    identity: { name: stored?.name || null, essence: stored?.essence || null },
    temporal: { coveredRange, newRange, exploredPercent, lifespan },
    activity: { histogram, sparkline: sparkline(histogram), peak: peakPeriod(histogram) },
    neighbourhood,
    metrics,
  };
}

/**
 * Render the capsule into a compact, deterministic prompt block (prepended before the
 * narration samples). Stable ordering so describe signatures don't flap.
 */
export function renderCapsule(cap) {
  if (!cap) return '';
  const L = [];
  const idLine = `AREA (${cap.kind})${cap.identity.name ? ` "${cap.identity.name}"` : ''}${cap.identity.essence ? ` — "${cap.identity.essence}"` : ''}.`;
  L.push(idLine);

  const lp = cap.temporal.lifespan;
  if (lp || cap.activity.sparkline) {
    let line = 'TIMELINE:';
    if (lp) line += ` active ${day(lp.start)} → ${day(lp.end)}`;
    if (cap.activity.sparkline) line += ` · activity by month ${cap.activity.sparkline}${cap.activity.peak ? ` (peak ${cap.activity.peak})` : ''}`;
    L.push(`${line}.`);
  }

  if (cap.temporal.coveredRange) {
    L.push(`PRIOR DESCRIPTION covered ${day(cap.temporal.coveredRange.start)} → ${day(cap.temporal.coveredRange.end)}.`);
    if (cap.temporal.newRange && cap.temporal.newRange.points > 0) {
      const pct = cap.temporal.exploredPercent != null ? `, ${cap.temporal.exploredPercent}% described overall` : '';
      L.push(`NOW FOLDING IN ${day(cap.temporal.newRange.start)} → ${day(cap.temporal.newRange.end)} (${cap.temporal.newRange.points} new item${cap.temporal.newRange.points === 1 ? '' : 's'}${pct}).`);
    }
    L.push('Fold the new period into the existing understanding; keep what still holds; note what changed.');
  } else if (cap.temporal.newRange) {
    L.push(`FIRST DESCRIPTION — content spans ${day(cap.temporal.newRange.start)} → ${day(cap.temporal.newRange.end)} (${cap.temporal.newRange.points} items).`);
  }

  // SHAPE: the measured analysis-engine signals (v4). Omitted entirely pre-analysis.
  const mx = cap.metrics || {};
  const shape = [];
  if (mx.vitality != null) shape.push(`vitality ${mx.vitality.toFixed(2)}${mx.phase ? ` (${mx.phase})` : ''}`);
  else if (mx.phase) shape.push(`phase ${mx.phase}`);
  if (mx.fisherPhase) shape.push(`movement ${mx.fisherPhase}`);
  if (mx.coherence != null) shape.push(`coherence ${mx.coherence.toFixed(2)} (${mx.coherence < 0.4 ? 'scattered' : mx.coherence > 0.7 ? 'focused' : 'mixed'})`);
  if (mx.recurrence != null) shape.push(`recurs ~${Math.round(mx.recurrence)}d`);
  if (shape.length) L.push(`SHAPE: ${shape.join(' · ')}.`);

  const n = cap.neighbourhood || {};
  const conn = [];
  if (n.parentRealm) conn.push(`in realm "${n.parentRealm.name}"`);
  if (n.children?.length) conn.push(`contains ${n.children.map((c) => `"${c.name}"`).join(', ')}`);
  if (n.nearest?.length) conn.push(`near by meaning ${n.nearest.map((x) => `"${x.name}"`).join(', ')}`);
  if (n.cofiring?.length) conn.push(`co-activates with ${n.cofiring.map((x) => `"${x.name}"`).join(', ')}`);
  if (n.descendedFrom?.length) conn.push(`descended from ${n.descendedFrom.map((x) => `"${x.name}"`).join(', ')}`);
  if (conn.length) L.push(`CONNECTED — ${conn.join(' · ')}.`);

  return L.join('\n');
}

/** The span to persist as "what this description is now based on", after a narration.
 *  Territories: span of all seen members (the cumulative coverage). Realms/themes:
 *  full member span (described from a whole-timeline stratified spread). */
export function describedPeriodFor(kind, members, seenIds = null) {
  if (kind === 'territory' && seenIds && seenIds.size) {
    return memberRange(members.filter((m) => seenIds.has(m.id))) || memberRange(members);
  }
  return memberRange(members);
}

export default buildContextCapsule;
