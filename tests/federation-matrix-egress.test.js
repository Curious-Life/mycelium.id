import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockMatrixClient } from '../src/federation/matrix-client.js';
import { createMatrixEgress } from '../src/federation/matrix-egress.js';

function fakeDb() {
  const bindings = new Map();
  const audits = [];
  return {
    spaceMatrixRooms: { async getByRoom(roomId) { return [...bindings.values()].find((b) => b.room_id === roomId) || null; } },
    egressAudit: { async record(e) { audits.push(e); } },
    _bind(spaceId, roomId) { bindings.set(spaceId, { space_id: spaceId, room_id: roomId }); },
    _audits: audits,
  };
}

describe('matrix-egress (Phase B B7 §11 chokepoint)', () => {
  test('delivers to a bound, encrypted room and audits allowed (hash only)', async () => {
    const db = fakeDb(); const mx = createMockMatrixClient();
    const roomId = await mx.ensureEncryptedRoom({ name: 'S' });
    db._bind('space1', roomId);
    const egress = createMatrixEgress({ matrixClient: mx, db });
    const r = await egress.send(roomId, 'social.mycelium.knowledge.v1', { content: 'secret text' });
    assert.equal(r.delivered, true);
    assert.ok(r.eventId);
    const a = db._audits.at(-1);
    assert.equal(a.decision, 'allowed');
    assert.equal(a.channelId, roomId);
    assert.match(a.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(a).includes('secret text')); // never plaintext (§1/§8)
  });

  test('gate 1 — refuses an unknown (un-bound) room, audits denied, no send', async () => {
    const db = fakeDb(); const mx = createMockMatrixClient();
    const roomId = await mx.ensureEncryptedRoom(); // exists on client but NOT bound
    const egress = createMatrixEgress({ matrixClient: mx, db });
    const r = await egress.send(roomId, 't', { content: 'x' });
    assert.equal(r.delivered, false);
    assert.equal(r.reason, 'unknown-room');
    assert.equal(db._audits.at(-1).decision, 'denied');
    assert.equal(mx.calls.filter((c) => c[0] === 'send').length, 0);
  });

  test('gate 2 — refuses an unencrypted room (fail closed), audits denied', async () => {
    const db = fakeDb(); const mx = createMockMatrixClient();
    const roomId = await mx.ensureEncryptedRoom();
    mx._rooms.get(roomId).encrypted = false; // simulate a non-E2EE room
    db._bind('space1', roomId);
    const egress = createMatrixEgress({ matrixClient: mx, db });
    const r = await egress.send(roomId, 't', { content: 'x' });
    assert.equal(r.delivered, false);
    assert.equal(r.reason, 'room-not-encrypted');
    assert.equal(db._audits.at(-1).reason, 'room-not-encrypted');
    assert.equal(mx.calls.filter((c) => c[0] === 'send').length, 0);
  });
});
