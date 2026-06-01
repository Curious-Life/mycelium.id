/**
 * Users namespace — core user row (id, display_name, timezone, settings).
 *
 * Settings are stored as JSON blob in the `settings` column and
 * serialized on the way out. Empty settings come back as `{}`, not
 * null — consumers can always spread them.
 *
 * @typedef {object} UsersNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

export function createUsersNamespace(deps) {
  if (!deps) throw new TypeError('createUsersNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createUsersNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createUsersNamespace: firstRow required');

  return {
    async count() {
      const result = await d1Query(`SELECT COUNT(*) as count FROM users`);
      return firstRow(result)?.count || 0;
    },

    async create(id, displayName) {
      await d1Query(
        `INSERT INTO users (id, display_name) VALUES (?, ?)`,
        [id, displayName],
      );
    },

    async getTimezone(userId) {
      const result = await d1Query(`SELECT timezone FROM users WHERE id = ?`, [userId]);
      return firstRow(result)?.timezone || null;
    },

    async updateTimezone(userId, timezone) {
      await d1Query(`UPDATE users SET timezone = ? WHERE id = ?`, [timezone, userId]);
    },

    async updateSettings(userId, settings) {
      await d1Query(
        `UPDATE users SET settings = ? WHERE id = ?`,
        [JSON.stringify(settings), userId],
      );
    },

    async getSettings(userId) {
      const result = await d1Query(`SELECT settings FROM users WHERE id = ?`, [userId]);
      const raw = firstRow(result)?.settings;
      return raw ? JSON.parse(raw) : {};
    },

    /** Primary user (single-user app token auth). */
    async getFirst() {
      const result = await d1Query(
        `SELECT id, display_name, timezone, settings FROM users LIMIT 1`,
      );
      return firstRow(result);
    },
  };
}
