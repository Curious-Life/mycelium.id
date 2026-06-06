import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockMatrixClient } from '../src/federation/matrix-client.js';
import { createSpaceSync } from '../src/federation/space-sync.js';

// A tiny in-memory db with just the namespaces space-sync touches.
function fakeDb() {
  const bindings = new Map();
  const knowledge = [];
  return {
    spaces: { async get(id) { return { id, name: `Space ${id}` }; } },
    spaceMatrixRooms: {
      async get(spaceId) { return bindings.get(spaceId) || null; },
      async getByRoom(roomId) { return [...bindings.values()].find((b) => b.room_id === roomId) || null; },
      async bind(spaceId, roomId, createdBy) { bindings.set(spaceId, { space_id: spaceId, room_id: roomId, created_by: createdBy }); },
    },
    spaceKnowledge: {
      async add(spaceId, content, src, tid, type, vis, tags, ref) { knowledge.push({ spaceId, content, src, type, ref }); return `k${knowledge.length}`; },
      async existsBySourceRef(spaceId, ref) { return !!ref && knowledge.some((k) => k.spaceId === spaceId && k.ref === ref); },
    },
    _bindings: bindings,
    _knowledge: knowledge,
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
    assert.equal((await sync.mirrorKnowledge('space1', { content: 'x' })).skipped, 'matrix-not-configured');
  });

  // ── B8 mirror ──
  test('mirrorKnowledge emits a valid knowledge.v1 to the space room', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    await sync.syncGrant('space1', 'bob@x', 'owner'); // creates the room
    const r = await sync.mirrorKnowledge('space1', { content: 'an insight', source_type: 'direct' });
    assert.equal(r.mirrored, true);
    const send = mx.calls.find((c) => c[0] === 'send');
    assert.equal(send[2], 'social.mycelium.knowledge.v1');
    assert.equal(send[3].space_ref, 'space1');
    assert.equal(send[3].content, 'an insight');
  });
  test('mirrorKnowledge skips when the space has no room yet', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    assert.equal((await sync.mirrorKnowledge('space1', { content: 'x' })).skipped, 'no-room');
    assert.equal(mx.calls.length, 0);
  });

  // ── B9 inbound ──
  test('handleInbound validates → maps room→space → persists once (dedup)', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    const g = await sync.syncGrant('space1', 'bob@x', 'owner');
    const evt = { roomId: g.roomId, eventType: 'social.mycelium.knowledge.v1', senderMxid: '@bob:hs', eventId: '$e1', content: { $type: 'social.mycelium.knowledge.v1', space_ref: 'space1', content: 'from bob' } };
    assert.equal((await sync.handleInbound(evt)).persisted, 'knowledge');
    assert.equal((await sync.handleInbound(evt)).skipped, 'duplicate'); // persist-once
    assert.equal(db._knowledge.length, 1);
    assert.equal(db._knowledge[0].content, 'from bob');
    assert.equal(db._knowledge[0].type, 'remote');
    assert.equal(db._knowledge[0].ref, 'matrix:$e1');
  });
  test('handleInbound drops an invalid lexicon record (fail closed)', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    const g = await sync.syncGrant('space1', 'bob@x', 'owner');
    const bad = { roomId: g.roomId, senderMxid: '@bob:hs', eventId: '$e2', content: { $type: 'social.mycelium.knowledge.v1', space_ref: 'space1', embedding: [0.1] } };
    assert.equal((await sync.handleInbound(bad)).skipped, 'invalid');
    assert.equal(db._knowledge.length, 0);
  });
  test('handleInbound ignores our OWN echoed events (no self re-ingest)', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs', selfMxid: '@me:hs' });
    const g = await sync.syncGrant('space1', 'bob@x', 'owner');
    const echo = { roomId: g.roomId, senderMxid: '@me:hs', eventId: '$mine', content: { $type: 'social.mycelium.knowledge.v1', space_ref: 'space1', content: 'my own entry' } };
    assert.equal((await sync.handleInbound(echo)).skipped, 'self-echo');
    assert.equal(db._knowledge.length, 0);
  });
  test('handleInbound dedup is durable (survives a fresh space-sync instance)', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const s1 = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    const g = await s1.syncGrant('space1', 'bob@x', 'owner');
    const evt = { roomId: g.roomId, senderMxid: '@bob:hs', eventId: '$dup', content: { $type: 'social.mycelium.knowledge.v1', space_ref: 'space1', content: 'once' } };
    await s1.handleInbound(evt);
    // a brand-new instance (simulating a restart — no in-memory state) still dedups via the DB
    const s2 = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    assert.equal((await s2.handleInbound(evt)).skipped, 'duplicate');
    assert.equal(db._knowledge.length, 1);
  });
  test('handleInbound drops an unknown room', async () => {
    const db = fakeDb();
    const mx = createMockMatrixClient();
    const sync = createSpaceSync({ db, matrixClient: mx, resolveMxid: async () => '@bob:hs' });
    const r = await sync.handleInbound({ roomId: '!nope:hs', eventId: '$e3', content: { $type: 'social.mycelium.knowledge.v1', space_ref: 'x', content: 'y' } });
    assert.equal(r.skipped, 'unknown-room');
  });
});
