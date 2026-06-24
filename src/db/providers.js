/**
 * AI providers namespace — per-user credentials for Claude, OpenAI,
 * custom LLM endpoints. `auth_type` distinguishes between OAuth (via
 * `config_dir` pointing at a Claude Code session) and API-key flows.
 *
 * SECURITY: `credentials` is an encrypted column handled by the
 * auto-encrypt/decrypt layer in db-d1.js. This namespace does not
 * touch plaintext — it just shapes SELECT/INSERT/UPDATE.
 *
 * `setActive` enforces exactly one active provider per `provider` type
 * per user: deactivate siblings first, then activate the target.
 *
 * @typedef {object} ProvidersNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createProvidersNamespace(deps) {
  if (!deps) throw new TypeError('createProvidersNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createProvidersNamespace: d1Query required');

  return {
    async list(userId) {
      const result = await d1Query(
        `SELECT id, user_id, provider, label, auth_type, config_dir,
                model_preference, base_url, is_active, status, last_used_at,
                created_at, updated_at
         FROM ai_providers WHERE user_id = ? ORDER BY provider, is_active DESC, created_at`,
        [userId],
      );
      return result.results || [];
    },

    async create(userId, { provider, label, authType, credentials, configDir, model, baseUrl }) {
      const result = await d1Query(
        `INSERT INTO ai_providers (user_id, provider, label, auth_type, credentials, config_dir, model_preference, base_url, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [userId, provider, label || null, authType, credentials || null, configDir || null, model || null, baseUrl || null],
      );
      return result.meta?.last_row_id;
    },

    async update(id, userId, fields) {
      // `auth_type` is in the allowlist so the connectivity test can demote
      // a `setup-token`-shaped artifact to `auth_type='setup_token'` for
      // hard quarantine.
      const allowed = ['label', 'model_preference', 'base_url', 'status', 'credentials', 'config_dir', 'last_used_at', 'auth_type'];
      const sets = [];
      const params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return;
      sets.push("updated_at = datetime('now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    async remove(id, userId) {
      await d1Query(
        `DELETE FROM ai_providers WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
    },

    async setActive(id, userId) {
      // Activate one provider-of-type, deactivate all siblings of the
      // same type. Preserves invariant: at most one active per type.
      const target = await d1Query(
        `SELECT provider FROM ai_providers WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const row = target.results?.[0];
      if (!row) return;
      await d1Query(
        `UPDATE ai_providers SET is_active = 0, updated_at = datetime('now')
         WHERE user_id = ? AND provider = ?`,
        [userId, row.provider],
      );
      // Bump last_used_at on activate so THIS provider becomes the resolved
      // "active" one — getActive(no type) returns is_active=1 ORDER BY last_used_at
      // DESC, so choosing a provider must make it the most-recent or the UI/system
      // would keep showing whichever ran inference last (the "shows Claude 3 but
      // uses Regolo" bug). Cross-type siblings stay is_active (one per type), but
      // only the chosen one is the resolved default.
      await d1Query(
        `UPDATE ai_providers SET is_active = 1, last_used_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
    },

    /** Full row (incl. decrypted credentials) by id — for the connectivity probe. */
    async get(id, userId) {
      const result = await d1Query(
        `SELECT id, provider, label, auth_type, credentials, config_dir,
                model_preference, base_url, status, is_active
         FROM ai_providers WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      return result.results?.[0] || null;
    },

    async getActive(userId, providerType) {
      if (providerType) {
        const result = await d1Query(
          `SELECT id, provider, label, auth_type, credentials, config_dir,
                  model_preference, base_url, status
           FROM ai_providers WHERE user_id = ? AND provider = ? AND is_active = 1`,
          [userId, providerType],
        );
        return result.results?.[0] || null;
      }
      // No type specified — return any active provider, prefer most-recently-used.
      const result = await d1Query(
        `SELECT id, provider, label, auth_type, credentials, config_dir,
                model_preference, base_url, status
         FROM ai_providers WHERE user_id = ? AND is_active = 1
         ORDER BY last_used_at DESC NULLS LAST LIMIT 1`,
        [userId],
      );
      return result.results?.[0] || null;
    },
  };
}
