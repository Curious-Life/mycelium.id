/**
 * OAuth states namespace — transient state + redirect_url during OAuth
 * redirects (Discord link, provider auth callbacks).
 *
 * Reads are scoped to `expires_at > now()` so expired states can't be
 * replayed. insert() accepts an arbitrary object and writes whatever
 * columns it contains — the caller is responsible for field naming.
 *
 * @typedef {object} OauthStatesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for expiry check timestamp
 */

export function createOauthStatesNamespace(deps) {
  if (!deps) throw new TypeError('createOauthStatesNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createOauthStatesNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createOauthStatesNamespace: firstRow required');

  return {
    async insert(state) {
      const cols = Object.keys(state).join(', ');
      const placeholders = Object.keys(state).map(() => '?').join(', ');
      await d1Query(
        `INSERT INTO oauth_states (${cols}) VALUES (${placeholders})`,
        Object.values(state),
      );
    },

    async validate(state, provider) {
      const result = await d1Query(
        `SELECT user_id, redirect_url FROM oauth_states WHERE state = ? AND provider = ? AND expires_at > ?`,
        [state, provider, now().toISOString()],
      );
      return firstRow(result);
    },

    async delete(state) {
      await d1Query(`DELETE FROM oauth_states WHERE state = ?`, [state]);
    },
  };
}
