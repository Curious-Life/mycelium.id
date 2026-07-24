import express from 'express';
import { createReadiness } from './readiness.js';
import { getEmbedderHealth, getEmbedSupervisor } from './embed/supervisor.js';
import { nudgeEnrichDrainer, resetPullBackoff, resetEnrichGiveUpCounters, pauseEnrichProcessing, resumeEnrichProcessing, pauseEmbed, resumeEmbed, pauseCategorize, resumeCategorize, isCategorizePaused, defaultLabelModel } from './enrich/drainer.js';
import { assembleTimelineMessages } from './streams/assemble-messages.js';
import { clampStored } from './enrich/text-limits.js';
import { resolveInferenceConfigForTask } from './inference/resolve.js';
import { createInferenceRouter } from './inference/router.js';
// The ONE handle writer + the ONE authoritative read. Validation (isValidHandle),
// the single reserved list, the control-plane availability check and the claim all
// live there — this router never touches user_profiles.handle itself.
import { setHandle, checkAvailability, currentHandle, pendingHandle, mirrorProfileHandle } from './identity/handle-service.js';
import { computeContentHash, validatePath, SaveDocumentError } from './core/document-store.js';
import { resolveKeyAgreementKey } from './federation/did.js';
import { applyShareGrant, applyShareRevoke } from './federation/space-membership.js';
import { mirrorKnowledgeWrite, mirrorKnowledgeDelete } from './federation/space-content-mirror.js';
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
export function portalCompatRouter({ db, userId, readiness: injected }) {
  // The ONE readiness model, injected by server-rest so every consumer shares one answer
  // and one warm cache. Fallback keeps standalone verify scripts working.
  const readiness = injected || createReadiness({ db, userId, embedderHealth: getEmbedderHealth });
  if (!db) throw new Error('portalCompatRouter: db required');
  // Shared-space membership + content cross-box sync is handled by the E2E system
  // (space-membership.js applyShareGrant/Revoke + space-content-mirror.js, over the
  // ciphertext oplog), wired into the grant/revoke/knowledge handlers below.
  const router = express.Router();
  router.use(express.json({ limit: process.env.MYCELIUM_API_BODY_LIMIT || '64mb' }));

  const ok = (res, body) => res.json(body);
  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });
  const decodePath = (raw) => { try { return decodeURIComponent(raw); } catch { return raw; } };

  // Library search is a bounded decrypt-scan (title/summary are encrypted at
  // rest, so SQL can't filter them). Scan at most this many most-recent docs.
  const SEARCH_SCAN_CAP = 3000;

  // ── Library: documents ─────────────────────────────────────────────────
  // GET /documents?pinned=1&folder_id=&limit=&offset= → { documents:[...], total? }
  router.get('/documents', async (req, res) => {
    try {
      const folderOpts = {};
      if (req.query.pinned === '1' || req.query.pinned === 'true') folderOpts.pinnedOnly = true;
      if (typeof req.query.folder_id === 'string' && req.query.folder_id) folderOpts.folderId = req.query.folder_id;

      // Optional pagination — when limit is given, page the decrypt + return a
      // total for infinite scroll. Omitted (e.g. MCP callers) → full set, unchanged.
      const limit = Number(req.query.limit);
      const paged = Number.isFinite(limit) && limit > 0;
      const pageLimit = paged ? Math.min(Math.floor(limit), 500) : null;
      const offsetN = Number(req.query.offset);
      const offset = Number.isFinite(offsetN) && offsetN > 0 ? Math.floor(offsetN) : 0;

      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 200) : '';
      if (q) {
        // title/summary are encrypted at rest → search can't filter in SQL.
        // Decrypt-scan the most-recent SEARCH_SCAN_CAP rows (same pattern as
        // /portal/attachments) and filter in JS on the decrypted path/title/
        // summary. One bounded request — vastly cheaper than the client loading
        // the entire vault just to search. Covers the most-recent cap; older
        // docs fall outside the search window (acceptable for a personal vault).
        const scanned = await db.documents.list(userId, { ...folderOpts, limit: SEARCH_SCAN_CAP, offset: 0 });
        const matched = scanned.filter((d) => `${d.path || ''}\n${d.title || ''}\n${d.summary || ''}`.toLowerCase().includes(q));
        const documents = pageLimit != null ? matched.slice(offset, offset + pageLimit) : matched;
        return ok(res, { documents, total: matched.length });
      }

      const opts = { ...folderOpts };
      if (paged) { opts.limit = pageLimit; opts.offset = offset; }
      const documents = await db.documents.list(userId, opts);
      const body = { documents };
      if (paged) body.total = await db.documents.count(userId, folderOpts);
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
      const { path, title, content, folder_id } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      const doc = {
        user_id: userId, path,
        title: typeof title === 'string' ? title : null,
      };
      // FOOTGUN FIX (hardening P1 step 4): only set `content` when the client
      // actually sent a string. The old `content: ... : ''` fallback meant a
      // metadata-only update (rename/pin/autosave that omits content) UPDATEd
      // content='' on conflict → silent whole-document wipe. Omitting the column
      // leaves the upsert's ON CONFLICT SET without it → content preserved. When
      // content IS provided, compute content_hash inline (matching the canonical
      // saveDocument boundary) so portal writes get dedup/change-detection too.
      if (typeof content === 'string') {
        doc.content = content;
        doc.content_hash = computeContentHash(content);
      }
      // Only set folder_id when the client sent it (create / move) so an
      // autosave — which omits it — never clobbers the doc's folder on conflict.
      if (folder_id !== undefined) doc.folder_id = folder_id === null ? null : String(folder_id);
      const row = await db.documents.upsert(doc);
      ok(res, { ok: true, document: row });
    } catch (e) {
      // Surface a NON-sensitive error code (e.g. SQLITE_CORRUPT / SQLITE_FULL)
      // so the client shows WHY a write failed instead of dropping it silently.
      // Never include the error message — it can echo document content.
      fail(res, 500, e?.code || e?.name || 'document write failed');
    }
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

  // POST /documents/rename → { path, title } — sets the display title only
  // (path is the stable identity; never changed here). Dedicated route so a
  // rename can't accidentally wipe content the way the upsert route would.
  router.post('/documents/rename', async (req, res) => {
    try {
      const { path, title } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      if (typeof title !== 'string' || !title.trim()) return fail(res, 400, 'title required');
      const row = await db.documents.setTitle(userId, path, title.trim().slice(0, 500));
      if (!row) return fail(res, 404, 'document not found');
      ok(res, { ok: true, document: row });
    } catch { fail(res); }
  });

  // POST /documents/rename-path → { path, new_path } — change the slug / ?doc= id.
  // Distinct from /rename (title): this moves the document's IDENTITY and atomically
  // cascades every FK-less path reference (see DOCUMENT-SLUG-RENAME-DESIGN). public_slug
  // is independent, so published/shared URLs are unaffected.
  router.post('/documents/rename-path', async (req, res) => {
    try {
      const { path, new_path: newPath } = req.body || {};
      if (typeof path !== 'string' || !path) return fail(res, 400, 'path required');
      if (typeof newPath !== 'string' || !newPath.trim()) return fail(res, 400, 'new_path required');
      const target = newPath.trim();
      // Reuse the canonical create-path validator (empty/length/slash/traversal/null) so
      // the slug rules can't drift from creation. 'portal' source = no reserved-prefix gate.
      try { validatePath(target, 'portal'); }
      catch (e) { if (e instanceof SaveDocumentError) return fail(res, 400, e.code || 'invalid_path'); throw e; }
      const row = await db.documents.renamePath(userId, path, target);
      ok(res, { ok: true, document: row });
    } catch (e) {
      // Map the renamePath sentinels; never echo content.
      if (e?.message === 'RENAME_CONFLICT') return fail(res, 409, 'a document with that link already exists');
      if (e?.message === 'RENAME_NOT_FOUND') return fail(res, 404, 'document not found');
      if (e?.message === 'RENAME_BAD_PATH') return fail(res, 400, 'new_path required');
      fail(res, 500, e?.code || e?.name || 'rename failed');
    }
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

  // POST /folders { name, parent_id? } → create a Library folder (or sub-folder).
  // The db.folders namespace already exists (+ fires the live-SSE hooks); this is
  // the missing write route — without it LibraryNav's "New folder" POSTs into the
  // void and fails silently. parent_id is a folder UUID; null/absent = top level.
  router.post('/folders', async (req, res) => {
    try {
      if (!db.folders?.create) return fail(res, 500, 'folders unavailable');
      const name = String(req.body?.name || '').trim().slice(0, 200);
      if (!name) return fail(res, 400, 'name required');
      const parentId = req.body?.parent_id ? String(req.body.parent_id) : null;
      // Scope the parent to the caller (fail-closed): a foreign/nonexistent parent
      // is rejected rather than silently creating an orphan under someone else's id.
      if (parentId && db.folders.findById && !(await db.folders.findById(userId, parentId))) {
        return fail(res, 400, 'parent not found');
      }
      const folder = await db.folders.create(userId, name, parentId);
      ok(res, { ok: true, folder });
    } catch { fail(res, 500, 'could not create folder'); }
  });

  // PUT /folders/:id { name } → rename.
  router.put('/folders/:id', async (req, res) => {
    try {
      if (!db.folders?.rename) return fail(res, 500, 'folders unavailable');
      const name = String(req.body?.name || '').trim().slice(0, 200);
      if (!name) return fail(res, 400, 'name required');
      // Ownership check — rename is user-scoped in SQL, but reject unknown ids loudly.
      if (db.folders.findById && !(await db.folders.findById(userId, req.params.id))) {
        return fail(res, 404, 'folder not found');
      }
      await db.folders.rename(userId, req.params.id, name);
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not rename folder'); }
  });

  // DELETE /folders/:id → remove the folder (documents move to no-folder, child
  // folders re-parent to the deleted folder's parent — handled in db.folders.delete).
  router.delete('/folders/:id', async (req, res) => {
    try {
      if (!db.folders?.delete) return fail(res, 500, 'folders unavailable');
      await db.folders.delete(userId, req.params.id);
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not delete folder'); }
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
  // HANDLE: this router is NOT a writer. `user_profiles.handle` is a DERIVED
  // MIRROR of firstLabel(remote.json publicHost) — see src/identity/handle-service.js
  // for why (a bare `UPDATE user_profiles SET handle=?` here used to be COSMETIC:
  // no claim, no DNS, no did:web, and the Profile screen then advertised a
  // <handle>.mycelium.id that did not exist). Validation, the reserved list, the
  // availability check and the claim all live in the ONE setter.

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
    // handle is DERIVED from the authoritative store (publicHost), never read from
    // the row — the row is only a mirror and a stale one would re-create the exact
    // divergence this unification removes. `pending_handle` is a name the owner
    // picked that is not claimed yet; the UI must render it as NOT yet live.
    const handle = currentHandle();
    return {
      display_name: row.display_name || 'You',
      handle,
      handle_claimed: handle ? 1 : 0,
      pending_handle: handle ? null : pendingHandle(),
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
  // Hits the CONTROL PLANE — the only authority. It used to query the LOCAL
  // user_profiles table, which in a single-user vault says "available" for every
  // name on earth, so onboarding promised handles the relay then 409'd.
  // FAIL CLOSED: unreachable → available:false with a distinguishable reason.
  router.get('/profile/handle/check', async (req, res) => {
    ok(res, await checkAvailability(req.query.handle));
  });

  // PUT /profile → update handle / display_name / signature → { ok, profile }
  router.put('/profile', async (req, res) => {
    try {
      const body = req.body || {};
      const sets = [], params = [];
      // HANDLE → delegate to the ONE setter (claim + publicHost + mirror). We never
      // write `handle` into `sets` — that bare UPDATE was the cosmetic-handle bug.
      // A failed claim is IDENTITY-AFFECTING: surface it, never swallow it.
      let handleResult = null;
      if (typeof body.handle === 'string') {
        try {
          handleResult = await setHandle({
            handle: body.handle,
            mirror: (h) => mirrorProfileHandle(db, userId, h),
          });
        } catch (e) {
          const st = Number.isInteger(e?.status) ? e.status : 400;
          return fail(res, st, e?.message || 'could not set that handle');
        }
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
      if (!sets.length && !handleResult) return fail(res, 400, 'nothing to update');
      if (sets.length) {
        await ensureRow();
        await db.rawQuery(`UPDATE user_profiles SET ${sets.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`, [...params, userId]);
      }
      // `handle` echoes the setter's honest outcome: claimed (live address, needs a
      // restart for the signing identity) vs recorded-but-not-claimed.
      ok(res, { ok: true, profile: await readProfile(), ...(handleResult ? { handle: handleResult } : {}) });
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
      // E2E (O3-HOOK): mirror into the ciphertext oplog so grantees can fetch + decrypt it.
      mirrorKnowledgeWrite(db, id, entryId, content, { log: (m) => console.error(m) }).catch(() => {});
      ok(res, { ok: true, id: entryId });
    } catch { fail(res, 500, 'could not add knowledge'); }
  });
  router.delete('/spaces/:id/knowledge/:entryId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'contributor'))) return;
    try {
      const entryId = decodePath(req.params.entryId);
      await db.spaceKnowledge.revoke(entryId, id);
      mirrorKnowledgeDelete(db, id, entryId, { log: (m) => console.error(m) }).catch(() => {}); // E2E tombstone
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not remove knowledge'); }
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
        if (t) {
          const c = t.essence || t.name || '';
          const eid = await db.spaceKnowledge.add(id, c, userId, String(tid), 'territory', 'all', null);
          mirrorKnowledgeWrite(db, id, eid, c, { log: (m) => console.error(m) }).catch(() => {}); // E2E mirror
        }
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
      mirrorKnowledgeWrite(db, id, entryId, content, { log: (m) => console.error(m) }).catch(() => {}); // E2E mirror
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
      // Announce the grant to the peer's instance → appears in their "Shared with
      // you" + lights their People badge (federation sharing Phase 2).
      try { const sp = await db.spaces.get(id); db.connections.announceShare(userId, conn.id, { kind: 'space', ref: id, name: sp?.name || sp?.display_name || null, role, action: 'grant' }).catch(() => {}); } catch {}
      // E2E (BU-REKEY): seal the space CEK to the new member's X25519 key so they can
      // decrypt. Best-effort — the access grant + announce stand even if the peer is
      // unreachable; the seal retries on a future grant. Confidentiality never depends on it.
      applyShareGrant({ db, spaceId: id, memberDid: conn.remote_did, resolveKey: (d) => resolveKeyAgreementKey(d), log: (m) => console.error(m) }).catch(() => {});
      ok(res, { ok: true });
    } catch { fail(res, 500, 'could not share space'); }
  });
  router.delete('/spaces/:id/shares/:granteeId', async (req, res) => {
    const id = decodePath(req.params.id);
    if (!(await guardSpace(res, id, 'creator'))) return;
    try {
      const granteeId = decodePath(req.params.granteeId);
      await db.spaceAccess.revoke(id, granteeId);
      // E2E (BU-REKEY): rekey the space so the evicted peer can't read content written
      // after revocation (forward secrecy). Survivors = the REMAINING members (post-revoke)
      // mapped to their connections' DIDs; the allowlist rekey seals a fresh CEK only to
      // them + the owner. Best-effort + fail-closed: an unresolvable survivor is skipped
      // (re-syncs on next grant), and confidentiality holds regardless.
      try {
        const [remaining, conns] = await Promise.all([db.spaceAccess.list(id), db.connections.list(userId)]);
        const didFor = (uid) => conns.find((c) => c.other_user_id === uid)?.remote_did || null;
        const survivorDids = remaining.map((m) => didFor(m.user_id)).filter(Boolean);
        const removedDid = didFor(granteeId);
        const conn = conns.find((c) => c.other_user_id === granteeId);
        if (conn) db.connections.announceShare(userId, conn.id, { kind: 'space', ref: id, action: 'revoke' }).catch(() => {});
        // AWAIT the rekey (forward-secrecy enforcement) and SURFACE a failure rather than
        // swallowing it (review F2): a silent failure would leave new writes under the gen
        // the evicted peer still holds. applyShareRevoke never throws — it returns a status.
        const rev = await applyShareRevoke({ db, spaceId: id, removedDid, survivorDids, resolveKey: (d) => resolveKeyAgreementKey(d), log: (m) => console.error(m) });
        if (rev && rev.rekeyed === false && rev.reason === 'rekey-failed') {
          console.error(`[spaces] revoke for ${id}: access removed but key rotation PENDING — re-drive the rekey (authz 403 still blocks the evicted peer meanwhile)`);
        }
      } catch {}
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
      // 'summarize' is a LOCAL task (router LOCAL_TASKS) → it ALWAYS runs on-box,
      // regardless of any active cloud provider. So the on-box model must be one the
      // owner APPROVED (#148 consent) — resolve it and require it. Without this the
      // router fails open to DEFAULT_LOCAL_MODEL (llama3.1) and silently runs a model
      // the owner never consented to. `defaultLabelModel` is the single #148 reader
      // (settings.taskModels.categorize.model); null ⇒ refuse honestly (503 below).
      const localModel = await defaultLabelModel(db, userId);
      const router2 = createInferenceRouter({ ...provider, localModel, requireApprovedLocal: true, onUsage: createUsageSink(db, userId, { source: 'context-area' }) });
      const summary = (await router2.infer({ prompt, task: 'summarize', maxTokens: 400 })).trim();
      await db.contexts.setSummary(userId, id, summary);
      ok(res, { ok: true, summary });
    } catch (e) {
      // Honest surface for the consent refusal: no on-box model approved → 503 that
      // points at Settings → Intelligence, NOT a generic 500 (and NOT a summary
      // fabricated by an un-approved model).
      if (e?.code === 'no-approved-local-model') {
        return fail(res, 503, 'no on-box model is approved — approve one in Settings → Intelligence');
      }
      fail(res, 500, e.message || 'could not generate summary');
    }
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
    catch { return { total: 0, embedded: 0, pending: 0, unprocessable: 0, gaveUp: 0 }; }
  }

  router.get('/onboarding/status', async (_req, res) => {
    const { total, embedded, pending, unprocessable } = await embedCounts();
    // The embedder's REAL state, from the one readiness model. Cached slice: this endpoint
    // is polled (MindscapeView @5s) and the pure scan is a multi-second SQLCipher decrypt.
    let embedderUp = false;
    try { embedderUp = (await readiness.get({ slices: ['embedder'] })).embedder.up; } catch { /* fail-closed: not ready */ }
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
      // aiModelsReady was HARDCODED `true` — one of the disagreeing facts the readiness
      // model exists to end (DATA-READINESS-DESIGN §2.8 #4): MindscapeView trusted it (so
      // `aiReady` was ALWAYS true and auto-generate fired into a dead embedder), while
      // OnboardingFlow ignored it and queried /providers instead. Now it is measured.
      // Operator decision D3 accepts the behaviour change: auto-generate stops firing on a
      // box whose embedder is down — which is correct, and was the point.
      aiModelsReady: embedderUp,
      // enrichedCount/enrichmentPending are REAL now (embedded vs pending) — the
      // MindscapeView "data ready → Generate" gate + the guide's import progress
      // read these. messageCount drives hasImportedData.
      steps: { data: { messageCount: total, enrichedCount: embedded, enrichmentPending: pending, enrichmentUnprocessable: unprocessable } },
    });
  });

  // ── Retry the embedder (the bundled Nomic model) ────────────────────────────
  // THE fresh-install un-hang. The embedder is NOT infallibly "bundled + ok": it
  // downloads its ONNX weights from HuggingFace at first load (embed-service.py
  // _load_model → hf_hub_download nomic-embed-text-v1.5). That download can fail
  // (network/HF/disk), the deps can be missing (dev), or the restart governor can
  // HALT after repeated crashes — and a dead embedder means the drainer embeds
  // nothing → Generate preflight 409s forever → "Processing 0/N" with no escape.
  // This is the user's escape hatch, wired to the ONE resume path:
  //   • embedSup.nudge()  — resumes a halted governor + forces an immediate
  //                         re-evaluate (adopt/deps-recheck/respawn as needed).
  //   • nudgeEnrichDrainer() — kicks a drain so a live-but-'error' service gets an
  //                         /embed that re-calls _load_model() → re-downloads now.
  // Best-effort + fail-SAFE: nudge is never awaited to a success (the download is
  // async on the service side), and a null supervisor (verify/injected-keys boot)
  // is a no-op — we NEVER claim a retry succeeded. The response reflects REAL
  // health from the one source, so the UI shows the true state (still loading /
  // deps_missing with the actionable hint / recovered), never a fake ✓.
  router.post('/embed/retry', (_req, res) => {
    try { getEmbedSupervisor()?.nudge?.(); } catch { /* best-effort — nudge must never throw the route */ }
    try { nudgeEnrichDrainer(); } catch { /* best-effort — a nudge is a hint, not a contract */ }
    ok(res, { ok: true, health: getEmbedderHealth() });
  });

  // ── Enrichment (embedding backlog) status/trigger/progress ──────────────────
  // The OnboardingGuide + MindscapeView poll these to show "embedding N/M" and to
  // kick a drain. Thin wrappers over the in-process drainer (no separate pipeline)
  // — the drainer already embeds on a timer; trigger just nudges it now.
  router.get('/enrichment/status', async (_req, res) => {
    const { total, embedded, pending, unprocessable, gaveUp } = await embedCounts();
    ok(res, {
      // `unprocessable` — content-bearing rows that are neither embedded nor queued
      // (poison / blank-skip / attempt-capped). Carried so a client can SAY SO instead
      // of the counter silently omitting them: before the counted-pending fix they
      // inflated `pending` forever ("Embedding N of M" that never finished); without
      // this field the fix would merely make them vanish. A COUNT ONLY — the reason
      // stays in nlp_error and is never surfaced here (§1: no per-message failure
      // patterns over HTTP).
      // `gaveUp` — the attempt-capped subset of unprocessable (rows retired after
      // EMBED_MAX_ATTEMPTS counted failures against a healthy service). Surfaced
      // separately because these are RECOVERABLE: POST /portal/enrichment/retry-failed
      // re-queues them. Also a count only.
      messages: { total, enriched: embedded, embedded, pending, unprocessable, gaveUp },
      service: { rate: '0' }, // per-second throughput not measured in V1
      activeJob: pending > 0 ? { id: 'enrich', status: 'running' } : null,
    });
  });

  // ── Retry the gave-up rows (embed attempt-capped + label gave-up) ────────────
  // The user-facing recovery path for the terminal states the bounded-retry
  // safeguards introduce (enrich/service.js EMBED_MAX_ATTEMPTS / LABEL_MAX_ATTEMPTS):
  // resets 'embed-capped' rows and categories_processed = -1 rows back to pending,
  // clears every attempt counter (persisted markers via the DAL; the in-memory L1
  // counters via the drainer), then kicks a drain cycle so progress starts now.
  // Response carries COUNTS ONLY — never content, ids, or error strings (§1).
  router.post('/enrichment/retry-failed', async (_req, res) => {
    let reset;
    try { reset = await db.messages.resetEnrichmentGiveUps(userId); }
    catch { return fail(res, 500, 'could not reset failed rows'); }
    resetEnrichGiveUpCounters(); // fresh in-memory budgets (no-op if no drainer runs)
    nudgeEnrichDrainer();
    ok(res, { reset: { embed: reset.embedReset, label: reset.labelReset } });
  });

  router.post('/enrichment/trigger', async (_req, res) => {
    // The owner's explicit "process/try again": clear the pull-failure backoff FIRST so a model
    // download that gave up (storm fix, 2026-07-17) is retried NOW, then kick a cycle. Safe to
    // couple: this route's only callers are user-initiated buttons — automated paths (chat/import
    // saves) go through enqueueEnrichment/nudge, which deliberately does NOT touch the backoff.
    resetPullBackoff();
    nudgeEnrichDrainer(); // kick a drain cycle now; no-op if the drainer isn't up
    ok(res, { jobId: 'enrich' });
  });

  router.get('/enrichment/progress/:jobId', async (_req, res) => {
    const { total, embedded, pending, unprocessable } = await embedCounts();
    // The bar counts the PROCESSABLE set (embedded + pending), not every message.
    // `status` comes off `pending`, so the two must share a basis: with `total` as the
    // denominator, a vault holding un-embeddable rows would report status:'done' over a
    // stageLabel of "2 / 4" — a half-full bar announcing completion. (Consistent before
    // the counted-pending fix only because BOTH were wrong.) embedded + pending is the
    // work that can actually be done, so step === totalSteps exactly when pending hits 0.
    const processable = embedded + pending;
    ok(res, {
      id: 'enrich',
      status: pending > 0 ? 'running' : 'done',
      step: embedded,
      totalSteps: processable,
      // UI parses "(\d[\d,]*)\s*/\s*(\d[\d,]*)" out of stageLabel for the bar.
      stageLabel: `Embedding: ${embedded.toLocaleString()} / ${processable.toLocaleString()}`,
      total,             // every embeddable message, for context
      unprocessable,     // count ONLY — the reason lives in nlp_error (encrypted)
      error: null,
    });
  });

  // ── Categorization (Context Engine L1) control + progress ───────────────────
  // The on-box-model tagging pass is the "my computer is working a lot" churn. These
  // let the owner SEE it (count + paused state), STOP it (pause), and START it
  // (resume → nudge, or trigger). Progress also shows in the unified activity feed
  // ('Sorting your messages · N / M'); this is the explicit control surface.
  router.get('/enrichment/categorize/status', async (_req, res) => {
    const { tagged, total, pending, gaveUp = 0 } = await db.messages.categoriesBacklogCached(userId);
    ok(res, {
      // `gaveUp` — rows terminally skipped for labeling after LABEL_MAX_ATTEMPTS
      // counted failures against a working model (categories_processed = -1). A
      // count only; recoverable via POST /portal/enrichment/retry-failed.
      messages: { total, tagged, pending, gaveUp },
      paused: isCategorizePaused(),
      status: isCategorizePaused() ? 'paused' : (pending > 0 ? 'running' : 'idle'),
      stageLabel: `Sorting: ${tagged.toLocaleString()} / ${total.toLocaleString()}`,
    });
  });

  // ── Pause / resume ALL on-box processing (§3.9/R3, D13) ────────────────────
  // Renamed off `/enrichment/categorize/*`: the flag gates the embed drain AND L1+L2, so a
  // path saying "categorize" described one of the three stages it stops — and not the one
  // burning the CPU.
  //
  // ⚠️ PERSIST FIRST, APPLY SECOND, AND REPORT A FAILED WRITE. The pause is persisted (D13:
  // "only restart when you click restart"), so a write that fails while the flag flips in
  // memory produces INVISIBLE divergence: the vault reads paused now and silently resumes on
  // the next restart — the exact silent-undo D13 exists to remove. Refusing to apply is
  // visible and recoverable; applying without persisting is neither. Same rule as E3's
  // /onboarding/reset: a control that cannot keep its promise says so.
  //
  // ⚠️ READ-MODIFY-WRITE: db.users.updateSettings REPLACES THE WHOLE BLOB (portal-hardware.js
  // :115). A bare write of {enrichProcessingPaused} drops taskModels, and with it the model
  // approvals — it has already happened once. Gated by P4.
  // ⚠️ PER-STAGE PERSIST (QA R2). The pause is now split embed vs categorize (drainer.js), so the
  // durable record carries two flags — enrichEmbedPaused / enrichCategorizePaused — plus:
  //   • enrichProcessingPausedAt — the ONE durable "paused since" stamp (readiness.processing reads
  //     it). Set when the FIRST stage pauses; the earliest stamp is preserved while any stage stays
  //     paused; cleared only when NO stage remains paused. There is no per-stage stamp.
  //   • enrichProcessingPaused — the LEGACY composite (BOTH paused). Kept so the old single-flag
  //     reader and verify:processing-pause (P4/P5, which drive the GLOBAL route) stay honest, and so
  //     a downgrade still reads a coherent "all paused" state.
  // Undefined stage args carry the current persisted value forward — a per-stage write must not
  // clobber the sibling stage. Same READ-MODIFY-WRITE + `...s` spread guard as before (P4): a bare
  // write would drop taskModels = the model consent record.
  async function persistPauseState({ embed, categorize } = {}) {
    const s = (await db.users.getSettings(userId)) || {};
    const nextEmbed = embed === undefined ? (s.enrichEmbedPaused === true) : Boolean(embed);
    const nextCat = categorize === undefined ? (s.enrichCategorizePaused === true) : Boolean(categorize);
    const anyPaused = nextEmbed || nextCat;
    const pausedAt = anyPaused ? (s.enrichProcessingPausedAt || new Date().toISOString()) : null;
    await db.users.updateSettings(userId, {
      ...s,
      enrichEmbedPaused: nextEmbed,
      enrichCategorizePaused: nextCat,
      enrichProcessingPaused: nextEmbed && nextCat,   // legacy composite (both stopped)
      enrichProcessingPausedAt: pausedAt,
    });
    return pausedAt;
  }

  // ── GLOBAL pause/resume — the StatusPopover banner control (stops/starts EVERYTHING) ──
  router.post('/enrichment/processing/pause', async (_req, res) => {
    let pausedAt;
    try { pausedAt = await persistPauseState({ embed: true, categorize: true }); }
    catch { return fail(res, 500, 'could not pause processing'); }
    pauseEnrichProcessing();
    ok(res, { paused: true, pausedAt });
  });

  router.post('/enrichment/processing/resume', async (_req, res) => {
    try { await persistPauseState({ embed: false, categorize: false }); }
    catch { return fail(res, 500, 'could not resume processing'); }
    resumeEnrichProcessing(); // clears both flags + kicks a cycle so progress moves at once
    ok(res, { paused: false, pausedAt: null });
  });

  // ── PER-STAGE pause/resume/restart (QA R2-PIPECTL, R3-PIPESTOP) — the co-located PipelineStatus
  // controls. Each mirrors the global pair: PERSIST FIRST (report a failed write, D13), APPLY SECOND.
  // Resume nudges a cycle so the resumed stage moves at once. Restart re-queues that stage's gave-up
  // rows (the bounded-retry terminals) and nudges — independent of pause (a user can Restart a
  // running stage to reclaim its failures). ──
  const stagePauseRoute = (stage, pause, apply) =>
    router.post(`/enrichment/${stage}/${pause ? 'pause' : 'resume'}`, async (_req, res) => {
      let pausedAt;
      try { pausedAt = await persistPauseState({ [stage === 'embed' ? 'embed' : 'categorize']: pause }); }
      catch { return fail(res, 500, `could not ${pause ? 'pause' : 'resume'} ${stage}`); }
      apply();
      ok(res, { paused: pause, pausedAt });
    });
  stagePauseRoute('embed', true, pauseEmbed);
  stagePauseRoute('embed', false, resumeEmbed);
  stagePauseRoute('categorize', true, pauseCategorize);
  stagePauseRoute('categorize', false, resumeCategorize);

  router.post('/enrichment/embed/restart', async (_req, res) => {
    let reset;
    try { reset = await db.messages.resetEnrichmentGiveUps(userId, { stage: 'embed' }); }
    catch { return fail(res, 500, 'could not reset failed embeds'); }
    nudgeEnrichDrainer();
    ok(res, { reset: { embed: reset.embedReset } });
  });

  router.post('/enrichment/categorize/restart', async (_req, res) => {
    let reset;
    try { reset = await db.messages.resetEnrichmentGiveUps(userId, { stage: 'categorize' }); }
    catch { return fail(res, 500, 'could not reset failed labels'); }
    resetEnrichGiveUpCounters(); // fresh in-memory L1 attempt budgets (no-op if no drainer runs)
    nudgeEnrichDrainer();
    ok(res, { reset: { label: reset.labelReset } });
  });

  // ── Import preview — the onboarding "See your mind" evidence card ───────────
  // A leak-safe AGGREGATE summary of what's in the vault: counts, date range,
  // sources, people. Reads ONLY plaintext columns (created_at, source,
  // conversation_id are NOT in ENCRYPTED_FIELDS.messages) + COUNT(*); it never
  // touches the encrypted `content`, so nothing sensitive is decrypted or logged.
  // Drives "847 messages · 2019–2024 · 3 sources" proof-of-perception.
  //
  // The aggregates now live in readiness's `evidence` slice, because the invite's Data
  // step needs the SAME four facts and a second copy is how the two drift apart. This
  // route keeps its response shape verbatim (its live caller — OnboardingFlow:185 — and
  // its gate, verify-portal-data.mjs D8b, are unchanged) and delegates the SQL.
  //
  // ⚠️ It keeps its own PURE embedCounts(): `messageCount` here feeds a
  // read-after-import correctness check, where the cached count's stale 0 would keep the
  // welcome screen up after an import. That purity is exactly why the invite must NOT
  // reuse this route (design PIVOT 2) — the card wants the aggregates WITHOUT a
  // multi-second scan, and gets them from `evidence` directly.
  router.get('/import/preview', async (_req, res) => {
    try {
      const { total, embedded, pending } = await embedCounts();
      // ⚠️ fresh:true — evidence is SWR-memoized in readiness (15s TTL, serve-stale) for
      // the status popover's once-per-open read; THIS route is the read-after-import
      // correctness surface (the card renders moments after the vault changed), where a
      // stale snapshot shows "0 sources" over a just-imported corpus. Same split as the
      // PURE embedCounts() one line up, same reason. fresh write-throughs the memo on
      // success, so paying the scan here also warms the popover.
      const { evidence } = await readiness.get({ slices: ['evidence'], fresh: true });
      // ⚠️ HONOR `unknown`. `evidence()` degrades to zeros + `unknown:true` instead of
      // throwing; destructuring the zeros and dropping the flag would serve HTTP 200
      // {messageCount: 76000, sources: [], conversationCount: 0} off a scan that NEVER RAN —
      // the owner reads "76,000 messages · 0 sources" and the card gates on messageCount
      // being a number, so it renders it. That is precisely the §3.2a bug this slice's own
      // comment exists to prevent, and I shipped it: the flag was computed correctly and
      // discarded one line later by the only caller (independent review, 2026-07-16).
      // Before delegation this route THREW into its own 500, so the card rendered nothing.
      // Fail closed — preserve that.
      if (evidence.unknown) return fail(res, 500, 'failed to summarize import');
      ok(res, {
        messageCount: total,
        embedded, pending,
        dateRange: evidence.dateRange,
        sources: evidence.sources,
        sourceCount: evidence.sources.length,
        conversationCount: evidence.conversationCount,
        peopleCount: evidence.peopleCount,
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

  // Un-dismiss — "show setup guidance again" (§3.7b). Ported from
  // the canonical portal route; the CLIENT ROUTE ALREADY EXISTED
  // (secure-fetch.ts:180) and 404'd, so the undo has been unreachable since the rail shipped.
  //
  // ⚠️ WHY THIS IS NON-NEGOTIABLE, not a nicety: the rail is gated on `!dismissed`, and
  // `dismissed` is TODAY PERMANENT WITH NO UNDO (§2.10). Without this route, ONE reflexive ×
  // permanently silences the only surface that ever says "your AI isn't connected" — for the
  // life of the vault. Dismissing is "stop nudging me", NOT "lie to me forever".
  //
  // ⚠️ AND IT REPORTS FAILURE, unlike its sibling above. /onboarding/dismiss swallows its error
  // and returns ok:true regardless — defensible there ("never block the UI on a write": a failed
  // dismiss just means the nudge persists, which is safe). Here the polarity inverts: a failed
  // reset that answers ok:true tells the user "your guidance is back" while it stays gone, and
  // they have no way to tell. Fail closed and say so — same discipline as §3.2a.
  router.post('/onboarding/reset', async (_req, res) => {
    try {
      await db.rawQuery('UPDATE users SET onboarding_dismissed_at = NULL WHERE id = ?', [userId]);
    } catch { return fail(res, 500, 'could not restore setup guidance'); }
    ok(res, { ok: true, dismissed: false });
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

  // ── Recovery-key backup gate (U1.3) — the ONE unskippable onboarding step ────
  // A DURABLE flag in the users.settings blob that records the user has EXTERNALLY
  // backed up their recovery key (a real password-manager save OR the re-entry
  // challenge). The wizard's Step 2 forces itself back on relaunch until this is
  // set, so a quit-before-backup can never leave a vault with an un-backed-up key.
  //
  // ⚠️ CARRIES NO KEY MATERIAL. Only a boolean. The recovery key itself never
  // touches this route (it is read/saved server-side by /api/v1/account/*). Keeping
  // the flag OUT of the account surface keeps that surface key-only.
  //
  // ⚠️ TRI-STATE — the flag distinguishes THREE populations, and conflating them
  // over-gates or re-reveals the key on upgrade:
  //   • recovery_key_backed_up === true      → backed up (done).
  //   • recovery_key_backed_up === false      → a U1.3 FRESH vault, backup PENDING (the
  //     server writes this explicit false at /setup create). `pending` → the wizard forces
  //     Step 2 and reveals.
  //   • recovery_key_backed_up === undefined  → a PRE-U1.3 vault (the flag never existed):
  //     `pending:false` + `backedUp:false` → NEVER gate, NEVER re-reveal the key.
  // On a read error we return neither true — biasing AWAY from re-revealing an established
  // key (the MED regression); a fresh vault recovers on the next poll (the explicit false
  // is durable), and the key is Keychain-safe with no user data in that window.
  router.get('/onboarding/recovery-key-status', async (_req, res) => {
    let v;
    try {
      const s = (await db.users.getSettings(userId)) || {};
      v = s.recovery_key_backed_up;
    } catch { v = undefined; }
    ok(res, { ok: true, backedUp: v === true, pending: v === false });
  });

  // ── WRITE: mark the recovery key externally backed up. Set ONLY when Step 2 is
  // passed. ⚠️ READ-MODIFY-WRITE — db.users.updateSettings REPLACES THE WHOLE BLOB
  // (users.js:41), so a bare write would drop taskModels / model-consent / pause
  // state. Spread the prior settings and add the one key (same discipline as the
  // pause-state persister above). ⚠️ REPORTS FAILURE (fail-closed): the wizard must
  // NOT advance past the gate if this write did not land — an ok:true over a failed
  // write would tell the user "backed up" while the flag stays false, re-gating them
  // next launch with no idea why. Same polarity as /onboarding/reset.
  router.post('/onboarding/recovery-key-backed-up', async (_req, res) => {
    try {
      const s = (await db.users.getSettings(userId)) || {};
      await db.users.updateSettings(userId, { ...s, recovery_key_backed_up: true });
    } catch { return fail(res, 500, 'could not record recovery-key backup'); }
    ok(res, { ok: true, backedUp: true });
  });

  return router;
}

export default portalCompatRouter;
