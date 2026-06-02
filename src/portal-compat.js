import express from 'express';

/**
 * portalCompatRouter — a thin compatibility surface that lets the CANONICAL
 * SvelteKit portal (portal-app/, ported from the cloud product) run against the
 * local V1 server with minimal per-screen edits.
 *
 * The portal's data layer (portal-app/src/lib/api.ts) calls cloud `/portal/*`
 * endpoints; api.ts rewrites those to `/api/v1/portal/*`, which this router
 * serves — returning the SAME JSON SHAPES the screens consume, backed directly
 * by the local db namespaces. This is the M2 "light up the screens" work; it
 * grows one vertical at a time (Library first). Unimplemented paths simply 404
 * — screens render their empty state.
 *
 * MOUNTED UNDER `/api/v1/portal` (so routes here are relative, and this
 * router's express.json parser is scoped to portal calls only — it must NOT
 * touch the raw-bytes /api/v1/upload route or the tool routes).
 *
 * Security posture is identical to apiRouter: localhost-only, no auth yet
 * (Phase 4), errors never leak internals/plaintext.
 *
 * @param {object} deps
 * @param {object} deps.db       the wired db namespace (documents, folders, messages…)
 * @param {string} deps.userId   the single V1 owner
 * @returns {import('express').Router}
 */
export function portalCompatRouter({ db, userId }) {
  if (!db) throw new Error('portalCompatRouter: db required');
  const router = express.Router();
  router.use(express.json({ limit: process.env.MYCELIUM_API_BODY_LIMIT || '64mb' }));

  const ok = (res, body) => res.json(body);
  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });
  const decodePath = (raw) => { try { return decodeURIComponent(raw); } catch { return raw; } };

  // ── Library: documents ─────────────────────────────────────────────────
  // GET /documents?pinned=1&folder_id=… → { documents: [...] }
  router.get('/documents', async (req, res) => {
    try {
      const opts = {};
      if (req.query.pinned === '1' || req.query.pinned === 'true') opts.pinnedOnly = true;
      if (typeof req.query.folder_id === 'string' && req.query.folder_id) opts.folderId = req.query.folder_id;
      const documents = await db.documents.list(userId, opts);
      ok(res, { documents });
    } catch { fail(res); }
  });

  // GET /documents/<path> → { document: {...,content} }
  router.get(/^\/documents\/(.+)$/, async (req, res) => {
    try {
      const doc = await db.documents.get(userId, decodePath(req.params[0]));
      if (!doc) return fail(res, 404, 'document not found');
      ok(res, { document: doc });
    } catch { fail(res); }
  });

  // POST /documents → create/update { path, title, content }
  router.post('/documents', async (req, res) => {
    try {
      const { path, title, content } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      const row = await db.documents.upsert({
        user_id: userId, path,
        title: typeof title === 'string' ? title : null,
        content: typeof content === 'string' ? content : '',
      });
      ok(res, { ok: true, document: row });
    } catch { fail(res); }
  });

  // POST /documents/pin → { path, pinned: boolean }
  router.post('/documents/pin', async (req, res) => {
    try {
      const { path, pinned } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      await (pinned ? db.documents.pin(userId, path) : db.documents.unpin(userId, path));
      ok(res, { ok: true });
    } catch { fail(res); }
  });

  // POST /documents/move → { path, folder_id: string|null }
  router.post('/documents/move', async (req, res) => {
    try {
      const { path, folder_id } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      await db.documents.moveToFolder(userId, path, folder_id ?? null);
      ok(res, { ok: true });
    } catch { fail(res); }
  });

  // DELETE /documents/<path>
  router.delete(/^\/documents\/(.+)$/, async (req, res) => {
    try {
      await db.documents.delete(userId, decodePath(req.params[0]));
      ok(res, { ok: true });
    } catch { fail(res); }
  });

  // GET /folders → { folders: [...] }
  router.get('/folders', async (_req, res) => {
    try {
      const folders = db.folders?.list ? await db.folders.list(userId) : [];
      ok(res, { folders: folders || [] });
    } catch { ok(res, { folders: [] }); }
  });

  // ── Timeline: the chronological message feed (Phase T) ─────────────────
  // GET /messages?limit=50&before=<created_at> → { messages: [...] }
  // Backed by db.messages.selectTimeline. `metadata` is stripped from the
  // projection — it holds triage decisions / dedupe nonces / delivery state we
  // must never leak past the read path (CLAUDE.md §1).
  router.get('/messages', async (req, res) => {
    try {
      const raw = parseInt(req.query.limit, 10);
      const limit = !Number.isFinite(raw) || raw <= 0 ? 50 : Math.min(raw, 200);
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
      const rows = await db.messages.selectTimeline(userId, { limit, before, scope: 'all' });
      const messages = rows.map(({ metadata, ...m }) => m);
      ok(res, { messages });
    } catch { ok(res, { messages: [] }); }
  });

  // ── Profile (Phase P) — synthesized for the single-user vault ───────────
  // GET /profile → { profile: {...} }. V1 has no user_profiles row; we surface
  // the local identity + live counts. apiGet throws on non-200, so this must
  // always 200. Pipeline-computed scores are null until Tier-2 runs.
  router.get('/profile', async (_req, res) => {
    const count = async (fn) => { try { return await fn(); } catch { return 0; } };
    const message_count = await count(() => db.messages.countByUser(userId));
    const territory_count = await count(async () => (await db.mindscape.getTerritoryProfiles(userId)).length);
    const realm_count = await count(async () => (await db.mindscape.getRealms(userId)).length);
    ok(res, { profile: {
      display_name: 'You', handle: 'local', avatar_url: null, exlibris_url: null, signature: null,
      depth_score: null, breadth_score: null, coherence_score: null, exploration_score: null,
      territory_count, realm_count, message_count, member_since: null, public_realms_json: null,
    } });
  });

  // ── Settings (Phase S) — timezone only; theme is client-side localStorage ─
  router.get('/settings', (_req, res) => ok(res, { settings: { timezone: 'UTC' } }));

  // ── Benign reads consumed by several screens (kill 404 noise; all are ────
  // graceful on the client, but answering them keeps the console clean).
  router.get('/stats', async (_req, res) => {
    let total = 0; try { total = await db.messages.countByUser(userId); } catch { /* 0 */ }
    ok(res, { messages: { total, bySource: {}, byAgent: {}, dateRange: null, last30Days: 0 },
      documents: { total: 0 }, attachments: { total: 0, byType: {}, totalSizeMB: 0 },
      contacts: { total: 0, byTier: {} }, mindscape: { territories: 0, realms: 0, points: 0 }, integrations: [] });
  });
  router.get('/agents', (_req, res) => ok(res, { agents: [] }));
  router.get('/identity', (_req, res) => ok(res, { ownerName: 'You', ownerTelegramId: null, ownerDiscordId: null }));

  // ── Onboarding status (read by the app layout + mindscape on load) ──────
  // Benign shape so those screens don't error before their verticals land.
  router.get('/onboarding/status', async (_req, res) => {
    let messageCount = 0;
    try { messageCount = db.messages?.countByUser ? await db.messages.countByUser(userId) : 0; } catch { /* 0 */ }
    ok(res, {
      // Phase O — first-run welcome: an empty vault shows the welcome modal that
      // guides the user to Import; once anything is captured it stops appearing.
      showWelcome: messageCount === 0,
      show: false,
      aiModelsReady: true,
      steps: { data: { messageCount, enrichedCount: 0, enrichmentPending: 0 } },
    });
  });

  return router;
}

export default portalCompatRouter;
