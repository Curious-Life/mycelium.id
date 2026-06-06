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

  // ── Profile (Phase P) — read + edit, backed by user_profiles ────────────
  // user_profiles holds the public-facing fields (handle/display_name/signature
  // — plaintext by design, not in ENCRYPTED_FIELDS). Cognitive scores
  // (depth/breadth/coherence/exploration) are pipeline-computed (Tier-2) and stay
  // null until clustering runs. apiGet throws on non-200, so GET must always 200.
  const HANDLE_RE = /^[a-z0-9][a-z0-9_]{2,29}$/;
  const RESERVED_HANDLES = new Set(['admin', 'api', 'www', 'app', 'mycelium', 'settings', 'profile', 'login', 'support', 'system', 'public', 'auth', 'id']);

  const countOf = async (fn) => { try { return await fn(); } catch { return 0; } };
  async function readProfile() {
    let row = {};
    try {
      const r = await db.rawQuery(
        `SELECT handle, display_name, signature, avatar_url, exlibris_url,
                depth_score, breadth_score, coherence_score, exploration_score,
                territory_count, realm_count, message_count, member_since, public_realms_json
           FROM user_profiles WHERE user_id = ?`, [userId]);
      row = (r.results || r || [])[0] || {};
    } catch { /* table-less / fresh vault → defaults below */ }
    const message_count = await countOf(() => db.messages.countByUser(userId));
    const territory_count = await countOf(async () => (await db.mindscape.getTerritoryProfiles(userId)).length);
    const realm_count = await countOf(async () => (await db.mindscape.getRealms(userId)).length);
    return {
      display_name: row.display_name || 'You',
      handle: row.handle || null,
      avatar_url: row.avatar_url || null,
      exlibris_url: row.exlibris_url || null,
      signature: row.signature || null,
      depth_score: row.depth_score ?? null, breadth_score: row.breadth_score ?? null,
      coherence_score: row.coherence_score ?? null, exploration_score: row.exploration_score ?? null,
      territory_count, realm_count, message_count,
      member_since: row.member_since || null, public_realms_json: row.public_realms_json || null,
    };
  }
  // Ensure the single-user row exists before an UPDATE (PK = user_id).
  const ensureRow = () => db.rawQuery(
    `INSERT INTO user_profiles (user_id, member_since) VALUES (?, datetime('now')) ON CONFLICT(user_id) DO NOTHING`, [userId]);

  router.get('/profile', async (_req, res) => {
    try { ok(res, { profile: await readProfile() }); } catch { fail(res, 500, 'profile read failed'); }
  });

  // GET /profile/handle/check?handle=… → { available, reason? }
  router.get('/profile/handle/check', async (req, res) => {
    const h = typeof req.query.handle === 'string' ? req.query.handle.trim().toLowerCase() : '';
    if (!HANDLE_RE.test(h)) return ok(res, { available: false, reason: '3–30 chars: a–z, 0–9, _ (start alphanumeric)' });
    if (RESERVED_HANDLES.has(h)) return ok(res, { available: false, reason: 'reserved' });
    try {
      const r = await db.rawQuery(`SELECT user_id FROM user_profiles WHERE handle = ? AND user_id != ?`, [h, userId]);
      ok(res, { available: !((r.results || r || []).length) });
    } catch { ok(res, { available: true }); }
  });

  // PUT /profile → update handle / display_name / signature → { ok, profile }
  router.put('/profile', async (req, res) => {
    try {
      const body = req.body || {};
      const sets = [], params = [];
      if (typeof body.handle === 'string') {
        const h = body.handle.trim().toLowerCase();
        if (!HANDLE_RE.test(h)) return fail(res, 400, 'invalid handle (3–30 chars: a–z, 0–9, _)');
        if (RESERVED_HANDLES.has(h)) return fail(res, 400, 'that handle is reserved');
        sets.push('handle = ?'); params.push(h);
      }
      if (typeof body.display_name === 'string') { sets.push('display_name = ?'); params.push(body.display_name.slice(0, 80)); }
      if (typeof body.signature === 'string') { sets.push('signature = ?'); params.push(body.signature.slice(0, 500)); }
      if (!sets.length) return fail(res, 400, 'nothing to update');
      await ensureRow();
      await db.rawQuery(`UPDATE user_profiles SET ${sets.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`, [...params, userId]);
      ok(res, { ok: true, profile: await readProfile() });
    } catch { fail(res, 500, 'could not save profile'); }
  });

  // POST /profile/stats/recompute → refresh the live counts (cognitive scores
  // need the Tier-2 pipeline, so they stay null here). → { ok, profile }
  router.post('/profile/stats/recompute', async (_req, res) => {
    try {
      const message_count = await countOf(() => db.messages.countByUser(userId));
      const territory_count = await countOf(async () => (await db.mindscape.getTerritoryProfiles(userId)).length);
      const realm_count = await countOf(async () => (await db.mindscape.getRealms(userId)).length);
      await ensureRow();
      await db.rawQuery(`UPDATE user_profiles SET territory_count = ?, realm_count = ?, message_count = ?, updated_at = datetime('now') WHERE user_id = ?`,
        [territory_count, realm_count, message_count, userId]);
      ok(res, { ok: true, profile: await readProfile() });
    } catch { fail(res, 500, 'recompute failed'); }
  });

  // ── Connections (federation Tier-0) — backs the Connections page ─────────
  // db.connections is wired in getDb. Remote peers cache handle=NULL (the local
  // user owns the UNIQUE handle), so coalesce the display handle from the
  // connection row's remote_user_handle. GETs degrade to empty on error.
  const connId = (req) => decodePath(req.params.id || '');
  const mapConn = (c) => ({ ...c, other_handle: c.other_handle || c.remote_user_handle || null });
  const mapPending = (r) => ({
    id: r.id,
    handle: r.handle || r.remote_user_handle || null,
    display_name: r.display_name || null,
    signature: r.signature || null,
    avatar_url: r.avatar_url || null,
    territory_count: r.territory_count ?? 0,
    realm_count: r.realm_count ?? 0,
    public_realms_json: r.public_realms_json || null,
  });
  const mapSent = (s) => ({
    id: s.id, status: s.status, created_at: s.created_at,
    to_handle: s.to_handle || s.remote_user_handle || null,
    to_display_name: s.to_display_name || null,
    to_avatar_url: s.to_avatar_url || null,
  });

  router.get('/connections', async (_req, res) => {
    try { ok(res, { connections: (await db.connections.list(userId)).map(mapConn) }); }
    catch { ok(res, { connections: [] }); }
  });
  // count of pending INBOUND requests — feeds the nav badge.
  router.get('/connections/count', async (_req, res) => {
    try { ok(res, { count: (await db.connections.pending(userId)).length }); }
    catch { ok(res, { count: 0 }); }
  });
  router.get('/connections/pending', async (_req, res) => {
    try { ok(res, { requests: (await db.connections.pending(userId)).map(mapPending) }); }
    catch { ok(res, { requests: [] }); }
  });
  router.get('/connections/sent', async (_req, res) => {
    try { ok(res, { sent: (await db.connections.sent(userId)).map(mapSent) }); }
    catch { ok(res, { sent: [] }); }
  });
  // POST /connections/request { toHandle, message? } — message stored client-side only for now.
  router.post('/connections/request', async (req, res) => {
    try {
      const toHandle = String(req.body?.toHandle || '').trim().replace(/^@/, '');
      if (!toHandle) return fail(res, 400, 'handle required');
      const id = await db.connections.request(userId, toHandle);
      ok(res, { ok: true, id });
    } catch (e) { fail(res, 400, e.message || 'could not send request'); }
  });
  // accept/reject route through respondRemote so an accept fires the signed
  // connect-response callback that completes the peer's side of the handshake.
  router.post('/connections/:id/accept', async (req, res) => {
    try { await db.connections.respondRemote(userId, connId(req), 'accept'); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not accept'); }
  });
  router.post('/connections/:id/reject', async (req, res) => {
    try { await db.connections.respondRemote(userId, connId(req), 'reject'); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not reject'); }
  });
  router.post('/connections/:id/block', async (req, res) => {
    try { await db.connections.block(userId, connId(req)); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not block'); }
  });
  router.delete('/connections/:id', async (req, res) => {
    try { await db.connections.disconnect(userId, connId(req)); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not disconnect'); }
  });
  router.get('/connections/:id/overlap', async (req, res) => {
    try { ok(res, { overlap: await db.connections.computeOverlap(userId, connId(req)) }); }
    catch (e) { fail(res, 400, e.message || 'could not compute overlap'); }
  });

  // ── Spaces (default-private shareable folders, Phase A) ──────────────────
  // Every read/write is gated by space_access via db.spaces.requireRole, which
  // is fail-closed (no grant → throws). Non-members get 404 (indistinguishable
  // from a missing space), so a space reveals nothing by default. randomUUID is
  // on the base adapter (db._base.randomUUID).
  const newId = () => db._base.randomUUID();
  // Run `fn` only if the caller holds at least `minRole` on the space; otherwise
  // 404 (never leak existence). Returns true when allowed.
  async function guardSpace(res, spaceId, minRole) {
    try { await db.spaces.requireRole(spaceId, userId, minRole); return true; }
    catch { fail(res, 404, 'not found'); return false; }
  }

  router.get('/spaces', async (_req, res) => {
    try { ok(res, { spaces: await db.spaces.listForUser(userId) }); }
    catch { ok(res, { spaces: [] }); }
  });
  router.post('/spaces', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return fail(res, 400, 'name required');
      const id = newId();
      await db.spaces.create(id, name, req.body?.essence ?? null, req.body?.voice ?? null, userId);
      ok(res, { id, ...(await db.spaces.get(id)), role: 'creator' });
    } catch { fail(res, 500, 'could not create space'); }
  });
  router.get('/spaces/territories', async (_req, res) => {
    try {
      const terr = await db.mindscape.getTerritoryProfiles(userId);
      ok(res, { territories: (terr || []).map((t) => ({ id: String(t.territory_id ?? t.id), name: t.name, essence: t.essence, message_count: t.message_count ?? 0 })) });
    } catch { ok(res, { territories: [] }); }
  });
  router.get('/spaces/:id', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'member'))) return;
    try { ok(res, { ...(await db.spaces.get(id)), role: await db.spaces.getRole(id, userId) }); }
    catch { fail(res, 500, 'could not load space'); }
  });
  router.put('/spaces/:id', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try {
      const b = req.body || {};
      await db.spaces.update(id, { name: b.name, essence: b.essence, voice: b.voice, coverDocPath: b.coverDocPath });
      ok(res, { ok: true, ...(await db.spaces.get(id)) });
    } catch { fail(res, 500, 'could not update space'); }
  });
  router.delete('/spaces/:id', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try { await db.spaces.delete(id); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not delete space'); }
  });

  // knowledge
  router.get('/spaces/:id/knowledge', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'member'))) return;
    try { ok(res, { entries: await db.spaceKnowledge.list(id) }); } catch { ok(res, { entries: [] }); }
  });
  router.post('/spaces/:id/knowledge', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const content = String(req.body?.content || '').trim();
      if (!content) return fail(res, 400, 'content required');
      const entryId = await db.spaceKnowledge.add(id, content, userId, null, 'direct', 'all', req.body?.domain_tags ?? null);
      ok(res, { ok: true, id: entryId });
    } catch { fail(res, 500, 'could not add knowledge'); }
  });
  router.delete('/spaces/:id/knowledge/:entryId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try { await db.spaceKnowledge.revoke(decodePath(req.params.entryId), id); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not remove knowledge'); }
  });
  router.post('/spaces/:id/seed', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const ids = Array.isArray(req.body?.territory_ids) ? req.body.territory_ids : [];
      const terr = await db.mindscape.getTerritoryProfiles(userId).catch(() => []);
      const byId = new Map((terr || []).map((t) => [String(t.territory_id ?? t.id), t]));
      for (const tid of ids) {
        const t = byId.get(String(tid));
        if (t) await db.spaceKnowledge.add(id, t.essence || t.name || '', userId, String(tid), 'territory', 'all', null);
      }
      ok(res, { ok: true, seeded: ids.length });
    } catch { fail(res, 500, 'could not seed space'); }
  });

  // members + sharing (grant a connection access; default-deny)
  router.get('/spaces/:id/members', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'member'))) return;
    try { ok(res, { members: await db.spaceAccess.list(id) }); } catch { ok(res, { members: [] }); }
  });
  router.get('/spaces/:id/shares', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try {
      const [members, connections] = await Promise.all([db.spaceAccess.list(id), db.connections.list(userId)]);
      ok(res, { members, connections });
    } catch { ok(res, { members: [], connections: [] }); }
  });
  router.post('/spaces/:id/shares', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try {
      const granteeId = String(req.body?.granteeId || '').trim();
      const role = ['member', 'contributor'].includes(req.body?.role) ? req.body.role : 'member';
      if (!granteeId) return fail(res, 400, 'granteeId required');
      if (granteeId === userId) return fail(res, 400, 'cannot share with yourself');
      await db.spaceAccess.grant(id, granteeId, role, userId);
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not share space'); }
  });
  router.delete('/spaces/:id/shares/:granteeId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try { await db.spaceAccess.revoke(id, decodePath(req.params.granteeId)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not revoke share'); }
  });

  // rooms (nested folders) + documents
  const roomsList = async (req, res, parentId) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'member'))) return;
    try { ok(res, { rooms: await db.spaceRooms.listChildren(id, parentId) }); } catch { ok(res, { rooms: [] }); }
  };
  router.get('/spaces/:id/rooms', async (req, res) => {
    const parent = typeof req.query.parent === 'string' && req.query.parent ? req.query.parent : null;
    await roomsList(req, res, parent);
  });
  router.get('/spaces/:id/rooms/:roomId/children', (req, res) => roomsList(req, res, decodePath(req.params.roomId)));
  router.post('/spaces/:id/rooms', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return fail(res, 400, 'name required');
      const room = await db.spaceRooms.create({ spaceId: id, parentId: req.body?.parentId ?? null, name, essence: req.body?.essence ?? null, createdBy: userId });
      ok(res, { ok: true, id: room?.id ?? room });
    } catch { fail(res, 500, 'could not create folder'); }
  });
  router.delete('/spaces/:id/rooms/:roomId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try { await db.spaceRooms.delete(decodePath(req.params.roomId), id); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not delete folder'); }
  });
  // contents: at space root or within a room
  const contentsList = async (req, res, roomId) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'member'))) return;
    try {
      const documents = roomId ? await db.spaceRoomDocuments.listByRoom(roomId, userId) : await db.spaceRoomDocuments.listAtRoot(id, userId);
      ok(res, { documents });
    } catch { ok(res, { documents: [] }); }
  };
  router.get('/spaces/:id/contents', (req, res) => contentsList(req, res, null));
  router.get('/spaces/:id/rooms/:roomId/contents', (req, res) => contentsList(req, res, decodePath(req.params.roomId)));
  const seedDoc = async (req, res, roomId) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const documentPath = String(req.body?.documentPath || '').trim();
      if (!documentPath) return fail(res, 400, 'documentPath required');
      const row = await db.spaceRoomDocuments.add({ spaceId: id, roomId, documentPath, createdBy: userId });
      ok(res, { ok: true, id: row?.id ?? row });
    } catch { fail(res, 500, 'could not add document'); }
  };
  router.post('/spaces/:id/seed-doc', (req, res) => seedDoc(req, res, null));
  router.post('/spaces/:id/rooms/:roomId/seed-doc', (req, res) => seedDoc(req, res, decodePath(req.params.roomId)));
  const removeContent = async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try { await db.spaceRoomDocuments.remove(decodePath(req.params.docId), id); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not remove document'); }
  };
  router.delete('/spaces/:id/contents/:docId', removeContent);
  router.delete('/spaces/:id/rooms/:roomId/contents/:docId', removeContent);

  // ── Contexts (the "Work Self / Private Self" granular model) ─────────────
  // A context is a named bucket of territories shared with chosen connections —
  // "what facet of yourself they see". Default-private: a territory is invisible
  // to a connection unless it's in a non-private context granted to them
  // (db.contexts.canSeeTerritory is the fail-closed gate). Cross-node visibility
  // activates with federation; the model is recorded + enforced locally now.
  async function ownsContext(id) {
    try {
      const r = await db._base.d1Query(`SELECT 1 FROM sharing_contexts WHERE id = ? AND user_id = ?`, [id, userId]);
      return (r.results || []).length > 0;
    } catch { return false; }
  }
  async function guardContext(res, id) {
    if (await ownsContext(id)) return true;
    fail(res, 404, 'not found'); return false;
  }

  router.get('/contexts', async (_req, res) => {
    try { await db.contexts.ensureDefaults(userId); ok(res, { contexts: await db.contexts.list(userId) }); }
    catch { ok(res, { contexts: [] }); }
  });
  router.post('/contexts', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return fail(res, 400, 'name required');
      const id = await db.contexts.create(userId, { name, is_private: !!req.body?.is_private });
      ok(res, { ok: true, id });
    } catch (e) { fail(res, 400, e.message || 'could not create context'); }
  });
  router.put('/contexts/:id', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.rename(userId, id, String(req.body?.name || '').trim()); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not rename'); }
  });
  router.delete('/contexts/:id', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.remove(userId, id); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not delete context'); }
  });
  router.get('/contexts/:id/territories', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { ok(res, { territories: await db.contexts.getTerritories(id) }); } catch { ok(res, { territories: [] }); }
  });
  router.post('/contexts/:id/territories/:territoryId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.addTerritory(id, decodePath(req.params.territoryId)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not add territory'); }
  });
  router.delete('/contexts/:id/territories/:territoryId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.removeTerritory(id, decodePath(req.params.territoryId)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not remove territory'); }
  });
  router.get('/contexts/:id/connections', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { ok(res, { grants: await db.contexts.getGrants(id) }); } catch { ok(res, { grants: [] }); }
  });
  router.post('/contexts/:id/grant/:connId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.grant(id, decodePath(req.params.connId)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not grant'); }
  });
  router.delete('/contexts/:id/grant/:connId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.revoke(id, decodePath(req.params.connId)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not revoke'); }
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
  //
  // Has the user already seen the first-run welcome? Persisted on the users row
  // (welcome_shown_at) so the modal shows ONCE — without this it re-popped on
  // every reload of a not-yet-populated vault. A fresh local vault has no users
  // row, so a missing row / table reads as "not seen yet" and the POST upserts.
  async function welcomeSeen() {
    try {
      const r = await db.rawQuery(`SELECT welcome_shown_at FROM users WHERE id = ?`, [userId]);
      return Boolean((r.results || r || [])[0]?.welcome_shown_at);
    } catch { return false; }
  }

  router.get('/onboarding/status', async (_req, res) => {
    let messageCount = 0;
    try { messageCount = db.messages?.countByUser ? await db.messages.countByUser(userId) : 0; } catch { /* 0 */ }
    const seen = await welcomeSeen();
    ok(res, {
      // First-run welcome: show on an empty vault UNTIL it's been seen once (or
      // anything is captured), then never again — so it never re-pops jarringly.
      showWelcome: !seen && messageCount === 0,
      show: false,
      aiModelsReady: true,
      steps: { data: { messageCount, enrichedCount: 0, enrichmentPending: 0 } },
    });
  });

  // Mark the first-run welcome as seen (idempotent — keeps the first timestamp).
  // The WelcomeModal already posts here on finish/skip; the endpoint was missing,
  // so the dismissal never stuck. Upserts because a fresh vault has no users row.
  router.post('/onboarding/welcome-seen', async (_req, res) => {
    try {
      await db.rawQuery(
        `INSERT INTO users (id, welcome_shown_at) VALUES (?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET welcome_shown_at = COALESCE(users.welcome_shown_at, datetime('now'))`,
        [userId]);
    } catch { /* best-effort — never block the UI on a write */ }
    ok(res, { ok: true });
  });

  return router;
}

export default portalCompatRouter;
