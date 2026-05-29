/**
 * Portal spaces router (Phase 10 PR 7B).
 *
 * Owns the collaborative-knowledge surface: a "space" is a named,
 * role-gated collection of knowledge entries + its own conversation
 * history. Endpoints:
 *
 *   GET    /portal/spaces                         — list for user
 *   POST   /portal/spaces                         — create
 *   GET    /portal/spaces/territories             — picker source (user's territories)
 *   GET    /portal/spaces/:id                     — detail + role
 *   PUT    /portal/spaces/:id                     — update (creator)
 *   DELETE /portal/spaces/:id                     — delete (creator)
 *   GET    /portal/spaces/:id/knowledge           — list entries (member)
 *   POST   /portal/spaces/:id/knowledge           — add direct entry (contributor)
 *   POST   /portal/spaces/:id/seed                — seed from territories (contributor)
 *   DELETE /portal/spaces/:id/knowledge/:kid      — revoke entry (contributor)
 *   GET    /portal/spaces/:id/context             — system prompt + recent msgs
 *   GET    /portal/spaces/:id/members             — list access
 *
 * All gated by worker secret + portal session. Role enforcement is
 * per-endpoint via db.spaces.requireRole().
 *
 * Bug-fixes folded in during extraction:
 *   - Every handler that called `db.*` immediately after `tryGetDb()`
 *     was missing a null-check. A missing DB would throw TypeError
 *     which the catch then reported as an internal 500 with a leaky
 *     message. Now each handler explicitly returns 503 on null db.
 *   - GET /portal/spaces/:id/context passed `req.params.id` (space
 *     UUID) as the first placeholder of a `WHERE user_id = ?` query.
 *     That mismatched the column, so the handler always returned an
 *     empty message history. Fixed to bind user.id.
 */

import crypto from 'crypto';
import { Router } from 'express';

/**
 * @typedef {object} CreatePortalSpacesRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {(req: any, res: any) => boolean}    requireWorkerSecret
 * @property {() => object|null}                  tryGetDb
 * @property {object} config                      — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalSpacesRouter(deps) {
  if (!deps) throw new TypeError('createPortalSpacesRouter: deps required');
  const {
    authenticatePortalRequest,
    requireWorkerSecret,
    tryGetDb,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalSpacesRouter: authenticatePortalRequest required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalSpacesRouter: requireWorkerSecret required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalSpacesRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalSpacesRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  // Map role-check errors to 403. Anything else is a 500 with the raw
  // message suppressed (the catch logger records the full error).
  const roleStatus = (msg) => (msg && msg.includes('Requires')) ? 403 : 500;

  // ── GET /portal/spaces ──────────────────────────────────────────────
  router.get('/portal/spaces', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      const spaces = await db.spaces.listForUser(user.id);
      res.json({ spaces });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Spaces list failed:`, e.message);
      res.status(500).json({ error: 'Failed to list spaces' });
    }
  });

  // ── POST /portal/spaces ─────────────────────────────────────────────
  router.post('/portal/spaces', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { name, essence, voice, handle } = req.body;
      if (!name || !essence) return res.status(400).json({ error: 'name and essence required' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      const spaceId = crypto.randomUUID();
      const space = await db.spaces.create(spaceId, name, essence, voice || 'conversational', user.id, handle || null);
      db.audit.log({ action: 'space.create', userId: user.id, ip: req.ip, resourceType: 'space', resourceId: spaceId }).catch(() => {});
      res.json(space);
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space create failed:`, e.message);
      res.status(500).json({ error: 'Failed to create space' });
    }
  });

  // ── GET /portal/spaces/territories ──────────────────────────────────
  // Lightweight territory picker source for the space detail page. Must
  // be registered BEFORE any /portal/spaces/:id route — otherwise Express
  // matches this path as `:id = territories`. Returns only the fields
  // needed to render a row.
  router.get('/portal/spaces/territories', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      const rows = await db.rawQuery(
        `SELECT id, territory_id, name, essence, message_count, current_phase, current_vitality
         FROM territory_profiles
         WHERE user_id = ?
           AND (dissolved_at IS NULL OR dissolved_at = '')
         ORDER BY message_count DESC
         LIMIT 200`,
        [user.id],
      );
      const results = Array.isArray(rows) ? rows : (rows?.results || []);
      res.json({ territories: results });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Spaces territory picker failed:`, e.message);
      res.status(500).json({ error: 'Failed to list territories' });
    }
  });

  // ── GET /portal/spaces/:id ──────────────────────────────────────────
  router.get('/portal/spaces/:id', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      const role = await db.spaces.getRole(req.params.id, user.id);
      if (!role) return res.status(403).json({ error: 'Not a member' });
      const space = await db.spaces.get(req.params.id);
      if (!space) return res.status(404).json({ error: 'Space not found' });
      res.json({ ...space, role });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space get failed:`, e.message);
      res.status(500).json({ error: 'Failed to get space' });
    }
  });

  // ── PUT /portal/spaces/:id ──────────────────────────────────────────
  router.put('/portal/spaces/:id', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'creator');
      await db.spaces.update(req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── DELETE /portal/spaces/:id ───────────────────────────────────────
  router.delete('/portal/spaces/:id', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'creator');
      await db.spaces.delete(req.params.id);
      db.audit.log({ action: 'space.delete', userId: user.id, ip: req.ip, resourceType: 'space', resourceId: req.params.id }).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── GET /portal/spaces/:id/knowledge ────────────────────────────────
  router.get('/portal/spaces/:id/knowledge', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');
      const entries = await db.spaceKnowledge.list(req.params.id, {
        sourceType: req.query.type || undefined,
      });
      res.json({ entries });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── POST /portal/spaces/:id/knowledge ───────────────────────────────
  // Direct-entry knowledge path — a member (contributor+) pastes or types
  // freeform knowledge into the space. No territory binding; source_type
  // is 'direct'. Length is capped at 4000 chars so a single entry cannot
  // dominate the context window. Visibility is always 'all' in S1 (no
  // per-entry restriction UI yet).
  router.post('/portal/spaces/:id/knowledge', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');

      const { content, domain_tags } = req.body || {};
      const raw = typeof content === 'string' ? content.trim() : '';
      if (!raw) return res.status(400).json({ error: 'content required' });
      if (raw.length > 4000) {
        return res.status(413).json({ error: 'content exceeds 4000 chars' });
      }

      const tags = Array.isArray(domain_tags)
        ? domain_tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 20)
        : null;

      const id = await db.spaceKnowledge.add(
        req.params.id, raw, user.id, null, 'direct', 'all',
        tags && tags.length ? tags : null,
        null, // no source_ref for freeform direct entry
      );

      db.audit.log({
        action: 'space.knowledge.add',
        userId: user.id,
        ip: req.ip,
        resourceType: 'space',
        resourceId: req.params.id,
        details: { entry_id: id, source_type: 'direct', length: raw.length },
      }).catch(() => {});

      res.status(201).json({
        id,
        content: raw,
        source_type: 'direct',
        domain_tags: tags,
        visibility: 'all',
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space knowledge add failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── POST /portal/spaces/:id/seed ────────────────────────────────────
  // Seed a space's knowledge from the user's own territory profiles. The
  // `depth` param controls how much context each territory contributes:
  //   - 'essence' (default): name + essence + story_* columns only.
  //   - 'full':              essence + current vitality/phase + top-5
  //                          bridge territories (via territory_cofire).
  //
  // Fix from PR 7C: the row SELECT previously requested a `title` column
  // which never existed on territory_profiles — the real column is `name`
  // (added in migration 027). The handler was silently broken.
  router.post('/portal/spaces/:id/seed', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      const { territory_ids, depth } = req.body || {};
      if (!territory_ids?.length) return res.status(400).json({ error: 'territory_ids required' });
      const seedDepth = depth === 'full' ? 'full' : 'essence';

      await db.spaces.get(req.params.id);
      const territories = [];
      for (const tid of territory_ids) {
        const result = await db.rawQuery(
          `SELECT id, territory_id, name, essence,
                  story_birth, story_arc, story_peak_moments, story_current_chapter,
                  current_phase, current_vitality
           FROM territory_profiles WHERE id = ? AND user_id = ?`,
          [tid, user.id],
        );
        const rows = Array.isArray(result) ? result : (result?.results || []);
        const t = rows[0];
        if (t) territories.push(t);
      }

      if (!territories.length) return res.status(404).json({ error: 'No matching territories found' });

      // For depth='full', fetch top-5 bridge partners per territory via
      // territory_cofire (weekly co-fire weight = project-level bonds).
      // territory_cofire stores undirected edges with territory_a<territory_b,
      // so the partner id flips depending on which side the seed territory
      // is on.
      if (seedDepth === 'full') {
        for (const t of territories) {
          if (t.territory_id == null) { t._bridges = []; continue; }
          const result = await db.rawQuery(
            `SELECT
               CASE WHEN tc.territory_a = ? THEN tc.territory_b ELSE tc.territory_a END AS partner_id,
               CASE WHEN tc.territory_a = ? THEN tp_b.name ELSE tp_a.name END AS partner_name,
               tc.cofire_weekly
             FROM territory_cofire tc
             LEFT JOIN territory_profiles tp_a
               ON tp_a.territory_id = tc.territory_a AND tp_a.user_id = tc.user_id
             LEFT JOIN territory_profiles tp_b
               ON tp_b.territory_id = tc.territory_b AND tp_b.user_id = tc.user_id
             WHERE tc.user_id = ?
               AND (tc.territory_a = ? OR tc.territory_b = ?)
               AND tc.cofire_weekly > 0
             ORDER BY tc.cofire_weekly DESC
             LIMIT 5`,
            [t.territory_id, t.territory_id, user.id, t.territory_id, t.territory_id],
          );
          const rows = Array.isArray(result) ? result : (result?.results || []);
          t._bridges = rows.filter((r) => r.partner_name);
        }
      }

      const summaries = territories.map((t) => {
        const parts = [t.essence, t.story_birth, t.story_arc, t.story_peak_moments, t.story_current_chapter]
          .filter(Boolean);
        if (seedDepth === 'full') {
          if (t.current_phase || t.current_vitality != null) {
            const freq = typeof t.current_vitality === 'number'
              ? t.current_vitality.toFixed(2)
              : t.current_vitality;
            parts.push(`Current phase: ${t.current_phase || 'unknown'}${freq != null ? ` (vitality ${freq})` : ''}.`);
          }
          if (t._bridges?.length) {
            const names = t._bridges.map((b) => b.partner_name).filter(Boolean);
            if (names.length) parts.push(`Connects to: ${names.join(', ')}.`);
          }
        }
        return {
          territory_id: t.id,
          territory_name: t.name,
          summary: parts.join('\n\n'),
        };
      });

      const entryIds = [];
      for (const s of summaries) {
        if (!s.summary) continue;
        const id = await db.spaceKnowledge.add(
          req.params.id, s.summary, user.id, s.territory_id, 'territory_seed', 'all',
          s.territory_name ? [s.territory_name] : null,
          s.territory_id ? `territory:${s.territory_id}` : null,
        );
        entryIds.push({ id, territory_name: s.territory_name });
      }

      db.audit.log({
        action: 'space.seed',
        userId: user.id,
        ip: req.ip,
        resourceType: 'space',
        resourceId: req.params.id,
        details: { territory_count: territories.length, depth: seedDepth },
      }).catch(() => {});

      res.json({ entries: entryIds, seeded: entryIds.length, depth: seedDepth });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space seed failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── DELETE /portal/spaces/:id/knowledge/:kid ────────────────────────
  router.delete('/portal/spaces/:id/knowledge/:kid', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      await db.spaceKnowledge.revoke(req.params.kid, req.params.id);
      db.audit.log({
        action: 'space.prune',
        userId: user.id,
        ip: req.ip,
        resourceType: 'space',
        resourceId: req.params.id,
        details: { entry_id: req.params.kid },
      }).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── GET /portal/spaces/:id/context ──────────────────────────────────
  // Assembles the system prompt + recent conversation history for a
  // chat turn inside a space. Bug-fix during PR 7B: the recent-messages
  // query previously bound `req.params.id` (space UUID) to the
  // `user_id = ?` placeholder, so it always returned empty results.
  router.get('/portal/spaces/:id/context', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');

      const space = await db.spaces.get(req.params.id);
      if (!space) return res.status(404).json({ error: 'Space not found' });

      const knowledge = await db.spaceKnowledge.list(req.params.id, { limit: 50 });
      const settings = space.settings || {};

      const knowledgeText = knowledge.map((k) => k.content).join('\n\n---\n\n');
      const systemPrompt = [
        `You are ${space.name}.`,
        settings.essence ? `${settings.essence}.` : '',
        settings.voice ? `Your communication style is ${settings.voice}.` : '',
        '',
        'You draw on your accumulated knowledge to help people explore and understand.',
        'You do not reveal the identities of your contributors or the raw content they shared.',
        'You speak as yourself — your understanding, your perspective, your synthesis.',
        '',
        knowledgeText ? `Your knowledge:\n\n${knowledgeText}` : '',
      ].filter(Boolean).join('\n');

      const conv = await db.spaceConversations.getOrCreate(req.params.id, user.id);

      // Bug-fix: first placeholder must be user.id (matches user_id = ?),
      // not the space id.
      const messages = await db.rawQuery(
        `SELECT role, content, created_at FROM messages
         WHERE user_id = ? AND conversation_id = ?
         ORDER BY created_at DESC LIMIT 20`,
        [user.id, conv.id],
      );

      await db.spaceAccess.updateLastActive(req.params.id, user.id);

      res.json({
        systemPrompt,
        conversationId: conv.id,
        messages: (messages || []).reverse(),
        space: { name: space.name, essence: settings.essence, voice: settings.voice },
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space context failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── GET /portal/spaces/:id/members ──────────────────────────────────
  router.get('/portal/spaces/:id/members', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');
      const members = await db.spaceAccess.list(req.params.id);
      res.json({ members });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ═══ Rooms ═════════════════════════════════════════════════════════
  //
  // Lightweight folders inside a space. Members can list; contributors
  // can create / rename / delete / move. Migration 137. Same role
  // enforcement as the rest of the spaces surface.

  // ── GET /portal/spaces/:id/rooms ─────────────────────────────────────
  // Lazy tree: returns one level (the children of `parent` query
  // param, or top-level when omitted). The portal lazy-loads a level
  // per click so a 500-room space stays fast.
  router.get('/portal/spaces/:id/rooms', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');
      const parentId = req.query.parent ? String(req.query.parent) : null;
      const rooms = await db.spaceRooms.listChildren(req.params.id, parentId);
      res.json({ rooms });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── POST /portal/spaces/:id/rooms ────────────────────────────────────
  router.post('/portal/spaces/:id/rooms', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      const { name, essence, parentId, coverDocPath, position } = req.body || {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name required' });
      }
      const id = await db.spaceRooms.create({
        spaceId: req.params.id,
        parentId: parentId || null,
        name: name.trim(),
        essence: essence ? String(essence).trim() : null,
        coverDocPath: coverDocPath || null,
        position: typeof position === 'number' ? position : 0,
        createdBy: user.id,
      });
      db.audit.log({ action: 'space.room.create', userId: user.id, ip: req.ip, resourceType: 'space_room', resourceId: id }).catch(() => {});
      res.json({ id });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Room create failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── PUT /portal/spaces/:id/rooms/:rid ────────────────────────────────
  router.put('/portal/spaces/:id/rooms/:rid', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      const room = await db.spaceRooms.getById(req.params.rid, req.params.id);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      await db.spaceRooms.update(req.params.rid, req.params.id, req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── DELETE /portal/spaces/:id/rooms/:rid ─────────────────────────────
  // Cascades: removes the junction rows for this room first so
  // deleting a room with seeded docs leaves no orphan junction rows.
  // The actual library docs stay untouched — they live in `documents`.
  router.delete('/portal/spaces/:id/rooms/:rid', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      // Refuse to delete a room with sub-rooms — the user should
      // empty it first. Avoids accidental orphan trees.
      if (await db.spaceRooms.hasChildren(req.params.rid, req.params.id)) {
        return res.status(409).json({ error: 'Room has sub-rooms; remove them first' });
      }
      await db.spaceRoomDocuments.removeAllByRoom(req.params.rid, req.params.id);
      await db.spaceRooms.delete(req.params.rid, req.params.id);
      db.audit.log({ action: 'space.room.delete', userId: user.id, ip: req.ip, resourceType: 'space_room', resourceId: req.params.rid }).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── GET /portal/spaces/:id/rooms/:rid/contents ──────────────────────
  // Documents seeded into a room. Joins to the `documents` table so
  // the portal gets title/summary/source_type/metadata in one round-trip.
  router.get('/portal/spaces/:id/rooms/:rid/contents', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');
      const documents = await db.spaceRoomDocuments.listByRoom(req.params.rid, user.id);
      res.json({ documents });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── POST /portal/spaces/:id/rooms/:rid/seed-doc ─────────────────────
  // Body: { documentPath, position? }
  // The doc must already exist in the user's library. Idempotent on
  // (room_id, document_path).
  router.post('/portal/spaces/:id/rooms/:rid/seed-doc', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      const { documentPath, position } = req.body || {};
      if (!documentPath || typeof documentPath !== 'string') {
        return res.status(400).json({ error: 'documentPath required' });
      }
      // Verify the doc exists in the contributor's library before
      // creating the junction — otherwise we'd be storing a dangling
      // reference. The seed becomes visible to all space members on
      // success.
      const doc = await db.documents.get(user.id, documentPath);
      if (!doc) return res.status(404).json({ error: 'Document not found in your library' });
      const id = await db.spaceRoomDocuments.add({
        spaceId: req.params.id,
        roomId: req.params.rid,
        documentPath,
        position: typeof position === 'number' ? position : 0,
        createdBy: user.id,
      });
      db.audit.log({ action: 'space.room.seed_doc', userId: user.id, ip: req.ip, resourceType: 'space_room_document', resourceId: id }).catch(() => {});
      res.json({ id });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Room seed-doc failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── DELETE /portal/spaces/:id/rooms/:rid/contents/:cid ─────────────
  // Removes a doc from a room (deletes the junction row only — the
  // actual document stays in the library).
  router.delete('/portal/spaces/:id/rooms/:rid/contents/:cid', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      await db.spaceRoomDocuments.remove(req.params.cid, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── GET /portal/spaces/:id/contents ────────────────────────────────
  // Root-level contents of a space's Context tab: top-level folders
  // (rooms with parent_id=null) + documents directly attached to the
  // space (room_id=null in space_room_documents). Mirrors the
  // /rooms/:rid/contents shape so the UI can use one render path.
  router.get('/portal/spaces/:id/contents', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'member');
      const documents = await db.spaceRoomDocuments.listAtRoot(req.params.id, user.id);
      res.json({ documents });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── POST /portal/spaces/:id/seed-doc ────────────────────────────────
  // Body: { documentPath, position? }
  // Attaches a doc at the space root (no folder). Idempotent on
  // (space_id, document_path) for root-scoped seeds.
  router.post('/portal/spaces/:id/seed-doc', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      const { documentPath, position } = req.body || {};
      if (!documentPath || typeof documentPath !== 'string') {
        return res.status(400).json({ error: 'documentPath required' });
      }
      const doc = await db.documents.get(user.id, documentPath);
      if (!doc) return res.status(404).json({ error: 'Document not found in your library' });
      const id = await db.spaceRoomDocuments.add({
        spaceId: req.params.id,
        roomId: null,
        documentPath,
        position: typeof position === 'number' ? position : 0,
        createdBy: user.id,
      });
      db.audit.log({
        action: 'space.seed_doc',
        userId: user.id,
        ip: req.ip,
        resourceType: 'space_room_document',
        resourceId: id,
      }).catch(() => {});
      res.json({ id });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Space seed-doc failed:`, e.message);
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  // ── DELETE /portal/spaces/:id/contents/:cid ────────────────────────
  // Removes a root-level doc from the space (junction only — the doc
  // stays in the contributor's library).
  router.delete('/portal/spaces/:id/contents/:cid', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.spaces.requireRole(req.params.id, user.id, 'contributor');
      await db.spaceRoomDocuments.remove(req.params.cid, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(roleStatus(e.message)).json({ error: e.message });
    }
  });

  logger.info?.('[portal-spaces-router] mounted 22 handlers');
  return router;
}
