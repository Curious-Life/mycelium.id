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
import { bustMindscapePoints } from '../mindscape-cache.js';

/** A fresh capability epoch for unlisted links (16 bytes hex = 128 bits). */
function randomNonce() {
  return randomBytes(16).toString('hex');
}

// RT2-H1 (0035/0036): every ENCRYPTED document field a write can poison — versioned
// as a whole so an overwrite is fully recoverable, not just content/title/summary
// (red-team MED-1). Must stay a subset of ENCRYPTED_FIELDS.documents (crypto-local.js).
const DOC_VERSIONED_FIELDS = ['title', 'summary', 'content', 'tags', 'entities', 'relations', 'metadata', 'entity_summary', 'source_path'];
// Keep-last-N bound on version rows per (user,path) — an injection loop of overwrites
// must not grow the vault without bound (red-team HIGH-1; mirrors activity-feed.prune).
const DOC_VERSION_KEEP = 50;

export function createDocumentsNamespace(deps) {
  if (!deps) throw new TypeError('createDocumentsNamespace: deps required');
  const { d1Query, firstRow, rawDb, withTransaction } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createDocumentsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createDocumentsNamespace: firstRow required');
  // rawDb + withTransaction power the atomic version-snapshot+overwrite (the raw
  // sync transaction over the plaintext documents/document_versions tables). The
  // sole caller (src/db/index.js) supplies them from the adapter; require them
  // fail-closed so a future caller can't silently lose snapshot atomicity.
  if (!rawDb || typeof rawDb.prepare !== 'function') throw new TypeError('createDocumentsNamespace: rawDb (better-sqlite3 handle) required');
  if (typeof withTransaction !== 'function') throw new TypeError('createDocumentsNamespace: withTransaction required');

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

  // Single shape for the list-affecting single-column-ish mutations (pin/unpin/
  // setTitle/publish/unpublish/revokeShareLinks): UPDATE the given SET, ALWAYS bump
  // updated_at (so the list sort + SSE patcher see a fresh row), RETURNING *, then
  // fire afterUpsertHooks (the broadcaster/publish re-render subscribe here — this
  // helper MUST keep firing them). `params` bind into `setSql`'s placeholders, then
  // (user_id, path) for the WHERE. The deviant mutations (moveToFolder ownership
  // check, setSalience conditional cols, redact multi-statement, setPublicSlug nonce,
  // incrementVisitCount no-hook) keep their own bodies.
  async function updateColumns(userId, path, setSql, params = [], { returnSlug = false } = {}) {
    const result = await d1Query(
      `UPDATE documents
          SET ${setSql},
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE user_id = ? AND path = ?
      RETURNING *`,
      [...params, userId, path],
    );
    const row = firstRow(result);
    if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
    return returnSlug ? (row?.public_slug || null) : row;
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

      // RT2-H1 overwrite recoverability (migration 0035): before a content-changing
      // overwrite of an EXISTING doc, snapshot the prior versioned fields into
      // document_versions so a poisoned/mistaken write is recoverable. Create (no
      // prior) and identical re-write (no diff) capture nothing. Bulk importers
      // bypass this DAL (raw inserts) so import is unaffected. No plaintext is logged.
      let prev = null;
      let changed = false;
      if (doc && doc.user_id && doc.path && opts.skipVersion !== true) {
        prev = firstRow(await d1Query(
          `SELECT id, forgotten_at, ${DOC_VERSIONED_FIELDS.join(', ')} FROM documents WHERE user_id = ? AND path = ?`,
          [doc.user_id, doc.path],
        ));
        // Version when ANY versioned field the caller is writing actually changes —
        // not just content/title/summary (red-team MED-1: metadata/tags/entities were
        // silently overwritten unversioned). Create + identical re-write capture nothing.
        changed = !!(prev && !prev.forgotten_at &&
          DOC_VERSIONED_FIELDS.some((f) => doc[f] !== undefined && doc[f] !== prev[f]));
      }

      let row;
      if (changed) {
        // ATOMIC-CONSISTENCY (DOCUMENTS-LAYER-HARDENING §6, v4): snapshot the prior
        // content AND apply the overwrite in ONE transaction — a content overwrite
        // NEVER commits without its recovery snapshot, and a snapshot can't orphan a
        // write. Both tables are PLAINTEXT (empty ENCRYPTED_FIELDS) so raw sync
        // statements are correct. The row already exists, so the main write is a plain
        // UPDATE: autoEncryptParams injects `scope` only on INSERT into a SCOPE_AWARE
        // table (crypto-local.js:1665) — an UPDATE needs no scope/encrypt transform,
        // which is what makes the raw sync path safe here. A versioning failure now
        // ROLLS BACK the write (the deliberate change from the old best-effort hedge,
        // which guarded encryption flakiness that no longer applies).
        const snap = {};
        for (const f of DOC_VERSIONED_FIELDS) if (prev[f] != null) snap[f] = prev[f];
        const setSql = updateCols.map((c) => `${c} = ?`).join(', ');
        withTransaction(() => {
          rawDb.prepare(
            `INSERT INTO document_versions (document_id, user_id, path, title, summary, content, snapshot_json, trigger, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(prev.id, doc.user_id, doc.path, prev.title ?? null, prev.summary ?? null, prev.content ?? null, JSON.stringify(snap), opts.trigger || 'overwrite', opts.reason ?? null);
          // Bound growth (red-team HIGH-1): keep the most-recent N versions per (user,path).
          rawDb.prepare(
            `DELETE FROM document_versions WHERE user_id = ? AND path = ? AND id NOT IN (
               SELECT id FROM document_versions WHERE user_id = ? AND path = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          ).run(doc.user_id, doc.path, doc.user_id, doc.path, DOC_VERSION_KEEP);
          if (setSql) {
            rawDb.prepare(
              `UPDATE documents SET ${setSql} WHERE user_id = ? AND path = ?`,
            ).run(...updateCols.map((c) => doc[c]), doc.user_id, doc.path);
          }
        }, { tables: ['documents', 'document_versions'] });
        // Re-read through the async adapter so the hook/return row is fully decrypted
        // (old envelope rows: any untouched encrypted column still needs value-shape
        // decrypt that a raw RETURNING would skip).
        row = firstRow(await d1Query(
          `SELECT * FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
          [doc.user_id, doc.path],
        ));
      } else {
        // Create / partial-update / no-diff: the existing async path. This is the
        // branch that needs INSERT scope-injection + auto-encrypt, so it MUST stay on
        // d1Query (no raw sync). `created_at` excluded from the conflict SET (above).
        const cols = Object.keys(doc).join(', ');
        const placeholders = Object.keys(doc).map(() => '?').join(', ');
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
        row = firstRow(result);
      }

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
      return updateColumns(userId, path, 'is_pinned = 1');
    },

    async unpin(userId, path) {
      return updateColumns(userId, path, 'is_pinned = 0');
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

    // Rename = set the display title. The `path` (the identity / UNIQUE key,
    // referenced without cascade by context_documents, space_room_documents,
    // document_versions) is deliberately NOT changed — only the title. Mirrors
    // pin/moveToFolder: UPDATE by (user_id, path), bump updated_at, fire hooks
    // (so the library list + search reflect the new name). Content is untouched.
    async setTitle(userId, path, title) {
      return updateColumns(userId, path, 'title = ?', [typeof title === 'string' ? title : null]);
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
      bustMindscapePoints(userId); // clustering_points deleted → drop BOTH points + full caches
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
      return updateColumns(userId, path, 'published = 1, public_slug = COALESCE(public_slug, ?)', [slug], { returnSlug: true });
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
      return updateColumns(userId, path, 'published = 0, publish_nonce = NULL');
    },

    /**
     * Revoke ONLY the unlisted links (publish_nonce=NULL) while leaving the
     * doc's published state untouched. Use this to kill outstanding /s/ links
     * without un-publishing a doc that is also public. Re-sharing mints a fresh
     * nonce. Returns the updated row.
     */
    async revokeShareLinks(userId, path) {
      return updateColumns(userId, path, 'publish_nonce = NULL');
    },

    // ── RT2-H1 recovery (migration 0035) ────────────────────────────────

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
     * Atomically rename a document's `path` (its slug / ?doc= URL id) and cascade
     * every FK-less reference so nothing orphans. The row `id` is preserved, so
     * document_versions / embeddings / FTS linkage stay intact (FTS self-heals by
     * rowid on the UPDATE). See docs/DOCUMENT-SLUG-RENAME-DESIGN-2026-06-29.md.
     *
     * Atomic + plaintext-only: every cascade column is a plaintext path, so the raw
     * sync withTransaction (no async auto-encrypt) is correct — the {tables} dev
     * assert proves all five touched tables have empty ENCRYPTED_FIELDS. A conflict
     * or any failure rolls back with zero partial state. `public_slug` is NOT touched
     * (independent of path) so published/unlisted URLs keep working.
     *
     * Throws RENAME_BAD_PATH / RENAME_CONFLICT / RENAME_NOT_FOUND for the route to map.
     * document_versions.path is intentionally left as a historical snapshot.
     */
    async renamePath(userId, oldPath, newPath) {
      if (typeof newPath !== 'string' || !newPath.trim()) throw new Error('RENAME_BAD_PATH');
      newPath = newPath.trim();
      if (newPath === oldPath) {
        return firstRow(await d1Query(
          `SELECT * FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
          [userId, oldPath],
        ));
      }
      const ts = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
      withTransaction(() => {
        if (rawDb.prepare(`SELECT 1 FROM documents WHERE user_id = ? AND path = ? LIMIT 1`).get(userId, newPath)) {
          throw new Error('RENAME_CONFLICT');
        }
        const moved = rawDb.prepare(
          `UPDATE documents SET path = ?, updated_at = ${ts} WHERE user_id = ? AND path = ?`,
        ).run(newPath, userId, oldPath);
        if (moved.changes === 0) throw new Error('RENAME_NOT_FOUND');
        // FK-less path references (sweep §2 cascade map). context_documents /
        // space_room_documents / space_rooms have no user_id column — safe in the
        // single-user vault (V2 multi-tenant must scope via ownership joins).
        rawDb.prepare(`UPDATE share_links          SET document_path = ? WHERE user_id = ? AND document_path = ?`).run(newPath, userId, oldPath);
        rawDb.prepare(`UPDATE context_documents    SET document_path = ? WHERE document_path = ?`).run(newPath, oldPath);
        rawDb.prepare(`UPDATE space_room_documents SET document_path = ? WHERE document_path = ?`).run(newPath, oldPath);
        rawDb.prepare(`UPDATE space_rooms          SET cover_doc_path = ? WHERE cover_doc_path = ?`).run(newPath, oldPath);
        // document_versions.path: intentionally NOT updated (path-at-time history).
      }, { tables: ['documents', 'share_links', 'context_documents', 'space_room_documents', 'space_rooms'] });
      // Decrypted read for the response/hooks; broadcast as upsert(newPath) + remove(oldPath).
      const row = firstRow(await d1Query(
        `SELECT * FROM documents WHERE user_id = ? AND path = ? AND forgotten_at IS NULL`,
        [userId, newPath],
      ));
      if (row && afterUpsertHooks.length) fireHooks(afterUpsertHooks, row);
      if (afterDeleteHooks.length) fireHooks(afterDeleteHooks, { user_id: userId, path: oldPath });
      return row;
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
