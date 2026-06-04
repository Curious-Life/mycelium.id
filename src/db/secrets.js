/**
 * Secrets namespace — encrypted key/value store for OAuth tokens, API keys,
 * connector state. Routed through SYSTEM_KEY (the `secrets` table is in
 * SYSTEM_KEY_TABLES; crypto-local.js), so `key`, `value`, `description` are
 * encrypted at rest.
 *
 * Lookup pattern: AES-GCM is non-deterministic, so the encrypted `key` column
 * can't be matched with `WHERE key = ?`. We SELECT the user's rows (the adapter
 * auto-decrypts) and match on the decrypted `key` in JS — the same approach the
 * Worker's secrets-api.ts uses. A single-user vault has few secrets, so this is
 * cheap. Mutations target the integer `id` PK (never encrypted).
 *
 * SECURITY: every query is scoped by user_id. `list()` returns metadata only,
 * never values. `value` never appears in any non-decrypting query result.
 *
 * @typedef {object} SecretsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

const norm = (a) => (a == null ? null : a);

export function createSecretsNamespace(deps) {
  if (!deps) throw new TypeError('createSecretsNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createSecretsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createSecretsNamespace: firstRow required');

  /** Fetch + decrypt the user's secrets, optionally matching key/agent in JS. */
  async function rows(userId) {
    const r = await d1Query(
      `SELECT id, key, value, scope, agent, description, version, created_at, updated_at
       FROM secrets WHERE user_id = ?`,
      [userId],
    );
    return r.results || [];
  }
  async function findRow(userId, key, agent = null) {
    const all = await rows(userId);
    return all.find((row) => row.key === key && norm(row.agent) === norm(agent)) || null;
  }

  return {
    /** Upsert a secret. value is encrypted at rest via the SYSTEM_KEY path. */
    async set(userId, { key, value, scope = 'personal', agent = null, description = null }) {
      if (!userId) throw new Error('secrets.set: userId required');
      if (!key || typeof key !== 'string') throw new Error('secrets.set: key required');
      if (typeof value !== 'string' || value.length === 0) throw new Error('secrets.set: value required');
      const existing = await findRow(userId, key, agent);
      if (existing) {
        await d1Query(
          `UPDATE secrets SET value = ?, scope = ?, description = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`,
          [value, scope, description, existing.id],
        );
        return { id: existing.id, updated: true };
      }
      const res = await d1Query(
        `INSERT INTO secrets (key, value, scope, user_id, agent, description) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [key, value, scope, userId, agent, description],
      );
      return { id: firstRow(res)?.id ?? null, updated: false };
    },

    /** Decrypted value for a key, or null. */
    async get(userId, key, agent = null) {
      const row = await findRow(userId, key, agent);
      return row ? row.value : null;
    },

    /** Whether a key is set (no value disclosure). */
    async has(userId, key, agent = null) {
      return Boolean(await findRow(userId, key, agent));
    },

    /** Metadata for all the user's secrets — NEVER values. */
    async list(userId, { prefix } = {}) {
      const all = await rows(userId);
      return all
        .filter((row) => (prefix ? typeof row.key === 'string' && row.key.startsWith(prefix) : true))
        .map(({ key, scope, agent, description, version, created_at, updated_at }) =>
          ({ key, scope, agent, description, version, created_at, updated_at }));
    },

    /** Delete a secret by key. Returns { deleted }. */
    async delete(userId, key, agent = null) {
      const row = await findRow(userId, key, agent);
      if (row) await d1Query(`DELETE FROM secrets WHERE id = ?`, [row.id]);
      return { deleted: Boolean(row) };
    },
  };
}
