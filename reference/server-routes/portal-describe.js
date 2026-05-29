/**
 * Describe router (Phase 10 PR 7G).
 *
 * Three POST handlers the mindscape agent calls during think sessions to
 * persist LLM-generated narratives:
 *
 *   POST /territory/describe  → territoryDocs.upsertDescription()
 *   POST /realm/describe      → raw INSERT OR CONFLICT into `realms`
 *   POST /contact/describe    → people.updateDescription() with JSON blob
 *
 * All three are gated by requireWorkerSecret (only the agent runtime may
 * call them) and resolve the tenant from MYA_USER_ID / MINDSCAPE_OWNER_ID
 * with `users.getFirst()` as a fallback for standalone owner VPSes.
 *
 * Each handler tolerates LLM field-name drift: the territory payload
 * normalises five alternate names (archetype / birth / arc / current_chapter
 * / peak_moments / patterns / open_questions / edges / expertise /
 * curious_about / can_help_with / would_consult / entities) so we don't
 * lose data when the LLM picks a synonym.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalDescribeRouterDeps
 * @property {() => object|null} tryGetDb
 * @property {(req: any, res: any) => boolean} requireWorkerSecret
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalDescribeRouter(deps) {
  if (!deps) throw new TypeError('createPortalDescribeRouter: deps required');
  const { tryGetDb, requireWorkerSecret, config, log } = deps;

  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalDescribeRouter: tryGetDb required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalDescribeRouter: requireWorkerSecret required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalDescribeRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err  = logger.error ? logger.error.bind(logger) : console.error;
  const warn = logger.warn  ? logger.warn.bind(logger)  : console.warn;
  const info = logger.info  ? logger.info.bind(logger)  : console.log;

  // Resolve the tenant owner for writes. Customer VPSes set MYA_USER_ID
  // or MINDSCAPE_OWNER_ID; owner-only deploys fall back to users.getFirst.
  async function resolveTenantUser(db) {
    const tenantId = process.env.MYA_USER_ID || process.env.MINDSCAPE_OWNER_ID;
    if (tenantId) return { id: tenantId };
    return db.users.getFirst();
  }

  const router = Router();

  // ── /territory/describe ────────────────────────────────────────────

  router.post('/territory/describe', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { territories, version, raw_llm_output } = req.body;
      if (!territories || !Array.isArray(territories)) {
        return res.status(400).json({ error: 'territories array required' });
      }

      const user = await resolveTenantUser(db);
      if (!user) return res.status(500).json({ error: 'No user found' });

      let stored = 0;
      const fieldWarnings = [];
      for (const t of territories) {
        if (!t.territory_id && t.territory_id !== 0) continue;

        // Track which "critical" fields are missing — the LLM sometimes
        // skips rare/edge territories. We warn but still store what we got.
        const missing = [];
        for (const f of ['name', 'essence', 'story_arc', 'signature_patterns', 'agent_expertise']) {
          if (!t[f]) missing.push(f);
        }
        if (missing.length > 0) {
          fieldWarnings.push({ territory_id: t.territory_id, missing });
        }

        // Normalise field-name aliases emitted by the LLM.
        const desc = {
          name: t.name,
          essence: t.essence,
          archetype_type: t.archetype_type || t.archetype,
          archetype_character: t.archetype_character,
          story_birth: t.story_birth || t.birth,
          story_arc: t.story_arc || t.arc,
          story_current_chapter: t.story_current_chapter || t.current_chapter,
          story_peak_moments: t.story_peak_moments || t.peak_moments,
          signature_patterns: t.signature_patterns || t.patterns,
          uncertainty_open_questions: t.uncertainty_open_questions || t.open_questions,
          uncertainty_edges: t.uncertainty_edges || t.edges || t.connections,
          agent_expertise: t.agent_expertise || t.expertise,
          agent_curious_about: t.agent_curious_about || t.curious_about,
          agent_can_help_with: t.agent_can_help_with || t.can_help_with,
          agent_would_consult: t.agent_would_consult || t.would_consult,
          top_entities: t.top_entities || t.entities,
          point_count: t.point_count,
        };

        // Store per-territory raw; full raw_llm_output if caller sent it.
        const rawForTerritory = raw_llm_output || JSON.stringify(t);
        await db.territoryDocs.upsertDescription(
          user.id,
          t.territory_id,
          desc,
          version || '',
          rawForTerritory,
        );
        stored++;
      }

      if (fieldWarnings.length > 0) {
        warn(`[${LOG_PREFIX}] [territory/describe] Missing fields: ${JSON.stringify(fieldWarnings)}`);
      }
      info(`[${LOG_PREFIX}] [territory/describe] Stored ${stored} territory descriptions (version: ${version})`);
      res.json({ stored, version, fieldWarnings });
    } catch (e) {
      err(`[${LOG_PREFIX}] Territory describe error: ${e.message}`);
      res.status(500).json({ error: 'Failed to store territory descriptions' });
    }
  });

  // ── /realm/describe ────────────────────────────────────────────────

  router.post('/realm/describe', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { realms, raw_llm_output } = req.body;
      if (!realms || !Array.isArray(realms)) {
        return res.status(400).json({ error: 'realms array required' });
      }

      const user = await resolveTenantUser(db);
      if (!user) return res.status(500).json({ error: 'No user found' });

      let stored = 0;
      for (const r of realms) {
        if (r.realm_id === undefined) continue;
        await db.rawQuery(
          `INSERT INTO realms (realm_id, user_id, name, essence, archetype_type, archetype_character,
            story_birth, story_arc, story_current_chapter, story_peak_moments,
            signature_patterns, uncertainty_open_questions, uncertainty_edges,
            agent_expertise, agent_curious_about, agent_can_help_with,
            territory_count, message_count, top_entities, generation_model, raw_response)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-opus', ?)
          ON CONFLICT(realm_id, user_id) DO UPDATE SET
            name = excluded.name, essence = excluded.essence,
            archetype_type = excluded.archetype_type, archetype_character = excluded.archetype_character,
            story_birth = excluded.story_birth, story_arc = excluded.story_arc,
            story_current_chapter = excluded.story_current_chapter, story_peak_moments = excluded.story_peak_moments,
            signature_patterns = excluded.signature_patterns,
            uncertainty_open_questions = excluded.uncertainty_open_questions,
            uncertainty_edges = excluded.uncertainty_edges,
            agent_expertise = excluded.agent_expertise, agent_curious_about = excluded.agent_curious_about,
            agent_can_help_with = excluded.agent_can_help_with,
            territory_count = excluded.territory_count, message_count = excluded.message_count,
            top_entities = excluded.top_entities, generation_model = excluded.generation_model,
            raw_response = excluded.raw_response`,
          [r.realm_id, user.id, r.name, r.essence,
           r.archetype_type, r.archetype_character,
           r.story_birth, r.story_arc, r.story_current_chapter,
           JSON.stringify(r.story_peak_moments || []),
           JSON.stringify(r.signature_patterns || []),
           JSON.stringify(r.uncertainty_open_questions || []),
           r.uncertainty_edges,
           r.agent_expertise, r.agent_curious_about,
           JSON.stringify(r.agent_can_help_with || []),
           r.territory_count || 0, r.message_count || 0,
           JSON.stringify(r.top_entities || []),
           raw_llm_output || JSON.stringify(r)],
        );
        stored++;
      }

      info(`[${LOG_PREFIX}] [realm/describe] Stored ${stored} realm descriptions`);
      res.json({ stored });
    } catch (e) {
      err(`[${LOG_PREFIX}] Realm describe error: ${e.message}`);
      res.status(500).json({ error: 'Failed to store realm descriptions' });
    }
  });

  // ── /contact/describe ──────────────────────────────────────────────

  router.post('/contact/describe', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { contacts, raw_llm_output } = req.body;
      if (!contacts || !Array.isArray(contacts)) {
        return res.status(400).json({ error: 'contacts array required' });
      }

      const user = await resolveTenantUser(db);
      if (!user) return res.status(500).json({ error: 'No user found' });

      let stored = 0;
      for (const c of contacts) {
        if (!c.contact_id) continue;

        const desc = {
          essence: c.essence,
          relationship_arc: c.relationship_arc || c.arc,
          current_chapter: c.current_chapter,
          signature_topics: c.signature_topics || c.topics,
          interaction_style: c.interaction_style || c.style,
          notable_moments: c.notable_moments || c.moments,
        };

        await db.people.updateDescription(c.contact_id, user.id, JSON.stringify(desc));
        stored++;
      }

      info(`[${LOG_PREFIX}] [contact/describe] Stored ${stored} contact descriptions`);
      res.json({
        stored,
        raw_llm_output: raw_llm_output ? `${raw_llm_output.length} chars` : null,
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] Contact describe error: ${e.message}`);
      res.status(500).json({ error: 'Failed to store contact descriptions' });
    }
  });

  info(`[${LOG_PREFIX}] portal-describe-router mounted 3 handlers`);

  return router;
}
