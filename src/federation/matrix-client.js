// src/federation/matrix-client.js — the headless Matrix client SEAM for Phase B.
//
// The orchestration (space-sync.js, egress, inbound) depends on this small
// interface, never on matrix-js-sdk directly — so it is unit-testable against
// the in-memory MockMatrixClient here, exactly as A1b proved the real client
// works (spike/federation-a1b-matrix, 7/7). The REAL client
// (createMatrixClient, matrix-js-sdk + rust-crypto) is wired in a deploy session
// against a live homeserver; it must implement this same contract, including the
// A1b key-sharing rule (await peer join + getUserDeviceInfo before first send).
//
/**
 * @typedef {object} MatrixClient
 * @property {(opts?:{name?:string}) => Promise<string>} ensureEncryptedRoom  create a Megolm-encrypted room → roomId
 * @property {(roomId:string, mxid:string) => Promise<void>} invite
 * @property {(roomId:string, mxid:string) => Promise<void>} kick
 * @property {(roomId:string) => Promise<string[]>} roomMembers
 * @property {(roomId:string, eventType:string, content:object) => Promise<string>} send  → event id
 * @property {(handler:(e:{roomId:string,eventType:string,content:object,senderMxid:string,eventId:string})=>void) => void} onTimelineEvent
 */

/**
 * In-memory MatrixClient for tests + sandbox orchestration (no homeserver).
 * Records `calls` for assertions and tracks room membership.
 * @returns {MatrixClient & { calls: any[][], _rooms: Map<string, any> }}
 */
export function createMockMatrixClient() {
  const rooms = new Map(); // roomId → { name, encrypted, members:Set<mxid> }
  const calls = [];
  let n = 0;
  return {
    calls,
    _rooms: rooms,
    async ensureEncryptedRoom({ name } = {}) {
      const roomId = `!mock${++n}:local`;
      rooms.set(roomId, { name: name ?? null, encrypted: true, members: new Set() });
      calls.push(['ensureEncryptedRoom', roomId, name ?? null]);
      return roomId;
    },
    async invite(roomId, mxid) {
      if (!rooms.has(roomId)) throw new Error(`invite: unknown room ${roomId}`);
      rooms.get(roomId).members.add(mxid);
      calls.push(['invite', roomId, mxid]);
    },
    async kick(roomId, mxid) {
      rooms.get(roomId)?.members.delete(mxid);
      calls.push(['kick', roomId, mxid]);
    },
    async roomMembers(roomId) {
      return [...(rooms.get(roomId)?.members || [])];
    },
    async send(roomId, eventType, content) {
      if (!rooms.has(roomId)) throw new Error(`send: unknown room ${roomId}`);
      const eventId = `$evt${++n}:local`;
      calls.push(['send', roomId, eventType, content, eventId]);
      return eventId;
    },
    onTimelineEvent(handler) { this._handler = handler; },
    /** test helper: simulate an inbound timeline event reaching this client */
    _emit(e) { return this._handler?.(e); },
  };
}
