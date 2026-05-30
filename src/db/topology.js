/**
 * Topology namespace — co-firing network analysis over the territory graph.
 *
 * Twelve methods answering mindscape questions:
 *   getCoFiring       — immediate neighbours of a territory
 *   getOrphans        — high-message territories w/ few connections
 *   getBridges        — territories spanning realms (connect clusters)
 *   getGaps           — semantically close pairs that don't co-fire
 *   getCluster        — same-theme territories w/ path strength
 *   walkGraph         — BFS with path-strength accumulation (depth-limited)
 *   getOrphanGaps     — embedding-similarity orphan detection
 *   getLatestAudit    — most recent topology audit snapshot
 *   getAuditHistory   — last N audit snapshots
 *   getAuditFindings  — findings for a specific snapshot
 *   getBridgesWithHealth — bridges + coherence + multi-realm filter
 *   getDescendants/getAncestors — territory lineage (dissolved → merged)
 *
 * `cofireCol` is injected because it's a free helper in db-d1.js that
 * maps cofireStrength scale names to column names — extracting it into
 * a dep lets tests substitute a fake scale.
 *
 * @typedef {object} TopologyNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {(scale: string) => string} cofireCol
 */

export function createTopologyNamespace(deps) {
  if (!deps) throw new TypeError('createTopologyNamespace: deps required');
  const { d1Query, firstRow, cofireCol } = deps;
  if (typeof d1Query !== 'function')  throw new TypeError('createTopologyNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createTopologyNamespace: firstRow required');
  if (typeof cofireCol !== 'function') throw new TypeError('createTopologyNamespace: cofireCol required');

  return {
    async getCoFiring(params) {
      const col = cofireCol(params.p_scale);
      const result = await d1Query(
        `WITH neighbors AS (
           SELECT territory_b as neighbor_id, ${col} as cofire_strength
           FROM territory_cofire WHERE user_id = ? AND territory_a = ? AND ${col} > ?
           UNION ALL
           SELECT territory_a as neighbor_id, ${col} as cofire_strength
           FROM territory_cofire WHERE user_id = ? AND territory_b = ? AND ${col} > ?
         )
         SELECT n.neighbor_id as territory_id, tp.name, tp.message_count, n.cofire_strength
         FROM neighbors n
         JOIN territory_profiles tp ON tp.territory_id = n.neighbor_id AND tp.user_id = ?
         WHERE COALESCE(tp.is_catchall, 0) = 0 AND tp.dissolved_at IS NULL
         ORDER BY n.cofire_strength DESC
         LIMIT ?`,
        [
          params.p_user_id, params.p_territory_id, params.p_min_strength || 0.1,
          params.p_user_id, params.p_territory_id, params.p_min_strength || 0.1,
          params.p_user_id, params.p_limit || 10,
        ],
      );
      return result.results || [];
    },

    async getOrphans(params) {
      const col = cofireCol(params.p_scale);
      const minCofire = params.p_min_cofire || 0.1;
      const result = await d1Query(
        `WITH territory_conn AS (
           SELECT tp.territory_id, tp.name, tp.essence, tp.message_count,
             (SELECT COUNT(*) FROM territory_cofire tc
              WHERE tc.user_id = ?
                AND (tc.territory_a = tp.territory_id OR tc.territory_b = tp.territory_id)
                AND tc.${col} > ?) as connection_count
           FROM territory_profiles tp
           WHERE tp.user_id = ? AND tp.message_count >= ?
             AND COALESCE(tp.is_catchall, 0) = 0
         )
         SELECT * FROM territory_conn
         WHERE connection_count <= ?
         ORDER BY message_count DESC
         LIMIT ?`,
        [
          params.p_user_id, minCofire,
          params.p_user_id, params.p_min_messages || 5,
          params.p_max_connections || 3,
          params.p_limit || 10,
        ],
      );
      return result.results || [];
    },

    async getBridges(params) {
      const col = cofireCol(params.p_scale);
      const result = await d1Query(
        `WITH all_conn AS (
           SELECT territory_a as tid, territory_b as neighbor_id, ${col} as strength
           FROM territory_cofire WHERE user_id = ? AND ${col} > ?
           UNION ALL
           SELECT territory_b as tid, territory_a as neighbor_id, ${col} as strength
           FROM territory_cofire WHERE user_id = ? AND ${col} > ?
         )
         SELECT
           c.tid as territory_id,
           tp.name,
           COUNT(DISTINCT c.neighbor_id) as connection_count,
           COUNT(DISTINCT tp2.realm_id) as connected_realms,
           SUM(c.strength) as total_cofire_strength
         FROM all_conn c
         JOIN territory_profiles tp ON tp.territory_id = c.tid AND tp.user_id = ?
         LEFT JOIN territory_profiles tp2 ON tp2.territory_id = c.neighbor_id AND tp2.user_id = ?
         WHERE COALESCE(tp.is_catchall, 0) = 0 AND tp.dissolved_at IS NULL
         GROUP BY c.tid
         HAVING COUNT(DISTINCT c.neighbor_id) >= ?
         ORDER BY connection_count DESC
         LIMIT ?`,
        [
          params.p_user_id, params.p_min_cofire || 0.05,
          params.p_user_id, params.p_min_cofire || 0.05,
          params.p_user_id, params.p_user_id,
          params.p_min_connections || 3,
          params.p_limit || 10,
        ],
      );
      return result.results || [];
    },

    async getGaps(params) {
      const col = cofireCol(params.p_scale);
      const result = await d1Query(
        `SELECT
           tn.neighbor_id as territory_id,
           tp.name,
           tp.message_count,
           (1.0 - COALESCE(tn.distance, 0)) as semantic_similarity,
           0 as cofire_strength,
           (1.0 - COALESCE(tn.distance, 0)) as gap_score
         FROM territory_neighbors tn
         JOIN territory_profiles tp ON tp.territory_id = tn.neighbor_id AND tp.user_id = tn.user_id
         WHERE tn.user_id = ? AND tn.territory_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM territory_cofire tc
             WHERE tc.user_id = ?
               AND ((tc.territory_a = tn.territory_id AND tc.territory_b = tn.neighbor_id)
                 OR (tc.territory_b = tn.territory_id AND tc.territory_a = tn.neighbor_id))
               AND tc.${col} > ?
           )
         ORDER BY tn.distance ASC
         LIMIT ?`,
        [
          params.p_user_id, params.p_territory_id,
          params.p_user_id, params.p_max_cofire || 0.05,
          params.p_limit || 10,
        ],
      );
      return result.results || [];
    },

    async getCluster(params) {
      const col = cofireCol(params.p_scale);
      const result = await d1Query(
        `SELECT tp.territory_id, tp.name, tp.essence, tp.message_count,
           1 as depth,
           COALESCE(
             (SELECT tc.${col} FROM territory_cofire tc
              WHERE tc.user_id = ?
                AND ((tc.territory_a = ? AND tc.territory_b = cp.territory_id)
                  OR (tc.territory_b = ? AND tc.territory_a = cp.territory_id))
             ), 0) as path_strength
         FROM clustering_points cp
         JOIN territory_profiles tp ON tp.territory_id = cp.territory_id AND tp.user_id = cp.user_id
         WHERE cp.user_id = ? AND cp.territory_id != ?
           AND tp.dissolved_at IS NULL
           AND cp.theme_id IN (
             SELECT theme_id FROM clustering_points WHERE user_id = ? AND territory_id = ?
           )
         ORDER BY path_strength DESC
         LIMIT ?`,
        [
          params.p_user_id, params.p_territory_id, params.p_territory_id,
          params.p_user_id, params.p_territory_id,
          params.p_user_id, params.p_territory_id,
          params.p_limit || 20,
        ],
      );
      return result.results || [];
    },

    async walkGraph(params) {
      const col = cofireCol(params.p_scale);
      const maxDepth = params.p_depth || 2;
      const minStrength = params.p_min_strength || 0.1;
      const limit = params.p_limit || 20;
      const userId = params.p_user_id;
      const seedId = params.p_territory_id;

      const visited = new Set([seedId]);
      const results = [];
      let frontier = [{ territory_id: seedId, path_strength: 1.0, depth: 0 }];

      for (let d = 1; d <= maxDepth; d++) {
        const nextFrontier = [];
        for (const node of frontier) {
          const neighbors = await d1Query(
            `WITH neighbors AS (
               SELECT territory_b as neighbor_id, ${col} as strength
               FROM territory_cofire WHERE user_id = ? AND territory_a = ? AND ${col} > ?
               UNION ALL
               SELECT territory_a, ${col}
               FROM territory_cofire WHERE user_id = ? AND territory_b = ? AND ${col} > ?
             )
             SELECT n.neighbor_id as territory_id, tp.name, tp.message_count, n.strength
             FROM neighbors n
             JOIN territory_profiles tp ON tp.territory_id = n.neighbor_id AND tp.user_id = ?
             WHERE COALESCE(tp.is_catchall, 0) = 0 AND tp.dissolved_at IS NULL
             ORDER BY n.strength DESC LIMIT 15`,
            [userId, node.territory_id, minStrength,
             userId, node.territory_id, minStrength, userId],
          );

          for (const nb of (neighbors.results || neighbors)) {
            if (visited.has(nb.territory_id)) continue;
            visited.add(nb.territory_id);
            const pathStrength = node.path_strength * nb.strength;
            results.push({
              territory_id: nb.territory_id,
              name: nb.name,
              message_count: nb.message_count,
              depth: d,
              path_strength: Math.round(pathStrength * 1000) / 1000,
              cofire_strength: Math.round(nb.strength * 1000) / 1000,
            });
            nextFrontier.push({ territory_id: nb.territory_id, path_strength: pathStrength, depth: d });
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      results.sort((a, b) => b.path_strength - a.path_strength);
      return results.slice(0, limit);
    },

    async getOrphanGaps(params) {
      const userId = params.p_user_id;
      const territoryId = params.p_territory_id;
      const limit = params.p_limit || 10;
      const minSimilarity = params.p_min_similarity || 0.7;

      const seedResult = await d1Query(
        `SELECT centroid_256 FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [userId, territoryId],
      );
      const seedRow = firstRow(seedResult);
      if (!seedRow?.centroid_256) return [];
      const seedVec = typeof seedRow.centroid_256 === 'string' ? JSON.parse(seedRow.centroid_256) : seedRow.centroid_256;

      const candidates = await d1Query(
        `SELECT territory_id, name, essence, message_count, realm_id, centroid_256
         FROM territory_profiles
         WHERE user_id = ? AND territory_id != ?
           AND centroid_256 IS NOT NULL
           AND COALESCE(is_catchall, 0) = 0
           AND dissolved_at IS NULL
           AND message_count > 0`,
        [userId, territoryId],
      );

      const existingCofire = await d1Query(
        `SELECT territory_a, territory_b FROM territory_cofire
         WHERE user_id = ?
           AND (territory_a = ? OR territory_b = ?)
           AND cofire_weekly > 0.05`,
        [userId, territoryId, territoryId],
      );
      const cofireSet = new Set();
      for (const e of (existingCofire.results || existingCofire)) {
        cofireSet.add(e.territory_a === territoryId ? e.territory_b : e.territory_a);
      }

      const norm = (v) => {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * v[i];
        return Math.sqrt(s) || 1;
      };
      const seedNorm = norm(seedVec);

      const scored = [];
      for (const c of (candidates.results || candidates)) {
        if (cofireSet.has(c.territory_id)) continue;
        const vec = typeof c.centroid_256 === 'string' ? JSON.parse(c.centroid_256) : c.centroid_256;
        if (!vec || vec.length !== seedVec.length) continue;
        let dot = 0;
        for (let i = 0; i < seedVec.length; i++) dot += seedVec[i] * vec[i];
        const sim = dot / (seedNorm * norm(vec));
        if (sim >= minSimilarity) {
          scored.push({
            territory_id: c.territory_id,
            name: c.name,
            essence: c.essence,
            message_count: c.message_count,
            realm_id: c.realm_id,
            similarity: Math.round(sim * 1000) / 1000,
            cofire_strength: 0,
            gap_type: 'orphan_embedding',
          });
        }
      }

      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit);
    },

    async getLatestAudit(params) {
      const result = await d1Query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM topology_audit_findings f
                 WHERE f.snapshot_id = s.id AND f.severity = 'critical') as critical_count,
                (SELECT COUNT(*) FROM topology_audit_findings f
                 WHERE f.snapshot_id = s.id AND f.severity = 'warning') as warning_count
         FROM topology_audit_snapshots s
         WHERE s.user_id = ?
         ORDER BY s.run_at DESC LIMIT 1`,
        [params.p_user_id],
      );
      return firstRow(result);
    },

    async getAuditHistory(params) {
      const result = await d1Query(
        `SELECT run_at, m2_entropy, m2_delta, m2_trend,
                total_territories, catchall_count, orphan_count,
                degree_gini, mean_degree
         FROM topology_audit_snapshots
         WHERE user_id = ?
         ORDER BY run_at DESC
         LIMIT ?`,
        [params.p_user_id, params.p_limit || 30],
      );
      return result.results || [];
    },

    async getAuditFindings(params) {
      const result = await d1Query(
        `SELECT f.*
         FROM topology_audit_findings f
         WHERE f.user_id = ? AND f.snapshot_id = ?
         ORDER BY
           CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           f.message_count DESC
         LIMIT ?`,
        [params.p_user_id, params.p_snapshot_id, params.p_limit || 50],
      );
      return result.results || [];
    },

    async getBridgesWithHealth(params) {
      const col = cofireCol(params.p_scale);
      const result = await d1Query(
        `WITH all_conn AS (
           SELECT territory_a as tid, territory_b as neighbor_id, ${col} as strength
           FROM territory_cofire WHERE user_id = ? AND ${col} > ?
           UNION ALL
           SELECT territory_b as tid, territory_a as neighbor_id, ${col} as strength
           FROM territory_cofire WHERE user_id = ? AND ${col} > ?
         )
         SELECT
           c.tid as territory_id, tp.name, tp.essence,
           tp.message_count, tp.coherence, tp.is_catchall,
           COUNT(DISTINCT c.neighbor_id) as connection_count,
           COUNT(DISTINCT tp2.realm_id) as connected_realms,
           SUM(c.strength) as total_strength,
           AVG(c.strength) as avg_strength
         FROM all_conn c
         JOIN territory_profiles tp ON tp.territory_id = c.tid AND tp.user_id = ?
         LEFT JOIN territory_profiles tp2 ON tp2.territory_id = c.neighbor_id AND tp2.user_id = ?
         WHERE COALESCE(tp.is_catchall, 0) = 0 AND tp.dissolved_at IS NULL
         GROUP BY c.tid
         HAVING COUNT(DISTINCT c.neighbor_id) >= ? AND COUNT(DISTINCT tp2.realm_id) > 1
         ORDER BY connected_realms DESC, AVG(c.strength) DESC
         LIMIT ?`,
        [
          params.p_user_id, params.p_min_cofire || 0.05,
          params.p_user_id, params.p_min_cofire || 0.05,
          params.p_user_id, params.p_user_id,
          params.p_min_connections || 3,
          params.p_limit || 10,
        ],
      );
      return result.results || [];
    },

    async getDescendants(params) {
      const result = await d1Query(
        `SELECT l.new_territory_id, l.message_count, l.transfer_strength, l.is_dominant,
                l.cluster_version, l.recorded_at,
                tp.name as new_name, tp.dissolved_at as new_dissolved_at
         FROM territory_lineage l
         LEFT JOIN territory_profiles tp ON tp.territory_id = l.new_territory_id AND tp.user_id = l.user_id
         WHERE l.user_id = ? AND l.old_territory_id = ?
         ORDER BY l.transfer_strength DESC`,
        [params.p_user_id, params.p_territory_id],
      );
      return result.results || [];
    },

    async getAncestors(params) {
      const result = await d1Query(
        `SELECT l.old_territory_id, l.message_count, l.transfer_strength, l.is_dominant,
                l.cluster_version, l.recorded_at,
                tp.name as old_name, tp.essence as old_essence,
                tp.dissolved_at as old_dissolved_at
         FROM territory_lineage l
         LEFT JOIN territory_profiles tp ON tp.territory_id = l.old_territory_id AND tp.user_id = l.user_id
         WHERE l.user_id = ? AND l.new_territory_id = ?
         ORDER BY l.transfer_strength DESC`,
        [params.p_user_id, params.p_territory_id],
      );
      return result.results || [];
    },
  };
}
