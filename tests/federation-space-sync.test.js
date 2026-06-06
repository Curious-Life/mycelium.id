import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockMatrixClient } from '../src/federation/matrix-client.js';
import { createSpaceSync } from '../src/federation/space-sync.js';

// A tiny in-memory db with just the namespaces space-sync touches.
function fakeDb() {
  const bindings = new Map();
  return {
    spaces: { async get(id) { return { id, name: `Space ${id}` }; } },
    spaceMatrixRooms: {
      async get(spaceId) { return bindings.get(spaceId) || null; },
      async bind(spaceId, roomId, createdBy) { bindings.set(spaceId, { space_id: spaceId, room_id: roomId, created_by: createdBy }); },
    },
    _bindings: bindings,
  };
}

describe('space-sync (Phase B membership orchestration)', () => {
  test('first grant lazily creates ONE encrypted room + invites the peer MXID', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs.example' });
    const r = await sync.syncGrant('space1', 'bob@bob.example', 'owner');
    assert.equal(r.invited, true);
    assert.equal(r.mxid, '@bob:hs.example');
    assert.equal(mx.calls.filter((c) => c[0] === 'ensureEncryptedRoom').length, 1);
    assert.deepEqual(await mx.roomMembers(r.roomId), ['@bob:hs.example']);
    // the binding is recorded so a second grant reuses the room
    assert.equal((await db.spaceMatrixRooms.get('space1')).room_id, r.roomId);
  });

  test('second grant reuses the existing room (no new room created)', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const mxids = { 'bob@x': '@bob:hs', 'carol@y': '@carol:hs' };
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async (id) => mxids[id] });
    const a = await sync.syncGrant('space1', 'bob@x', 'owner');
    const b = await sync.syncGrant('space1', 'carol@y', 'owner');
    assert.equal(a.roomId, b.roomId);
    assert.equal(mx.calls.filter((c) => c[0] === 'ensureEncryptedRoom').length, 1);
    assert.deepEqual((await mx.roomMembers(a.roomId)).sort(), ['@bob:hs', '@carol:hs']);
  });

  test('revoke kicks the peer from the room', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    const g = await sync.syncGrant('space1', 'bob@x', 'owner');
    await sync.syncRevoke('space1', 'bob@x');
    assert.deepEqual(await mx.roomMembers(g.roomId), []);
    assert.ok(mx.calls.some((c) => c[0] === 'kick' && c[2] === '@bob:hs'));
  });

  test('skips (no invite, no room) when the peer advertises no #matrix', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => null });
    const r = await sync.syncGrant('space1', 'bob@x', 'owner');
    assert.equal(r.skipped, 'peer-has-no-matrix');
    assert.equal(mx.calls.length, 0);
    assert.equal(await db.spaceMatrixRooms.get('space1'), null); // no room created
  });

  test('degrades safe (all no-ops) when Matrix is not configured', async () => {
    const db = fakeDb();
    const sync = createSpaceSync({ db, matrixClient: null, resolveMxid: async () => '@bob:hs' });
    assert.equal(sync.enabled, false);
    assert.equal((await sync.syncGrant('space1', 'bob@x', 'owner')).skipped, 'matrix-not-configured');
    assert.equal((await sync.syncRevoke('space1', 'bob@x')).skipped, 'matrix-not-configured');
  });
});
