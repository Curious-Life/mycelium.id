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
  };
}
