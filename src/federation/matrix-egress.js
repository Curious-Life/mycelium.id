// src/federation/matrix-egress.js — the §11 egress chokepoint for Matrix content.
//
// Phase B B7: every piece of content that leaves the box over Matrix passes
// through here — never matrixClient.send directly. Ports the reference gate
// chain (reference/egress/send-handler.js) down to the two Matrix-only gates +
// the shared audit:
//   1. allowlist/authority — only a BOUND space room (space_matrix_rooms) is a
//      legal target. Fail-closed: an unknown room is refused, never delivered.
//   2. encryption-required — the room MUST be Megolm-encrypted. Fail-closed.
//   3. audit — an egress_audit row (sha256 hex + length only, NEVER plaintext;
//      CLAUDE.md §1/§8) records the decision for allowed AND denied.
// Membership ops (invite/kick) are NOT content egress and stay on the client.
import { createHash } from 'node:crypto';

/**
 * @param {object} deps
 * @param {import('./matrix-client.js').MatrixClient} deps.matrixClient
 * @param {object} deps.db                 needs db.spaceMatrixRooms.getByRoom + db.egressAudit.record
 * @param {string} [deps.agentId]
 */
export function createMatrixEgress({ matrixClient, db, agentId = 'personal-agent', logger = console }) {
  if (!matrixClient) throw new TypeError('createMatrixEgress: matrixClient required');
  if (!db) throw new TypeError('createMatrixEgress: db required');

  async function audit(roomId, content, decision, reason) {
    const text = JSON.stringify(content ?? null);
    try {
      await db.egressAudit?.record({
        agentId, channelId: roomId,
        contentHash: createHash('sha256').update(text).digest('hex'),
        contentLength: text.length, decision, reason,
      });
    } catch (e) { logger.warn?.(`[matrix-egress] audit failed: ${e.message}`); } // audit failure never leaks content
  }

  return {
    /**
     * Gate → audit → deliver. Returns { delivered:true, eventId } or
     * { delivered:false, reason } (already audited as 'denied').
     */
    async send(roomId, eventType, content) {
      const binding = await db.spaceMatrixRooms.getByRoom(roomId); // gate 1
      if (!binding) { await audit(roomId, content, 'denied', 'unknown-room'); return { delivered: false, reason: 'unknown-room' }; }
      if (!(await matrixClient.isRoomEncrypted(roomId))) {        // gate 2
        await audit(roomId, content, 'denied', 'room-not-encrypted');
        return { delivered: false, reason: 'room-not-encrypted' };
      }
      const eventId = await matrixClient.send(roomId, eventType, content);
      await audit(roomId, content, 'allowed', 'space-mirror');
      return { delivered: true, eventId };
    },
  };
}
