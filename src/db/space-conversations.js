/**
 * Space conversations namespace — per-user threads inside a space.
 *
 * Tracks message counts + last-activity timestamp per (space, user)
 * pair. `getOrCreate` is idempotent — if no row exists it inserts one
 * with message_count=0 and takeaway_opt_in=1 by default.
 *
 * @typedef {object} SpaceConversationsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => string} [randomUUID] — test seam
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createSpaceConversationsNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceConversationsNamespace: deps required');
  const { d1Query, firstRow, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createSpaceConversationsNamespace: d1Query required');
  }
  if (typeof firstRow !== 'function') {
    throw new TypeError('createSpaceConversationsNamespace: firstRow required');
  }

  return {
    async getOrCreate(spaceId, userId) {
      const result = await d1Query(
        `SELECT * FROM space_conversations WHERE space_id = ? AND user_id = ?`,
        [spaceId, userId],
      );
      let conv = firstRow(result);
      if (!conv) {
        const id = randomUUID();
        await d1Query(
          `INSERT INTO space_conversations (id, space_id, user_id) VALUES (?, ?, ?)`,
          [id, spaceId, userId],
        );
        conv = { id, space_id: spaceId, user_id: userId, message_count: 0, takeaway_opt_in: 1 };
      }
      return conv;
    },

    async incrementCount(spaceId, userId) {
      await d1Query(
        `UPDATE space_conversations SET message_count = message_count + 1, last_message_at = datetime('now')
         WHERE space_id = ? AND user_id = ?`,
        [spaceId, userId],
      );
    },

    async list(spaceId, userId) {
      const result = await d1Query(
        `SELECT * FROM space_conversations WHERE space_id = ? AND user_id = ?`,
        [spaceId, userId],
      );
      return result.results || [];
    },
  };
}
