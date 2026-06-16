import express from 'express';
import { nudgeEnrichDrainer } from './enrich/drainer.js';
import { mediaTypeOf } from './portal-attachments.js';
import { clampStored } from './enrich/text-limits.js';

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
export function portalCompatRouter({ db, userId, spaceSync = null }) {
  if (!db) throw new Error('portalCompatRouter: db required');
  // spaceSync (Phase B, optional): when a Matrix client is wired, a share grant/
  // revoke also syncs the peer into/out of the space's Megolm room. Null until a
  // homeserver is configured → the grant is recorded locally regardless.
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
      // Join attachment metadata so the timeline renders the ACTUAL media
      // (TimelineView expects msg.attachment {type,url,description,transcript,
      // filename,fileSize}). One batched user-scoped lookup; decrypted fields
      // come back through the adapter like any read. Fail-soft: a lookup error
      // degrades to text-only messages, never an empty feed.
      let attMap = new Map();
      try {
        const ids = [...new Set(rows.map((m) => m.attachment_id).filter(Boolean))];
        if (ids.length && db.attachments?.getByIds) {
          const atts = await db.attachments.getByIds(ids, userId);
          attMap = new Map((atts || []).map((a) => [a.id, {
            type: mediaTypeOf(a.file_type),
            url: `/api/v1/portal/attachments/${a.id}/file`,
            filename: a.file_name || null,
            fileSize: a.file_size ?? null,
            description: a.description || null,
            transcript: a.transcript || null,
          }]));
        }
      } catch { /* text-only fallback */ }
      const messages = rows.map(({ metadata, ...m }) => ({
        ...m,
        ...(m.attachment_id && attMap.has(m.attachment_id) ? { attachment: attMap.get(m.attachment_id) } : {}),
      }));
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
      // Validate-don't-silently-slice: a too-long name is rejected (the user
      // learns), not quietly truncated. The signature/bio is free-text content —
      // store it in full (DoS-bounded), never clip it. (persistence ≠ budget)
      if (typeof body.display_name === 'string') {
        if (body.display_name.length > 200) return fail(res, 400, 'display name too long (max 200 chars)');
        sets.push('display_name = ?'); params.push(body.display_name);
      }
      if (typeof body.signature === 'string') { sets.push('signature = ?'); params.push(clampStored(body.signature)); }
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
  // Withdraw a sent-but-unaccepted request (clears a stranded/failed-delivery
  // pending outbound row so it can be re-sent). Initiator-only; pending-only.
  router.post('/connections/:id/withdraw', async (req, res) => {
    try { await db.connections.withdraw(userId, connId(req)); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not withdraw'); }
  });
  router.get('/connections/:id/overlap', async (req, res) => {
    try { ok(res, { overlap: await db.connections.computeOverlap(userId, connId(req)) }); }
    catch (e) { fail(res, 400, e.message || 'could not compute overlap'); }
  });

  // ── Direct messaging with a connected peer (federation Tier-0c) ───────────
  // unread is registered before /:id/messages; its literal path can't be
  // captured by the :id pattern (distinct 3rd segment).
  router.get('/connections/messages/unread', async (_req, res) => {
    try { ok(res, await db.connections.unreadMessages(userId)); }
    catch { ok(res, { total: 0, byConnection: {} }); }
  });
  router.get('/connections/:id/messages', async (req, res) => {
    try { ok(res, { messages: await db.connections.listMessages(userId, connId(req)) }); }
    catch (e) { fail(res, 400, e.message || 'could not load messages'); }
  });
  router.post('/connections/:id/messages', async (req, res) => {
    try {
      const message = await db.connections.sendMessage(userId, connId(req), String(req.body?.text || ''));
      ok(res, { ok: true, message });
    } catch (e) { fail(res, 400, e.message || 'could not send message'); }
  });
  router.post('/connections/:id/messages/read', async (req, res) => {
    try { await db.connections.markMessagesRead(userId, connId(req)); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not mark read'); }
  });
  // Everything shared WITH this connection — the management hub: spaces granted
  // to the peer + contexts (territory facets) granted to the connection.
  router.get('/connections/:id/shared', async (req, res) => {
    try {
      const cid = connId(req);
      const cr = await db._base.d1Query(
        `SELECT user_a, user_b FROM connections WHERE id = ? AND (user_a = ? OR user_b = ?) AND status = 'accepted'`,
        [cid, userId, userId],
      );
      const row = cr.results?.[0];
      if (!row) return ok(res, { peer_id: null, spaces: [], contexts: [] });
      const peerId = row.user_a === userId ? row.user_b : row.user_a;
      const spaces = (await db._base.d1Query(
        `SELECT u.id, u.display_name AS name, sa.role
         FROM space_access sa JOIN users u ON u.id = sa.space_id
         WHERE sa.user_id = ? AND sa.revoked_at IS NULL AND u.type = 'space'
         ORDER BY u.display_name`,
        [peerId],
      )).results || [];
      const contexts = (await db._base.d1Query(
        `SELECT sc.id, sc.name, sc.is_private
         FROM context_grants cg JOIN sharing_contexts sc ON sc.id = cg.context_id
         WHERE cg.connection_id = ? AND sc.user_id = ?
         ORDER BY sc.name`,
        [cid, userId],
      )).results || [];
      ok(res, { peer_id: peerId, spaces, contexts });
    } catch { ok(res, { peer_id: null, spaces: [], contexts: [] }); }
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
  // The mindscape cluster hierarchy (Realm → Theme → Territory) for the
  // "share a whole cluster at a level" picker.
  router.get('/spaces/cluster-hierarchy', async (_req, res) => {
    try {
      const [realms, themes, territories] = await Promise.all([
        db.mindscape.getRealms(userId).catch(() => []),
        db.mindscape.getSemanticThemes(userId).catch(() => []),
        db.mindscape.getTerritoryProfiles(userId).catch(() => []),
      ]);
      const byRealm = new Map();
      for (const t of themes || []) {
        const k = String(t.realm_id);
        if (!byRealm.has(k)) byRealm.set(k, []);
        byRealm.get(k).push({ semantic_theme_id: t.semantic_theme_id, name: t.name, essence: t.essence, territory_count: t.territory_count ?? 0 });
      }
      const out = (realms || []).map((r) => ({
        realm_id: r.realm_id, name: r.name, essence: r.essence, territory_count: r.territory_count ?? 0,
        themes: byRealm.get(String(r.realm_id)) || [],
      }));
      ok(res, { realms: out, territory_count: (territories || []).length });
    } catch { ok(res, { realms: [], territory_count: 0 }); }
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
      spaceSync?.mirrorKnowledge(id, { content, source_type: 'direct' }).catch(() => {});
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
  // Share a whole CLUSTER at a chosen level (realm / theme / territory) — one
  // traceable knowledge card synthesizing the cluster's essence + members.
  // source_ref ('realm:N' / 'theme:N:M' / 'territory:K') keeps it re-resolvable
  // (the Phase-B Megolm mirror can re-expand it). Never sends embeddings.
  router.post('/spaces/:id/seed-cluster', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const level = req.body?.level;
      const realmId = req.body?.realm_id, themeId = req.body?.semantic_theme_id, terrId = req.body?.territory_id;
      const [realms, themes, territories] = await Promise.all([
        db.mindscape.getRealms(userId).catch(() => []),
        db.mindscape.getSemanticThemes(userId).catch(() => []),
        db.mindscape.getTerritoryProfiles(userId).catch(() => []),
      ]);
      let label, name, essence, members = [], sourceRef, srcTerr = null;
      if (level === 'territory') {
        const t = (territories || []).find((x) => String(x.territory_id) === String(terrId));
        if (!t) return fail(res, 404, 'territory not found');
        label = 'Territory'; name = t.name; essence = t.essence; sourceRef = `territory:${terrId}`; srcTerr = String(terrId);
      } else if (level === 'theme') {
        const th = (themes || []).find((x) => String(x.realm_id) === String(realmId) && String(x.semantic_theme_id) === String(themeId));
        if (!th) return fail(res, 404, 'theme not found');
        label = 'Theme'; name = th.name; essence = th.essence; sourceRef = `theme:${realmId}:${themeId}`;
        members = (territories || []).filter((t) => String(t.realm_id) === String(realmId) && String(t.semantic_theme_id) === String(themeId));
      } else if (level === 'realm') {
        const r = (realms || []).find((x) => String(x.realm_id) === String(realmId));
        if (!r) return fail(res, 404, 'realm not found');
        label = 'Realm'; name = r.name; essence = r.essence; sourceRef = `realm:${realmId}`;
        members = (territories || []).filter((t) => String(t.realm_id) === String(realmId));
      } else {
        return fail(res, 400, 'level must be realm, theme, or territory');
      }
      const memberLines = members.slice(0, 50).map((m) => `• ${m.name}${m.essence ? ` — ${m.essence}` : ''}`).join('\n');
      const content = [`${label}: ${name || '(unnamed)'}`, essence, memberLines].filter(Boolean).join('\n\n');
      const entryId = await db.spaceKnowledge.add(id, content, userId, srcTerr, level, 'all', null, sourceRef);
      spaceSync?.mirrorKnowledge(id, { content, source_type: level, source_ref: sourceRef }).catch(() => {});
      ok(res, { ok: true, id: entryId, level, members: members.length });
    } catch (e) { fail(res, 500, e.message || 'could not share cluster'); }
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
      // Grantee must be an ACCEPTED connection — don't let an arbitrary id be
      // wired into a space's access list (defense-in-depth; the UI already only
      // offers connections).
      const conns = await db.connections.list(userId);
      if (!conns.some((c) => c.other_user_id === granteeId)) return fail(res, 400, 'grantee must be an accepted connection');
      await db.spaceAccess.grant(id, granteeId, role, userId);
      // best-effort Megolm-room invite (no-op until Matrix is configured)
      spaceSync?.syncGrant(id, granteeId, userId).catch(() => {});
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not share space'); }
  });
  router.delete('/spaces/:id/shares/:granteeId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try {
      const granteeId = decodePath(req.params.granteeId);
      await db.spaceAccess.revoke(id, granteeId);
      spaceSync?.syncRevoke(id, granteeId).catch(() => {});
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not revoke share'); }
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
  // (/agents now served by portalChatRouter — the real single-agent endpoint.)
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

  // Embedding backlog counts — total / embedded / pending. Mirrors the query in
  // portal-mindscape's /mycelium/processing-status; `embedded` rows have a
  // non-NULL embedding_768. Best-effort: any error reads as all-zero.
  async function embedCounts() {
    // Single source of truth (db.messages.embedBacklog) — counts only embeddable
    // (content-bearing) messages so `pending` reaches 0. PIPELINE-INTEGRITY §P1.2.
    try { return await db.messages.embedBacklog(userId); }
    catch { return { total: 0, embedded: 0, pending: 0 }; }
  }

  router.get('/onboarding/status', async (_req, res) => {
    const { total, embedded, pending } = await embedCounts();
    const seen = await welcomeSeen();
    let dismissed = false;
    try {
      const r = await db.rawQuery(`SELECT onboarding_dismissed_at FROM users WHERE id = ?`, [userId]);
      dismissed = Boolean((r.results || r || [])[0]?.onboarding_dismissed_at);
    } catch { /* not dismissed */ }
    ok(res, {
      // First-run welcome: show on an empty vault UNTIL it's been seen once (or
      // anything is captured), then never again — so it never re-pops jarringly.
      showWelcome: !seen && total === 0,
      show: false,
      dismissed,
      aiModelsReady: true,
      // enrichedCount/enrichmentPending are REAL now (embedded vs pending) — the
      // MindscapeView "data ready → Generate" gate + the guide's import progress
      // read these. messageCount drives hasImportedData.
      steps: { data: { messageCount: total, enrichedCount: embedded, enrichmentPending: pending } },
    });
  });

  // ── Enrichment (embedding backlog) status/trigger/progress ──────────────────
  // The OnboardingGuide + MindscapeView poll these to show "embedding N/M" and to
  // kick a drain. Thin wrappers over the in-process drainer (no separate pipeline)
  // — the drainer already embeds on a timer; trigger just nudges it now.
  router.get('/enrichment/status', async (_req, res) => {
    const { total, embedded, pending } = await embedCounts();
    ok(res, {
      messages: { total, enriched: embedded, embedded, pending },
      service: { rate: '0' }, // per-second throughput not measured in V1
      activeJob: pending > 0 ? { id: 'enrich', status: 'running' } : null,
    });
  });

  router.post('/enrichment/trigger', async (_req, res) => {
    nudgeEnrichDrainer(); // kick a drain cycle now; no-op if the drainer isn't up
    ok(res, { jobId: 'enrich' });
  });

  router.get('/enrichment/progress/:jobId', async (_req, res) => {
    const { total, embedded, pending } = await embedCounts();
    ok(res, {
      id: 'enrich',
      status: pending > 0 ? 'running' : 'done',
      step: embedded,
      totalSteps: total,
      // UI parses "(\d[\d,]*)\s*/\s*(\d[\d,]*)" out of stageLabel for the bar.
      stageLabel: `Embedding: ${embedded.toLocaleString()} / ${total.toLocaleString()}`,
      error: null,
    });
  });

  // ── Import preview — the onboarding "See your mind" evidence card ───────────
  // A leak-safe AGGREGATE summary of what's in the vault: counts, date range,
  // sources, people. Reads ONLY plaintext columns (created_at, source,
  // conversation_id are NOT in ENCRYPTED_FIELDS.messages) + COUNT(*); it never
  // touches the encrypted `content`, so nothing sensitive is decrypted or logged.
  // Drives Step 3's "847 messages · 2019–2024 · 3 sources" proof-of-perception.
  router.get('/import/preview', async (_req, res) => {
    try {
      const { total, embedded, pending } = await embedCounts();
      const one = (r) => (r?.results || r || [])[0] || {};
      const rows = (r) => r?.results || r || [];

      const range = one(await db.rawQuery(
        'SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM messages WHERE user_id = ?', [userId]));
      const srcRows = rows(await db.rawQuery(
        `SELECT source, COUNT(*) AS c FROM messages WHERE user_id = ? AND source IS NOT NULL
           GROUP BY source ORDER BY c DESC LIMIT 12`, [userId]));
      const convRow = one(await db.rawQuery(
        `SELECT COUNT(DISTINCT conversation_id) AS c FROM messages
           WHERE user_id = ? AND conversation_id IS NOT NULL`, [userId]));
      let peopleCount = 0;
      try {
        peopleCount = Number(one(await db.rawQuery(
          'SELECT COUNT(*) AS c FROM people WHERE user_id = ?', [userId])).c ?? 0);
      } catch { /* people table empty/absent → 0 */ }

      const yearOf = (ts) => { const y = String(ts || '').slice(0, 4); return /^\d{4}$/.test(y) ? Number(y) : null; };
      ok(res, {
        messageCount: total,
        embedded, pending,
        dateRange: {
          earliest: range.earliest || null,
          latest: range.latest || null,
          yearStart: yearOf(range.earliest),
          yearEnd: yearOf(range.latest),
        },
        sources: srcRows.map((r) => ({ source: r.source, count: Number(r.c || 0) })),
        sourceCount: srcRows.length,
        conversationCount: Number(convRow.c || 0),
        peopleCount,
      });
    } catch { fail(res, 500, 'failed to summarize import'); }
  });

  // Mark the onboarding guide dismissed (persisted on the users row so it stays
  // dismissed across reloads). Mirrors the welcome-seen upsert; set fresh each time.
  router.post('/onboarding/dismiss', async (_req, res) => {
    try {
      await db.rawQuery(
        `INSERT INTO users (id, onboarding_dismissed_at) VALUES (?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET onboarding_dismissed_at = datetime('now')`,
        [userId]);
    } catch { /* best-effort — never block the UI on a write */ }
    ok(res, { ok: true });
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
