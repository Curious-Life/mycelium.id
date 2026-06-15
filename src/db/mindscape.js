/**
 * Mindscape namespace — visualization reads (clustering points + theme
 * cards + territory profiles + realms + semantic themes).
 *
 * Every method parses JSON columns through the injected `parseJson`
 * (tolerant — returns null on malformed input). Column lists match the
 * portal's 3D mindscape rendering contract exactly.
 *
 * @typedef {object} MindscapeNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(val: any) => any} parseJson
 */

export function createMindscapeNamespace(deps) {
  if (!deps) throw new TypeError('createMindscapeNamespace: deps required');
  const { d1Query, parseJson } = deps;
  if (typeof d1Query !== 'function')   throw new TypeError('createMindscapeNamespace: d1Query required');
  if (typeof parseJson !== 'function') throw new TypeError('createMindscapeNamespace: parseJson required');

  return {
    async getPoints(userId, limit = 100000) {
      const result = await d1Query(
        `SELECT id, source_id, atom_id, territory_id, theme_id, realm_id,
                landscape_x, landscape_y, landscape_z, source_type, created_at
         FROM clustering_points
         WHERE user_id = ? AND landscape_x IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    async getNoiseStats(userId) {
      const result = await d1Query(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN territory_id IS NULL OR territory_id = -1 THEN 1 ELSE 0 END) as noise
         FROM clustering_points
         WHERE user_id = ? AND landscape_x IS NOT NULL`,
        [userId],
      );
      const row = (result.results || [])[0] || { total: 0, noise: 0 };
      return {
        total: row.total || 0,
        noise: row.noise || 0,
        noisePct: row.total > 0 ? ((row.noise / row.total) * 100).toFixed(1) : '0',
      };
    },

    async getThemeCards(userId) {
      const result = await d1Query(
        `SELECT theme_id, territory_id, title, essence, message_count,
                explored_count, explored_percent, top_entities,
                story_birth, story_arc, story_peak_moments, story_current_chapter,
                uncertainty_open_questions, uncertainty_edges
         FROM theme_cards WHERE user_id = ?`,
        [userId],
      );
      return (result.results || []).map((row) => ({
        ...row,
        top_entities: parseJson(row.top_entities),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
      }));
    },

    async getTerritoryProfiles(userId) {
      const result = await d1Query(
        `SELECT territory_id, realm_id, semantic_theme_id, name, essence,
                archetype_type, archetype_character,
                message_count, explored_count, explored_percent,
                top_entities, signature_patterns,
                story_birth, story_arc, story_peak_moments, story_current_chapter,
                uncertainty_open_questions, uncertainty_edges,
                agent_expertise, agent_curious_about, agent_can_help_with, agent_would_consult,
                visibility, temporal_saliency, first_active, last_active, days_active,
                current_vitality, current_phase, is_anchored, predecessor_ids, evolved_from_count,
                dissolved_at
         FROM territory_profiles WHERE user_id = ? AND dissolved_at IS NULL`,
        [userId],
      );
      return (result.results || []).map((row) => ({
        ...row,
        top_entities: parseJson(row.top_entities),
        signature_patterns: parseJson(row.signature_patterns),
        story_peak_moments: parseJson(row.story_peak_moments),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        agent_can_help_with: parseJson(row.agent_can_help_with),
        agent_would_consult: parseJson(row.agent_would_consult),
      }));
    },

    async getRealms(userId) {
      const result = await d1Query(
        `SELECT realm_id, name, essence, archetype_type, archetype_character,
                territory_count, message_count, top_entities, signature_patterns,
                story_birth, story_arc, story_peak_moments, story_current_chapter,
                uncertainty_open_questions, uncertainty_edges,
                agent_expertise, agent_curious_about, agent_can_help_with,
                activity_timeline, explored_percent
         FROM realms WHERE user_id = ?`,
        [userId],
      );
      return (result.results || []).map((row) => ({
        ...row,
        top_entities: parseJson(row.top_entities),
        signature_patterns: parseJson(row.signature_patterns),
        story_peak_moments: parseJson(row.story_peak_moments),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        agent_can_help_with: parseJson(row.agent_can_help_with),
        activity_timeline: parseJson(row.activity_timeline),
      }));
    },

    /** Write a realm's chronicle (describe-chronicles realm pass). UPDATE-only —
     * realm rows are created exclusively by describe-clusters from live points
     * (or import); narration must never resurrect a pruned/absent realm
     * (fail-closed). NOTE: raw model output is deliberately NOT stored —
     * realms.raw_response is not in ENCRYPTED_FIELDS.realms, so writing it
     * would put narrative plaintext at rest (CLAUDE.md §1). */
    async upsertRealmDescription(userId, realmId, desc, version, modelLabel = 'unknown') {
      await d1Query(
        `UPDATE realms SET
           essence = ?, archetype_type = ?, archetype_character = ?,
           story_birth = ?, story_arc = ?, story_current_chapter = ?,
           story_peak_moments = ?, signature_patterns = ?,
           uncertainty_open_questions = ?, uncertainty_edges = ?,
           agent_expertise = ?, agent_curious_about = ?, agent_can_help_with = ?,
           generation_version = ?, point_count_at_description = ?,
           generated_at = datetime('now'), generation_model = ?,
           updated_at = datetime('now')
         WHERE user_id = ? AND realm_id = ?`,
        [desc.essence, desc.archetype_type, desc.archetype_character,
         desc.story_birth, desc.story_arc, desc.story_current_chapter,
         JSON.stringify(desc.story_peak_moments || []),
         JSON.stringify(desc.signature_patterns || []),
         JSON.stringify(desc.uncertainty_open_questions || []),
         desc.uncertainty_edges,
         desc.agent_expertise, desc.agent_curious_about,
         JSON.stringify(desc.agent_can_help_with || []),
         version, desc.point_count, modelLabel,
         userId, realmId],
      );
    },

    async getSemanticThemes(userId) {
      const result = await d1Query(
        `SELECT realm_id, semantic_theme_id, name, essence,
                territory_count, message_count, territory_ids,
                included_territory_count, coverage_percent, explored_percent,
                top_entities, signature_patterns,
                story_birth, story_arc, story_current_chapter,
                uncertainty_open_questions
         FROM semantic_themes WHERE user_id = ?`,
        [userId],
      );
      return (result.results || []).map((row) => ({
        ...row,
        territory_ids: parseJson(row.territory_ids),
        top_entities: parseJson(row.top_entities),
        signature_patterns: parseJson(row.signature_patterns),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
      }));
    },

    // ── Theme materialization + narration (describe-chronicles theme pass) ──────
    // The THEME level (semantic_themes) is materialized in the DESCRIBE stage from
    // clustering_points.theme_id (cluster.py's structural output). theme_id ===
    // semantic_theme_id, realm-local. A territory's theme = its points' DOMINANT
    // theme_id. Themes are a parallel mid-level drill-down between realm and
    // territory; they are narrated from their MEMBER TERRITORY descriptions.

    /** Set each live territory's semantic_theme_id to its points' dominant theme,
     * then return the per-theme rosters (membership + counts). Plaintext columns
     * only (theme_id/realm_id/territory_id/message_count) → SQL aggregation is safe. */
    async assignTerritoryThemes(userId) {
      await d1Query(
        `UPDATE territory_profiles SET semantic_theme_id = (
            SELECT cp.theme_id FROM clustering_points cp
            WHERE cp.user_id = territory_profiles.user_id
              AND cp.territory_id = territory_profiles.territory_id
              AND cp.theme_id IS NOT NULL AND cp.theme_id >= 0
            GROUP BY cp.theme_id ORDER BY COUNT(*) DESC LIMIT 1)
         WHERE user_id = ? AND dissolved_at IS NULL`,
        [userId],
      );
      const r = await d1Query(
        `SELECT realm_id, semantic_theme_id AS theme_id,
                COUNT(*) AS territory_count, SUM(message_count) AS message_count,
                json_group_array(territory_id) AS territory_ids
         FROM territory_profiles
         WHERE user_id = ? AND dissolved_at IS NULL AND semantic_theme_id IS NOT NULL AND realm_id >= 0
         GROUP BY realm_id, semantic_theme_id`,
        [userId],
      );
      return (r.results || []).map((row) => ({
        realm_id: row.realm_id,
        theme_id: row.theme_id,
        territory_count: row.territory_count || 0,
        message_count: row.message_count || 0,
        territory_ids: parseJson(row.territory_ids) || [],
      }));
    },

    /** Create/refresh a theme's STRUCTURAL row (membership + counts). Never writes
     * narration — so an imported chronicle is preserved; a brand-new theme lands
     * with NULL name → the narration gate fills it. */
    async upsertSemanticThemeStructural(userId, { realm_id, theme_id, territory_count, message_count, territory_ids }) {
      await d1Query(
        `INSERT INTO semantic_themes
           (user_id, realm_id, semantic_theme_id, territory_count, message_count,
            territory_ids, included_territory_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, realm_id, semantic_theme_id) DO UPDATE SET
           territory_count = excluded.territory_count, message_count = excluded.message_count,
           territory_ids = excluded.territory_ids, included_territory_count = excluded.included_territory_count,
           updated_at = datetime('now')`,
        [userId, realm_id, theme_id, territory_count, message_count,
         JSON.stringify(territory_ids || []), (territory_ids || []).length],
      );
    },

    /** Themes that still need narration: SELECT the gate inputs. semantic_themes
     * has NO point_count_at_description, so the regen signal is CHILD-CHANGE — the
     * newest member-territory narration vs this theme's generated_at. describe-
     * chronicles filters in JS: narrate if NO name yet (fill gap; preserves
     * imported themes, whose generated_at is NULL) OR a child was described after
     * we last narrated the theme (regenerate-on-significant-child-change). */
    async getSemanticThemesForNarration(userId) {
      const r = await d1Query(
        `SELECT realm_id, semantic_theme_id AS theme_id, name, generated_at, generation_version, message_count,
                (SELECT MAX(tp.last_described_at) FROM territory_profiles tp
                  WHERE tp.user_id = semantic_themes.user_id AND tp.realm_id = semantic_themes.realm_id
                    AND tp.semantic_theme_id = semantic_themes.semantic_theme_id AND tp.dissolved_at IS NULL
                ) AS child_max_described
         FROM semantic_themes WHERE user_id = ? ORDER BY message_count DESC`,
        [userId],
      );
      return r.results || [];
    },

    /** Member-territory digests that a theme is narrated FROM (bottom-up). */
    async getThemeTerritoryDigests(userId, realmId, themeId, limit = 8) {
      const r = await d1Query(
        `SELECT name, essence, story_current_chapter, story_arc, message_count
         FROM territory_profiles
         WHERE user_id = ? AND realm_id = ? AND semantic_theme_id = ?
           AND dissolved_at IS NULL AND name IS NOT NULL
         ORDER BY message_count DESC LIMIT ?`,
        [userId, realmId, themeId, limit],
      );
      return r.results || [];
    },

    /** Write a theme's narration (name + essence + story). UPDATE-only — the row
     * exists from upsertSemanticThemeStructural. Writes ONLY columns in
     * semantic_themes' ENCRYPTED_FIELDS (name, essence, the story fields,
     * signature_patterns, uncertainty_open_questions, top_entities) + plaintext
     * bookkeeping; NOT archetype_type or story_peak_moments (absent / not
     * encrypted on this table, so writing them would leak plaintext, CLAUDE.md §1). */
    async upsertSemanticThemeChronicle(userId, realmId, themeId, desc, version, modelLabel = 'unknown') {
      await d1Query(
        `UPDATE semantic_themes SET
           name = ?, essence = ?,
           story_birth = ?, story_arc = ?, story_current_chapter = ?,
           signature_patterns = ?, uncertainty_open_questions = ?, top_entities = ?,
           generation_version = ?, generated_at = datetime('now'),
           generation_model = ?, updated_at = datetime('now')
         WHERE user_id = ? AND realm_id = ? AND semantic_theme_id = ?`,
        [desc.name, desc.essence,
         desc.story_birth, desc.story_arc, desc.story_current_chapter,
         JSON.stringify(desc.signature_patterns || []),
         JSON.stringify(desc.uncertainty_open_questions || []),
         JSON.stringify(desc.top_entities || []),
         version, modelLabel,
         userId, realmId, themeId],
      );
    },

    /** Prune themes with no live member (fail-closed: never prune when the live
     * roster is empty). liveKeys = [{realm_id, theme_id}]. */
    async pruneSemanticThemes(userId, liveKeys) {
      if (!Array.isArray(liveKeys) || liveKeys.length === 0) return 0;
      const pairs = liveKeys.map((k) => `(${Number(k.realm_id)},${Number(k.theme_id)})`).join(',');
      const r = await d1Query(
        `DELETE FROM semantic_themes
         WHERE user_id = ? AND (realm_id, semantic_theme_id) NOT IN (${pairs})`,
        [userId],
      );
      return r?.meta?.changes ?? 0;
    },

    /** CASCADE explored_percent (message-weighted) territory → theme → realm. */
    async cascadeExploredPercent(userId) {
      await d1Query(
        `UPDATE semantic_themes SET explored_percent = COALESCE((
            SELECT ROUND(SUM(tp.explored_percent * tp.message_count) * 1.0 / NULLIF(SUM(tp.message_count), 0))
            FROM territory_profiles tp
            WHERE tp.user_id = semantic_themes.user_id AND tp.realm_id = semantic_themes.realm_id
              AND tp.semantic_theme_id = semantic_themes.semantic_theme_id AND tp.dissolved_at IS NULL
          ), explored_percent) WHERE user_id = ?`,
        [userId],
      );
      await d1Query(
        `UPDATE realms SET explored_percent = COALESCE((
            SELECT ROUND(SUM(tp.explored_percent * tp.message_count) * 1.0 / NULLIF(SUM(tp.message_count), 0))
            FROM territory_profiles tp
            WHERE tp.user_id = realms.user_id AND tp.realm_id = realms.realm_id AND tp.dissolved_at IS NULL
          ), explored_percent) WHERE user_id = ?`,
        [userId],
      );
    },
  };
}
