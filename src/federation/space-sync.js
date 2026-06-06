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
export function createSpaceSync({ db, matrixClient = null, resolveMxid, logger = console }) {
  if (!db) throw new TypeError('createSpaceSync: db required');

  // Get-or-create the space's Megolm room, recording the binding once.
  async function ensureRoom(spaceId, createdBy) {
    const existing = await db.spaceMatrixRooms.get(spaceId);
    if (existing) return existing.room_id;
    const space = await db.spaces.get(spaceId);
    const roomId = await matrixClient.ensureEncryptedRoom({ name: space?.name || 'Shared space' });
    await db.spaceMatrixRooms.bind(spaceId, roomId, createdBy);
    return roomId;
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
  };
}
