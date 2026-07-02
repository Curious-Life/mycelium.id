// tests/federation-sharing.test.js — federation SHARING handlers (Tier-0d/0e).
// Security-critical: a peer can only read content that was actually shared with
// them, no embeddings ever leave the box, the response is signed, and revocation
// is honored live. No express; the handlers + the authorization resolver are the
// units under test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFederationHandlers } from '../src/federation/handlers.js';
import { buildDidDocument } from '../src/federation/did.js';
import { canonicalize } from '../src/federation/sign.js';
import { createIdentity, verifyWithPublicKey } from '../src/identity/identity.js';
import { createConnectionsNamespace } from '../src/db/connections.js';

const PEER = createIdentity({ masterHex: 'a'.repeat(64), handle: 'lo' });
const PEER_HOST = 'lo.mycelium.id';
const PEER_DID = `did:web:${PEER_HOST}`;
const LOCAL = createIdentity({ masterHex: 'b'.repeat(64), handle: 'hi' });
const LOCAL_HOST = 'hi.mycelium.id';

const fetchPeerDid = async (url, init) => {
  assert.equal(init.redirect, 'manual');
  if (url === `https://${PEER_HOST}/.well-known/did.json`) {
    return { ok: true, status: 200, async json() { return buildDidDocument(PEER_HOST, PEER.publicKeyB64); } };
  }
  return { ok: false, status: 404, async json() { return {}; } };
};

// A controllable db double. `grantState` decides resolveSharedGrant; `content`
// is what the space/context accessors return (with an embedding to prove it's
// stripped). `shares` captures inbound upserts/revokes.
function makeDb({ grantState = { granted: true, connId: 'cid', peerId: PEER_DID }, accepted = true } = {}) {
  const shares = [];
  return {
    db: {
      connections: {
        async findAcceptedByPeer() { return accepted ? 'cid' : null; },
        async resolveSharedGrant() { return grantState; },
      },
      inboundShares: {
        async upsert(p) { shares.push({ op: 'upsert', ...p }); },
        async revoke(p) { shares.push({ op: 'revoke', ...p }); },
      },
      // Legacy plaintext stores — the E2E serve no longer reads these for spaces; kept so
      // the test can prove the plaintext ('a private note') is NEVER in the served bytes.
      spaceKnowledge: { async list() { return [{ content: 'a private note', source_type: 'direct', created_at: 't', embedding_768: [0.1, 0.2] }]; } },
      spaceRoomDocuments: { async listAtRoot() { return [{ path: 'work/plan.md', title: 'Plan', summary: 'the plan', embedding_768: [0.3], centroid_256: [0.4] }]; } },
      // E2E ciphertext oplog: opaque ciphertext entries + the requester's sealed CEK grants.
      spaceOplog: {
        async listSince() { return [{ seq: 0, op_id: 'op1', author_did: PEER_DID, kind: 'content', action: 'put', item_ref: 'doc-1', gen: 0, item_lamport: 0, payload: JSON.stringify({ v: 4, kf: 'space', space_id: 'sp1', gen: 0, item_id: 'doc-1', iv: 'AAAA', ct: 'CIPHERTEXTONLY', tag: 'BBBB' }), header_sig: 'SIG' }]; },
        async getCekGrants() { return [{ gen: 0, blob: { iv: 'x', ct: 'y', tag: 'z', epk: 'e' }, seq: 0 }]; },
        async head() { return 0; },
      },
      spaces: { async get() { return { name: 'Work' }; } },
      contexts: { async getTerritories() { return [{ territory_id: 1, name: 'Rust', essence: 'systems', realm_id: 2, centroid_3d: [1, 2, 3] }]; } },
      audit: { log() { return Promise.resolve(); } },
    },
    shares,
  };
}

function handlers(db) {
  return createFederationHandlers({
    db, userId: 'me', identity: LOCAL,
    getHost: () => LOCAL_HOST, getHandle: () => 'hi',
    fetch: fetchPeerDid,
  });
}

function sign(payload) {
  return { payload, headers: { 'x-myc-did': PEER_DID, 'x-myc-sig': PEER.sign(canonicalize(payload)) } };
}
const base = (over) => ({ from_did: PEER_DID, nonce: 'n-' + Math.random(), ts: Date.now(), ...over });

describe('share announce (Tier-0d)', () => {
  it('records an announce from an ACCEPTED connection', async () => {
    const { db, shares } = makeDb();
    const r = await handlers(db).share(sign(base({ $type: 'social.mycelium.share.v1', kind: 'space', ref: 'sp1', name: 'Work', action: 'grant' })));
    assert.equal(r.status, 202);
    assert.equal(shares[0].op, 'upsert');
    assert.equal(shares[0].remoteRef, 'sp1');
  });
  it('403 when the verified peer is NOT an accepted connection', async () => {
    const { db } = makeDb({ accepted: false });
    const r = await handlers(db).share(sign(base({ $type: 'social.mycelium.share.v1', kind: 'space', ref: 'sp1', action: 'grant' })));
    assert.equal(r.status, 403);
  });
  it('401 on an unsigned request', async () => {
    const { db } = makeDb();
    const { payload } = sign(base({ $type: 'social.mycelium.share.v1', kind: 'space', ref: 'sp1' }));
    const r = await handlers(db).share({ payload, headers: {}, ip: '1.1.1.1' });
    assert.equal(r.status, 401);
  });
});

describe('shared content serve (Tier-0e) — security core', () => {
  it('403 when no live grant exists (fail-closed)', async () => {
    const { db } = makeDb({ grantState: { granted: false } });
    const r = await handlers(db).sharedContent(sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'space', ref: 'sp1' })));
    assert.equal(r.status, 403);
  });

  it('serves SIGNED, CIPHERTEXT-ONLY space content + the requester sealed grants (NO plaintext)', async () => {
    const { db } = makeDb();
    const r = await handlers(db).sharedContent(sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'space', ref: 'sp1' })));
    assert.equal(r.status, 200);
    // response is signed by US (the peer can verify it came from hi)
    assert.equal(r.did, `did:web:${LOCAL_HOST}`);
    assert.ok(verifyWithPublicKey(LOCAL.publicKeyB64, r.signedBody, r.sig), 'response signature must verify with our key');
    // §7: NO embedding/centroid/vector anywhere in the served bytes
    assert.ok(!/embedding|centroid|vector/i.test(r.signedBody), 'served payload must not contain any vector field');
    const body = JSON.parse(r.signedBody);
    // E2E: serves OPAQUE ciphertext entries + the requester's sealed CEK grants, never plaintext.
    assert.equal(body.knowledge, undefined, 'must NOT serve plaintext knowledge');
    assert.equal(body.documents, undefined, 'must NOT serve plaintext documents');
    assert.ok(!r.signedBody.includes('a private note'), 'the plaintext body must NEVER appear in the served bytes');
    assert.equal(body.entries[0].item_ref, 'doc-1');
    assert.ok(body.entries[0].payload.includes('CIPHERTEXTONLY'), 'the entry payload is opaque ciphertext');
    assert.equal(body.grants.length, 1, 'serves the requesting peer their sealed CEK grant');
    assert.equal(body.head, 0, 'serves the head cursor for incremental paging');
  });

  it('serves a vector-free context payload (no centroids)', async () => {
    const { db } = makeDb();
    const r = await handlers(db).sharedContent(sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'context', ref: 'cx1' })));
    assert.equal(r.status, 200);
    assert.ok(!/centroid|embedding|vector/i.test(r.signedBody));
    assert.equal(JSON.parse(r.signedBody).territories[0].name, 'Rust');
  });

  it('403 after the grant is revoked (live check)', async () => {
    // First granted, then resolveSharedGrant flips to not-granted (revoke).
    let granted = true;
    const db = makeDb().db;
    db.connections.resolveSharedGrant = async () => ({ granted });
    assert.equal((await handlers(db).sharedContent(sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'space', ref: 'sp1' })))).status, 200);
    granted = false;
    assert.equal((await handlers(db).sharedContent(sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'space', ref: 'sp1' })))).status, 403);
  });

  it('rejects an unsigned content request (verify gate)', async () => {
    const { db } = makeDb();
    const { payload } = sign(base({ $type: 'social.mycelium.shared-content.v1', kind: 'space', ref: 'sp1' }));
    assert.equal((await handlers(db).sharedContent({ payload, headers: {}, ip: '2.2.2.2' })).status, 401);
  });
});

describe('resolveSharedGrant — the authorization SQL (fail-closed)', () => {
  // In-memory sqlite-less double of d1Query covering the exact rows the resolver
  // reads: connections, space_access, context_grants, sharing_contexts.
  function makeResolver(rows) {
    const d1Query = async (sql, params) => {
      if (/FROM connections/.test(sql)) return { results: rows.connection ? [rows.connection] : [] };
      if (/FROM space_access/.test(sql)) return { results: rows.spaceGrant ? [{ 1: 1 }] : [] };
      if (/context_grants/.test(sql)) return { results: rows.ctxGrant ? [{ 1: 1 }] : [] };
      return { results: [] };
    };
    return createConnectionsNamespace({ d1Query });
  }
  const conn = { id: 'cid', user_a: 'me', user_b: PEER_DID };

  it('granted=true only with an accepted connection AND a live space grant', async () => {
    const ns = makeResolver({ connection: conn, spaceGrant: true });
    const r = await ns.resolveSharedGrant({ fromDid: PEER_DID, verifiedHost: PEER_HOST, toUserId: 'me', kind: 'space', ref: 'sp1' });
    assert.equal(r.granted, true);
  });
  it('granted=false when the connection is missing (unknown peer)', async () => {
    const ns = makeResolver({ connection: null, spaceGrant: true });
    assert.equal((await ns.resolveSharedGrant({ fromDid: PEER_DID, verifiedHost: PEER_HOST, toUserId: 'me', kind: 'space', ref: 'sp1' })).granted, false);
  });
  it('granted=false when the space grant is absent (revoked / never granted)', async () => {
    const ns = makeResolver({ connection: conn, spaceGrant: false });
    assert.equal((await ns.resolveSharedGrant({ fromDid: PEER_DID, verifiedHost: PEER_HOST, toUserId: 'me', kind: 'space', ref: 'sp1' })).granted, false);
  });
  it('granted=false for a private context (the SQL requires is_private=0)', async () => {
    // ctxGrant=false models the JOIN returning nothing because is_private!=0.
    const ns = makeResolver({ connection: conn, ctxGrant: false });
    assert.equal((await ns.resolveSharedGrant({ fromDid: PEER_DID, verifiedHost: PEER_HOST, toUserId: 'me', kind: 'context', ref: 'cx1' })).granted, false);
  });
});
