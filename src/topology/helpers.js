/**
 * topologyHelpers — the resolver + fetchers the topology MCP tools depend on.
 *
 * BUILD-NEW (V1): not present in reference/. The topology MCP domain
 * (src/tools/topology-tools.js) consumes `topologyHelpers` with this exact
 * shape:
 *
 *   { resolveTerritoryId, fetchCoFiring, fetchGaps, fetchCluster,
 *     fetchOrphans, fetchBridges }
 *
 * Each fetcher is a thin adapter over the db.topology namespace
 * (src/db/topology.js), which already speaks the encrypted SQLite vault via
 * the d1Query adapter. The namespace methods take `p_*` params and return
 * arrays; the tool handlers call the fetchers with positional/option args, so
 * the helpers translate between the two and inject the single-user `user_id`.
 *
 * Honest-empty contract: against an EMPTY vault (topology tables exist but hold
 * no rows), every fetcher resolves to `[]` and resolveTerritoryId resolves to
 * `{ id: null, name: null }` — no throw, no fabricated data.
 *
 * @param {object} deps
 * @param {object} deps.db      assembled db namespace (needs rawQuery + topology.*)
 * @param {string} [deps.userId='local-user'] single-user scope id
 */
export function createTopologyHelpers(deps) {
  if (!deps) throw new TypeError('createTopologyHelpers: deps required');
  const { db, userId = 'local-user' } = deps;
  if (!db) throw new TypeError('createTopologyHelpers: db required');
  if (!db.topology) throw new TypeError('createTopologyHelpers: db.topology namespace required');

  const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));

  /**
   * Resolve a territory name (string, fuzzy) or numeric ID to
   * { id, name }. Numeric input is taken as the ID directly; string input is
   * matched against territory_profiles.name (exact, then LIKE). Returns
   * { id: null, name: null } when nothing matches (honest empty).
   */
  async function resolveTerritoryId(territory) {
    if (territory === null || territory === undefined || territory === '') {
      return { id: null, name: null };
    }

    // Numeric ID (number or numeric string) — look up its name, accept even if absent.
    const asNum = typeof territory === 'number' ? territory
      : (/^\d+$/.test(String(territory).trim()) ? Number(String(territory).trim()) : null);
    if (asNum !== null) {
      const rows = asArray(await db.rawQuery(
        `SELECT territory_id, name FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [userId, asNum],
      ).catch(() => []));
      return { id: asNum, name: rows[0]?.name || null };
    }

    const name = String(territory).trim();

    // Exact (case-insensitive) match first.
    let rows = asArray(await db.rawQuery(
      `SELECT territory_id, name FROM territory_profiles
       WHERE user_id = ? AND LOWER(name) = LOWER(?) AND dissolved_at IS NULL
       ORDER BY message_count DESC LIMIT 1`,
      [userId, name],
    ).catch(() => []));
    if (rows[0]) return { id: rows[0].territory_id, name: rows[0].name };

    // Fuzzy LIKE fallback.
    rows = asArray(await db.rawQuery(
      `SELECT territory_id, name FROM territory_profiles
       WHERE user_id = ? AND LOWER(name) LIKE LOWER(?) AND dissolved_at IS NULL
       ORDER BY message_count DESC LIMIT 1`,
      [userId, `%${name}%`],
    ).catch(() => []));
    if (rows[0]) return { id: rows[0].territory_id, name: rows[0].name };

    return { id: null, name: null };
  }

  function fetchCoFiring(territoryId, opts = {}) {
    return db.topology.getCoFiring({
      p_user_id: userId,
      p_territory_id: territoryId,
      p_scale: opts.scale,
      p_limit: opts.limit,
      p_min_strength: opts.minStrength,
    }).then(asArray).catch(() => []);
  }

  function fetchGaps(territoryId, opts = {}) {
    return db.topology.getGaps({
      p_user_id: userId,
      p_territory_id: territoryId,
      p_scale: opts.scale,
      p_limit: opts.limit,
      p_max_cofire: opts.maxCofire,
    }).then(asArray).catch(() => []);
  }

  function fetchCluster(territoryId, opts = {}) {
    // depth > 1 → graph walk; depth 1 → same-theme cluster slice.
    if (opts.depth && opts.depth > 1) {
      return db.topology.walkGraph({
        p_user_id: userId,
        p_territory_id: territoryId,
        p_scale: opts.scale,
        p_depth: opts.depth,
        p_limit: opts.limit,
      }).then(asArray).catch(() => []);
    }
    return db.topology.getCluster({
      p_user_id: userId,
      p_territory_id: territoryId,
      p_scale: opts.scale,
      p_limit: opts.limit,
    }).then(asArray).catch(() => []);
  }

  function fetchOrphans(opts = {}) {
    return db.topology.getOrphans({
      p_user_id: userId,
      p_scale: opts.scale,
      p_limit: opts.limit,
    }).then(asArray).catch(() => []);
  }

  function fetchBridges(opts = {}) {
    return db.topology.getBridges({
      p_user_id: userId,
      p_scale: opts.scale,
      p_limit: opts.limit,
    }).then(asArray).catch(() => []);
  }

  return {
    resolveTerritoryId,
    fetchCoFiring,
    fetchGaps,
    fetchCluster,
    fetchOrphans,
    fetchBridges,
  };
}
