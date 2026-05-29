/**
 * Space access namespace — per-user access grants to shared spaces.
 *
 * Space access is the "who can join this space" table. revoked_at
 * being non-null means the user is blocked from the space.
 *
 * @typedef {object} SpaceAccessNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createSpaceAccessNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceAccessNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createSpaceAccessNamespace: d1Query required');
  }

  return {
    async list(spaceId) {
      const result = await d1Query(
        `SELECT sa.*, u.display_name FROM space_access sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.space_id = ? AND sa.revoked_at IS NULL
         ORDER BY sa.created_at`,
        [spaceId],
      );
      return result.results || [];
    },

    async revoke(spaceId, userId) {
      await d1Query(
        `UPDATE space_access SET revoked_at = datetime('now') WHERE space_id = ? AND user_id = ?`,
        [spaceId, userId],
      );
    },

    async updateLastActive(spaceId, userId) {
      await d1Query(
        `UPDATE space_access SET last_active_at = datetime('now') WHERE space_id = ? AND user_id = ?`,
        [spaceId, userId],
      );
    },
  };
}
