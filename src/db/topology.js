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
 * ENCRYPTION (SEC-2): `territory_cofire.cofire_*` strengths and
 * `territory_neighbors.distance` are now ENCRYPTED at rest (non-deterministic
 * AES-GCM). They CANNOT be compared/ordered/aggregated in SQL. So every method
 * that used to `WHERE cofire_x > ?` / `ORDER BY strength` / `SUM(strength)` now:
 *   1. JOINs/filters only on PLAINTEXT keys in SQL (territory ids, message_count,
 *      is_catchall, realm_id, theme_id, timestamps),
 *   2. loads the cofire edges / neighbor distances (the adapter auto-DECRYPTS
 *      them on read), and
 *   3. thresholds / sorts / aggregates the decrypted strengths in JS.
 * Graphs are small (≤ a few hundred territories) so this is trivially fast.
 *
 * `cofireCol` is still injected (kept for the factory contract) but no longer
 * used to build SQL predicates — scale selection happens in JS via `scaleKey`.
 *
 * @typedef {object} TopologyNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {(scale: string) => string} cofireCol
 */

const SCALES = new Set(['immediate', 'session', 'daily', 'weekly']);
/** Normalize a scale name to a cofire field; defaults to 'weekly'. */
function scaleKey(scale) { return SCALES.has(scale) ? scale : 'weekly'; }
function numOr0(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function rowsOf(r) { return (r && Array.isArray(r.results)) ? r.results : (Array.isArray(r) ? r : []); }

// T1: topology_audit_snapshots / topology_audit_findings have ENCRYPTED metric
// columns (added to ENCRYPTED_FIELDS); the adapter auto-decrypts them to STRINGS
// on read, so coerce the numerics back to numbers (NULL/undefined preserved,
// non-numeric enums like m2_trend/finding_type left untouched). Mirrors
// src/db/fisher.js coerceNums.
const AUDIT_SNAPSHOT_NUMERIC = [
  'total_territories', 'total_connections', 'catchall_count', 'orphan_count',
  'bridge_count', 'max_degree', 'mean_degree', 'degree_gini',
  'm2_entropy', 'm2_delta',
];
const AUDIT_FINDING_NUMERIC = [
  'message_count', 'connection_count', 'connected_realms', 'coherence',
  'bridge_quality',
];
function coerceCols(row, fields) {
  if (!row) return row;
  for (const f of fields) {
    const v = row[f];
    if (v !== null && v !== undefined && typeof v !== 'number') {
      const n = Number(v);
      if (!Number.isNaN(n)) row[f] = n;
    }
  }
  return row;
}
function coerceAuditNums(row) { return coerceCols(row, AUDIT_SNAPSHOT_NUMERIC); }
function coerceFindingNums(row) { return coerceCols(row, AUDIT_FINDING_NUMERIC); }

export function createTopologyNamespace(deps) {
  if (!deps) throw new TypeError('createTopologyNamespace: deps required');
  const { d1Query, firstRow, cofireCol } = deps;
  if (typeof d1Query !== 'function')  throw new TypeError('createTopologyNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createTopologyNamespace: firstRow required');
  if (typeof cofireCol !== 'function') throw new TypeError('createTopologyNamespace: cofireCol required');

  // ── Decrypt-on-read loaders (the adapter decrypts cofire_*/distance) ──────

  /** All cofire edges for a user, optionally only those touching `territoryId`.
   *  Strengths come back DECRYPTED (strings) → coerced to numbers here. */
  async function loadCofire(userId, territoryId = null) {
    const sql = territoryId == null
      ? `SELECT territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly
         FROM territory_cofire WHERE user_id = ?`
      : `SELECT territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly
         FROM territory_cofire WHERE user_id = ? AND (territory_a = ? OR territory_b = ?)`;
    const params = territoryId == null ? [userId] : [userId, territoryId, territoryId];
    return rowsOf(await d1Query(sql, params)).map((e) => ({
      a: e.territory_a, b: e.territory_b,
      immediate: numOr0(e.cofire_immediate), session: numOr0(e.cofire_session),
      daily: numOr0(e.cofire_daily), weekly: numOr0(e.cofire_weekly),
    }));
  }

  /** Live, non-catch-all territory profiles as a Map(territory_id → row).
   *  message_count / coherence are Number()'d so this survives SEC-3 (when they
   *  too become encrypted → decrypt to strings). */
  async function loadTerritories(userId, { includeDissolved = false } = {}) {
    const rows = rowsOf(await d1Query(
      `SELECT territory_id, name, essence, message_count, realm_id, coherence,
              COALESCE(is_catchall, 0) AS is_catchall, dissolved_at
       FROM territory_profiles WHERE user_id = ?`,
      [userId],
    ));
    const map = new Map();
    for (const t of rows) {
      if (!includeDissolved && t.dissolved_at) continue;
      map.set(t.territory_id, {
        ...t,
        message_count: numOr0(t.message_count),
        coherence: t.coherence == null ? null : numOr0(t.coherence),
        is_catchall: Number(t.is_catchall) ? 1 : 0,
      });
    }
    return map;
  }

  /** Neighbor distances for a territory (distance DECRYPTED → number). */
  async function loadNeighbors(userId, territoryId) {
    return rowsOf(await d1Query(
      `SELECT neighbor_id, distance FROM territory_neighbors WHERE user_id = ? AND territory_id = ?`,
      [userId, territoryId],
    )).map((n) => ({ neighbor_id: n.neighbor_id, distance: numOr0(n.distance) }));
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;

  return {
    async getCoFiring(params) {
      const k = scaleKey(params.p_scale);
      const min = params.p_min_strength ?? 0.1;
      const limit = params.p_limit ?? 10;
      const [edges, terts] = await Promise.all([
        loadCofire(params.p_user_id, params.p_territory_id),
        loadTerritories(params.p_user_id),
      ]);
      const out = [];
      for (const e of edges) {
        const strength = e[k];
        if (strength <= min) continue;
        const neighborId = e.a === params.p_territory_id ? e.b : e.a;
        const tp = terts.get(neighborId);
        if (!tp || tp.is_catchall) continue;
        out.push({ territory_id: neighborId, name: tp.name, message_count: tp.message_count, cofire_strength: strength });
      }
      out.sort((x, y) => y.cofire_strength - x.cofire_strength);
      return out.slice(0, limit);
    },

    async getOrphans(params) {
      const k = scaleKey(params.p_scale);
      const minCofire = params.p_min_cofire ?? 0.1;
      const minMessages = params.p_min_messages ?? 5;
      const maxConn = params.p_max_connections ?? 3;
      const limit = params.p_limit ?? 10;
      const [edges, terts] = await Promise.all([
        loadCofire(params.p_user_id),
        loadTerritories(params.p_user_id),
      ]);
      // connection count per territory = distinct neighbors with strength > minCofire
      const conns = new Map(); // tid → Set(neighbor)
      for (const e of edges) {
        if (e[k] <= minCofire) continue;
        if (!conns.has(e.a)) conns.set(e.a, new Set());
        if (!conns.has(e.b)) conns.set(e.b, new Set());
        conns.get(e.a).add(e.b);
        conns.get(e.b).add(e.a);
      }
      const out = [];
      for (const tp of terts.values()) {
        if (tp.is_catchall || tp.message_count < minMessages) continue;
        const cc = conns.get(tp.territory_id)?.size ?? 0;
        if (cc > maxConn) continue;
        out.push({ territory_id: tp.territory_id, name: tp.name, essence: tp.essence, message_count: tp.message_count, connection_count: cc });
      }
      out.sort((x, y) => y.message_count - x.message_count);
      return out.slice(0, limit);
    },

    async getBridges(params) {
      const k = scaleKey(params.p_scale);
      const min = params.p_min_cofire ?? 0.05;
      const minConn = params.p_min_connections ?? 3;
      const limit = params.p_limit ?? 10;
      const [edges, terts] = await Promise.all([
        loadCofire(params.p_user_id),
        loadTerritories(params.p_user_id),
      ]);
      const agg = new Map(); // tid → { neighbors:Set, realms:Set, total }
      const bump = (tid, neighborId, strength) => {
        const tp = terts.get(tid);
        if (!tp || tp.is_catchall) return;
        if (!agg.has(tid)) agg.set(tid, { neighbors: new Set(), realms: new Set(), total: 0 });
        const a = agg.get(tid);
        a.neighbors.add(neighborId);
        const nb = terts.get(neighborId);
        if (nb && nb.realm_id != null) a.realms.add(nb.realm_id);
        a.total += strength;
      };
      for (const e of edges) {
        if (e[k] <= min) continue;
        bump(e.a, e.b, e[k]);
        bump(e.b, e.a, e[k]);
      }
      const out = [];
      for (const [tid, a] of agg) {
        if (a.neighbors.size < minConn) continue;
        const tp = terts.get(tid);
        out.push({ territory_id: tid, name: tp.name, connection_count: a.neighbors.size, connected_realms: a.realms.size, total_cofire_strength: round3(a.total) });
      }
      out.sort((x, y) => y.connection_count - x.connection_count);
      return out.slice(0, limit);
    },

    async getGaps(params) {
      const k = scaleKey(params.p_scale);
      const maxCofire = params.p_max_cofire ?? 0.05;
      const limit = params.p_limit ?? 10;
      const [neighbors, edges, terts] = await Promise.all([
        loadNeighbors(params.p_user_id, params.p_territory_id),
        loadCofire(params.p_user_id, params.p_territory_id),
        loadTerritories(params.p_user_id),
      ]);
      // neighbors that already co-fire above the threshold are NOT gaps
      const cofiring = new Set();
      for (const e of edges) {
        if (e[k] > maxCofire) cofiring.add(e.a === params.p_territory_id ? e.b : e.a);
      }
      const out = [];
      for (const n of neighbors) {
        if (cofiring.has(n.neighbor_id)) continue;
        const tp = terts.get(n.neighbor_id);
        if (!tp) continue;
        const sim = 1 - n.distance;
        out.push({ territory_id: n.neighbor_id, name: tp.name, message_count: tp.message_count, semantic_similarity: sim, cofire_strength: 0, gap_score: sim });
      }
      out.sort((x, y) => x.semantic_similarity < y.semantic_similarity ? 1 : -1); // distance ASC == similarity DESC
      return out.slice(0, limit);
    },

    async getCluster(params) {
      const k = scaleKey(params.p_scale);
      const limit = params.p_limit ?? 20;
      // same-theme territories via plaintext keys (clustering_points.theme_id)
      const sameTheme = rowsOf(await d1Query(
        `SELECT DISTINCT tp.territory_id, tp.name, tp.essence, tp.message_count
         FROM clustering_points cp
         JOIN territory_profiles tp ON tp.territory_id = cp.territory_id AND tp.user_id = cp.user_id
         WHERE cp.user_id = ? AND cp.territory_id != ?
           AND tp.dissolved_at IS NULL
           AND cp.theme_id IN (SELECT theme_id FROM clustering_points WHERE user_id = ? AND territory_id = ?)`,
        [params.p_user_id, params.p_territory_id, params.p_user_id, params.p_territory_id],
      ));
      const edges = await loadCofire(params.p_user_id, params.p_territory_id);
      const strengthTo = new Map();
      for (const e of edges) strengthTo.set(e.a === params.p_territory_id ? e.b : e.a, e[k]);
      const out = sameTheme.map((tp) => ({
        territory_id: tp.territory_id, name: tp.name, essence: tp.essence,
        message_count: numOr0(tp.message_count), depth: 1,
        path_strength: round3(strengthTo.get(tp.territory_id) ?? 0),
      }));
      out.sort((x, y) => y.path_strength - x.path_strength);
      return out.slice(0, limit);
    },

    async walkGraph(params) {
      const k = scaleKey(params.p_scale);
      const maxDepth = params.p_depth || 2;
      const minStrength = params.p_min_strength || 0.1;
      const limit = params.p_limit || 20;
      const userId = params.p_user_id;
      const seedId = params.p_territory_id;
      const [allEdges, terts] = await Promise.all([loadCofire(userId), loadTerritories(userId)]);

      // adjacency: tid → [{neighbor, strength}] above the threshold, non-catchall
      const adj = new Map();
      const add = (from, to, s) => {
        const tp = terts.get(to);
        if (!tp || tp.is_catchall) return;
        if (!adj.has(from)) adj.set(from, []);
        adj.get(from).push({ neighbor: to, strength: s });
      };
      for (const e of allEdges) {
        if (e[k] <= minStrength) continue;
        add(e.a, e.b, e[k]);
        add(e.b, e.a, e[k]);
      }

      const visited = new Set([seedId]);
      const results = [];
      let frontier = [{ territory_id: seedId, path_strength: 1.0 }];
      for (let d = 1; d <= maxDepth; d++) {
        const next = [];
        for (const node of frontier) {
          const nbs = (adj.get(node.territory_id) || []).slice().sort((a, b) => b.strength - a.strength).slice(0, 15);
          for (const nb of nbs) {
            if (visited.has(nb.neighbor)) continue;
            visited.add(nb.neighbor);
            const tp = terts.get(nb.neighbor);
            const pathStrength = node.path_strength * nb.strength;
            results.push({
              territory_id: nb.neighbor, name: tp?.name, message_count: tp?.message_count ?? 0,
              depth: d, path_strength: round3(pathStrength), cofire_strength: round3(nb.strength),
            });
            next.push({ territory_id: nb.neighbor, path_strength: pathStrength });
          }
        }
        frontier = next;
        if (!frontier.length) break;
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

      const candidates = rowsOf(await d1Query(
        `SELECT territory_id, name, essence, message_count, realm_id, centroid_256
         FROM territory_profiles
         WHERE user_id = ? AND territory_id != ?
           AND centroid_256 IS NOT NULL
           AND COALESCE(is_catchall, 0) = 0
           AND dissolved_at IS NULL
           AND message_count > 0`,
        [userId, territoryId],
      ));

      // already-co-firing neighbours (weekly > 0.05) excluded — strengths decrypted in JS
      const edges = await loadCofire(userId, territoryId);
      const cofireSet = new Set();
      for (const e of edges) {
        if (e.weekly > 0.05) cofireSet.add(e.a === territoryId ? e.b : e.a);
      }

      const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s) || 1; };
      const seedNorm = norm(seedVec);
      const scored = [];
      for (const c of candidates) {
        if (cofireSet.has(c.territory_id)) continue;
        const vec = typeof c.centroid_256 === 'string' ? JSON.parse(c.centroid_256) : c.centroid_256;
        if (!vec || vec.length !== seedVec.length) continue;
        let dot = 0;
        for (let i = 0; i < seedVec.length; i++) dot += seedVec[i] * vec[i];
        const sim = dot / (seedNorm * norm(vec));
        if (sim >= minSimilarity) {
          scored.push({
            territory_id: c.territory_id, name: c.name, essence: c.essence,
            message_count: numOr0(c.message_count), realm_id: c.realm_id,
            similarity: round3(sim), cofire_strength: 0, gap_type: 'orphan_embedding',
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
      // T1: the snapshot's metric columns are ENCRYPTED at rest; the adapter
      // auto-decrypts them to STRINGS. Coerce the numerics back to numbers so
      // downstream consumers (REST/portal) get usable values. m2_trend stays a
      // string (categorical). critical_count/warning_count come from the
      // COUNT(*) subqueries (plaintext integers) and need no coercion.
      return coerceAuditNums(firstRow(result));
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
      // T1: ORDER BY run_at is plaintext (fine); the SELECTed metric columns
      // decrypt to strings → coerce each row's numerics.
      return (result.results || []).map(coerceAuditNums);
    },

    async getAuditFindings(params) {
      // T1: message_count is now ENCRYPTED → it cannot be a SQL ORDER BY key
      // (non-deterministic ciphertext). Sort by the plaintext severity rank in
      // SQL, then break ties by the DECRYPTED message_count in JS (the adapter
      // auto-decrypts on read). LIMIT is applied AFTER the JS sort so the top-N
      // reflects the real (decrypted) ordering.
      const result = await d1Query(
        `SELECT f.*
         FROM topology_audit_findings f
         WHERE f.user_id = ? AND f.snapshot_id = ?
         ORDER BY
           CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
        [params.p_user_id, params.p_snapshot_id],
      );
      const limit = params.p_limit || 50;
      const sevRank = (s) => (s === 'critical' ? 0 : s === 'warning' ? 1 : 2);
      const rows = (result.results || []).map(coerceFindingNums);
      rows.sort((a, b) => (sevRank(a.severity) - sevRank(b.severity))
        || ((b.message_count || 0) - (a.message_count || 0)));
      return rows.slice(0, limit);
    },

    async getBridgesWithHealth(params) {
      const k = scaleKey(params.p_scale);
      const min = params.p_min_cofire ?? 0.05;
      const minConn = params.p_min_connections ?? 3;
      const limit = params.p_limit ?? 10;
      const [edges, terts] = await Promise.all([
        loadCofire(params.p_user_id),
        loadTerritories(params.p_user_id),
      ]);
      const agg = new Map(); // tid → { neighbors:Set, realms:Set, total, count }
      const bump = (tid, neighborId, strength) => {
        const tp = terts.get(tid);
        if (!tp || tp.is_catchall) return;
        if (!agg.has(tid)) agg.set(tid, { neighbors: new Set(), realms: new Set(), total: 0, n: 0 });
        const a = agg.get(tid);
        a.neighbors.add(neighborId);
        const nb = terts.get(neighborId);
        if (nb && nb.realm_id != null) a.realms.add(nb.realm_id);
        a.total += strength; a.n += 1;
      };
      for (const e of edges) {
        if (e[k] <= min) continue;
        bump(e.a, e.b, e[k]);
        bump(e.b, e.a, e[k]);
      }
      const out = [];
      for (const [tid, a] of agg) {
        if (a.neighbors.size < minConn || a.realms.size <= 1) continue;
        const tp = terts.get(tid);
        out.push({
          territory_id: tid, name: tp.name, essence: tp.essence, message_count: tp.message_count,
          coherence: tp.coherence, is_catchall: tp.is_catchall,
          connection_count: a.neighbors.size, connected_realms: a.realms.size,
          total_strength: round3(a.total), avg_strength: round3(a.n ? a.total / a.n : 0),
        });
      }
      out.sort((x, y) => (y.connected_realms - x.connected_realms) || (y.avg_strength - x.avg_strength));
      return out.slice(0, limit);
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
