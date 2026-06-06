// src/federation/space-sync.js — Phase B membership sync (B6).
//
// Turns a recorded space_access grant/revoke into Matrix room membership: the
// shared space's Megolm room is created lazily on the first grant, the granted
// peer's MXID is invited, and a revoke kicks them. Pure orchestration over the
// injected MatrixClient seam (matrix-client.js) + a resolveMxid resolver, so it
// is fully unit-testable with the mock and carries NO homeserver dependency.
//
// Degrades safe: when `matrixClient` is null (Matrix not configured — the
// sandbox / pre-deploy state), every op is a no-op. The grant is still recorded
// locally (by the caller); delivery activates the moment a real client is wired.
//
/**
 * @param {object} deps
 * @param {object} deps.db                  the wired db (needs spaceMatrixRooms, spaces)
 * @param {import('./matrix-client.js').MatrixClient|null} deps.matrixClient
 * @param {(granteeUserId:string) => Promise<string|null>} deps.resolveMxid  peer id → MXID (null if none)
 * @param {Console} [deps.logger]
 */
import { validateLexicon } from './lexicon.js';

/**
 * @param {object} deps
 * @param {string} [deps.selfMxid]  the box's own MXID — inbound events from it
 *   are our own echoes and must be ignored (we already persisted them locally).
 */
export function createSpaceSync({ db, matrixClient = null, matrixEgress = null, resolveMxid, selfMxid = null, logger = console }) {
  if (!db) throw new TypeError('createSpaceSync: db required');
  // Per-space in-flight room-creation locks: prevents two concurrent first-grants
  // from minting two rooms for one space.
  const roomLocks = new Map();

  // Get-or-create the space's Megolm room, recording the binding once. Serialized
  // per space so concurrent grants share one room.
  function ensureRoom(spaceId, createdBy) {
    const inflight = roomLocks.get(spaceId);
    if (inflight) return inflight;
    const p = (async () => {
      const existing = await db.spaceMatrixRooms.get(spaceId);
      if (existing) return existing.room_id;
      const space = await db.spaces.get(spaceId);
      const roomId = await matrixClient.ensureEncryptedRoom({ name: space?.name || 'Shared space' });
      await db.spaceMatrixRooms.bind(spaceId, roomId, createdBy);
      return roomId;
    })().finally(() => roomLocks.delete(spaceId));
    roomLocks.set(spaceId, p);
    return p;
  }

  return {
    enabled: !!matrixClient,

    /** A peer was granted access → ensure the room exists + invite their MXID. */
    async syncGrant(spaceId, granteeUserId, createdBy) {
      if (!matrixClient) return { skipped: 'matrix-not-configured' };
      let mxid;
      try { mxid = await resolveMxid(granteeUserId); }
      catch (e) { logger.warn?.(`[space-sync] MXID resolve failed: ${e.message}`); return { skipped: 'resolve-failed' }; }
      if (!mxid) return { skipped: 'peer-has-no-matrix' }; // peer advertises no #matrix → can't deliver yet
      const roomId = await ensureRoom(spaceId, createdBy);
      await matrixClient.invite(roomId, mxid);
      return { roomId, mxid, invited: true };
    },

    /** A peer's access was revoked → kick their MXID from the room. */
    async syncRevoke(spaceId, granteeUserId) {
      if (!matrixClient) return { skipped: 'matrix-not-configured' };
      const binding = await db.spaceMatrixRooms.get(spaceId);
      if (!binding) return { skipped: 'no-room' };
      let mxid;
      try { mxid = await resolveMxid(granteeUserId); }
      catch { return { skipped: 'resolve-failed' }; }
      if (!mxid) return { skipped: 'peer-has-no-matrix' };
      await matrixClient.kick(binding.room_id, mxid);
      return { roomId: binding.room_id, mxid, kicked: true };
    },

    /**
     * B8 — mirror a local knowledge entry OUT to the space's Megolm room as a
     * social.mycelium.knowledge.v1 record (best-effort; skips if no room yet).
     * Validated through the lexicon (incl. §7 tripwire) before it leaves the box.
     */
    async mirrorKnowledge(spaceId, entry) {
      if (!matrixEgress) return { skipped: 'matrix-not-configured' };
      const binding = await db.spaceMatrixRooms.get(spaceId);
      if (!binding) return { skipped: 'no-room' }; // nothing shared cross-node yet
      const record = {
        $type: 'social.mycelium.knowledge.v1',
        space_ref: spaceId,
        content: String(entry?.content ?? ''),
        ...(entry?.source_type ? { source_type: String(entry.source_type) } : {}),
        ...(entry?.source_ref ? { source_ref: String(entry.source_ref) } : {}),
      };
      const v = validateLexicon(record);
      if (!v.ok) { logger.warn?.(`[space-sync] refusing to mirror invalid record: ${v.error}`); return { skipped: 'invalid', error: v.error }; }
      // §11: content leaves ONLY through the egress chokepoint (gates + audit)
      const r = await matrixEgress.send(binding.room_id, record.$type, record);
      if (!r.delivered) return { skipped: r.reason };
      return { roomId: binding.room_id, eventId: r.eventId, mirrored: true };
    },

    /**
     * B9 — handle an INBOUND room event: validate the lexicon record, map the
     * room back to its space, and persist ONCE (dedup on event id; durable
     * source_ref='matrix:<eventId>'). Returns what it did. Fail-closed: an
     * invalid record or unknown room is dropped, never persisted.
     */
    async handleInbound({ roomId, eventType, content, senderMxid, eventId } = {}) {
      if (!eventId) return { skipped: 'no-event-id' };
      // our own echoed events were already persisted locally — never re-ingest
      if (selfMxid && senderMxid === selfMxid) return { skipped: 'self-echo' };
      const v = validateLexicon(content);
      if (!v.ok) return { skipped: 'invalid', error: v.error };
      // wire event-type, when present, must agree with the signed $type
      if (eventType && eventType !== content.$type) return { skipped: 'type-mismatch' };
      const binding = await db.spaceMatrixRooms.getByRoom(roomId);
      if (!binding) return { skipped: 'unknown-room' };
      if (content.space_ref && content.space_ref !== binding.space_id) return { skipped: 'space-mismatch' };
      const sourceRef = `matrix:${eventId}`;
      // durable persist-once: survives process restart (no in-memory-only dedup)
      if (await db.spaceKnowledge.existsBySourceRef(binding.space_id, sourceRef)) return { skipped: 'duplicate' };
      if (content.$type === 'social.mycelium.knowledge.v1') {
        // NOTE: senderMxid is the raw MXID; normalizing it to the peer's synthetic
        // id (handle@host) is a deploy-time follow-up when the MXID↔peer map exists.
        await db.spaceKnowledge.add(
          binding.space_id, content.content, senderMxid || null, null, 'remote', 'all', null, sourceRef,
        );
        return { spaceId: binding.space_id, persisted: 'knowledge' };
      }
      return { skipped: 'unhandled-type' };
    },
  };
}
