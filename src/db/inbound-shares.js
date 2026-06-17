/**
 * Inbound shares namespace — the grantee side of federation sharing. Records the
 * spaces/contexts a connected peer (A) has shared WITH me, as announced by A's
 * instance over a signed `social.mycelium.share.v1` federation message. The
 * CONTENT is never stored here; it is fetched on demand (grant-gated, signed)
 * from A's instance. `name` is ENCRYPTED at rest (ENCRYPTED_FIELDS.inbound_shares).
 *
 * @typedef {object} InboundSharesDeps
 * @property {(sql:string, params:any[])=>Promise<any>} d1Query  the ENCRYPTING query
 * @property {()=>string} [randomUUID]
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createInboundSharesNamespace(deps) {
  if (!deps) throw new TypeError('createInboundSharesNamespace: deps required');
  const { d1Query, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createInboundSharesNamespace: d1Query required');

  return {
    /**
     * Record (or update) a share a peer announced. Idempotent on
     * (connection_id, kind, remote_ref): a re-announce updates name/role/granted_at
     * and clears the revoked flag (re-grant); a fresh row starts unseen.
     * created_at is omitted (DEFAULT) so the encrypted `name` param keeps its slot.
     * @param {{connectionId:string, peerDid?:string, kind:'space'|'context', remoteRef:string, name?:string, role?:string, grantedAt?:string}} p
     */
    async upsert({ connectionId, peerDid = null, kind, remoteRef, name = null, role = null, grantedAt = null }) {
      if (!connectionId || !kind || !remoteRef) throw new Error('inbound_shares.upsert: connectionId, kind, remoteRef required');
      await d1Query(
        `INSERT INTO inbound_shares (id, connection_id, peer_did, kind, remote_ref, name, role, granted_at, revoked, seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(connection_id, kind, remote_ref) DO UPDATE SET
           peer_did   = COALESCE(excluded.peer_did, inbound_shares.peer_did),
           name       = excluded.name,
           role       = excluded.role,
           granted_at = excluded.granted_at,
           revoked    = 0`,
        [randomUUID(), connectionId, peerDid, kind, remoteRef, name, role, grantedAt],
      );
    },

    /** Mark a peer's share as revoked (A announced a revoke). */
    async revoke({ connectionId, kind, remoteRef }) {
      await d1Query(
        `UPDATE inbound_shares SET revoked = 1 WHERE connection_id = ? AND kind = ? AND remote_ref = ?`,
        [connectionId, kind, remoteRef],
      );
    },

    /** All non-revoked shares a peer granted me on this connection (name decrypts). */
    async listForConnection(connectionId) {
      const r = await d1Query(
        `SELECT id, kind, remote_ref, name, role, granted_at, peer_did, seen
         FROM inbound_shares WHERE connection_id = ? AND revoked = 0
         ORDER BY granted_at DESC, created_at DESC`,
        [connectionId],
      );
      return r.results || [];
    },

    /** Load one inbound share (for the content-fetch path). */
    async get(id) {
      const r = await d1Query(`SELECT * FROM inbound_shares WHERE id = ?`, [id]);
      return r.results?.[0] || null;
    },

    /** Count of unseen, non-revoked shares — feeds the People badge. */
    async unseenCount() {
      const r = await d1Query(`SELECT COUNT(*) AS n FROM inbound_shares WHERE seen = 0 AND revoked = 0`, []);
      return r.results?.[0]?.n || 0;
    },

    /** Mark all shares seen (called when the user opens the Shared view). */
    async markAllSeen() {
      await d1Query(`UPDATE inbound_shares SET seen = 1 WHERE seen = 0`, []);
    },

    async markSeen(id) {
      await d1Query(`UPDATE inbound_shares SET seen = 1 WHERE id = ?`, [id]);
    },
  };
}

export default createInboundSharesNamespace;
