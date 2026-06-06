// tests/federation-handlers.test.js — Tier-0 federation handlers (no express).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFederationHandlers } from '../src/federation/handlers.js';
import { buildDidDocument } from '../src/federation/did.js';
import { canonicalize } from '../src/federation/sign.js';
import { createIdentity } from '../src/identity/identity.js';

const SENDER = createIdentity({ masterHex: 'e'.repeat(64), handle: 'bob' });
const SENDER_HOST = 'bob.mycelium.id';
const SENDER_DID = `did:web:${SENDER_HOST}`;
const LOCAL = createIdentity({ masterHex: 'f'.repeat(64), handle: 'alice' });

// fake fetch that serves the SENDER's did document for resolution
const fetchSenderDid = async (url, init) => {
  assert.equal(init.redirect, 'manual');
  if (url === `https://${SENDER_HOST}/.well-known/did.json`) {
    return { ok: true, status: 200, async json() { return buildDidDocument(SENDER_HOST, SENDER.publicKeyB64); } };
  }
  return { ok: false, status: 404, async json() { return {}; } };
};

function makeHandlers({ host = 'alice.mycelium.id', handle = 'alice', now } = {}) {
  const received = [];
  const db = { connections: { async receiveRemote(p) { received.push(p); return 'cid'; } } };
  const h = createFederationHandlers({
    db, userId: 'me', identity: LOCAL,
    getHost: () => host, getHandle: () => handle,
    fetch: fetchSenderDid, now,
  });
  return { h, received };
}

function signedPayload(now = Date.now(), over = {}) {
  const payload = {
    $type: 'social.mycelium.connect-request.v1',
    from_handle: 'bob', from_instance: SENDER_HOST, from_did: SENDER_DID,
    to_handle: 'alice', nonce: 'nonce-' + Math.random(), ts: now,
    profile: { signature: 'thinks in graphs' },
    ...over,
  };
  return { payload, headers: { 'x-myc-did': SENDER_DID, 'x-myc-sig': SENDER.sign(canonicalize(payload)) } };
}

describe('didJson / webfinger', () => {
  it('serves the did doc when a host is set, 404 otherwise', () => {
    assert.equal(makeHandlers().h.didJson().status, 200);
    assert.equal(makeHandlers({ host: '' }).h.didJson().status, 404);
  });
  it('webfinger describes our acct, 404 for foreign', () => {
    const { h } = makeHandlers();
    assert.equal(h.webfinger('acct:alice@alice.mycelium.id').status, 200);
    assert.equal(h.webfinger('acct:eve@alice.mycelium.id').status, 404);
  });
});

describe('connect', () => {
  it('503 when no public identity / host', async () => {
    const { h } = makeHandlers({ host: '' });
    const { payload, headers } = signedPayload();
    assert.equal((await h.connect({ payload, headers, ip: '1.1.1.1' })).status, 503);
  });

  it('202 for a valid signed, fresh, resolvable connect — and persists', async () => {
    const { h, received } = makeHandlers();
    const { payload, headers } = signedPayload();
    const r = await h.connect({ payload, headers, ip: '1.1.1.1' });
    assert.equal(r.status, 202);
    assert.equal(received.length, 1);
    assert.equal(received[0].fromDid, SENDER_DID);
    assert.equal(received[0].toUserId, 'me');
  });

  it('401 unsigned', async () => {
    const { h } = makeHandlers();
    const { payload } = signedPayload();
    assert.equal((await h.connect({ payload, headers: {}, ip: '1.1.1.1' })).status, 401);
  });

  it('401 on a tampered body (signature no longer matches)', async () => {
    const { h } = makeHandlers();
    const { payload, headers } = signedPayload();
    payload.to_handle = 'mallory';
    assert.equal((await h.connect({ payload, headers, ip: '1.1.1.1' })).status, 401);
  });

  it('401 stale timestamp', async () => {
    const now = 1_000_000_000_000;
    const { h } = makeHandlers({ now: () => now });
    const { payload, headers } = signedPayload(now - 10 * 60 * 1000); // 10 min old
    assert.equal((await h.connect({ payload, headers, ip: '1.1.1.1' })).status, 401);
  });

  it('401 replayed nonce (second use rejected)', async () => {
    const { h } = makeHandlers();
    const sp = signedPayload();
    assert.equal((await h.connect({ payload: sp.payload, headers: sp.headers, ip: '1.1.1.1' })).status, 202);
    assert.equal((await h.connect({ payload: sp.payload, headers: sp.headers, ip: '1.1.1.1' })).status, 401);
  });

  it('401 when header did mismatches payload from_did', async () => {
    const { h } = makeHandlers();
    const { payload, headers } = signedPayload(Date.now(), { from_did: 'did:web:evil.example' });
    assert.equal((await h.connect({ payload, headers, ip: '1.1.1.1' })).status, 401);
  });

  it('429 once the per-ip rate limit is exceeded', async () => {
    const { h } = makeHandlers();
    let last = 0;
    for (let i = 0; i < 32; i++) {
      const { payload, headers } = signedPayload();
      last = (await h.connect({ payload, headers, ip: '9.9.9.9' })).status;
    }
    assert.equal(last, 429);
  });
});
