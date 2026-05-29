/**
 * Portal mindscape reads router (Phase 10 PR 7C-b).
 *
 * Owns the read-only mindscape surface — the 3D map, growth events,
 * territory/realm profiles, topology audits, vitality analytics, and
 * social graph. 22 handlers, all portal-session-authenticated, pure
 * D1 queries (no child_process, no SSE, no background_jobs state).
 *
 *   Main aggregator (1):
 *     GET /portal/mindscape                              — 3D scene + activity timelines
 *
 *   Growth + time (3):
 *     GET /portal/mindscape/time-chronicles
 *     GET /portal/mindscape/growth
 *     GET /portal/mindscape/growth/summary
 *
 *   Social graph (2):
 *     GET /portal/mindscape/social                       — contacts by tier + territory links
 *     GET /portal/mindscape/social/:contactId            — contact detail + messages
 *
 *   Territory profiles (3):
 *     GET /portal/mindscape/territories
 *     GET /portal/mindscape/territory/:id
 *     PUT /portal/mindscape/territory/:id/visibility     — the sole write (role-gated)
 *
 *   Complexity + fingerprint (2):
 *     GET /portal/mindscape/complexity
 *     GET /portal/mindscape/fingerprint
 *
 *   Topology (4):
 *     GET /portal/mindscape/topology-audit
 *     GET /portal/mindscape/topology-audit/history
 *     GET /portal/mindscape/bridges
 *     GET /portal/mindscape/cofire
 *
 *   Vitality (2):
 *     GET /portal/mindscape/vitality-map
 *     GET /portal/mindscape/vitality/:territoryId
 *     GET /portal/mindscape/phase-history              — historical phase + freq per territory (Mindscape Pulses M1)
 *
 *   Orphan gaps (2):
 *     GET /portal/mindscape/orphan-gaps
 *     GET /portal/mindscape/orphan-gaps/:territoryId
 *
 *   Realms + activations + noise (3):
 *     GET /portal/mindscape/realms
 *     GET /portal/mindscape/activations
 *     GET /portal/mindscape/noise-stats
 *
 * Exploration job status + the mycelium-generation endpoints stay in
 * agent-server.js for the upcoming PR 7C-c because they carry
 * background-job state + SSE streaming that can't be naively extracted.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalMindscapeReadsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} config                       — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalMindscapeReadsRouter(deps) {
  if (!deps) throw new TypeError('createPortalMindscapeReadsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    safeError,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMindscapeReadsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMindscapeReadsRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalMindscapeReadsRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalMindscapeReadsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  // ══════════════════════════════════════════════════════════════════
  // Main aggregator: the full 3D scene + activity timelines.
  // ══════════════════════════════════════════════════════════════════

  // Shared JSON coercion helpers, scoped to the main aggregator.
  const parseArr = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return []; }
    }
    return [];
  };
  const mapEntities = (raw) => {
    const arr = parseArr(raw);
    return arr.map((e) => {
      if (typeof e === 'string') return { name: e };
      return { name: e.text || e.name || String(e), type: e.type, count: e.count };
    });
  };
  const activityArray = (map) => Object.entries(map || {})
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  router.get('/portal/mindscape', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // Settle individually so one failure doesn't poison the whole scene.
      const results = await Promise.allSettled([
        db.mindscape.getPoints(user.id),
        db.mindscape.getThemeCards(user.id),
        db.mindscape.getTerritoryProfiles(user.id),
        db.mindscape.getRealms(user.id),
        db.mindscape.getSemanticThemes(user.id),
      ]);
      const extract = (r, label) => {
        if (r.status === 'fulfilled') return r.value;
        logger.error?.(`[${LOG_PREFIX}] Mindscape ${label} failed:`, r.reason?.message || r.reason);
        return [];
      };
      const points = extract(results[0], 'points');
      const themeCards = extract(results[1], 'themeCards');
      const territoryProfiles = extract(results[2], 'territoryProfiles');
      const realmProfiles = extract(results[3], 'realms');
      const semanticThemeProfiles = extract(results[4], 'semanticThemes');

      const nodes = points.map((p) => ({
        id: p.source_id ? `${p.source_type === 'message' ? 'msg' : p.source_type}-${p.source_id}` : `cp-${p.id}`,
        type: 'message',
        data: {
          type: p.source_type || 'message',
          clusterId: p.realm_id,
          cluster3d: p.territory_id,
          themeId: p.theme_id,
          atomId: p.atom_id,
          position3d: { x: p.landscape_x, y: p.landscape_y, z: p.landscape_z },
          timestamp: p.created_at,
        },
      }));

      const themeActivity = {};
      const territoryActivity = {};
      const realmActivity = {};
      const semanticThemeActivity = {};
      const territoryCentroids = {};

      for (const p of points) {
        const month = p.created_at?.slice(0, 7);
        if (!month) continue;

        if (p.territory_id != null && p.theme_id != null) {
          const key = `${p.territory_id}-${p.theme_id}`;
          if (!themeActivity[key]) themeActivity[key] = {};
          themeActivity[key][month] = (themeActivity[key][month] || 0) + 1;
        }

        if (p.realm_id != null && p.realm_id !== -1) {
          if (!realmActivity[p.realm_id]) realmActivity[p.realm_id] = {};
          realmActivity[p.realm_id][month] = (realmActivity[p.realm_id][month] || 0) + 1;
        }

        if (p.territory_id != null && p.territory_id !== -1) {
          if (!territoryActivity[p.territory_id]) territoryActivity[p.territory_id] = {};
          territoryActivity[p.territory_id][month] = (territoryActivity[p.territory_id][month] || 0) + 1;

          if (!territoryCentroids[p.territory_id]) {
            territoryCentroids[p.territory_id] = { x: 0, y: 0, z: 0, count: 0 };
          }
          territoryCentroids[p.territory_id].x += p.landscape_x;
          territoryCentroids[p.territory_id].y += p.landscape_y;
          territoryCentroids[p.territory_id].z += p.landscape_z;
          territoryCentroids[p.territory_id].count++;
        }
      }

      const themes = {};
      for (const tc of themeCards) {
        if (!themes[tc.territory_id]) themes[tc.territory_id] = {};
        const actKey = `${tc.territory_id}-${tc.theme_id}`;
        themes[tc.territory_id][tc.theme_id] = {
          title: tc.title,
          essence: tc.essence,
          count: tc.message_count || 0,
          exploredCount: tc.explored_count || 0,
          exploredPercent: tc.explored_percent || 0,
          topEntities: mapEntities(tc.top_entities),
          storyBirth: tc.story_birth,
          storyArc: tc.story_arc,
          storyPeakMoments: parseArr(tc.story_peak_moments),
          storyCurrentChapter: tc.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tc.uncertainty_open_questions),
          uncertaintyEdges: tc.uncertainty_edges,
          activity: activityArray(themeActivity[actKey]),
        };
      }

      const territories = {};
      for (const tp of territoryProfiles) {
        const centroidData = territoryCentroids[tp.territory_id];
        const centroid = centroidData && centroidData.count > 0
          ? { x: centroidData.x / centroidData.count, y: centroidData.y / centroidData.count, z: centroidData.z / centroidData.count }
          : null;

        territories[tp.territory_id] = {
          name: tp.name,
          essence: tp.essence,
          archetypeType: tp.archetype_type,
          archetypeCharacter: tp.archetype_character,
          realmId: tp.realm_id,
          semanticThemeId: tp.semantic_theme_id,
          count: tp.message_count || 0,
          exploredCount: tp.explored_count || 0,
          exploredPercent: tp.explored_percent || 0,
          topEntities: mapEntities(tp.top_entities),
          signaturePatterns: parseArr(tp.signature_patterns),
          storyBirth: tp.story_birth,
          storyArc: tp.story_arc,
          storyPeakMoments: parseArr(tp.story_peak_moments),
          storyCurrentChapter: tp.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tp.uncertainty_open_questions),
          uncertaintyEdges: tp.uncertainty_edges,
          chronicle: tp.chronicle || null,
          agentExpertise: tp.agent_expertise,
          agentCuriousAbout: tp.agent_curious_about,
          agentCanHelpWith: parseArr(tp.agent_can_help_with),
          agentWouldConsult: parseArr(tp.agent_would_consult),
          activity: activityArray(territoryActivity[tp.territory_id]),
          centroid,
          visibility: tp.visibility || 'private',
          temporalSaliency: tp.temporal_saliency ?? null,
          firstActive: tp.first_active || null,
          lastActive: tp.last_active || null,
          daysActive: tp.days_active || null,
          currentVitality: tp.current_vitality ?? null,
          currentPhase: tp.current_phase || null,
          isAnchored: tp.is_anchored || 0,
          predecessorIds: tp.predecessor_ids ? (() => { try { return JSON.parse(tp.predecessor_ids); } catch { return []; } })() : [],
          evolvedFromCount: tp.evolved_from_count || 0,
        };
      }

      const realmCounts = {};
      const territoryCounts = {};
      const realmTerritoryIds = {};
      let noiseRealm = 0;
      let noiseTerritory = 0;
      for (const p of points) {
        if (p.realm_id == null || p.realm_id === -1) noiseRealm++;
        else {
          realmCounts[p.realm_id] = (realmCounts[p.realm_id] || 0) + 1;
          if (p.territory_id != null && p.territory_id !== -1) {
            if (!realmTerritoryIds[p.realm_id]) realmTerritoryIds[p.realm_id] = new Set();
            realmTerritoryIds[p.realm_id].add(p.territory_id);
          }
        }
        if (p.territory_id == null || p.territory_id === -1) noiseTerritory++;
        else territoryCounts[p.territory_id] = (territoryCounts[p.territory_id] || 0) + 1;
      }

      const realmProfileMap = {};
      for (const rp of realmProfiles) realmProfileMap[rp.realm_id] = rp;
      const realms = {};
      // Use points as the source of truth (not profiles) so transient
      // clustering output is still visible even when descriptions lag.
      for (const [realmId, count] of Object.entries(realmCounts)) {
        const rp = realmProfileMap[realmId] || {};
        realms[realmId] = {
          name: rp.name || null,
          essence: rp.essence || null,
          archetypeType: rp.archetype_type || null,
          archetypeCharacter: rp.archetype_character || null,
          territoryCount: (realmTerritoryIds[realmId]?.size) || rp.territory_count || 0,
          pointCount: count,
          topEntities: mapEntities(rp.top_entities),
          signaturePatterns: parseArr(rp.signature_patterns),
          storyBirth: rp.story_birth || null,
          storyArc: rp.story_arc || null,
          storyPeakMoments: parseArr(rp.story_peak_moments),
          storyCurrentChapter: rp.story_current_chapter || null,
          uncertaintyOpenQuestions: parseArr(rp.uncertainty_open_questions),
          uncertaintyEdges: rp.uncertainty_edges || null,
          agentExpertise: rp.agent_expertise || null,
          agentCuriousAbout: rp.agent_curious_about || null,
          agentCanHelpWith: parseArr(rp.agent_can_help_with),
          activity: activityArray(realmActivity[realmId]),
        };
      }

      for (const tp of territoryProfiles) {
        if (tp.semantic_theme_id != null && tp.realm_id != null) {
          const stKey = `${tp.realm_id}-${tp.semantic_theme_id}`;
          const tAct = territoryActivity[tp.territory_id] || {};
          for (const [month, count] of Object.entries(tAct)) {
            if (!semanticThemeActivity[stKey]) semanticThemeActivity[stKey] = {};
            semanticThemeActivity[stKey][month] = (semanticThemeActivity[stKey][month] || 0) + count;
          }
        }
      }

      const semanticThemes = {};
      for (const st of semanticThemeProfiles) {
        const key = `${st.realm_id}-${st.semantic_theme_id}`;
        semanticThemes[key] = {
          realmId: st.realm_id,
          semanticThemeId: st.semantic_theme_id,
          name: st.name,
          essence: st.essence,
          territoryCount: st.territory_count || 0,
          messageCount: st.message_count || 0,
          territoryIds: parseArr(st.territory_ids),
          includedTerritoryCount: st.included_territory_count || st.territory_count || 0,
          coveragePercent: st.coverage_percent ?? 100.0,
          topEntities: mapEntities(st.top_entities),
          signaturePatterns: parseArr(st.signature_patterns),
          storyBirth: st.story_birth,
          storyArc: st.story_arc,
          storyCurrentChapter: st.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(st.uncertainty_open_questions),
          activity: activityArray(semanticThemeActivity[key]),
        };
      }

      const total = points.length;
      res.json({
        nodes,
        themes,
        territories,
        realms,
        semanticThemes,
        meta: {
          total,
          noise10d: noiseRealm,
          noise10dPercent: total > 0 ? (noiseRealm / total * 100).toFixed(1) : 0,
          noise3d: noiseTerritory,
          noise3dPercent: total > 0 ? (noiseTerritory / total * 100).toFixed(1) : 0,
          clusterCounts: realmCounts,
          cluster3dCounts: territoryCounts,
        },
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Mindscape error:`, e.message);
      res.status(500).json({ error: 'Failed to load mindscape data' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Time + growth
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/time-chronicles', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const [rows, monthCoverage] = await Promise.all([
        db.rawQueryDecrypted(
          `SELECT period_key, period_start, theme, signature, territory_count, message_count, granularity
           FROM time_chronicles WHERE user_id = ? ORDER BY period_start`,
          [user.id],
        ),
        db.rawQuery(
          `SELECT substr(created_at, 1, 7) as month, COUNT(*) as points
           FROM clustering_points WHERE user_id IS NOT NULL
           GROUP BY month ORDER BY month`,
          [],
        ),
      ]);

      const chronicleMonths = new Set(rows.filter((r) => r.granularity === 'day').map((r) => r.period_key?.slice(0, 7)));
      const coverage = (monthCoverage || []).map((m) => ({
        month: m.month,
        points: m.points,
        hasChronicle: chronicleMonths.has(m.month),
      }));

      res.json({ chronicles: rows, coverage });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] time-chronicles error:`, e.message);
      res.status(500).json({ error: 'Failed to load time chronicles' });
    }
  });

  router.get('/portal/mindscape/growth', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { level, since, limit } = req.query;
      const events = await db.clusterEvents.getRecent(user.id, {
        level: level || undefined,
        since: since || undefined,
        limit: parseInt(limit, 10) || 50,
      });
      res.json({ events });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Growth events error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch growth events' });
    }
  });

  router.get('/portal/mindscape/growth/summary', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const summary = await db.clusterEvents.getSummary(user.id);
      res.json({ summary });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Growth summary error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch growth summary' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Social graph
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/social', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const tiers = (req.query.tiers || 'inner,engaged').split(',');
      logger.info?.(`[${LOG_PREFIX}] Social: loading tiers=${tiers.join(',')} for user=${user.id}`);

      const contacts = await db.rawQueryDecrypted(
        `SELECT p.id, p.name, p.company, p.position, p.status as tier,
                p.interaction_count, p.outbound_count, p.linkedin_url, p.email,
                p.connected_at, p.last_interaction_at, p.source, p.description
         FROM people p
         WHERE p.user_id = ? AND p.status IN (${tiers.map(() => '?').join(',')})
         ORDER BY p.interaction_count DESC`,
        [user.id, ...tiers],
      );

      // territory_profiles.centroid_3d is often empty, so compute centroids
      // from clustering_points directly (source of truth).
      const centroids = {};
      const centroidRows = await db.rawQuery(
        `SELECT territory_id,
                AVG(landscape_x) as cx, AVG(landscape_y) as cy, AVG(landscape_z) as cz
         FROM clustering_points
         WHERE user_id = ? AND territory_id IS NOT NULL AND territory_id >= 0
               AND landscape_x IS NOT NULL
         GROUP BY territory_id`,
        [user.id],
      );
      for (const r of centroidRows) {
        centroids[r.territory_id] = [r.cx, r.cy, r.cz];
      }

      const contactIds = contacts.map((c) => c.id);
      const links = [];
      if (contactIds.length > 0) {
        for (let i = 0; i < contactIds.length; i += 50) {
          const batch = contactIds.slice(i, i + 50);
          const placeholders = batch.map(() => '?').join(',');
          const batchLinks = await db.rawQuery(
            `SELECT ct.contact_id, ct.territory_id, ct.strength,
                    tp.name as territory_name
             FROM contact_territories ct
             LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id AND tp.user_id = ?
             WHERE ct.contact_id IN (${placeholders})
             ORDER BY ct.strength DESC`,
            [user.id, ...batch],
          );
          links.push(...batchLinks);
        }
      }

      const linksByContact = {};
      for (const link of links) {
        if (!linksByContact[link.contact_id]) linksByContact[link.contact_id] = [];
        linksByContact[link.contact_id].push({
          territory_id: link.territory_id,
          territory_name: link.territory_name,
          strength: link.strength,
          centroid_3d: centroids[link.territory_id] || null,
        });
      }

      const result = contacts.map((c) => {
        let description = null;
        if (c.description) {
          try { description = JSON.parse(c.description); } catch { description = c.description; }
        }
        return {
          id: c.id,
          name: c.name,
          company: c.company,
          position: c.position,
          tier: c.tier,
          interaction_count: c.interaction_count,
          outbound_count: c.outbound_count || 0,
          linkedin_url: c.linkedin_url,
          email: c.email,
          connected_at: c.connected_at,
          last_interaction_at: c.last_interaction_at,
          source: c.source,
          description,
          territories: linksByContact[c.id] || [],
        };
      });

      const tierCounts = await db.rawQuery(
        `SELECT status as tier, COUNT(*) as count FROM people WHERE user_id = ? GROUP BY status ORDER BY count DESC`,
        [user.id],
      );

      res.json({ contacts: result, tiers: tierCounts });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Social contacts error:`, e.message);
      res.status(500).json({ error: 'Failed to load contacts' });
    }
  });

  router.get('/portal/mindscape/social/:contactId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { contactId } = req.params;

      const contacts = await db.rawQueryDecrypted(
        `SELECT id, name, company, position, status as tier, interaction_count,
                linkedin_url, email, connected_at, last_interaction_at, description
         FROM people WHERE id = ? AND user_id = ?`,
        [contactId, user.id],
      );
      if (!contacts.length) return res.status(404).json({ error: 'Contact not found' });
      const contact = contacts[0];

      const territories = await db.rawQuery(
        `SELECT ct.territory_id, ct.strength, ct.mention_count,
                tp.name as territory_name, tp.essence, tp.centroid_3d
         FROM contact_territories ct
         LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id AND tp.user_id = ?
         WHERE ct.contact_id = ?
         ORDER BY ct.strength DESC`,
        [user.id, contactId],
      );

      const messages = await db.rawQuery(
        `SELECT id, role, content, source, conversation_id, metadata, created_at
         FROM messages
         WHERE user_id = ? AND (contact_id = ? OR (conversation_id IN (
           SELECT DISTINCT conversation_id FROM messages WHERE user_id = ? AND contact_id = ? AND conversation_id IS NOT NULL
         ) AND source = 'linkedin'))
         ORDER BY created_at DESC LIMIT 20`,
        [user.id, contactId, user.id, contactId],
      );

      res.json({
        contact,
        territories: territories.map((t) => ({
          ...t,
          centroid_3d: t.centroid_3d ? JSON.parse(t.centroid_3d) : null,
        })),
        messages,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Social contact detail error:`, e.message);
      res.status(500).json({ error: 'Failed to load contact' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Territory profiles + visibility
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/territories', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const territories = await db.territoryDocs.getAllWithDynamics(user.id);
      res.json({ territories });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Territory profiles error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch territory profiles' });
    }
  });

  router.get('/portal/mindscape/territory/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const territory = await db.territoryDocs.getByTerritoryId(user.id, parseInt(req.params.id, 10));
      if (!territory) return res.status(404).json({ error: 'Territory not found' });
      res.json({ territory });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Territory detail error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch territory detail' });
    }
  });

  router.put('/portal/mindscape/territory/:id/visibility', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { visibility } = req.body || {};
      await db.profiles.setTerritoryVisibility(user.id, req.params.id, visibility);
      res.json({ ok: true });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Profile visibility error:`, e.message);
      res.status(400).json({ error: safeError(e, 'Failed to update visibility') });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Complexity + fingerprint
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/complexity', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const latest = await db.rawQuery(
        `SELECT level, level_id, level_name, lz_complexity, point_count, window_end, computed_at
         FROM complexity_snapshots
         WHERE user_id = ?
         ORDER BY computed_at DESC`,
        [user.id],
      );

      const byKey = new Map();
      const globalHistory = [];
      for (const row of latest) {
        const key = `${row.level}:${row.level_id ?? 'null'}`;
        if (!byKey.has(key)) byKey.set(key, row);
        if (row.level === 'global') globalHistory.push({ date: row.window_end, value: row.lz_complexity });
      }

      const territories = [];
      const realms = [];
      let global_complexity = null;

      for (const [, row] of byKey) {
        const entry = { id: row.level_id, name: row.level_name, complexity: row.lz_complexity, points: row.point_count, date: row.window_end };
        if (row.level === 'territory') territories.push(entry);
        else if (row.level === 'realm') realms.push(entry);
        else if (row.level === 'global') global_complexity = row.lz_complexity;
      }

      res.json({ global_complexity, globalHistory: globalHistory.reverse(), territories, realms });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Complexity error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch complexity data' });
    }
  });

  router.get('/portal/mindscape/fingerprint', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const rows = await db.rawQuery(
        `SELECT depth_score, breadth_score, coherence_score, exploration_score,
                territory_count, realm_count, message_count, member_since, updated_at
         FROM user_profiles WHERE user_id = ?`,
        [user.id],
      );
      if (!rows.length) return res.json({ fingerprint: null });
      res.json({ fingerprint: rows[0] });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Fingerprint error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch fingerprint' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Topology
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/topology-audit', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      // Topology is optional — missing namespace → empty response (not 503).
      if (!db?.topology) return res.json({ audit: null });
      const audit = await db.topology.getLatestAudit({ p_user_id: user.id });
      if (!audit) return res.json({ audit: null });
      const findings = await db.topology.getAuditFindings({
        p_user_id: user.id,
        p_snapshot_id: audit.id,
        p_limit: parseInt(req.query.limit, 10) || 50,
      });
      res.json({ audit, findings });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Topology audit error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch topology audit' });
    }
  });

  router.get('/portal/mindscape/topology-audit/history', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.topology) return res.json({ history: [] });
      const history = await db.topology.getAuditHistory({
        p_user_id: user.id,
        p_limit: parseInt(req.query.limit, 10) || 30,
      });
      res.json({ history });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Audit history error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch audit history' });
    }
  });

  router.get('/portal/mindscape/bridges', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.topology) return res.json({ bridges: [] });
      const bridges = await db.topology.getBridgesWithHealth({
        p_user_id: user.id,
        p_scale: req.query.scale || 'weekly',
        p_min_connections: parseInt(req.query.minConnections, 10) || 3,
        p_limit: parseInt(req.query.limit, 10) || 10,
      });
      res.json({ bridges });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Bridges error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch bridges' });
    }
  });

  router.get('/portal/mindscape/cofire', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const territoryId = parseInt(req.query.territory, 10);
      if (isNaN(territoryId)) return res.status(400).json({ error: 'territory param required' });
      const scale = req.query.scale || 'daily';
      const limit = parseInt(req.query.limit, 10) || 10;

      const connections = await db.topology.getCoFiring({
        p_user_id: user.id,
        p_territory_id: territoryId,
        p_scale: scale,
        p_min_strength: 0.05,
        p_limit: limit,
      });
      res.json({ connections });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Cofire error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch co-firing data' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Vitality
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/vitality-map', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.json({ territories: [], summary: {} });
      const rows = await db.rawQuery(
        `SELECT tp.territory_id, tp.name, tp.current_vitality as vitality, tp.current_phase as phase,
                tp.message_count, tp.realm_id
         FROM territory_profiles tp
         WHERE tp.user_id = ? AND tp.message_count > 0 AND tp.current_vitality IS NOT NULL
           AND tp.dissolved_at IS NULL
         ORDER BY tp.current_vitality DESC`,
        [user.id],
      );
      const sparseCount = rows.filter((r) => r.phase === 'sparse').length;
      const activeCount = rows.filter((r) => r.phase === 'active').length;
      const anchorCount = rows.filter((r) => r.phase === 'anchor').length;
      const mean = rows.length > 0 ? rows.reduce((s, r) => s + (r.vitality || 0), 0) / rows.length : 0;
      res.json({
        summary: { sparse_count: sparseCount, active_count: activeCount, anchor_count: anchorCount, mean_vitality: Math.round(mean * 1000) / 1000 },
        territories: rows,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Vitality map error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch vitality map' });
    }
  });

  router.get('/portal/mindscape/vitality/:territoryId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const tid = parseInt(req.params.territoryId, 10);
      const current = await db.rawQuery(
        `SELECT tp.territory_id, tp.name, tp.current_vitality as vitality, tp.current_phase as phase
         FROM territory_profiles tp WHERE tp.user_id = ? AND tp.territory_id = ?`,
        [user.id, tid],
      );
      const trend = await db.rawQuery(
        `SELECT vitality, phase, entropy_diversification, connection_growth_rate, reach, cofire_partner_diversity, computed_at
         FROM territory_vitality WHERE user_id = ? AND territory_id = ?
         ORDER BY computed_at DESC LIMIT 10`,
        [user.id, tid],
      );
      res.json({ current: current[0] || null, trend });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Territory vitality error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch territory vitality' });
    }
  });

  // ── GET /portal/mindscape/phase-history ─────────────────────────────
  // Full historical phase + vitality time-series for every territory
  // the user has ever had a phase sample on. Feeds Wave M1 of the
  // Mindscape Pulses plan — the client interpolates halo color at the
  // current scrub position as `phaseColorAt(history, t)`.
  //
  // Shape: { territories: [{ territory_id, name, history: [{t, phase, vitality}] }] }
  // Ordering: history is sorted oldest → newest so binary-search and
  // step-function lookup on the client are straightforward.
  //
  // Typical size: ~60 territories × ~180 daily samples ≈ 11k rows, ≈
  // 100KB gzipped. One-shot on page load; no pagination needed.
  router.get('/portal/mindscape/phase-history', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.json({ territories: [] });

      const rows = await db.rawQuery(
        `SELECT tf.territory_id, tf.computed_at, tf.phase, tf.vitality
         FROM territory_vitality tf
         WHERE tf.user_id = ?
         ORDER BY tf.territory_id ASC, tf.computed_at ASC`,
        [user.id],
      );

      // Pull territory names in one go so the client can label without
      // a second round-trip (the phase sparkline wants them).
      const nameRows = await db.rawQuery(
        `SELECT territory_id, name FROM territory_profiles
         WHERE user_id = ? AND (dissolved_at IS NULL OR dissolved_at = '')`,
        [user.id],
      );
      const nameById = new Map();
      for (const r of (Array.isArray(nameRows) ? nameRows : (nameRows?.results || []))) {
        nameById.set(r.territory_id, r.name);
      }

      const results = Array.isArray(rows) ? rows : (rows?.results || []);
      const byTid = new Map();
      for (const r of results) {
        if (!byTid.has(r.territory_id)) byTid.set(r.territory_id, []);
        byTid.get(r.territory_id).push({
          t: r.computed_at,
          phase: r.phase,
          vitality: typeof r.vitality === 'number' ? r.vitality : Number(r.vitality) || 0,
        });
      }

      const territories = [];
      for (const [tid, history] of byTid) {
        territories.push({
          territory_id: tid,
          name: nameById.get(tid) || null,
          history,
        });
      }

      res.json({ territories });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Phase history error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch phase history' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Orphan gaps
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/orphan-gaps/:territoryId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.topology) return res.json({ gaps: [] });
      const gaps = await db.topology.getOrphanGaps({
        p_user_id: user.id,
        p_territory_id: parseInt(req.params.territoryId, 10),
        p_min_similarity: parseFloat(req.query.minSimilarity) || 0.7,
        p_limit: parseInt(req.query.limit, 10) || 10,
      });
      res.json({ gaps });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Orphan gaps error:`, e.message);
      res.status(500).json({ error: 'Failed to compute orphan gaps' });
    }
  });

  router.get('/portal/mindscape/orphan-gaps', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.topology) return res.json({ orphans: [] });
      const orphans = await db.topology.getOrphans({
        p_user_id: user.id,
        p_min_messages: parseInt(req.query.minMessages, 10) || 50,
        p_max_connections: 0,
        p_scale: 'weekly',
        p_limit: parseInt(req.query.limit, 10) || 20,
      });
      const results = [];
      for (const orphan of orphans) {
        const gaps = await db.topology.getOrphanGaps({
          p_user_id: user.id,
          p_territory_id: orphan.territory_id,
          p_min_similarity: 0.7,
          p_limit: 5,
        });
        results.push({ ...orphan, gaps });
      }
      res.json({ orphans: results });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Orphans error:`, e.message);
      res.status(500).json({ error: 'Failed to compute orphan gaps' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Realms + activations + noise
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/mindscape/realms', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // Derive realms from clustering_points (source of truth); fall back
      // to territory_profiles when names/descriptions aren't populated yet.
      const realmStats = await db.rawQuery(`
        SELECT realm_id, COUNT(*) as point_count,
               COUNT(DISTINCT territory_id) as territory_count
        FROM clustering_points
        WHERE user_id = ? AND realm_id IS NOT NULL AND realm_id >= 0
        GROUP BY realm_id
      `, [user.id]);

      const realmProfiles = await db.mindscape.getRealms(user.id);
      const profileMap = Object.fromEntries(realmProfiles.map((r) => [r.realm_id, r]));

      const enriched = realmStats.map((rs) => {
        const profile = profileMap[rs.realm_id] || {};
        return {
          realm_id: rs.realm_id,
          name: profile.name || null,
          essence: profile.essence || null,
          archetype_type: profile.archetype_type || null,
          archetype_character: profile.archetype_character || null,
          territory_count: rs.territory_count || 0,
          point_count: rs.point_count || 0,
          total_messages: rs.point_count || 0,
          top_entities: profile.top_entities || [],
          signature_patterns: profile.signature_patterns || [],
          story_birth: profile.story_birth || null,
          story_arc: profile.story_arc || null,
          story_peak_moments: profile.story_peak_moments || [],
          story_current_chapter: profile.story_current_chapter || null,
          uncertainty_open_questions: profile.uncertainty_open_questions || [],
          uncertainty_edges: profile.uncertainty_edges || null,
          agent_expertise: profile.agent_expertise || null,
          agent_curious_about: profile.agent_curious_about || null,
          agent_can_help_with: profile.agent_can_help_with || [],
          activity_timeline: profile.activity_timeline || [],
          explored_percent: profile.explored_percent || 0,
        };
      });

      res.json({ realms: enriched });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Realm list error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch realms' });
    }
  });

  router.get('/portal/mindscape/activations', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const date = req.query.date || new Date().toISOString().split('T')[0];
      const activations = await db.territoryDocs.getDailyActivations(user.id, date);
      res.json(activations);
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Territory activations error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch territory activations' });
    }
  });

  router.get('/portal/mindscape/noise-stats', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const stats = await db.mindscape.getNoiseStats(user.id);
      res.json(stats);
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Noise stats error:`, e.message);
      res.status(500).json({ error: 'Failed to fetch noise stats' });
    }
  });

  logger.info?.('[portal-mindscape-reads-router] mounted 22 handlers');
  return router;
}
