/**
 * Telegram groups namespace — authorized Telegram groups per space.
 *
 * Used by the Telegram bot to gate which chats can receive agent
 * responses. revoke() sets active=0 (soft delete) so history is
 * retained.
 *
 * @typedef {object} TelegramGroupsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createTelegramGroupsNamespace(deps) {
  if (!deps) throw new TypeError('createTelegramGroupsNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createTelegramGroupsNamespace: d1Query required');

  return {
    async authorize(groupId, title, spaceId, authorizedBy) {
      await d1Query(
        `INSERT OR REPLACE INTO telegram_groups (id, title, space_id, authorized_by, authorized_at, active)
         VALUES (?, ?, ?, ?, datetime('now'), 1)`,
        [String(groupId), title || null, spaceId, authorizedBy],
      );
    },

    async revoke(groupId) {
      await d1Query(
        `UPDATE telegram_groups SET active = 0 WHERE id = ?`,
        [String(groupId)],
      );
    },

    async get(groupId) {
      const result = await d1Query(
        `SELECT * FROM telegram_groups WHERE id = ? AND active = 1`,
        [String(groupId)],
      );
      return result.results?.[0] || null;
    },

    async list(authorizedBy) {
      const result = await d1Query(
        `SELECT tg.*, u.display_name as space_name
         FROM telegram_groups tg
         LEFT JOIN users u ON u.id = tg.space_id AND u.type = 'space'
         WHERE tg.active = 1 AND tg.authorized_by = ?
         ORDER BY tg.authorized_at DESC`,
        [authorizedBy],
      );
      return result.results || [];
    },

    async updateTitle(groupId, title) {
      await d1Query(
        `UPDATE telegram_groups SET title = ? WHERE id = ? AND active = 1`,
        [title, String(groupId)],
      );
    },
  };
}
