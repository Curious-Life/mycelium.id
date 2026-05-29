/**
 * Space rooms namespace — nested folders inside a shared space.
 *
 * A room is a named, optionally-described sub-area of a Space. Rooms
 * can nest (parent_id) and can have a `cover_doc_path` pointing at a
 * library HTML doc that renders as the room's "door" (the interface
 * a visitor sees when they enter). When cover_doc_path is null, the
 * portal renders an auto-generated list of contents.
 *
 * Tree queries are intentionally one-level-at-a-time — the index
 * `(space_id, parent_id)` is the hot path. A 500-room space lazy-
 * loads each level on click; we never bulk-fetch the full tree.
 *
 * Encryption: name + essence are auto-encrypted via Swiss Vault
 * (creator-keyed). cover_doc_path stays plaintext because it joins
 * to documents.path which is plaintext.
 *
 * @typedef {object} SpaceRoomsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => string} [randomUUID] — test seam
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createSpaceRoomsNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceRoomsNamespace: deps required');
  const { d1Query, firstRow, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createSpaceRoomsNamespace: d1Query required');
  }
  if (typeof firstRow !== 'function') {
    throw new TypeError('createSpaceRoomsNamespace: firstRow required');
  }

  return {
    /**
     * Create a room. parentId=null = top-level. position lets the
     * caller order siblings; default appends.
     */
    async create({ spaceId, parentId = null, name, essence = null, coverDocPath = null, position = 0, createdBy }) {
      const id = randomUUID();
      await d1Query(
        `INSERT INTO space_rooms
           (id, space_id, parent_id, name, essence, cover_doc_path, position, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, spaceId, parentId, name, essence, coverDocPath, position, createdBy],
      );
      return id;
    },

    async getById(id, spaceId) {
      const result = await d1Query(
        `SELECT * FROM space_rooms WHERE id = ? AND space_id = ?`,
        [id, spaceId],
      );
      return firstRow(result);
    },

    /**
     * List children of a parent within a space, ordered by position
     * then created_at (stable sort). parentId=null returns top-level
     * rooms. Hot path — uses `idx_space_rooms_tree`.
     */
    async listChildren(spaceId, parentId = null) {
      const sql = parentId === null
        ? `SELECT * FROM space_rooms WHERE space_id = ? AND parent_id IS NULL ORDER BY position, created_at`
        : `SELECT * FROM space_rooms WHERE space_id = ? AND parent_id = ? ORDER BY position, created_at`;
      const params = parentId === null ? [spaceId] : [spaceId, parentId];
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    /**
     * Walk up from a room to the space root, returning the breadcrumb
     * trail. Used by the portal to render "Space › Room A › Room B".
     * Bounded to 32 levels — same as the depth cap enforced on create.
     */
    async getBreadcrumb(roomId, spaceId) {
      const trail = [];
      let cursor = roomId;
      for (let i = 0; i < 32 && cursor; i++) {
        const result = await d1Query(
          `SELECT id, name, parent_id FROM space_rooms WHERE id = ? AND space_id = ?`,
          [cursor, spaceId],
        );
        const row = firstRow(result);
        if (!row) break;
        trail.unshift({ id: row.id, name: row.name });
        cursor = row.parent_id;
      }
      return trail;
    },

    async update(id, spaceId, fields) {
      const sets = [];
      const params = [];
      if (fields.name !== undefined)         { sets.push('name = ?');           params.push(fields.name); }
      if (fields.essence !== undefined)      { sets.push('essence = ?');        params.push(fields.essence); }
      if (fields.coverDocPath !== undefined) { sets.push('cover_doc_path = ?'); params.push(fields.coverDocPath); }
      if (fields.position !== undefined)     { sets.push('position = ?');       params.push(fields.position); }
      if (fields.parentId !== undefined)     { sets.push('parent_id = ?');      params.push(fields.parentId); }
      if (sets.length === 0) return;
      sets.push(`updated_at = datetime('now')`);
      params.push(id, spaceId);
      await d1Query(
        `UPDATE space_rooms SET ${sets.join(', ')} WHERE id = ? AND space_id = ?`,
        params,
      );
    },

    /**
     * Delete a room. Caller is responsible for either preventing
     * deletion of non-empty rooms or cascading — both are valid
     * policies depending on UX. Document references in
     * space_room_documents pointing at this room are NOT auto-cleaned;
     * pair with spaceRoomDocuments.removeAllByRoom() if cascading.
     */
    async delete(id, spaceId) {
      await d1Query(
        `DELETE FROM space_rooms WHERE id = ? AND space_id = ?`,
        [id, spaceId],
      );
    },

    /**
     * Quick "does this room have children?" check, used by the
     * portal's delete-room confirmation to decide whether to warn.
     */
    async hasChildren(id, spaceId) {
      const result = await d1Query(
        `SELECT 1 FROM space_rooms WHERE space_id = ? AND parent_id = ? LIMIT 1`,
        [spaceId, id],
      );
      return (result.results || []).length > 0;
    },
  };
}
