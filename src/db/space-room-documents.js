/**
 * Space room documents namespace — junction between rooms and the
 * library `documents` table.
 *
 * Adding a doc to a room = inserting a row here pointing at
 * `documents.path` (single source of truth — the doc itself stays
 * in the library, never duplicated). Removing = deleting the row;
 * the doc is unaffected. Same doc can be seeded into multiple rooms
 * across multiple spaces — the junction handles that naturally.
 *
 * Encryption: nothing here is encrypted. document_path is a join key
 * against documents.path (plaintext); other columns are non-sensitive
 * relational metadata (IDs, position, timestamps).
 *
 * @typedef {object} SpaceRoomDocumentsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {() => string} [randomUUID] — test seam
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createSpaceRoomDocumentsNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceRoomDocumentsNamespace: deps required');
  const { d1Query, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createSpaceRoomDocumentsNamespace: d1Query required');
  }

  return {
    /**
     * Add a doc to a space (room or root). `roomId === null` means the
     * doc is attached at the space root, alongside top-level folders.
     * Idempotent: inserts conflict on either the folder-scoped or
     * root-scoped UNIQUE index (see migration 142).
     */
    async add({ spaceId, roomId = null, documentPath, position = 0, createdBy }) {
      const id = randomUUID();
      // Two ON CONFLICT targets — folder-scoped and root-scoped — exist
      // as partial indexes. SQLite picks the relevant one based on
      // whether room_id is NULL. Catching either via DO NOTHING is fine.
      const target = roomId === null
        ? `(space_id, document_path) WHERE room_id IS NULL`
        : `(room_id, document_path) WHERE room_id IS NOT NULL`;
      await d1Query(
        `INSERT INTO space_room_documents
           (id, space_id, room_id, document_path, position, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT ${target} DO NOTHING`,
        [id, spaceId, roomId, documentPath, position, createdBy],
      );
      const lookup = roomId === null
        ? await d1Query(
            `SELECT id FROM space_room_documents
             WHERE space_id = ? AND document_path = ? AND room_id IS NULL`,
            [spaceId, documentPath],
          )
        : await d1Query(
            `SELECT id FROM space_room_documents WHERE room_id = ? AND document_path = ?`,
            [roomId, documentPath],
          );
      return lookup.results?.[0]?.id ?? id;
    },

    /**
     * List a room's documents in display order. Joins to documents
     * for title/summary/source_type so the portal can render cards
     * without a second round-trip.
     */
    async listByRoom(roomId, userId) {
      const result = await d1Query(
        `SELECT srd.id, srd.document_path AS path, srd.position, srd.created_at,
                d.title, d.summary, d.source_type, d.created_by, d.metadata, d.updated_at
         FROM space_room_documents srd
         LEFT JOIN documents d ON d.path = srd.document_path AND d.user_id = ?
         WHERE srd.room_id = ?
         ORDER BY srd.position, srd.created_at`,
        [userId, roomId],
      );
      return result.results || [];
    },

    /**
     * List space-root documents (no folder). Mirrors `listByRoom`
     * shape so the UI can render the same card grid for either level.
     */
    async listAtRoot(spaceId, userId) {
      const result = await d1Query(
        `SELECT srd.id, srd.document_path AS path, srd.position, srd.created_at,
                d.title, d.summary, d.source_type, d.created_by, d.metadata, d.updated_at
         FROM space_room_documents srd
         LEFT JOIN documents d ON d.path = srd.document_path AND d.user_id = ?
         WHERE srd.space_id = ? AND srd.room_id IS NULL
         ORDER BY srd.position, srd.created_at`,
        [userId, spaceId],
      );
      return result.results || [];
    },

    /**
     * "Where is this doc seeded?" — returns the set of (space_id,
     * room_id) pairs containing this document. Used by the library
     * card to show "seeded into 2 rooms".
     */
    async findRoomsByDocument(documentPath) {
      const result = await d1Query(
        `SELECT space_id, room_id FROM space_room_documents WHERE document_path = ?`,
        [documentPath],
      );
      return result.results || [];
    },

    async remove(id, spaceId) {
      await d1Query(
        `DELETE FROM space_room_documents WHERE id = ? AND space_id = ?`,
        [id, spaceId],
      );
    },

    /** Cascade helper for room deletion. */
    async removeAllByRoom(roomId, spaceId) {
      await d1Query(
        `DELETE FROM space_room_documents WHERE room_id = ? AND space_id = ?`,
        [roomId, spaceId],
      );
    },

    async updatePosition(id, spaceId, position) {
      await d1Query(
        `UPDATE space_room_documents SET position = ? WHERE id = ? AND space_id = ?`,
        [position, id, spaceId],
      );
    },

    /** "How many docs in this room?" — for empty-state UI. */
    async countByRoom(roomId) {
      const result = await d1Query(
        `SELECT COUNT(*) AS n FROM space_room_documents WHERE room_id = ?`,
        [roomId],
      );
      return result.results?.[0]?.n ?? 0;
    },
  };
}
