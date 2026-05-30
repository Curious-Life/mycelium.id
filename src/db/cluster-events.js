/**
 * Cluster events namespace — read-only reports on clustering changes.
 *
 * Clustering runs periodically; each run emits "events" about
 * territories forming, merging, splitting, dissolving at different
 * levels (theme / territory / realm). This namespace powers the
 * portal's growth/timeline view.
 *
 * JSON columns (old_cluster_ids, new_cluster_ids, sample_tags,
 * sample_entities) are parsed through the injected `parseJson`.
 *
 * @typedef {object} ClusterEventsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(val: any) => any} parseJson — tolerant JSON parse (returns null on error)
 */

export function createClusterEventsNamespace(deps) {
  if (!deps) throw new TypeError('createClusterEventsNamespace: deps required');
  const { d1Query, parseJson } = deps;
  if (typeof d1Query !== 'function')  throw new TypeError('createClusterEventsNamespace: d1Query required');
  if (typeof parseJson !== 'function') throw new TypeError('createClusterEventsNamespace: parseJson required');

  function hydrate(row) {
    return {
      ...row,
      old_cluster_ids: parseJson(row.old_cluster_ids),
      new_cluster_ids: parseJson(row.new_cluster_ids),
      sample_tags:     parseJson(row.sample_tags),
      sample_entities: parseJson(row.sample_entities),
    };
  }

  return {
    async getRecent(userId, { limit = 50, level, since } = {}) {
      let sql = `SELECT * FROM cluster_events WHERE user_id = ?`;
      const params = [userId];
      if (level) { sql += ` AND level = ?`;        params.push(level); }
      if (since) { sql += ` AND created_at >= ?`;  params.push(since); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return (result.results || []).map(hydrate);
    },

    async getByVersion(userId, clusterVersion) {
      const result = await d1Query(
        `SELECT * FROM cluster_events WHERE user_id = ? AND cluster_version = ? ORDER BY level, event_type`,
        [userId, clusterVersion],
      );
      return (result.results || []).map(hydrate);
    },

    async getSummary(userId) {
      const result = await d1Query(`
        SELECT level, event_type, COUNT(*) as count,
               MAX(created_at) as last_at
        FROM cluster_events WHERE user_id = ?
        GROUP BY level, event_type
        ORDER BY level, event_type
      `, [userId]);
      return result.results || [];
    },
  };
}
