/**
 * Connectors namespace — operational STATE for a data connection (gmail/linear/
 * mock). The dedicated `connectors` table (migration 0008) replaces the old
 * `connector:<id>:state` secret blob: structural columns (id/provider/status/
 * cursor/counts/timestamps) stay PLAINTEXT so the scheduler can enumerate +
 * filter without an O(all-secrets) decrypt; the user-describing columns
 * (`account_label`, `last_error`, `recent_runs`) are ENCRYPTED at rest via the
 * auto-encrypt layer (ENCRYPTED_FIELDS.connectors, USER_MASTER_KEY).
 *
 * SECURITY / encryption-layer contract (see crypto-local.js):
 *   - We NEVER use `INSERT … ON CONFLICT DO UPDATE` here: the auto-encrypt
 *     parser only encrypts an INSERT's VALUES group, NOT a DO UPDATE SET clause,
 *     so an upsert would write the SET params (account_label/last_error/
 *     recent_runs) as PLAINTEXT. `put()` does an explicit SELECT → INSERT|UPDATE
 *     (the ai_providers pattern), each of which the parser encrypts correctly.
 *   - INSERT omits created_at/updated_at (DB DEFAULTs apply): a `datetime('now')`
 *     literal inside VALUES would truncate the parser's VALUES regex at its inner
 *     ')'. UPDATE sets `updated_at = datetime('now')` in SET, which the UPDATE
 *     parser splits paren-aware → safe.
 *   - SET/INSERT param order is fixed (COLS order) so encrypted-column param
 *     indices line up with what the parser computes.
 *   - `list()` is metadata-only: it NEVER selects the encrypted PII columns.
 *
 * Tokens + transient OAuth (oauthState/pkceVerifier) do NOT live here — they stay
 * in the encrypted `secrets` table (store.js). See
 * docs/DESIGN-connectors-tier2-2026-06-04.md §3.
 *
 * @typedef {object} ConnectorsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

// Canonical column order for INSERT (created_at/updated_at intentionally omitted
// — DB DEFAULTs). The encrypted columns (account_label, last_error, recent_runs)
// must keep their position so the auto-encrypt param indices align.
const COLS = [
  'id', 'user_id', 'provider', 'account_label', 'status', 'cursor',
  'connected_at', 'last_sync_at', 'last_ok_at', 'last_error_at', 'last_error',
  'idle_streak', 'items_last_sync', 'items_created', 'items_updated', 'items_deduped',
  'budget_date', 'items_today', 'recent_runs',
];

// Full read projection (incl. encrypted cols — auto-decrypted by the adapter).
const READ_COLS = [...COLS, 'created_at', 'updated_at'].join(', ');

// Metadata-only projection — NEVER includes the encrypted PII columns.
const META_COLS = [
  'id', 'user_id', 'provider', 'status', 'cursor',
  'connected_at', 'last_sync_at', 'last_ok_at', 'last_error_at',
  'idle_streak', 'items_last_sync', 'items_created', 'items_updated', 'items_deduped',
  'budget_date', 'items_today', 'created_at', 'updated_at',
].join(', ');

export function createConnectorsNamespace(deps) {
  if (!deps) throw new TypeError('createConnectorsNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createConnectorsNamespace: d1Query required');

  return {
    /** Full row (incl. decrypted PII) by id, scoped to the user. */
    async get(userId, id) {
      const r = await d1Query(
        `SELECT ${READ_COLS} FROM connectors WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      return r.results?.[0] || null;
    },

    /**
     * Full-replace persist of a connector row. `row` is keyed by COLUMN name
     * (snake_case); absent columns are written as NULL. Explicit SELECT →
     * INSERT|UPDATE (never ON CONFLICT) so the auto-encrypt layer encrypts the
     * PII columns in both branches. id/user_id come from args, not `row`.
     */
    async put(userId, id, row) {
      const exists = await d1Query(
        `SELECT id FROM connectors WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const val = (c) => {
        if (c === 'id') return id;
        if (c === 'user_id') return userId;
        return row[c] ?? null;
      };
      if (exists.results?.[0]) {
        // UPDATE every column except the identity/created keys. Param order =
        // SET columns (mutable, in COLS order) then WHERE (id, user_id).
        const mutable = COLS.filter((c) => c !== 'id' && c !== 'user_id');
        const sets = mutable.map((c) => `${c} = ?`).join(', ');
        const params = mutable.map(val);
        params.push(id, userId);
        await d1Query(
          `UPDATE connectors SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
          params,
        );
      } else {
        await d1Query(
          `INSERT INTO connectors (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`,
          COLS.map(val),
        );
      }
    },

    async remove(userId, id) {
      await d1Query(`DELETE FROM connectors WHERE id = ? AND user_id = ?`, [id, userId]);
    },

    /** All connector ids for the user (the scheduler's enumeration). */
    async listIds(userId) {
      const r = await d1Query(`SELECT id FROM connectors WHERE user_id = ?`, [userId]);
      return (r.results || []).map((x) => x.id);
    },

    /** Metadata-only rows — never returns the encrypted PII columns. */
    async list(userId) {
      const r = await d1Query(
        `SELECT ${META_COLS} FROM connectors WHERE user_id = ? ORDER BY provider, id`,
        [userId],
      );
      return r.results || [];
    },
  };
}
