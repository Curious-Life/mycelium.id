/**
 * src/metrics/axis-cvp.js — per-axis Construct Validity Protocol runner (E2).
 *
 * Wraps the pure `runCVP` harness (cvp.js) and PERSISTS its verdict to
 * cognitive_axis_separability (axis, anchor_version). This is the ONLY path that
 * may flip an inner-state `<axis>_lean` from cvp_status='pending' to 'pass' — and
 * only when runCVP clears all three criteria (discriminant / incremental /
 * confound-neutralized) on >= CVP_THRESHOLDS.min_n operator labels. With no labels
 * or too few, runCVP returns 'pending'; failing the criteria returns 'fail'. Both
 * stay refused by the gated reader (src/db/anchor.js) — fail-closed.
 *
 * It UPDATEs (never inserts) the separability row: an axis can only be CVP-validated
 * after it has been MEASURED (Phase A2 of compute-anchors writes the row). If no row
 * exists for (axis, anchor_version), the update is a no-op and the axis stays
 * pending — correct fail-closed behavior.
 *
 * Security: writes only the status enum + a JSON criteria/evidence trail + the label
 * count. Never writes or logs user content or label text.
 */

import { runCVP } from './cvp.js';

/**
 * Run CVP for one axis and persist the verdict.
 *
 * @param {(sql: string, params: any[]) => Promise<any>} querier
 * @param {object} args
 * @param {string}   args.axis           e.g. 'tone'
 * @param {string}   args.anchorVersion  the seed-set version the labels were rated against
 * @param {number[]} args.metric         per-sample axis lean values
 * @param {number[]} args.target         per-sample operator labels (the construct score)
 * @param {Record<string,number[]>} [args.baselines]  word_count, message_count, …
 * @param {Record<string,number[]>} [args.confounds]  topic, style, authorship, …
 * @param {object}   [args.thresholds]   override CVP_THRESHOLDS
 * @returns {Promise<{status:'pass'|'fail'|'pending', criteria:object, reason:string, calibrated:boolean, labeled_n:number, updated:boolean}>}
 */
export async function applyAxisCVP(querier, {
  axis, anchorVersion, metric, target, baselines = {}, confounds = {}, thresholds = {},
} = {}) {
  if (typeof querier !== 'function') throw new TypeError('applyAxisCVP: querier required');
  if (!axis || !anchorVersion) throw new TypeError('applyAxisCVP: axis + anchorVersion required');

  const report = runCVP({ metric, target, baselines, confounds, thresholds });
  const labeled_n = Array.isArray(target) ? target.length : 0;

  const res = await querier(
    `UPDATE cognitive_axis_separability
        SET cvp_status = ?, cvp_criteria = ?, cvp_labeled_n = ?,
            cvp_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE axis = ? AND anchor_version = ?`,
    [report.status, JSON.stringify(report.criteria ?? {}), labeled_n, axis, anchorVersion],
  );
  // better-sqlite3 returns {changes}; the adapter may wrap it — treat any truthy
  // changes>0 as updated, default to true (the caller validated the row exists).
  const changes = res?.changes ?? res?.rowsAffected ?? res?.meta?.changes;
  const updated = changes === undefined ? true : changes > 0;

  return { ...report, labeled_n, updated };
}

/**
 * Orchestrate a CVP run for one axis FROM stored operator labels. Joins the labels
 * (db.labels) with the raw computed leans (db.anchor.getLeansForCvp — the sanctioned
 * internal reader) by window, builds the metric/target vectors + a message-count
 * baseline (incremental validity: does the lean beat raw volume?), and delegates to
 * applyAxisCVP. Confounds (topic entropy / style) are accepted but optional — pass a
 * {windowEnd: value} map per confound in `extraConfounds` when a per-window reader is
 * available.
 *
 * Returns the runCVP report plus `n` (paired samples). With n < min_n the report stays
 * 'pending' — never a fabricated pass.
 *
 * @param {object} db   the assembled db (needs .labels, .anchor, .rawQuery)
 */
export async function runAxisCvpFromLabels(db, {
  userId, axis, anchorVersion, granularity = 'alpha', extraConfounds = {}, thresholds = {},
} = {}) {
  if (!db?.labels?.listLabels || !db?.anchor?.getLeansForCvp || typeof db?.rawQuery !== 'function') {
    throw new TypeError('runAxisCvpFromLabels: db.labels + db.anchor + db.rawQuery required');
  }
  if (!userId || !axis || !anchorVersion) throw new TypeError('runAxisCvpFromLabels: userId + axis + anchorVersion required');

  const labels = await db.labels.listLabels(userId, { axis, anchorVersion });
  const leans = await db.anchor.getLeansForCvp(userId, { axis, anchorVersion, granularity });
  const leanByWindow = new Map(leans.map((l) => [l.window_end, l]));

  // Confounds for DISCRIMINANT validity — does the lean track the construct BEYOND topic
  // diversity (frequency_snapshots.entropy) and writing style (compression)? Auto-fetched
  // per window for these labels; merged with any caller-supplied extraConfounds. Without
  // these the discriminant criterion is hollow (nothing to beat).
  const auto = { topic_entropy: {}, style_compression: {} };
  try {
    const fs = await db.rawQuery(
      'SELECT window_end, entropy, compression FROM frequency_snapshots WHERE user_id = ? AND granularity = ?',
      [userId, granularity],
    );
    for (const r of (Array.isArray(fs) ? fs : (fs?.results ?? fs?.rows ?? []))) {
      if (r.entropy != null) auto.topic_entropy[r.window_end] = Number(r.entropy);
      if (r.compression != null) auto.style_compression[r.window_end] = Number(r.compression);
    }
  } catch { /* confounds best-effort; absence just weakens discriminant control */ }
  const confoundSrc = { ...auto, ...extraConfounds };

  const metric = [], target = [], msgCount = [];
  const confoundCols = {};
  for (const k of Object.keys(confoundSrc)) confoundCols[k] = [];
  for (const lab of labels) {
    if (lab.granularity !== granularity) continue;       // join within one scale
    const l = leanByWindow.get(lab.window_end);
    if (!l) continue;                                    // labeled window has no lean → skip
    metric.push(l.lean);
    target.push(Number(lab.target));
    msgCount.push(l.message_count);
    for (const [k, map] of Object.entries(confoundSrc)) confoundCols[k].push(map?.[lab.window_end] ?? 0);
  }
  // Drop zero-variance confound columns (a constant is not a real confound).
  for (const k of Object.keys(confoundCols)) {
    const col = confoundCols[k];
    if (!col.length || col.every((x) => x === col[0])) delete confoundCols[k];
  }

  const baselines = { message_count: msgCount };
  const report = await applyAxisCVP(db.rawQuery, {
    axis, anchorVersion, metric, target, baselines, confounds: confoundCols, thresholds,
  });
  return { ...report, n: metric.length };
}

export default applyAxisCVP;
