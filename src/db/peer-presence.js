/**
 * Peer-presence namespace — the owner's activity heartbeat for the connection
 * online/offline indicator. (Distinct from db.publicPresence, which counts
 * anonymous "reading-now" visitors on PUBLISHED documents — unrelated.)
 *
 * Design: docs/DESIGN-connection-presence-indicator-2026-06-18.md
 *
 * "Online" = a Mycelium client has been active within the active window. The
 * portal polls /portal/* every 5–15s while the app is open, so each authenticated
 * request touches last_active_at; when the client closes, it goes stale → offline.
 * This is the cross-PROCESS bridge: the :8787 vault-auth chokepoint writes here,
 * the :4711 federation presence responder reads here, over the shared (SQLCipher)
 * DB — the two servers share no heap.
 *
 * Stored on the single-user `users` row (last_active_at TEXT). No vault content:
 * a server-generated timestamp only.
 *
 * @typedef {object} PeerPresenceNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */
export function createPeerPresenceNamespace(deps) {
  if (!deps) throw new TypeError('createPeerPresenceNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createPeerPresenceNamespace: d1Query required');
  }

  return {
    /**
     * Mark the owner active now. Called from the :8787 auth chokepoint; the caller
     * throttles (≥60s) so this is at most ~1 write/min — negligible (WAL on;
     * background_jobs already heartbeats every 10s). Pure write, no read-modify.
     */
    async touch(userId) {
      await d1Query(`UPDATE users SET last_active_at = datetime('now') WHERE id = ?`, [userId]);
    },

    /**
     * The owner's last-active timestamp (ISO/SQLite-datetime string), or null if
     * never set. Read by the federation presence responder to derive online/offline.
     */
    async lastActiveAt(userId) {
      const r = await d1Query(`SELECT last_active_at FROM users WHERE id = ?`, [userId]);
      return r.results?.[0]?.last_active_at ?? null;
    },
  };
}
