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
 * @property {(roomId:string) => Promise<boolean>} isRoomEncrypted
 * @property {(roomId:string, eventType:string, content:object) => Promise<string>} send  → event id
 * @property {(handler:(e:{roomId:string,eventType:string,content:object,senderMxid:string,eventId:string})=>void) => void} onTimelineEvent
 */

/**
 * REAL headless Matrix client (matrix-js-sdk + rust-crypto). Implements the
 * MatrixClient seam above against a live homeserver.
 *
 * ⚠️ DEPLOY-SESSION TASK — NOT YET IMPLEMENTED. This adapter cannot be validated
 * without a live homeserver, and pulling matrix-js-sdk + @matrix-org/matrix-sdk-
 * crypto-wasm into the vault dependency tree is a security-relevant decision that
 * must be made with hard evidence (a working 2-client send/receive against the
 * real server), not paper reasoning. Per docs/DESIGN-matrix-cross-machine-bringup-
 * 2026-06-16.md §4 step 2 + §8 step 2, the deploy session:
 *   1. `npm i matrix-js-sdk @matrix-org/matrix-sdk-crypto-wasm`
 *   2. implements this against the contract, with a PERSISTENT crypto store
 *      (RocksDB/sqlite — device keys MUST survive restart or all history is UTD),
 *      login from { homeserver, userId, accessToken }, startClient + initRustCrypto,
 *      and the A1b first-send rule (await peer join + getUserDeviceInfo before the
 *      first send) inside `send`.
 *   3. proves it with the §7 two-box E2E (the GO criterion).
 *
 * The boot path (server-rest.js) calls this inside try/catch: until it's
 * implemented, the throw is caught → matrixClient stays null → every Matrix op is
 * an inert no-op, exactly as when no homeserver is configured. So shipping this
 * stub is safe; it documents the contract and the deploy steps in one place.
 *
 * @param {{ homeserver:string, userId:string, accessToken:string, cryptoStorePath?:string }} _opts
 * @returns {Promise<MatrixClient>}
 */
export async function createMatrixClient(_opts = {}) {
  throw new Error(
    'createMatrixClient: real matrix-js-sdk adapter not yet implemented — '
    + 'deploy-session task (see docs/DESIGN-matrix-cross-machine-bringup-2026-06-16.md §4 step 2)',
  );
}

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
    async isRoomEncrypted(roomId) {
      return rooms.get(roomId)?.encrypted === true;
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
