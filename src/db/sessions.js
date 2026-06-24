/**
 * Sessions namespace — portal session token → user_id mapping.
 *
 * All reads are scoped to `expires_at > now()` so expired sessions
 * can't authenticate. tenant_id is nullable for owner-VPS single-user
 * mode; set to the customer's tenant id for managed instances.
 *
 * SECURITY: tokens are the ONLY credential for the portal. Any bug in
 * the expiry check would silently extend sessions. Tests assert the
 * WHERE clause shape explicitly.
 *
 * @typedef {object} SessionsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for expiry check timestamp
 */

export function createSessionsNamespace(deps) {
  if (!deps) throw new TypeError('createSessionsNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createSessionsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createSessionsNamespace: firstRow required');

  return {
    async getByToken(token) {
      const result = await d1Query(
        `SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?`,
        [token, now().toISOString()],
      );
      return firstRow(result)?.user_id || null;
    },

    async create(token, userId, expiresAt, tenantId = null) {
      await d1Query(
        `INSERT INTO sessions (token, user_id, expires_at, tenant_id) VALUES (?, ?, ?, ?)`,
        [token, userId, expiresAt, tenantId],
      );
    },

    async delete(token) {
      await d1Query(`DELETE FROM sessions WHERE token = ?`, [token]);
    },

    async getUserByToken(token) {
      const result = await d1Query(
        `SELECT s.user_id, u.display_name, u.timezone, u.settings
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = ? AND s.expires_at > ?`,
        [token, now().toISOString()],
      );
      return firstRow(result);
    },
  };
}
