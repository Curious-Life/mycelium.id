import express from 'express';
import { nudgeEnrichDrainer, pauseEnrichCategorize, resumeEnrichCategorize, isEnrichCategorizePaused } from './enrich/drainer.js';
import { assembleTimelineMessages } from './streams/assemble-messages.js';
import { clampStored } from './enrich/text-limits.js';
import { resolveInferenceConfigForTask } from './inference/resolve.js';
import { createInferenceRouter } from './inference/router.js';
import { isValidHandle } from './identity/identity.js';
import { createUsageSink } from './inference/usage.js';

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
  // GET /documents?pinned=1&folder_id=&limit=&offset= → { documents:[...], total? }
  router.get('/documents', async (req, res) => {
    try {
      const opts = {};
      if (req.query.pinned === '1' || req.query.pinned === 'true') opts.pinnedOnly = true;
      if (typeof req.query.folder_id === 'string' && req.query.folder_id) opts.folderId = req.query.folder_id;
      // Optional pagination — when limit is given, page the decrypt + return a
      // total for infinite scroll. Omitted (e.g. MCP callers) → full set, unchanged.
      const limit = Number(req.query.limit);
      const paged = Number.isFinite(limit) && limit > 0;
      if (paged) {
        opts.limit = Math.min(Math.floor(limit), 500);
        const offset = Number(req.query.offset);
        opts.offset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
      }
      const documents = await db.documents.list(userId, opts);
      const body = { documents };
      if (paged) body.total = await db.documents.count(userId, opts);
      ok(res, body);
    } catch { fail(res); }
  });

  // POST /documents/previews { paths:[...] } → { previews: { path: snippet } }
  // One round-trip for a page of grid cards; each snippet decrypts only the
  // content column (not the whole document). Replaces the per-card full-doc GET.
  router.post('/documents/previews', async (req, res) => {
    try {
      const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 100) : [];
      const previews = {};
      for (const p of paths) {
        if (typeof p !== 'string' || !p) continue;
        previews[decodePath(p)] = await db.documents.contentSnippet(userId, decodePath(p), 600);
      }
      ok(res, { previews });
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
      // Attachment-join + metadata-strip (shared with the Streams river so the two
      // can't drift) — see src/streams/assemble-messages.js.
      const messages = await assembleTimelineMessages(rows, { db, userId });
      ok(res, { messages });
    } catch { ok(res, { messages: [] }); }
  });

  // GET /streams/spectrum?windowDays=7 → { windowDays, days, kinds, sources:[…] }
  // The at-a-glance source spectrum: every source the user has (or has a connector
  // for), with health + a daily volume sparkline. PLAINTEXT-ONLY aggregates — no
  // decryption path (§7 fail-safe). Backed by db.streams.spectrum.
  router.get('/streams/spectrum', async (req, res) => {
    try {
      const raw = parseInt(req.query.windowDays, 10);
      const windowDays = !Number.isFinite(raw) || raw <= 0 ? 7 : Math.min(raw, 90);
      ok(res, await db.streams.spectrum(userId, { windowDays }));
    } catch { ok(res, { windowDays: 7, days: [], kinds: [], sources: [] }); }
  });

  // GET /streams/history → { start, end, days, sources:[{source,kind,total}], series, clamped }
  // The since-start history graph: per-day item counts per canonical source across
  // ALL of history (one stacked bar per day, coloured by source). PLAINTEXT-ONLY
  // aggregates — no decryption path (§7 fail-safe). Backed by db.streams.dailyVolume.
  router.get('/streams/history', async (req, res) => {
    try {
      ok(res, await db.streams.dailyVolume(userId));
    } catch { ok(res, { start: null, end: new Date().toISOString().slice(0, 10), days: [], sources: [], series: {}, clamped: false }); }
  });

  // POST /streams/recover-doc-dates  { sourceType?, apply?, overrides? }
  // Maintenance repair: a 2026-02-16 bulk re-stamp flattened obsidian documents'
  // created_at onto one day, losing their real timeline. The true date survives in
  // each row's plaintext metadata.file_last_modified (mirrored in updated_at); this
  // restores created_at from it. created_at + metadata are plaintext columns, so this
  // is a parameterised UPDATE — no decryption, no encrypted-column writes. Owner-only
  // (the router is single-user/loopback-mounted). Dry-run by default (apply !== true);
  // `overrides` ({path: ISO}) lets a trusted backup manifest supply dates when a row's
  // own metadata is missing one.
  router.post('/streams/recover-doc-dates', async (req, res) => {
    try {
      const apply = req.body?.apply === true;
      const sourceType = typeof req.body?.sourceType === 'string' ? req.body.sourceType : 'obsidian';
      const overrides = (req.body && typeof req.body.overrides === 'object' && req.body.overrides) || {};
      const day = (s) => String(s || '').slice(0, 10);
      const r = await db.rawQuery(
        `SELECT path, created_at, updated_at, metadata FROM documents
          WHERE user_id = ? AND source_type = ? AND forgotten_at IS NULL`, [userId, sourceType]);
      const rows = r.results || r || [];
      const plan = [];
      for (const d of rows) {
        let md = {}; try { md = JSON.parse(d.metadata || '{}'); } catch { /* keep {} */ }
        const cand = overrides[d.path] || md.file_last_modified || d.updated_at;
        if (!cand) continue;
        const t = Date.parse(cand);
        if (Number.isNaN(t)) continue;
        const iso = new Date(t).toISOString();
        // Only ever pull created_at BACK to an earlier real date — the flatten moved
        // dates FORWARD (onto 2026-02-16), so a candidate later than the current
        // created_at is a genuine earlier-creation/later-edit and must be left alone.
        if (day(iso) !== day(d.created_at) && t < Date.parse(d.created_at)) {
          plan.push({ path: d.path, old: d.created_at, neu: iso });
        }
      }
      let applied = 0;
      if (apply) {
        for (const p of plan) {
          await db.rawQuery(`UPDATE documents SET created_at = ? WHERE user_id = ? AND path = ?`, [p.neu, userId, p.path]);
          applied++;
        }
      }
      ok(res, {
        sourceType, scanned: rows.length, planned: plan.length, applied,
        samples: plan.slice(0, 6).map((p) => ({ old: day(p.old), neu: day(p.neu) })),
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // GET /streams?limit&before&since&types=message,document → { items, nextCursor }
  // The unified river: messages + documents + health + tasks interleaved by time.
  // Vector-free + metadata-stripped + §7-guarded in db.streams.feed.
  router.get('/streams', async (req, res) => {
    try {
      const raw = parseInt(req.query.limit, 10);
      const limit = !Number.isFinite(raw) || raw <= 0 ? 40 : Math.min(raw, 100);
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
      const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
      const types = typeof req.query.types === 'string' && req.query.types
        ? req.query.types.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      // q = a keyword substring filter (Phase 2.1). Bounded recent-window search,
      // not semantic; never logged (user plaintext about their own vault).
      const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q : undefined;
      ok(res, await db.streams.feed(userId, { limit, before, since, types, q }));
    } catch { ok(res, { items: [], nextCursor: null }); }
  });

  // ── Profile (Phase P) — read + edit, backed by user_profiles ────────────
  // user_profiles holds the public-facing fields (handle/display_name/signature
  // — plaintext by design, not in ENCRYPTED_FIELDS). Cognitive scores
  // (depth/breadth/coherence/exploration) are pipeline-computed (Tier-2) and stay
  // null until clustering runs. apiGet throws on non-200, so GET must always 200.
  // Handle validation is UNIFIED on the DNS-safe rule in identity.js (isValidHandle:
  // 2-32 chars, a–z0–9 + internal dashes, no leading/trailing dash, NO underscore) so a
  // profile handle is always a valid <handle>.mycelium.id subdomain / did:web label.
  // This layer previously allowed underscores that can never be a hostname (the bug).
  const RESERVED_HANDLES = new Set(['admin', 'api', 'www', 'app', 'mycelium', 'settings', 'profile', 'login', 'support', 'system', 'public', 'auth', 'id']);
  const HANDLE_HINT = '2–32 chars: a–z, 0–9, and dashes (no leading/trailing dash)';

  const countOf = async (fn) => { try { return await fn(); } catch { return 0; } };
  async function readProfile() {
    let row = {};
    try {
      const r = await db.rawQuery(
        `SELECT handle, display_name, signature, avatar_url,
                public_space_enabled, public_bio,
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
      signature: row.signature || null,
      // Public Space (#19): the enable flag + the intentionally-public bio.
      public_space_enabled: row.public_space_enabled ? 1 : 0,
      public_bio: row.public_bio || null,
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
    if (!isValidHandle(h)) return ok(res, { available: false, reason: HANDLE_HINT });
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
        if (!isValidHandle(h)) return fail(res, 400, `invalid handle (${HANDLE_HINT})`);
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
      // Public Space (#19): enable flag (0/1) + the public bio (free text, bounded).
      if (body.public_space_enabled !== undefined) { sets.push('public_space_enabled = ?'); params.push(body.public_space_enabled ? 1 : 0); }
      if (typeof body.public_bio === 'string') { sets.push('public_bio = ?'); params.push(clampStored(body.public_bio)); }
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
  // Online/offline presence for accepted remote connections (pull-on-demand, cached
  // ~45s). Returns { presence: { [connectionId]: 'online'|'offline'|'none' } }.
  // Literal path registered BEFORE /connections/:id so it isn't captured as id.
  router.get('/connections/presence', async (_req, res) => {
    try { ok(res, { presence: await db.connections.queryPresence(userId) }); }
    catch { ok(res, { presence: {} }); }
  });
  // Combined People nav badge: pending invites + unread direct messages + unseen
  // inbound shares. One poll drives the single dot next to "People".
  router.get('/people/badge', async (_req, res) => {
    const [invites, unread, newShares] = await Promise.all([
      db.connections.pending(userId).then((r) => r.length).catch(() => 0),
      db.connections.unreadMessages(userId).then((u) => u.total).catch(() => 0),
      db.inboundShares.unseenCount().catch(() => 0),
    ]);
    ok(res, { invites, unread, newShares, total: invites + unread + newShares });
  });
  // Mark all inbound shares seen (called when the Shared view is opened) → clears
  // the "new share" part of the badge.
  router.post('/inbound-shares/seen', async (_req, res) => {
    try { await db.inboundShares.markAllSeen(); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not mark seen'); }
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
  // Toggle whether I expose my online status to this connection (per-peer revoke /
  // re-grant). Default is shared; this turns the green/grey dot off for the peer.
  router.put('/connections/:id/presence', async (req, res) => {
    try { await db.connections.setPresenceShare(userId, connId(req), req.body?.share === true); ok(res, { ok: true }); }
    catch (e) { fail(res, 400, e.message || 'could not update presence sharing'); }
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
      // INBOUND: what this peer shared WITH me (federation sharing, grantee side).
      // Populated by the signed share-announce (Phase 2); names decrypt here.
      let inbound = [];
      try { inbound = (await db.inboundShares.listForConnection(cid)).map((s) => ({ id: s.id, kind: s.kind, name: s.name, role: s.role, granted_at: s.granted_at })); } catch {}
      ok(res, { peer_id: peerId, spaces, contexts, inbound });
    } catch { ok(res, { peer_id: null, spaces: [], contexts: [], inbound: [] }); }
  });

  // View the CONTENTS of a share a peer granted me (federation sharing Phase 3).
  // Drives the signed, grant-gated content fetch from THEIR instance + verifies
  // their signature on the response. Read-only; the content is never stored here.
  router.get('/connections/:id/shared/:shareId/contents', async (req, res) => {
    const cid = connId(req);
    const shareId = decodePath(req.params.shareId);
    try {
      const share = await db.inboundShares.get(shareId);
      // Bind the share to the connection in the URL (no cross-connection access).
      if (!share || share.connection_id !== cid || share.revoked) return fail(res, 404, 'share not found');
      const content = await db.connections.fetchSharedContent(userId, cid, { kind: share.kind, ref: share.remote_ref });
      await db.inboundShares.markSeen(shareId).catch(() => {});
      ok(res, { content });
    } catch (e) { fail(res, 502, e.message || 'could not load shared content'); }
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
      const conn = conns.find((c) => c.other_user_id === granteeId);
      if (!conn) return fail(res, 400, 'grantee must be an accepted connection');
      await db.spaceAccess.grant(id, granteeId, role, userId);
      // best-effort Megolm-room invite (no-op until Matrix is configured)
      spaceSync?.syncGrant(id, granteeId, userId).catch(() => {});
      // Announce the grant to the peer's instance → appears in their "Shared with
      // you" + lights their People badge (federation sharing Phase 2).
      try { const sp = await db.spaces.get(id); db.connections.announceShare(userId, conn.id, { kind: 'space', ref: id, name: sp?.name || sp?.display_name || null, role, action: 'grant' }).catch(() => {}); } catch {}
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
      try { const conns = await db.connections.list(userId); const conn = conns.find((c) => c.other_user_id === granteeId); if (conn) db.connections.announceShare(userId, conn.id, { kind: 'space', ref: id, action: 'revoke' }).catch(() => {}); } catch {}
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
    const cn = decodePath(req.params.connId);
    try {
      await db.contexts.grant(id, cn);
      // Announce to the peer's instance (federation sharing Phase 2). Only NON-private
      // contexts are ever exposed cross-instance, mirroring canSeeTerritory.
      try {
        const c = (await db._base.d1Query(`SELECT name, is_private FROM sharing_contexts WHERE id = ? AND user_id = ?`, [id, userId])).results?.[0];
        if (c && !c.is_private) db.connections.announceShare(userId, cn, { kind: 'context', ref: id, name: c.name || null, action: 'grant' }).catch(() => {});
      } catch {}
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not grant'); }
  });
  router.delete('/contexts/:id/grant/:connId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    const cn = decodePath(req.params.connId);
    try {
      await db.contexts.revoke(id, cn);
      db.connections.announceShare(userId, cn, { kind: 'context', ref: id, action: 'revoke' }).catch(() => {});
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not revoke'); }
  });

  // ── Context Areas (#19): documents + AI summary lens on a sharing_context ──
  router.get('/contexts/:id/documents', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { ok(res, { documents: await db.contexts.getDocuments(id) }); } catch { ok(res, { documents: [] }); }
  });
  router.post('/contexts/:id/documents', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    const path = String(req.body?.path || '').trim();
    if (!path) return fail(res, 400, 'path required');
    try { await db.contexts.addDocument(id, path); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not attach document'); }
  });
  router.delete('/contexts/:id/documents/:path', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try { await db.contexts.removeDocument(id, decodePath(req.params.path)); ok(res, { ok: true }); }
    catch { fail(res, 500, 'could not remove document'); }
  });
  // POST /contexts/:id/summary → synthesize a high-level summary of the area's
  // documents via the user's active model (inline). Encrypted at rest on write.
  router.post('/contexts/:id/summary', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardContext(res, id))) return;
    try {
      const docs = await db.contexts.getDocuments(id);
      if (!docs.length) return fail(res, 400, 'attach documents to this area first');
      const provider = await resolveInferenceConfigForTask(db, userId, 'summarize');
      if (!provider || (!provider.anthropicApiKey && !provider.openaiApiKey && !provider.baseUrl && !provider.cloudModel && !process.env.OLLAMA_URL)) {
        return fail(res, 503, 'no AI model is connected — connect one in Settings → Intelligence');
      }
      // Prompt from each doc's title + summary (fall back to a truncated content
      // peek). Bounded so a huge area can't overflow a small local model.
      const parts = docs.slice(0, 40).map((d) => `- ${d.title || d.path}${d.summary ? `: ${String(d.summary).slice(0, 400)}` : ''}`);
      const prompt = `Write a 2-3 sentence high-level summary of this area of someone's life, based on the documents in it. Be concise and concrete.\n\nArea documents:\n${parts.join('\n')}`;
      const router2 = createInferenceRouter({ ...provider, onUsage: createUsageSink(db, userId, { source: 'context-area' }) });
      const summary = (await router2.infer({ prompt, task: 'summarize', maxTokens: 400 })).trim();
      await db.contexts.setSummary(userId, id, summary);
      ok(res, { ok: true, summary });
    } catch (e) { fail(res, 500, e.message || 'could not generate summary'); }
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
    // PURE (not cached): feeds /onboarding/status showWelcome (`total === 0`), a
    // read-after-import correctness check — a stale 0 here would keep the welcome
    // screen up after the user imports. These compat endpoints are not the hot
    // pollers (the activity feed @2.5s is, and uses the cached accessor); on an
    // empty/onboarding vault this scan is instant (0 rows), and by the time the
    // table is large onboarding is long done.
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

  // ── Categorization (Context Engine L1) control + progress ───────────────────
  // The on-box-model tagging pass is the "my computer is working a lot" churn. These
  // let the owner SEE it (count + paused state), STOP it (pause), and START it
  // (resume → nudge, or trigger). Progress also shows in the unified activity feed
  // ('Sorting your messages · N / M'); this is the explicit control surface.
  router.get('/enrichment/categorize/status', async (_req, res) => {
    const { tagged, total, pending } = await db.messages.categoriesBacklogCached(userId);
    ok(res, {
      messages: { total, tagged, pending },
      paused: isEnrichCategorizePaused(),
      status: isEnrichCategorizePaused() ? 'paused' : (pending > 0 ? 'running' : 'idle'),
      stageLabel: `Sorting: ${tagged.toLocaleString()} / ${total.toLocaleString()}`,
    });
  });

  router.post('/enrichment/categorize/pause', async (_req, res) => {
    pauseEnrichCategorize();
    ok(res, { paused: true });
  });

  router.post('/enrichment/categorize/resume', async (_req, res) => {
    resumeEnrichCategorize(); // clears the flag + kicks a cycle so progress moves at once
    ok(res, { paused: false });
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
