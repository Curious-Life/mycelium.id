/**
 * Folders namespace — user document folder hierarchy.
 *
 * Supports parent-child nesting via parent_id. Delete is non-trivial:
 * orphaned documents get folder_id=NULL, child folders get their
 * grandparent as their new parent_id.
 *
 * Per-agent identity (PR 5.4-A): a folder may carry agent_id set to
 * the stable id of an agent (e.g. 'research-agent'). Folders with
 * agent_id are auto-created by publishArtifact on first publish; the
 * lookup is (user_id, agent_id) so the user can freely rename the
 * folder without breaking the agent's auto-assignment.
 *
 * @typedef {object} FoldersNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {() => string} [randomUUID] — test seam
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createFoldersNamespace(deps) {
  if (!deps) throw new TypeError('createFoldersNamespace: deps required');
  const { d1Query, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createFoldersNamespace: d1Query required');

  // ── Hooks (PR 7) ─────────────────────────────────────────────────────
  // Operation-specific hook lists, mirroring the documents namespace
  // pattern (addAfterUpsertHook / addAfterDeleteHook). Each fires with
  // a minimal payload — caller refetches `/portal/folders` if it needs
  // the current state. Folder names live in plaintext at rest but are
  // user-chosen labels that may carry sensitive context ("Therapy
  // notes 2025"); we deliberately keep them off the hook payload so
  // SSE wires don't stream them.
  const afterCreateHooks = [];
  const afterRenameHooks = [];
  const afterDeleteHooks = [];

  function fireHooks(list, payload) {
    if (!list.length) return;
    queueMicrotask(() => {
      for (const fn of list) {
        try { fn(payload); } catch { /* hook failure is isolated per-subscriber */ }
      }
    });
  }

  function makeAdder(list) {
    return function add(fn) {
      if (typeof fn !== 'function') return () => {};
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    };
  }

  const ns = {
    addAfterCreateHook: makeAdder(afterCreateHooks),
    addAfterRenameHook: makeAdder(afterRenameHooks),
    addAfterDeleteHook: makeAdder(afterDeleteHooks),

    async list(userId) {
      const result = await d1Query(
        `SELECT id, name, parent_id, agent_id, description
           FROM folders
          WHERE user_id = ?
          ORDER BY name`,
        [userId],
      );
      const folders = result.results || [];
      // Live document counts — "the right direction": ONE GROUP BY folder_id over
      // documents (index-only via 0037's partial covering index, ~1 ms on 20k docs)
      // instead of the stored `document_count` column, which was never maintained
      // (always 0). Plaintext aggregate (folder_id is a structural tag) — no decrypt.
      const counts = await d1Query(
        `SELECT folder_id, COUNT(*) AS n
           FROM documents
          WHERE user_id = ? AND is_internal = 0 AND forgotten_at IS NULL AND folder_id IS NOT NULL
          GROUP BY folder_id`,
        [userId],
      );
      const byFolder = new Map((counts.results || []).map((r) => [r.folder_id, Number(r.n) || 0]));
      // Expose both names: `document_count` (the column's name) and `doc_count`
      // (what LibraryNav reads). Folders with no docs get 0 (falsy → the nav hides
      // the badge, unchanged for empty folders).
      for (const f of folders) {
        const n = byFolder.get(f.id) || 0;
        f.document_count = n;
        f.doc_count = n;
      }
      return folders;
    },

    /**
     * Look up a single folder by id, scoped to the caller. Returns null
     * if the folder doesn't exist OR belongs to a different user. Used
     * by ownership checks (e.g. moveToFolder).
     */
    async findById(userId, folderId) {
      if (!folderId) return null;
      const result = await d1Query(
        `SELECT id, name, parent_id, agent_id
           FROM folders
          WHERE id = ? AND user_id = ?
          LIMIT 1`,
        [folderId, userId],
      );
      return result.results?.[0] || null;
    },

    /**
     * Find an agent's *root* folder for this user. Agent root is
     * defined as (user_id, agent_id, parent_id IS NULL).
     *
     * Returns null if the agent has no root folder yet (first publish
     * hasn't run, or user deleted the folder — next publish will
     * recreate it via ensureAgentFolder).
     */
    async findByAgent(userId, agentId) {
      if (!userId || !agentId) return null;
      const result = await d1Query(
        `SELECT id, name, parent_id, agent_id
           FROM folders
          WHERE user_id = ? AND agent_id = ? AND parent_id IS NULL
          LIMIT 1`,
        [userId, agentId],
      );
      return result.results?.[0] || null;
    },

    /**
     * Idempotent: returns the agent's root folder, creating it on first
     * call. The publisher memoizes the result per process so this hits
     * the DB at most once per agent lifetime.
     *
     * Race-safe: a concurrent first-publish (e.g. chat handler + cron
     * firing simultaneously) may both observe `findByAgent → null` and
     * then both INSERT. The second INSERT may either succeed (we end
     * up with a duplicate row, harmless — duplicates only cost a bit
     * of name-collision in the UI) or fail; in either case we re-find
     * and return the canonical row. SQLite has no UNIQUE constraint on
     * (user_id, agent_id) by default, so the duplicate-on-race case is
     * possible. Acceptable for now; a future migration can add the
     * UNIQUE index if duplicates are observed in practice.
     */
    async ensureAgentFolder(userId, agentId, displayName) {
      if (!userId || !agentId) {
        throw new Error('ensureAgentFolder: userId and agentId required');
      }
      const existing = await ns.findByAgent(userId, agentId);
      if (existing) return existing;

      const id = randomUUID();
      const name = displayName || agentId;
      try {
        await d1Query(
          `INSERT INTO folders (id, user_id, name, parent_id, agent_id)
           VALUES (?, ?, ?, ?, ?)`,
          [id, userId, name, null, agentId],
        );
        return { id, name, parent_id: null, agent_id: agentId };
      } catch (err) {
        // Race: another writer beat us. Re-find and return their row.
        const reFind = await ns.findByAgent(userId, agentId);
        if (reFind) return reFind;
        throw err;
      }
    },

    /**
     * Idempotent sub-folder under a known parent. Identity is
     * (user_id, parent_id, name) — agent_id stays NULL. Used by the
     * publisher to derive one level of sub-folder from
     * agent-files/<agent>/<segment>/... — segment becomes a regular
     * folder the user can rename or restructure. Race-safe like
     * ensureAgentFolder.
     */
    async ensureSubFolder(userId, parentId, name) {
      if (!userId || !parentId || !name) {
        throw new Error('ensureSubFolder: userId, parentId, name required');
      }
      const find = async () => {
        const r = await d1Query(
          `SELECT id, name, parent_id, agent_id
             FROM folders
            WHERE user_id = ? AND parent_id = ? AND name = ?
            LIMIT 1`,
          [userId, parentId, name],
        );
        return r.results?.[0] || null;
      };
      const existing = await find();
      if (existing) return existing;

      const id = randomUUID();
      try {
        await d1Query(
          `INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)`,
          [id, userId, name, parentId],
        );
        return { id, name, parent_id: parentId, agent_id: null };
      } catch (err) {
        const reFind = await find();
        if (reFind) return reFind;
        throw err;
      }
    },

    async create(userId, name, parentId = null) {
      const id = randomUUID();
      await d1Query(
        `INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)`,
        [id, userId, name, parentId],
      );
      fireHooks(afterCreateHooks, { user_id: userId, id, parent_id: parentId });
      return { id, name, parent_id: parentId };
    },

    async rename(userId, folderId, name) {
      await d1Query(
        `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`,
        [name, folderId, userId],
      );
      fireHooks(afterRenameHooks, { user_id: userId, id: folderId });
    },

    async delete(userId, folderId) {
      // Move documents in this folder to no folder.
      await d1Query(
        `UPDATE documents SET folder_id = NULL WHERE folder_id = ? AND user_id = ?`,
        [folderId, userId],
      );
      // Move child folders to parent of deleted folder.
      const folder = await d1Query(
        `SELECT parent_id FROM folders WHERE id = ? AND user_id = ?`,
        [folderId, userId],
      );
      const parentId = folder.results?.[0]?.parent_id || null;
      await d1Query(
        `UPDATE folders SET parent_id = ? WHERE parent_id = ? AND user_id = ?`,
        [parentId, folderId, userId],
      );
      await d1Query(
        `DELETE FROM folders WHERE id = ? AND user_id = ?`,
        [folderId, userId],
      );
      fireHooks(afterDeleteHooks, { user_id: userId, id: folderId });
    },
  };

  return ns;
}
