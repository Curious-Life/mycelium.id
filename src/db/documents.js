/**
 * Documents namespace — vault document records (content encrypted via
 * db-proxy auto-encrypt).
 *
 * `upsert()` builds an ON CONFLICT (user_id, path) DO UPDATE SET clause
 * that excludes user_id and path — those are the conflict key and must
 * not mutate.
 *
 * `list()` filters by category (path prefix), folderId, pinnedOnly, or
 * internalOnly (internal documents are hidden by default).
 *
 * @typedef {object} DocumentsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

import { randomBytes, createHash } from 'node:crypto';
import { assertSafeColumns, clampLimit } from './column-guard.js';
import { bustMindscape } from '../mindscape-cache.js';

/** A fresh capability epoch for unlisted links (16 bytes hex = 128 bits). */
function randomNonce() {
  return randomBytes(16).toString('hex');
}

// RT2-H1 (0034/0035): every ENCRYPTED document field a write can poison — versioned
// as a whole so an overwrite is fully recoverable, not just content/title/summary
// (red-team MED-1). Must stay a subset of ENCRYPTED_FIELDS.documents (crypto-local.js).
const DOC_VERSIONED_FIELDS = ['title', 'summary', 'content', 'tags', 'entities', 'relations', 'metadata', 'entity_summary', 'source_path'];
// Keep-last-N bound on version rows per (user,path) — an injection loop of overwrites
// must not grow the vault without bound (red-team HIGH-1; mirrors activity-feed.prune).
const DOC_VERSION_KEEP = 50;

export function createDocumentsNamespace(deps) {
  if (!deps) throw new TypeError('createDocumentsNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createDocumentsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createDocumentsNamespace: firstRow required');

  // Hook lists that fire fire-and-forget after a successful upsert or
  // delete. Multiple subscribers (publishing pipeline, doc-broadcaster,
  // future MCP write tools) can register independently — earlier
  // single-slot design silently overwrote on the second subscriber.
  // Closure-scoped (not on `this`) so call-site doesn't depend on
  // method-binding semantics.
  const afterUpsertHooks = [];
  const afterDeleteHooks = [];

  function fireHooks(hooks, payload) {
    for (const hook of hooks) {
      Promise.resolve()
        .then(() => hook(payload))
        .catch(() => { /* hook errors are non-fatal and isolated */ });
    }
  }

  return {
    /**
     * Register a post-upsert hook. Returns a disposer that removes it.
     * Hooks fire fire-and-forget after every successful upsert with
     * the row returned by RETURNING *. Errors in one hook never block
     * another.
     */
    addAfterUpsertHook(fn) {
      if (typeof fn !== 'function') return () => {};
      afterUpsertHooks.push(fn);
      return () => {
        const i = afterUpsertHooks.indexOf(fn);
        if (i >= 0) afterUpsertHooks.splice(i, 1);
      };
    },

    /**
     * Register a post-delete hook. Same shape as addAfterUpsertHook.
     * Receives `{ user_id, path }` after a successful delete.
     */
    addAfterDeleteHook(fn) {
      if (typeof fn !== 'function') return () => {};
      afterDeleteHooks.push(fn);
      return () => {
        const i = afterDeleteHooks.indexOf(fn);
        if (i >= 0) afterDeleteHooks.splice(i, 1);
      };
    },

    /**
     * Back-compat shim: clear-and-add. Old call sites that used the
     * single-slot setter still work; new code should use addAfterUpsertHook.
     */
    setAfterUpsertHook(fn) {
      afterUpsertHooks.length = 0;
      if (typeof fn === 'function') afterUpsertHooks.push(fn);
    },

    async get(userId, path) {
      const result = await d1Query(
        `SELECT * FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
        [userId, path],
      );
      return firstRow(result);
    },

    /**
     * Document fields SAFE to serve to a federated peer (a shared-space read).
     * EXPLICIT column list — NEVER `SELECT *`, which would leak `embedding_768`
     * (CLAUDE.md §7: an embedding is a semantic fingerprint and must never leave
     * the box). content/title/summary decrypt on read; the caller still runs the
     * hasVectorKey tripwire before serialization as a second line of defense.
     */
    async getForShare(userId, path) {
      const result = await d1Query(
        `SELECT path, title, summary, content, source_type, created_by, updated_at
         FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
        [userId, path],
      );
      return firstRow(result);
    },

    async upsert(doc, opts = {}) {
      assertSafeColumns(Object.keys(doc || {}), 'documents');

      // RT2-H1 overwrite recoverability (migration 0034): before a content-changing
      // overwrite of an EXISTING doc, snapshot the prior title/summary/content into
      // document_versions (encrypted) so a poisoned/mistaken write is recoverable.
      // Create (no prior) and identical re-write (no diff) capture nothing. Bulk
      // importers bypass this DAL (raw inserts) so import is unaffected. Non-fatal +
      // isolated — a versioning hiccup must NEVER deny an owner-authorized write
      // (mirrors the afterUpsertHooks discipline). No plaintext is ever logged.
      if (doc && doc.user_id && doc.path && opts.skipVersion !== true) {
        try {
          const prev = firstRow(await d1Query(
            `SELECT id, forgotten_at, ${DOC_VERSIONED_FIELDS.join(', ')} FROM documents WHERE user_id = ? AND path = ?`,
            [doc.user_id, doc.path],
          ));
          // Version when ANY encrypted field the caller is writing actually changes —
          // not just content/title/summary (red-team MED-1: metadata/tags/entities were
          // silently overwritten unversioned). Create + identical re-write capture nothing.
          const changed = prev && !prev.forgotten_at &&
            DOC_VERSIONED_FIELDS.some((f) => doc[f] !== undefined && doc[f] !== prev[f]);
          if (changed) {
            // Full prior snapshot (every non-null encrypted field) as one encrypted JSON
            // blob → a document overwrite is fully recoverable; title/summary/content are
            // also kept as columns for a cheap listVersions preview (no JSON parse).
            const snap = {};
            for (const f of DOC_VERSIONED_FIELDS) if (prev[f] != null) snap[f] = prev[f];
            await d1Query(
              `INSERT INTO document_versions (document_id, user_id, path, title, summary, content, snapshot_json, trigger, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [prev.id, doc.user_id, doc.path, prev.title ?? null, prev.summary ?? null, prev.content ?? null, JSON.stringify(snap), opts.trigger || 'overwrite', opts.reason ?? null],
            );
            // Bound growth (red-team HIGH-1): keep the most-recent N versions per (user,path).
            await d1Query(
              `DELETE FROM document_versions WHERE user_id = ? AND path = ? AND id NOT IN (
                 SELECT id FROM document_versions WHERE user_id = ? AND path = ?
                 ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
              [doc.user_id, doc.path, doc.user_id, doc.path, DOC_VERSION_KEEP],
            );
          }
        } catch (e) {
          console.warn(`[doc-version] prior-snapshot capture failed: ${e?.code || e?.name || 'error'}`);
        }
      }

      const cols = Object.keys(doc).join(', ');
      const placeholders = Object.keys(doc).map(() => '?').join(', ');
      // SET clause for ON CONFLICT. Exclude the conflict key (user_id, path) AND
      // `created_at`: created_at is the row's birth time — IMMUTABLE after first
      // insert. Including it let a re-import (e.g. a re-export with a fresh file
      // mtime) clobber the original creation date — the documents-timestamp bug
      // (docs/DESIGN-import-system-robustness-2026-06-19.md, Fix A). It is still
      // written on the initial INSERT (stays in `cols`/`placeholders`); only the
      // UPDATE branch leaves it untouched. `updated_at` stays mutable so an edit /
      // re-import still bumps it. Deliberate lowering of created_at is a separate
      // audited repair tool — never the import path.
      const IMMUTABLE = new Set(['user_id', 'path', 'created_at']);
      const updateCols = Object.keys(doc).filter((c) => !IMMUTABLE.has(c));
      const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');

      // If every supplied column is immutable, there is nothing to update on
      // conflict — DO NOTHING (avoids an empty `SET` = invalid SQL).
      const conflict = setClause ? `DO UPDATE SET ${setClause}` : 'DO NOTHING';
      const result = await d1Query(
        `INSERT INTO documents (${cols}) VALUES (${placeholders})
         ON CONFLICT (user_id, path) ${conflict}
         RETURNING *`,
        Object.values(doc),
      );
      const row = firstRow(result);

      // Fire post-upsert hooks on a fresh microtask so the upsert's
      // return value isn't blocked. Errors are isolated per-hook —
      // hook failure must never break a write or affect siblings.
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);

      return row;
    },

    async list(userId, { category, folderId, pinnedOnly, internalOnly = false, limit, offset } = {}) {
      // PR 5.10: include metadata so the library list view can resolve
      // per-upload sender names (encrypted JSON; auto-decrypted in
      // db-d1's read path). Cost: extra column read + one decrypt per
      // row — paginate (limit/offset) so the list view only decrypts a page.
      let sql = `SELECT path, title, summary, folder_id, is_pinned AS pinned, source_type, created_by, metadata, updated_at FROM documents WHERE user_id = ? AND is_internal = ? AND forgotten_at IS NULL`;
      const params = [userId, internalOnly ? 1 : 0];
      if (category) { sql += ` AND path LIKE ?`; params.push(`${category}/%`); }
      if (folderId) { sql += ` AND folder_id = ?`; params.push(folderId); }
      if (pinnedOnly) sql += ` AND is_pinned = 1`;
      sql += ` ORDER BY updated_at DESC`;
      // Optional pagination: omit (callers like MCP listDocuments) → full set, unchanged.
      if (Number.isFinite(limit) && limit > 0) {
        sql += ` LIMIT ?`; params.push(Math.floor(limit));
        if (Number.isFinite(offset) && offset > 0) { sql += ` OFFSET ?`; params.push(Math.floor(offset)); }
      }
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    /** Count of list()-visible documents (no decrypt) — for paginated totals. */
    async count(userId, { category, folderId, pinnedOnly, internalOnly = false } = {}) {
      let sql = `SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND is_internal = ? AND forgotten_at IS NULL`;
      const params = [userId, internalOnly ? 1 : 0];
      if (category) { sql += ` AND path LIKE ?`; params.push(`${category}/%`); }
      if (folderId) { sql += ` AND folder_id = ?`; params.push(folderId); }
      if (pinnedOnly) sql += ` AND is_pinned = 1`;
      const result = await d1Query(sql, params);
      return result.results?.[0]?.n || 0;
    },

    /**
     * Cheap card-preview: decrypt ONLY the content column and return its first
     * `maxChars`. Avoids db.documents.get's SELECT * (which decrypts every
     * encrypted column) for grid thumbnails.
     */
    async contentSnippet(userId, path, maxChars = 600) {
      const result = await d1Query(
        `SELECT content FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
        [userId, path],
      );
      const content = result.results?.[0]?.content;
      if (typeof content !== 'string') return '';
      return content.length > maxChars ? content.slice(0, maxChars) : content;
    },

    // ── Metadata mutations (PR 7) ──────────────────────────────────────
    //
    // pin / unpin / moveToFolder / publish / unpublish / setPublicSlug
    // all mutate list-affecting columns. Each:
    //   1. UPDATE ... RETURNING * so we have the post-mutation row.
    //   2. Bump updated_at so the list view's sort order reflects the
    //      change (a click-to-pin should look "fresh", and the SSE
    //      patcher relies on the updated_at delta to know an event
    //      arrived for a known path).
    //   3. Fire afterUpsertHooks with the returned row — same hook the
    //      upsert path uses, so the agent-server's broadcaster wires
    //      stay simple (one subscriber, one payload shape). Pin/move
    //      are conceptually "row was upserted" with a partial diff;
    //      reusing the hook is the lower-noise design.
    //
    // incrementVisitCount stays out of this — it's a high-frequency
    // page-visit counter, not a list-affecting change.

    async pin(userId, path) {
      const result = await d1Query(
        `UPDATE documents
            SET is_pinned = 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    async unpin(userId, path) {
      const result = await d1Query(
        `UPDATE documents
            SET is_pinned = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    async moveToFolder(userId, path, folderId) {
      // Defense-in-depth (PR 5.4-A): the user_id-WHERE on the UPDATE
      // already prevents cross-tenant writes, but a guessed folder
      // UUID belonging to another user could land the doc there —
      // invisible to its owner. Verify ownership up front. A folderId
      // of null is "remove from folder" and skips the check.
      if (folderId !== null && folderId !== undefined) {
        const owned = await d1Query(
          `SELECT 1 FROM folders WHERE id = ? AND user_id = ? LIMIT 1`,
          [folderId, userId],
        );
        if (!owned.results?.length) {
          throw new Error('moveToFolder: folder not owned by user');
        }
      }
      const result = await d1Query(
        `UPDATE documents
            SET folder_id = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [folderId, userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    async delete(userId, path) {
      await d1Query(
        `DELETE FROM documents WHERE user_id = ? AND path = ?`,
        [userId, path],
      );
      if (afterDeleteHooks.length) fireHooks(afterDeleteHooks, { user_id: userId, path });
    },

    /**
     * Soft-redact (forget) a document: null every encrypted column + the
     * embedding, delete the derived clustering_points row, stamp forgotten_at.
     * Keeps the path/timestamps husk for audit. Returns the pre-redaction
     * content hash + length for the audit ledger — never plaintext. Fires the
     * after-delete hooks so broadcasters/publishing react. Local SQLite.
     */
    async redact(userId, path) {
      const cur = await d1Query(
        `SELECT id, content, forgotten_at FROM documents WHERE user_id = ? AND path = ?`,
        [userId, path],
      );
      const row = firstRow(cur);
      if (!row) return { found: false, contentHash: null, length: 0 };
      if (row.forgotten_at) return { found: true, alreadyForgotten: true, contentHash: null, length: 0 };
      const content = row.content ?? '';
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      await d1Query(
        `UPDATE documents SET
           content = NULL, summary = NULL, title = NULL, tags = NULL, entities = NULL,
           relations = NULL, metadata = NULL, entity_summary = NULL, source_path = NULL,
           embedding_768 = NULL,
           forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ? AND path = ?`,
        [userId, path],
      );
      await d1Query(
        `DELETE FROM clustering_points WHERE user_id = ? AND source_type = 'document' AND source_id = ?`,
        [userId, row.id],
      );
      bustMindscape(userId); // points changed → drop cached mindscape aggregate
      if (afterDeleteHooks.length) fireHooks(afterDeleteHooks, { user_id: userId, path });
      return { found: true, contentHash, length: content.length };
    },

    /**
     * Set user-asserted salience on a document. Reuses is_pinned; adds sensitive.
     * Forgotten docs are immutable (excluded by WHERE). Fires upsert hooks so the
     * library list view reflects the change.
     */
    async setSalience(userId, path, { pinned, sensitive } = {}) {
      const sets = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
      const params = [];
      if (pinned !== undefined) { sets.push('is_pinned = ?'); params.push(pinned ? 1 : 0); }
      if (sensitive !== undefined) { sets.push('sensitive = ?'); params.push(sensitive ? 1 : 0); }
      params.push(userId, path);
      const result = await d1Query(
        `UPDATE documents SET ${sets.join(', ')} WHERE user_id = ? AND path = ? AND forgotten_at IS NULL RETURNING *`,
        params,
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return { found: !!row, changed: !!row };
    },

    // ── Publishing (migration 138) ──────────────────────────────────────

    /**
     * Lookup by public_slug (per-user). Returns the doc or null. Used
     * by the publish flow to detect slug conflicts before writing,
     * and by the agent server's render path. NOT used by the Worker
     * public route — that hits R2 directly.
     */
    async getBySlug(userId, slug) {
      const result = await d1Query(
        `SELECT * FROM documents WHERE user_id = ? AND public_slug = ? AND forgotten_at IS NULL LIMIT 1`,
        [userId, slug],
      );
      return firstRow(result);
    },

    /**
     * Share a doc as UNLISTED: assign a public_slug WITHOUT setting published=1,
     * and ensure a `publish_nonce` (the capability epoch) exists so signed
     * /s/<slug> links can be minted and later revoked.
     *
     * Idempotent: COALESCE keeps the existing slug AND the existing nonce if set
     * — so re-sharing the same doc keeps its URL and keeps previously-minted
     * links valid (slugs/nonces are immutable until explicit rename/revoke).
     * A doc whose nonce was revoked (NULL) gets a FRESH nonce here — old links
     * stay dead, new ones work.
     *
     * Returns the full row (callers need both `public_slug` and `publish_nonce`
     * to mint a link via src/publish/links.js#mintLink).
     */
    async setPublicSlug(userId, path, slug) {
      if (typeof slug !== 'string' || slug.length === 0) {
        throw new Error('setPublicSlug: slug required');
      }
      const nonce = randomNonce();
      // RETURNING * so the afterUpsertHook receives the full row and callers can
      // read the (coalesced) public_slug + publish_nonce to mint a link.
      const result = await d1Query(
        `UPDATE documents
            SET public_slug = COALESCE(public_slug, ?),
                publish_nonce = COALESCE(publish_nonce, ?),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [slug, nonce, userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    /**
     * Set published=1 + ensure public_slug. The slug is REQUIRED here
     * because the caller (publish route) has already auto-derived or
     * accepted one. Idempotent: re-publishing the same doc returns
     * the existing slug (slugs are immutable until explicit rename).
     */
    async publish(userId, path, slug) {
      // Defense in depth: don't allow publish without a slug. The
      // route layer enforces format; this is the last gate.
      if (typeof slug !== 'string' || slug.length === 0) {
        throw new Error('publish: slug required');
      }
      const result = await d1Query(
        `UPDATE documents
            SET published = 1,
                public_slug = COALESCE(public_slug, ?),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [slug, userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row?.public_slug || null;
    },

    /**
     * Take a doc back fully (make private). published=0 AND publish_nonce=NULL
     * — the latter INSTANTLY revokes every previously-minted unlisted /s/ link
     * (their embedded nonce no longer matches; NULL nonce is never servable).
     * public_slug is intentionally retained so a later re-publish keeps the same
     * URL; re-sharing as unlisted mints a FRESH nonce (old links stay dead). The
     * R2 artifact is deleted by the route layer's isPublic check.
     *
     * Fail-closed: "unpublish" means the public can no longer reach it by ANY
     * path — both the public /p/ route (published=0) and unlisted /s/ tokens.
     */
    async unpublish(userId, path) {
      const result = await d1Query(
        `UPDATE documents
            SET published = 0,
                publish_nonce = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    /**
     * Revoke ONLY the unlisted links (publish_nonce=NULL) while leaving the
     * doc's published state untouched. Use this to kill outstanding /s/ links
     * without un-publishing a doc that is also public. Re-sharing mints a fresh
     * nonce. Returns the updated row.
     */
    async revokeShareLinks(userId, path) {
      const result = await d1Query(
        `UPDATE documents
            SET publish_nonce = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ? AND path = ?
        RETURNING *`,
        [userId, path],
      );
      const row = firstRow(result);
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      return row;
    },

    // ── RT2-H1 recovery (migration 0034) ────────────────────────────────

    /**
     * Prior versions of a document, captured before each content-changing
     * overwrite (newest first). Snapshot columns (title/summary/content)
     * auto-decrypt on read. The recovery half of the owner-write grant.
     */
    async listVersions(userId, path, { limit = 20 } = {}) {
      const result = await d1Query(
        `SELECT id, title, summary, content, trigger, reason, created_at
           FROM document_versions
          WHERE user_id = ? AND path = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
        [userId, path, clampLimit(limit, 20, 200)],
      );
      return result.results || [];
    },

    /**
     * Restore a prior version's title/summary/content onto the live document.
     * Routes through upsert() so the CURRENT value is itself snapshotted first —
     * a restore is reversible. Returns the restored row, or null if the version
     * or the live doc is gone.
     */
    async restoreVersion(userId, path, versionId) {
      const v = firstRow(await d1Query(
        `SELECT title, summary, content, snapshot_json FROM document_versions WHERE id = ? AND user_id = ? AND path = ?`,
        [versionId, userId, path],
      ));
      if (!v) return null;
      const cur = await this.get(userId, path);
      if (!cur) return null;
      // Prefer the full snapshot (restores every prior encrypted field, MED-1); fall back
      // to the title/summary/content columns for pre-0034 version rows.
      let fields = { title: v.title ?? null, summary: v.summary ?? null, content: v.content ?? null };
      if (v.snapshot_json) {
        try {
          const snap = JSON.parse(v.snapshot_json);
          if (snap && typeof snap === 'object') fields = Object.fromEntries(DOC_VERSIONED_FIELDS.filter((f) => f in snap).map((f) => [f, snap[f]]));
        } catch { /* corrupt snapshot → fall back to the three preview columns */ }
      }
      return this.upsert({ user_id: userId, path, ...fields }, { trigger: 'restore', reason: `restore ${versionId}` });
    },

    /**
     * Atomic visit-count increment. Called by the Worker public route
     * via ctx.waitUntil so the response isn't blocked.
     */
    async incrementVisitCount(userId, path) {
      await d1Query(
        `UPDATE documents SET public_visit_count = public_visit_count + 1
         WHERE user_id = ? AND path = ?`,
        [userId, path],
      );
    },
  };
}
