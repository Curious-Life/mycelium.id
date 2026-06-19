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
      // LEFT JOIN both: local members live in `users`; remote-connection grantees
      // are cached in `user_profiles` (handle NULL, display_name = "handle@host").
      const result = await d1Query(
        `SELECT sa.*, COALESCE(u.display_name, up.display_name) AS display_name
         FROM space_access sa
         LEFT JOIN users u ON u.id = sa.user_id
         LEFT JOIN user_profiles up ON up.user_id = sa.user_id
         WHERE sa.space_id = ? AND sa.revoked_at IS NULL
         ORDER BY sa.created_at`,
        [spaceId],
      );
      return result.results || [];
    },

    /**
     * Grant (or re-grant) a user/connection access to a space. Idempotent on
     * (space_id, user_id): re-granting un-revokes and updates the role.
     */
    async grant(spaceId, userId, role = 'member', invitedBy = null) {
      await d1Query(
        `INSERT INTO space_access (id, space_id, user_id, role, invited_by, accepted_at, created_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role, revoked_at = NULL, accepted_at = datetime('now')`,
        [spaceId, userId, role, invitedBy],
      );
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
