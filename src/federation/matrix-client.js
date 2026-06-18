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
 * 🔒 SECURITY INVARIANTS the real adapter MUST enforce (federation audit 2026-06-19,
 * slice 3) — they are NOT optional and cannot be added later without re-auditing:
 *   • NO trust-on-first-use key-share. The homeserver is a semi-trusted relay that
 *     can present arbitrary devices for a peer's MXID; `send` MUST NOT share a Megolm
 *     session to an unverified/unknown device. Either gate on explicit device
 *     verification (cross-signing) or set blacklistUnverifiedDevices and refuse to
 *     send until the peer device is known — otherwise a malicious HS silently reads
 *     plaintext. The contract test must assert `send` refuses before the peer has
 *     joined AND a device is known.
 *   • The senderMxid on inbound events is homeserver-controlled — resolve it to a
 *     verified space member before trusting it as source attribution (space-sync.js
 *     handleInbound currently stores it raw; that becomes a spoof vector once a real
 *     HS is in the loop).
 *   • EGRESS provenance (CLAUDE.md §11): matrix-egress.js is the ONLY sanctioned
 *     send path (allowlist + encryption-required + audit). `matrixClient.send` is
 *     membership/protocol-only — never route content through it directly. If the
 *     native agent harness is ever wired to mirror AGENT-AUTHORED free-form text into
 *     a space room, that content MUST first pass assertDeliverable (the silent-reply /
 *     trivial-content / anti-impersonation gate — see reference/egress/send-handler.js)
 *     so agent output can't reach a peer's room unfiltered.
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
