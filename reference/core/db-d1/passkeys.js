/**
 * Passkeys namespace — WebAuthn credential storage + management.
 *
 * Two read surfaces:
 *   - listByUser()        — for authentication flow (credential_id,
 *                           public_key, counter, prf_salt)
 *   - listForManagement() — for settings UI (metadata + has_prf flag)
 *
 * SECURITY: `delete()` checks (id, user_id) in the WHERE so users can
 * only delete their OWN passkeys. Returns a boolean so the handler can
 * reject if changes=0 (treat as 404 / not-found-or-not-yours).
 *
 * @typedef {object} PasskeysNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for last_used_at timestamp
 */

export function createPasskeysNamespace(deps) {
  if (!deps) throw new TypeError('createPasskeysNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createPasskeysNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createPasskeysNamespace: firstRow required');

  return {
    async listByUser(userId) {
      const result = await d1Query(
        `SELECT credential_id, public_key, counter, prf_salt FROM passkey_credentials WHERE user_id = ?`,
        [userId],
      );
      return result.results || [];
    },

    async getByCredentialId(credentialId) {
      const result = await d1Query(
        `SELECT * FROM passkey_credentials WHERE credential_id = ?`,
        [credentialId],
      );
      return firstRow(result);
    },

    async create(userId, credentialId, publicKey, counter, prfSalt = null) {
      await d1Query(
        `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, prf_salt) VALUES (?, ?, ?, ?, ?)`,
        [userId, credentialId, publicKey, counter, prfSalt],
      );
    },

    async updateCounter(credentialId, counter) {
      await d1Query(
        `UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?`,
        [counter, credentialId],
      );
    },

    async listForManagement(userId) {
      const result = await d1Query(
        `SELECT id, credential_id, name, created_at, last_used_at, prf_salt IS NOT NULL as has_prf
         FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
      );
      return result.results || [];
    },

    async touchLastUsed(credentialId) {
      await d1Query(
        `UPDATE passkey_credentials SET last_used_at = ? WHERE credential_id = ?`,
        [now().toISOString(), credentialId],
      );
    },

    async rename(id, userId, name) {
      await d1Query(
        `UPDATE passkey_credentials SET name = ? WHERE id = ? AND user_id = ?`,
        [name, id, userId],
      );
    },

    /** Returns true iff a row was actually deleted (ownership check). */
    async delete(id, userId) {
      const result = await d1Query(
        `DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      return (result?.meta?.changes || 0) > 0;
    },

    async countByUser(userId) {
      const result = await d1Query(
        `SELECT COUNT(*) as c FROM passkey_credentials WHERE user_id = ?`,
        [userId],
      );
      return firstRow(result)?.c || 0;
    },
  };
}
