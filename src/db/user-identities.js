/**
 * User identities namespace — third-party account links (Discord, etc.).
 *
 * `link()` is idempotent — the underlying D1 statement is an UPSERT
 * keyed on (user_id, provider). `verified_at` is set to `new Date()`
 * on every call, matching pre-extraction behavior.
 *
 * @typedef {object} UserIdentitiesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for verified_at timestamp
 */

export function createUserIdentitiesNamespace(deps) {
  if (!deps) throw new TypeError('createUserIdentitiesNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createUserIdentitiesNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createUserIdentitiesNamespace: firstRow required');

  return {
    async lookupByDiscord(discordUserId) {
      const result = await d1Query(
        `SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_id = ?`,
        [discordUserId],
      );
      return firstRow(result)?.user_id || null;
    },

    async list(userId) {
      const result = await d1Query(
        `SELECT id, provider, provider_username, provider_avatar, verified_at, created_at FROM user_identities WHERE user_id = ?`,
        [userId],
      );
      return result.results || [];
    },

    async unlink(userId, provider) {
      await d1Query(
        `DELETE FROM user_identities WHERE user_id = ? AND provider = ?`,
        [userId, provider],
      );
    },

    async link(params) {
      await d1Query(
        `INSERT INTO user_identities (user_id, provider, provider_id, provider_username, provider_avatar, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           provider_id = excluded.provider_id,
           provider_username = excluded.provider_username,
           provider_avatar = excluded.provider_avatar,
           verified_at = excluded.verified_at`,
        [
          params.p_user_id,
          params.p_provider,
          params.p_provider_id,
          params.p_provider_username || null,
          params.p_provider_avatar || null,
          now().toISOString(),
        ],
      );
      return true;
    },
  };
}
