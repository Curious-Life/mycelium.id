import express from 'express';

/**
 * portalMindscapeRouter — the V1 read surface for the canonical portal's
 * Mindscape screen. Mounted under `/api/v1/portal` (alongside portalCompatRouter)
 * so the UI's `/portal/mindscape*` calls (rewritten by api.ts) resolve here.
 *
 * Ported faithfully from reference/server-routes/portal-mindscape-reads.js: the
 * aggregator (`GET /mindscape` → { nodes, themes, territories, realms,
 * semanticThemes, meta }) drives the 3D scene; the per-panel reads
 * (/territories, /realms, /noise-stats, /activations) drive the side panels.
 * Surfaces with NO V1 data source (fingerprint, complexity, exploration jobs,
 * phase-history, cofire, time-chronicles, social) return a graceful, benign
 * empty shape — the screen renders its empty state, never throws. Generate
 * (explore jobs) is Phase G; narrative population is Phase C.
 *
 * Backed by db.mindscape (clustering_points + *_profiles) + db.territoryDocs +
 * db.fisher — all read-only here. Same security posture as portalCompatRouter:
 * localhost-only, no auth yet (Phase 4), errors never leak internals/plaintext.
 *
 * @param {object} deps
 * @param {object} deps.db      wired db (mindscape, territoryDocs, fisher, messages…)
 * @param {string} deps.userId  the single V1 owner
 * @returns {import('express').Router}
 */
export function portalMindscapeRouter({ db, userId }) {
  if (!db) throw new Error('portalMindscapeRouter: db required');
  const router = express.Router();
  router.use(express.json({ limit: '8mb' }));

  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });

  // ── JSON coercion helpers (ported verbatim from the reference aggregator) ──
  const parseArr = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
    return [];
  };
  const mapEntities = (raw) => parseArr(raw).map((e) =>
    typeof e === 'string' ? { name: e } : { name: e.text || e.name || String(e), type: e.type, count: e.count });
  const activityArray = (map) => Object.entries(map || {})
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── Aggregator: the whole 3D scene in one shape ────────────────────────────
  // GET /mindscape → { nodes, themes, territories, realms, semanticThemes, meta }
  router.get('/mindscape', async (_req, res) => {
    try {
      const settled = await Promise.allSettled([
        db.mindscape.getPoints(userId),
        db.mindscape.getThemeCards(userId),
        db.mindscape.getTerritoryProfiles(userId),
        db.mindscape.getRealms(userId),
        db.mindscape.getSemanticThemes(userId),
      ]);
      const val = (r) => (r.status === 'fulfilled' ? r.value : []);
      const points = val(settled[0]);
      const themeCards = val(settled[1]);
      const territoryProfiles = val(settled[2]);
      const realmProfiles = val(settled[3]);
      const semanticThemeProfiles = val(settled[4]);

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

      const themeActivity = {}, territoryActivity = {}, realmActivity = {}, semanticThemeActivity = {};
      const territoryCentroids = {};
      for (const p of points) {
        const month = p.created_at?.slice(0, 7);
        if (!month) continue;
        if (p.territory_id != null && p.theme_id != null) {
          const key = `${p.territory_id}-${p.theme_id}`;
          (themeActivity[key] ||= {})[month] = (themeActivity[key][month] || 0) + 1;
        }
        if (p.realm_id != null && p.realm_id !== -1) {
          (realmActivity[p.realm_id] ||= {})[month] = (realmActivity[p.realm_id][month] || 0) + 1;
        }
        if (p.territory_id != null && p.territory_id !== -1) {
          (territoryActivity[p.territory_id] ||= {})[month] = (territoryActivity[p.territory_id][month] || 0) + 1;
          const c = (territoryCentroids[p.territory_id] ||= { x: 0, y: 0, z: 0, count: 0 });
          c.x += p.landscape_x; c.y += p.landscape_y; c.z += p.landscape_z; c.count++;
        }
      }

      const themes = {};
      for (const tc of themeCards) {
        (themes[tc.territory_id] ||= {})[tc.theme_id] = {
          title: tc.title, essence: tc.essence,
          count: tc.message_count || 0, exploredCount: tc.explored_count || 0,
          exploredPercent: tc.explored_percent || 0, topEntities: mapEntities(tc.top_entities),
          storyBirth: tc.story_birth, storyArc: tc.story_arc,
          storyPeakMoments: parseArr(tc.story_peak_moments), storyCurrentChapter: tc.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tc.uncertainty_open_questions), uncertaintyEdges: tc.uncertainty_edges,
          activity: activityArray(themeActivity[`${tc.territory_id}-${tc.theme_id}`]),
        };
      }

      const territories = {};
      for (const tp of territoryProfiles) {
        const c = territoryCentroids[tp.territory_id];
        const centroid = c && c.count > 0 ? { x: c.x / c.count, y: c.y / c.count, z: c.z / c.count } : null;
        territories[tp.territory_id] = {
          name: tp.name, essence: tp.essence,
          archetypeType: tp.archetype_type, archetypeCharacter: tp.archetype_character,
          realmId: tp.realm_id, semanticThemeId: tp.semantic_theme_id,
          count: tp.message_count || 0, exploredCount: tp.explored_count || 0, exploredPercent: tp.explored_percent || 0,
          topEntities: mapEntities(tp.top_entities), signaturePatterns: parseArr(tp.signature_patterns),
          storyBirth: tp.story_birth, storyArc: tp.story_arc,
          storyPeakMoments: parseArr(tp.story_peak_moments), storyCurrentChapter: tp.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tp.uncertainty_open_questions), uncertaintyEdges: tp.uncertainty_edges,
          chronicle: tp.chronicle || null,
          agentExpertise: tp.agent_expertise, agentCuriousAbout: tp.agent_curious_about,
          agentCanHelpWith: parseArr(tp.agent_can_help_with), agentWouldConsult: parseArr(tp.agent_would_consult),
          activity: activityArray(territoryActivity[tp.territory_id]), centroid,
          visibility: tp.visibility || 'private', temporalSaliency: tp.temporal_saliency ?? null,
          firstActive: tp.first_active || null, lastActive: tp.last_active || null, daysActive: tp.days_active || null,
          currentVitality: tp.current_vitality ?? null, currentPhase: tp.current_phase || null,
          isAnchored: tp.is_anchored || 0,
          predecessorIds: parseArr(tp.predecessor_ids), evolvedFromCount: tp.evolved_from_count || 0,
        };
      }

      const realmCounts = {}, territoryCounts = {}, realmTerritoryIds = {};
      let noiseRealm = 0, noiseTerritory = 0;
      for (const p of points) {
        if (p.realm_id == null || p.realm_id === -1) noiseRealm++;
        else {
          realmCounts[p.realm_id] = (realmCounts[p.realm_id] || 0) + 1;
          if (p.territory_id != null && p.territory_id !== -1) {
            (realmTerritoryIds[p.realm_id] ||= new Set()).add(p.territory_id);
          }
        }
        if (p.territory_id == null || p.territory_id === -1) noiseTerritory++;
        else territoryCounts[p.territory_id] = (territoryCounts[p.territory_id] || 0) + 1;
      }

      const realmProfileMap = {};
      for (const rp of realmProfiles) realmProfileMap[rp.realm_id] = rp;
      const realms = {};
      // Points are the source of truth so clustering output shows even when
      // descriptions lag (mirrors the reference aggregator).
      for (const [realmId, count] of Object.entries(realmCounts)) {
        const rp = realmProfileMap[realmId] || {};
        realms[realmId] = {
          name: rp.name || null, essence: rp.essence || null,
          archetypeType: rp.archetype_type || null, archetypeCharacter: rp.archetype_character || null,
          territoryCount: (realmTerritoryIds[realmId]?.size) || rp.territory_count || 0, pointCount: count,
          topEntities: mapEntities(rp.top_entities), signaturePatterns: parseArr(rp.signature_patterns),
          storyBirth: rp.story_birth || null, storyArc: rp.story_arc || null,
          storyPeakMoments: parseArr(rp.story_peak_moments), storyCurrentChapter: rp.story_current_chapter || null,
          uncertaintyOpenQuestions: parseArr(rp.uncertainty_open_questions), uncertaintyEdges: rp.uncertainty_edges || null,
          agentExpertise: rp.agent_expertise || null, agentCuriousAbout: rp.agent_curious_about || null,
          agentCanHelpWith: parseArr(rp.agent_can_help_with), activity: activityArray(realmActivity[realmId]),
        };
      }

      for (const tp of territoryProfiles) {
        if (tp.semantic_theme_id != null && tp.realm_id != null) {
          const stKey = `${tp.realm_id}-${tp.semantic_theme_id}`;
          for (const [month, count] of Object.entries(territoryActivity[tp.territory_id] || {})) {
            (semanticThemeActivity[stKey] ||= {})[month] = (semanticThemeActivity[stKey][month] || 0) + count;
          }
        }
      }

      const semanticThemes = {};
      for (const st of semanticThemeProfiles) {
        const key = `${st.realm_id}-${st.semantic_theme_id}`;
        semanticThemes[key] = {
          realmId: st.realm_id, semanticThemeId: st.semantic_theme_id,
          name: st.name, essence: st.essence,
          territoryCount: st.territory_count || 0, messageCount: st.message_count || 0,
          territoryIds: parseArr(st.territory_ids),
          includedTerritoryCount: st.included_territory_count || st.territory_count || 0,
          coveragePercent: st.coverage_percent ?? 100.0,
          topEntities: mapEntities(st.top_entities), signaturePatterns: parseArr(st.signature_patterns),
          storyBirth: st.story_birth, storyArc: st.story_arc, storyCurrentChapter: st.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(st.uncertainty_open_questions),
          activity: activityArray(semanticThemeActivity[key]),
        };
      }

      const total = points.length;
      res.json({
        nodes, themes, territories, realms, semanticThemes,
        meta: {
          total,
          noise10d: noiseRealm, noise10dPercent: total > 0 ? (noiseRealm / total * 100).toFixed(1) : 0,
          noise3d: noiseTerritory, noise3dPercent: total > 0 ? (noiseTerritory / total * 100).toFixed(1) : 0,
          clusterCounts: realmCounts, cluster3dCounts: territoryCounts,
        },
      });
    } catch { fail(res, 500, 'failed to load mindscape data'); }
  });

  // ── Per-panel reads ────────────────────────────────────────────────────────
  router.get('/mindscape/territories', async (_req, res) => {
    try { res.json({ territories: await db.mindscape.getTerritoryProfiles(userId) }); }
    catch { fail(res); }
  });

  router.get('/mindscape/realms', async (_req, res) => {
    try { res.json({ realms: await db.mindscape.getRealms(userId) }); }
    catch { fail(res); }
  });

  router.get('/mindscape/noise-stats', async (_req, res) => {
    try { res.json(await db.mindscape.getNoiseStats(userId)); }
    catch { fail(res); }
  });

  // Today's activations (which territories fired, vs. baseline). Real read.
  router.get('/mindscape/activations', async (_req, res) => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      res.json(await db.territoryDocs.getDailyActivations(userId, date));
    } catch { res.json({ active: [], silent: [], date: new Date().toISOString().slice(0, 10), total_messages: 0 }); }
  });

  // Trajectory summary — real read off db.fisher (the latest realm weekly_step).
  router.get('/trajectory/summary', async (_req, res) => {
    try {
      const row = await db.fisher.getCurrentPhase(userId, { level: 'realm' });
      res.json({ summary: row ? { phase: row.phase, exploration_ratio: row.exploration_ratio } : null });
    } catch { res.json({ summary: null }); }
  });

  // ── Graceful-empty: surfaces with NO V1 data source yet ─────────────────────
  // These are computed by Tier-2 pipeline stages (fingerprint, complexity),
  // built in later phases (explore jobs = Phase G), or belong to deferred
  // verticals (social, cofire, time-chronicles). They return benign shapes so
  // the screen renders cleanly instead of erroring. Never throw.
  router.get('/mindscape/fingerprint', (_req, res) => res.json({ fingerprint: null }));
  router.get('/mindscape/complexity', (_req, res) =>
    res.json({ global_complexity: null, globalHistory: [], territories: [], realms: [] }));
  router.get('/mindscape/exploration-status', async (_req, res) => {
    let totalTerritories = 0;
    try { totalTerritories = (await db.mindscape.getTerritoryProfiles(userId)).length; } catch { /* 0 */ }
    res.json({
      globalExploredPercent: 0, territoriesWithChronicles: 0, totalTerritories,
      totalMessages: 0, messagesAnalyzed: 0, lastRunAt: null,
      explorationRunning: false, explorationJobId: null,
    });
  });
  router.get('/mindscape/phase-history', (_req, res) => res.json({ territories: [] }));
  router.get('/mindscape/cofire', (_req, res) => res.json({ connections: [] }));
  router.get('/mindscape/time-chronicles', (_req, res) => res.json({ chronicles: [], coverage: [] }));
  router.get('/mindscape/social', (_req, res) => res.json({ contacts: [], tiers: [] }));
  router.get('/health/summary', (_req, res) => res.json({ today: null, averages: {}, trends: {}, days: [] }));

  return router;
}

export default portalMindscapeRouter;
