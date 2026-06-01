/**
 * visitor_sessions namespace — sessions for verified-but-unbound channels.
 *
 * Distinct from `sessions` (which is FK-bound to users):
 *   - Visitor sessions reference a CHANNEL, not a user.
 *   - owner_user_id is denormalized from identity_channels at issuance for
 *     fast cookie validation; it MAY become non-null if the visitor's
 *     channel is later linked (Phase 7), but full sessions live in `sessions`.
 *   - Cookie name: mycelium_visitor_session (separate from mycelium_session).
 *
 * Per IDENTITY-CHANNELS.md §3.5.
 *
 * @typedef {object} VisitorSessionsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for expiry check
 */

export function createVisitorSessionsNamespace(deps) {
  if (!deps) throw new TypeError('createVisitorSessionsNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createVisitorSessionsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createVisitorSessionsNamespace: firstRow required');

  return {
    async create({ token, channel_kind, channel_value, owner_user_id, display_name, expires_at }) {
      await d1Query(
        `INSERT INTO visitor_sessions
           (token, channel_kind, channel_value, owner_user_id, display_name, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          token,
          channel_kind,
          channel_value,
          owner_user_id || null,
          display_name || null,
          expires_at,
        ],
      );
    },

    /** Returns active visitor session row or null. Filters expired + revoked. */
    async getByToken(token) {
      const result = await d1Query(
        `SELECT token, channel_kind, channel_value, owner_user_id, display_name,
                expires_at, created_at
         FROM visitor_sessions
         WHERE token = ?
           AND revoked_at IS NULL
           AND expires_at > ?`,
        [token, now().toISOString()],
      );
      return firstRow(result) || null;
    },

    /** Soft-revoke single token. */
    async revoke(token) {
      await d1Query(
        `UPDATE visitor_sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`,
        [now().toISOString(), token],
      );
    },

    /** Bulk soft-revoke all visitor sessions tied to a channel (used when channel binding revokes). */
    async revokeForChannel(channel_kind, channel_value) {
      await d1Query(
        `UPDATE visitor_sessions SET revoked_at = ?
         WHERE channel_kind = ? AND channel_value = ? AND revoked_at IS NULL`,
        [now().toISOString(), channel_kind, channel_value],
      );
    },

    /**
     * Sweep expired-or-revoked-N-days-ago rows. Hygiene only — visitor sessions
     * with revoked_at set or expires_at well in the past can be hard-deleted.
     * Default: 30d retention after revoke/expiry.
     */
    async purgeOlderThan(cutoff_iso) {
      await d1Query(
        `DELETE FROM visitor_sessions
         WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
            OR expires_at < ?`,
        [cutoff_iso, cutoff_iso],
      );
    },
  };
}
