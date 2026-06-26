/**
 * CVP labels namespace — operator ground-truth for inner-state axis validation.
 *
 * Stores the user's rating of how much a time-window leans on an axis (the `target`
 * the Construct Validity Protocol correlates the computed lean against). Labels are
 * version-scoped: a label rates a window under a specific `anchor_version`, and a seed
 * change resets validity — so labels are never reused across versions.
 *
 * Plaintext at rest (whole-file SQLCipher); never logged. This namespace only writes/
 * reads the label table — it does NOT read cognitive_metrics_anchor (the gated reader
 * src/db/anchor.js owns that, per the verify:cvp 4i invariant).
 *
 * @typedef {object} LabelsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

const VALID_GRANULARITIES = new Set(['alpha', 'theta', 'delta']);
const rows = (r) => (Array.isArray(r) ? r : (r?.results ?? r?.rows ?? []));

export function createLabelsNamespace(deps) {
  if (!deps) throw new TypeError('createLabelsNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createLabelsNamespace: d1Query required');

  return {
    /**
     * Upsert one operator label for (axis, anchor_version, window). Re-rating the same
     * window overwrites its target. Validates inputs fail-closed.
     */
    async saveLabel(userId, { axis, anchorVersion, windowEnd, granularity, eraId, target } = {}) {
      if (!userId) throw new TypeError('saveLabel: userId required');
      if (!axis || typeof axis !== 'string') throw new TypeError('saveLabel: axis required');
      if (!anchorVersion) throw new TypeError('saveLabel: anchorVersion required');
      if (!windowEnd) throw new TypeError('saveLabel: windowEnd required');
      if (!VALID_GRANULARITIES.has(granularity)) {
        throw new TypeError(`saveLabel: invalid granularity "${granularity}"`);
      }
      if (!eraId) throw new TypeError('saveLabel: eraId required');
      const t = Number(target);
      if (!Number.isFinite(t)) throw new TypeError('saveLabel: target must be a finite number');

      await d1Query(
        `INSERT INTO cvp_labels
           (user_id, axis, anchor_version, window_end, granularity, era_id, target)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id, axis, anchor_version, window_end, granularity, era_id)
         DO UPDATE SET target = excluded.target,
                       labeled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        [userId, axis, anchorVersion, windowEnd, granularity, eraId, t],
      );
      return { ok: true };
    },

    /**
     * List labels for a user, optionally filtered to one axis + anchor_version,
     * chronologically by window. Returns plain row objects.
     */
    async listLabels(userId, { axis, anchorVersion } = {}) {
      if (!userId) throw new TypeError('listLabels: userId required');
      let sql = `SELECT axis, anchor_version, window_end, granularity, era_id, target, labeled_at
                 FROM cvp_labels WHERE user_id = ?`;
      const params = [userId];
      if (axis) { sql += ' AND axis = ?'; params.push(axis); }
      if (anchorVersion) { sql += ' AND anchor_version = ?'; params.push(anchorVersion); }
      sql += ' ORDER BY window_end ASC';
      return rows(await d1Query(sql, params));
    },

    /** How many labels exist for (axis, anchor_version) — the CVP min_n check. */
    async countLabels(userId, { axis, anchorVersion } = {}) {
      const r = await this.listLabels(userId, { axis, anchorVersion });
      return r.length;
    },
  };
}

export default createLabelsNamespace;
