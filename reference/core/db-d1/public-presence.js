/**
 * Public-presence namespace — live "reading now" tracking.
 *
 * Each open public page heartbeats every 10s to a dedicated route.
 * The Worker INSERT-OR-REPLACEs into this table keyed by session_id
 * (a random UUID stored as a long-lived cookie). "Reading now" =
 * COUNT(*) WHERE last_beat_at > now - 30 seconds.
 *
 * Lives per-tenant (alongside documents) so the agent server can
 * read the count directly when the owner views their share-status
 * popover. The Worker writes via resolveTenantDb on each heartbeat.
 *
 * A cron trigger on the Worker (every 5 min) deletes stale rows so
 * the table stays bounded. Reads are constant-time via the
 * (user_id, public_slug, last_beat_at) index.
 *
 * No encryption — session_id is opaque, public_slug is plaintext
 * (it's a join key against documents.public_slug), timestamps are
 * server-generated.
 *
 * @typedef {object} PublicPresenceNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createPublicPresenceNamespace(deps) {
  if (!deps) throw new TypeError('createPublicPresenceNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createPublicPresenceNamespace: d1Query required');
  }

  return {
    /**
     * Record a heartbeat. INSERT OR REPLACE keyed on session_id —
     * a returning visitor's row is just refreshed, not duplicated.
     * Called from the Worker public route on each ping.
     */
    async heartbeat({ sessionId, userId, publicSlug }) {
      await d1Query(
        `INSERT INTO public_presence (session_id, user_id, public_slug, last_beat_at, first_seen_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           last_beat_at = datetime('now'),
           user_id = excluded.user_id,
           public_slug = excluded.public_slug`,
        [sessionId, userId, publicSlug],
      );
    },

    /**
     * Count sessions actively viewing a specific doc — the "reading
     * now" number shown in the owner's share-status popover. Scopes
     * by the 30-second window so a closed tab disappears within
     * 20–40s of the last heartbeat.
     */
    async countActive(userId, publicSlug) {
      const result = await d1Query(
        `SELECT COUNT(*) AS n FROM public_presence
         WHERE user_id = ? AND public_slug = ?
           AND last_beat_at > datetime('now', '-30 seconds')`,
        [userId, publicSlug],
      );
      return result.results?.[0]?.n ?? 0;
    },

    /**
     * Cron-triggered cleanup. Deletes rows that haven't beaten in
     * the last 5 minutes — generous beyond the 30s "active" window
     * so we don't churn rows for visitors who briefly background a
     * tab.
     */
    async cleanup() {
      const result = await d1Query(
        `DELETE FROM public_presence
         WHERE last_beat_at < datetime('now', '-5 minutes')`,
        [],
      );
      return result.meta?.changes ?? 0;
    },
  };
}
