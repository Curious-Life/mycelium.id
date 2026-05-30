/**
 * Territory docs namespace — reads and writes LLM-generated territory
 * descriptions (name, essence, archetype, story, signatures, etc.).
 *
 * Two upsert paths: `upsertDynamics` for computed fields (energy,
 * coherence, velocity — emitted by clustering) and `upsertDescription`
 * for LLM-generated narrative fields. They target the same
 * `territory_profiles` table with different conflict resolution so the
 * two writers don't stomp each other.
 *
 * `getDailyActivations` powers the portal's "what's alive today" view:
 * which territories received messages today, which normally-active
 * territories went silent, ranked by deviation from baseline energy.
 *
 * @typedef {object} TerritoryDocsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(val: any) => any} parseJson — tolerant JSON parse
 */

export function createTerritoryDocsNamespace(deps) {
  if (!deps) throw new TypeError('createTerritoryDocsNamespace: deps required');
  const { d1Query, parseJson } = deps;
  if (typeof d1Query !== 'function')   throw new TypeError('createTerritoryDocsNamespace: d1Query required');
  if (typeof parseJson !== 'function') throw new TypeError('createTerritoryDocsNamespace: parseJson required');

  return {
    /** Get territories needing description (no description_version or outdated) */
    async getNeedingDescription(userId, currentVersion) {
      const result = await d1Query(`
        SELECT tp.territory_id, tp.name, tp.essence, tp.story_birth, tp.story_arc,
               tp.story_current_chapter, tp.signature_patterns, tp.open_questions,
               tp.description_version, tp.point_count_at_description, tp.message_count,
               tp.steward_agent_id, tp.growth_state, tp.energy, tp.coherence, tp.velocity,
               tp.moments_of_interest, tp.realm_id
        FROM territory_profiles tp
        WHERE tp.user_id = ?
          AND (tp.description_version IS NULL OR tp.description_version != ?)
        ORDER BY tp.message_count DESC
      `, [userId, currentVersion]);
      return (result.results || []).map(row => ({
        ...row,
        signature_patterns: parseJson(row.signature_patterns),
        moments_of_interest: parseJson(row.moments_of_interest),
      }));
    },

    /** Get all territory profiles with dynamics for a user */
    async getAllWithDynamics(userId) {
      const result = await d1Query(`
        SELECT territory_id, realm_id, name, essence, archetype_type, archetype_character,
               message_count, steward_agent_id, growth_state, energy, coherence, velocity,
               point_delta, description_version, point_count_at_description,
               story_birth, story_arc, story_current_chapter, story_peak_moments,
               signature_patterns, uncertainty_open_questions, uncertainty_edges,
               agent_expertise, agent_can_help_with, agent_curious_about, agent_would_consult,
               moments_of_interest,
               last_described_at, top_entities,
               activity_timeline, centroid_3d,
               explored_count, explored_percent, semantic_theme_id,
               chronicle, chronicle_cursor,
               temporal_saliency, first_active, last_active, days_active
        FROM territory_profiles WHERE user_id = ?
        ORDER BY energy DESC NULLS LAST
      `, [userId]);
      return (result.results || []).map(row => ({
        ...row,
        top_entities: parseJson(row.top_entities),
        signature_patterns: parseJson(row.signature_patterns),
        story_peak_moments: parseJson(row.story_peak_moments),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        agent_can_help_with: parseJson(row.agent_can_help_with),
        agent_would_consult: parseJson(row.agent_would_consult),
        moments_of_interest: parseJson(row.moments_of_interest),
        activity_timeline: parseJson(row.activity_timeline),
        centroid_3d: parseJson(row.centroid_3d),
      }));
    },

    /** Get a single territory profile by territory_id */
    async getByTerritoryId(userId, territoryId) {
      const result = await d1Query(`
        SELECT * FROM territory_profiles
        WHERE user_id = ? AND territory_id = ?
      `, [userId, territoryId]);
      const row = (result.results || [])[0];
      if (!row) return null;
      return {
        ...row,
        top_entities: parseJson(row.top_entities),
        signature_patterns: parseJson(row.signature_patterns),
        story_peak_moments: parseJson(row.story_peak_moments),
        uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        agent_can_help_with: parseJson(row.agent_can_help_with),
        agent_would_consult: parseJson(row.agent_would_consult),
        moments_of_interest: parseJson(row.moments_of_interest),
      };
    },

    /** Upsert dynamics (computed fields, not LLM-generated) */
    async upsertDynamics(userId, territoryId, dynamics) {
      await d1Query(`
        INSERT INTO territory_profiles (user_id, territory_id, energy, coherence, velocity,
          growth_state, steward_agent_id, message_count, point_delta, realm_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(territory_id, user_id) DO UPDATE SET
          energy = excluded.energy, coherence = excluded.coherence,
          velocity = excluded.velocity, growth_state = excluded.growth_state,
          steward_agent_id = excluded.steward_agent_id,
          message_count = excluded.message_count, point_delta = excluded.point_delta,
          realm_id = excluded.realm_id, updated_at = datetime('now')
      `, [userId, territoryId, dynamics.energy, dynamics.coherence, dynamics.velocity,
          dynamics.growth_state, dynamics.steward_agent_id, dynamics.message_count,
          dynamics.point_delta, dynamics.realm_id]);
    },

    /** Upsert full description (LLM-generated fields) */
    async upsertDescription(userId, territoryId, desc, version, rawResponse) {
      await d1Query(`
        INSERT INTO territory_profiles (user_id, territory_id, name, essence,
          archetype_type, archetype_character,
          story_birth, story_arc, story_current_chapter, story_peak_moments,
          signature_patterns, uncertainty_open_questions, uncertainty_edges,
          agent_expertise, agent_curious_about, agent_can_help_with, agent_would_consult,
          top_entities,
          description_version, point_count_at_description, last_described_at,
          generation_model, raw_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'claude-opus', ?)
        ON CONFLICT(territory_id, user_id) DO UPDATE SET
          name = excluded.name, essence = excluded.essence,
          archetype_type = excluded.archetype_type, archetype_character = excluded.archetype_character,
          story_birth = excluded.story_birth, story_arc = excluded.story_arc,
          story_current_chapter = excluded.story_current_chapter,
          story_peak_moments = excluded.story_peak_moments,
          signature_patterns = excluded.signature_patterns,
          uncertainty_open_questions = excluded.uncertainty_open_questions,
          uncertainty_edges = excluded.uncertainty_edges,
          agent_expertise = excluded.agent_expertise,
          agent_curious_about = excluded.agent_curious_about,
          agent_can_help_with = excluded.agent_can_help_with,
          agent_would_consult = excluded.agent_would_consult,
          top_entities = excluded.top_entities,
          description_version = excluded.description_version,
          point_count_at_description = excluded.point_count_at_description,
          last_described_at = excluded.last_described_at,
          generation_model = excluded.generation_model,
          raw_response = excluded.raw_response,
          updated_at = datetime('now')
      `, [userId, territoryId, desc.name, desc.essence,
          desc.archetype_type, desc.archetype_character,
          desc.story_birth, desc.story_arc, desc.story_current_chapter,
          JSON.stringify(desc.story_peak_moments || []),
          JSON.stringify(desc.signature_patterns || []),
          JSON.stringify(desc.uncertainty_open_questions || []),
          desc.uncertainty_edges,
          desc.agent_expertise, desc.agent_curious_about,
          JSON.stringify(desc.agent_can_help_with || []),
          JSON.stringify(desc.agent_would_consult || []),
          JSON.stringify(desc.top_entities || []),
          version, desc.point_count,
          rawResponse || JSON.stringify(desc)]);
    },

    /** Append a moment of interest to a territory (keeps last 20) */
    async appendMoment(userId, territoryId, moment) {
      const existing = await d1Query(
        `SELECT moments_of_interest FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [userId, territoryId],
      );
      const row = (existing.results || [])[0];
      const moments = parseJson(row?.moments_of_interest) || [];
      moments.push(moment);
      const trimmed = moments.slice(-20);
      await d1Query(
        `UPDATE territory_profiles SET moments_of_interest = ?, updated_at = datetime('now')
         WHERE user_id = ? AND territory_id = ?`,
        [JSON.stringify(trimmed), userId, territoryId],
      );
    },

    /**
     * Get today's territory activations: which territories received messages,
     * how many, who (which agents), and how that compares to baseline energy.
     * Returns territories sorted by surprise (deviation from expected).
     */
    async getDailyActivations(userId, date) {
      // date = 'YYYY-MM-DD'
      const since = `${date}T00:00:00Z`;
      const until = `${date}T23:59:59Z`;

      const activations = await d1Query(`
        SELECT cp.territory_id, cp.realm_id,
               COUNT(*) as today_count,
               GROUP_CONCAT(DISTINCT m.agent_id) as agents,
               GROUP_CONCAT(DISTINCT m.source) as sources
        FROM messages m
        JOIN clustering_points cp ON cp.source_id = m.id AND cp.source_type = 'message'
        WHERE m.user_id = ? AND m.created_at >= ? AND m.created_at <= ?
          AND cp.territory_id IS NOT NULL
        GROUP BY cp.territory_id
        ORDER BY today_count DESC
      `, [userId, since, until]);

      if (!activations.results?.length) return { active: [], silent: [], date };

      const activeTerritoryIds = (activations.results || []).map(a => a.territory_id);
      const placeholders = activeTerritoryIds.map(() => '?').join(',');
      const profiles = await d1Query(`
        SELECT territory_id, name, essence, energy, growth_state, coherence,
               velocity, message_count, steward_agent_id, realm_id
        FROM territory_profiles
        WHERE user_id = ? AND territory_id IN (${placeholders})
      `, [userId, ...activeTerritoryIds]);

      const profileMap = {};
      for (const p of (profiles.results || [])) {
        profileMap[p.territory_id] = p;
      }

      const totalResult = await d1Query(`
        SELECT COUNT(*) as total FROM messages
        WHERE user_id = ? AND created_at >= ? AND created_at <= ?
      `, [userId, since, until]);
      const totalToday = totalResult.results?.[0]?.total || 1;

      // Surprise = deviation of today's activation from baseline energy.
      // Positive = more active than usual, negative = quieter than usual.
      // New territory (baseline 0) with >2 messages = automatic surprise 1.0.
      const active = (activations.results || []).map(a => {
        const profile = profileMap[a.territory_id] || {};
        const todayEnergy = a.today_count / totalToday;
        const baselineEnergy = profile.energy || 0;
        const surprise = baselineEnergy > 0
          ? (todayEnergy - baselineEnergy) / baselineEnergy
          : (a.today_count > 2 ? 1.0 : 0.5);
        return {
          territory_id: a.territory_id,
          realm_id: a.realm_id,
          name: profile.name || `Territory ${a.territory_id}`,
          essence: profile.essence,
          today_count: a.today_count,
          today_energy: Math.round(todayEnergy * 1000) / 1000,
          baseline_energy: Math.round((baselineEnergy || 0) * 1000) / 1000,
          surprise: Math.round(surprise * 100) / 100,
          growth_state: profile.growth_state,
          agents: a.agents ? a.agents.split(',').filter(Boolean) : [],
          sources: a.sources ? a.sources.split(',').filter(Boolean) : [],
        };
      }).sort((a, b) => Math.abs(b.surprise) - Math.abs(a.surprise));

      // Normally-active territories that went silent today.
      const silentResult = await d1Query(`
        SELECT territory_id, name, essence, energy, growth_state, message_count
        FROM territory_profiles
        WHERE user_id = ? AND energy > 0.02 AND territory_id NOT IN (${placeholders})
        ORDER BY energy DESC LIMIT 10
      `, [userId, ...activeTerritoryIds]);

      const silent = (silentResult.results || []).map(s => ({
        territory_id: s.territory_id,
        name: s.name || `Territory ${s.territory_id}`,
        essence: s.essence,
        baseline_energy: Math.round((s.energy || 0) * 1000) / 1000,
        growth_state: s.growth_state,
        message_count: s.message_count,
      }));

      return { active, silent, date, total_messages: totalToday };
    },
  };
}
