/**
 * Space ⇄ Megolm room binding (Phase B). One room per shared space; the room is
 * created lazily on the first share-grant and torn down via the orchestration.
 * Thin namespace (mirrors space-access.js) — pure storage, no Matrix here.
 *
 * @typedef {object} SpaceMatrixRoomsDeps
 * @property {(sql:string, params:any[]) => Promise<any>} d1Query
 * @property {(res:any) => any} [firstRow]
 */
export function createSpaceMatrixRoomsNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceMatrixRoomsNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createSpaceMatrixRoomsNamespace: d1Query required');
  const one = (res) => (firstRow ? firstRow(res) : (res.results?.[0] || null));

  return {
    /** The room bound to a space, or null. */
    async get(spaceId) {
      return one(await d1Query(
        `SELECT space_id, room_id, created_by, created_at FROM space_matrix_rooms WHERE space_id = ?`,
        [spaceId],
      ));
    },
    /** The space bound to a room (reverse lookup for inbound events), or null. */
    async getByRoom(roomId) {
      return one(await d1Query(
        `SELECT space_id, room_id, created_by, created_at FROM space_matrix_rooms WHERE room_id = ?`,
        [roomId],
      ));
    },
    /** Bind (idempotent on space_id) — first grant creates the room then records it. */
    async bind(spaceId, roomId, createdBy) {
      await d1Query(
        `INSERT INTO space_matrix_rooms (space_id, room_id, created_by) VALUES (?, ?, ?)
         ON CONFLICT(space_id) DO UPDATE SET room_id = excluded.room_id`,
        [spaceId, roomId, createdBy],
      );
    },
    /** Remove the binding (e.g. space deleted). */
    async unbind(spaceId) {
      await d1Query(`DELETE FROM space_matrix_rooms WHERE space_id = ?`, [spaceId]);
    },
  };
}
