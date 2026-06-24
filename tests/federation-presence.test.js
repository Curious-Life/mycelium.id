// tests/federation-presence.test.js — connection presence responder (online/offline
// dot), Tier-0 federation. Verifies the fail-closed verify gate is reused, the
// share/consent + activity logic, the no-oracle `hidden`, the SIGNED + nonce-echoed
// reply, and that the audit leaks nothing beyond host+state.
// Design: docs/DESIGN-connection-presence-indicator-2026-06-18.md  (gate verify:presence)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFederationHandlers } from '../src/federation/handlers.js';
import { buildDidDocument } from '../src/federation/did.js';
import { canonicalize, verifyDetached } from '../src/federation/sign.js';
import { createIdentity } from '../src/identity/identity.js';

const SENDER = createIdentity({ masterHex: 'e'.repeat(64), handle: 'bob' });
const SENDER_HOST = 'bob.mycelium.id';
const SENDER_DID = `did:web:${SENDER_HOST}`;
const LOCAL = createIdentity({ masterHex: 'f'.repeat(64), handle: 'alice' });
const LOCAL_HOST = 'alice.mycelium.id';

const fetchSenderDid = async (url, init) => {
  assert.equal(init.redirect, 'manual');
  if (url === `https://${SENDER_HOST}/.well-known/did.json`) {
    return { ok: true, status: 200, async json() { return buildDidDocument(SENDER_HOST, SENDER.publicKeyB64); } };
  }
  return { ok: false, status: 404, async json() { return {}; } };
};
// Resolve any host to a public IP so safeFetch's assertResolvesPublic passes without
// real DNS (the env may be offline); the injected fetch then serves the did doc.
const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];

// peerResult: null → not an accepted connection; else { connId, share }.
function makeHandlers({ peerResult = { connId: 'cid', share: true }, paused = false, lastActive = null, activeWindowMin = 5, now } = {}) {
  const audit = [];
  const db = {
    connections: { async presenceShareForPeer() { return peerResult; } },
    audit: { log: (e) => { audit.push(e); return Promise.resolve(); } },
  };
  const h = createFederationHandlers({
    db, userId: 'me', identity: LOCAL,
    getHost: () => LOCAL_HOST, getHandle: () => 'alice',
    getPresenceConfig: () => ({ paused, activeWindowMin }),
    getLastActiveAt: async () => lastActive,
    fetch: fetchSenderDid, lookup: lookupPublic, now,
  });
  return { h, audit };
}

function signedQuery(now = Date.now(), over = {}) {
  const payload = { $type: 'social.mycelium.presence-query.v1', from_did: SENDER_DID, nonce: 'pn-' + Math.random(), ts: now, ...over };
  return { payload, headers: { 'x-myc-did': SENDER_DID, 'x-myc-sig': SENDER.sign(canonicalize(payload)) } };
}

// Parse + cryptographically verify a signed presence reply.
function reply(r) {
  assert.ok(r.signedBody, 'expected a signed reply body');
  assert.ok(verifyDetached(LOCAL.publicKeyB64, r.signedBody, r.sig), 'reply signature must verify against our key');
  assert.equal(r.did, LOCAL_DID());
  return JSON.parse(r.signedBody);
}
const LOCAL_DID = () => `did:web:${LOCAL_HOST}`;

describe('presence — happy path (V1/V3)', () => {
  it('online when shared + recently active; reply is signed and echoes the nonce', async () => {
    const t = 1_700_000_000_000;
    const { h, audit } = makeHandlers({ lastActive: new Date(t - 60_000).toISOString(), now: () => t });
    const { payload, headers } = signedQuery(t);
    const r = await h.presence({ payload, headers, ip: '1.1.1.1' });
    assert.equal(r.status, 200);
    const body = reply(r);
    assert.equal(body.state, 'online');
    assert.equal(body.nonce, payload.nonce, 'must echo the request nonce (anti-replay)');
    // V10 no-leak: audit carries host + state only, never the timestamp.
    assert.deepEqual(Object.keys(audit[0].details).sort(), ['peer', 'state']);
    assert.equal(audit[0].details.peer, SENDER_HOST);
    assert.equal(audit[0].action, 'presence_served');
  });

  it('offline when shared but idle beyond the window (V3)', async () => {
    const t = 1_700_000_000_000;
    const { h } = makeHandlers({ lastActive: new Date(t - 10 * 60_000).toISOString(), activeWindowMin: 5, now: () => t });
    const { payload, headers } = signedQuery(t);
    assert.equal(reply(await h.presence({ payload, headers, ip: '1.1.1.1' })).state, 'offline');
  });

  it('offline when never active (last_active_at null)', async () => {
    const t = 1_700_000_000_000;
    const { h } = makeHandlers({ lastActive: null, now: () => t });
    const { payload, headers } = signedQuery(t);
    assert.equal(reply(await h.presence({ payload, headers, ip: '1.1.1.1' })).state, 'offline');
  });
});

describe('presence — hidden has no oracle (V2/V4/V5)', () => {
  it('hidden for a non-connection (V2)', async () => {
    const t = 1_700_000_000_000;
    const { h } = makeHandlers({ peerResult: null, lastActive: new Date(t).toISOString(), now: () => t });
    const { payload, headers } = signedQuery(t);
    assert.equal(reply(await h.presence({ payload, headers, ip: '1.1.1.1' })).state, 'hidden');
  });
  it('hidden when sharing revoked (V4)', async () => {
    const t = 1_700_000_000_000;
    const { h } = makeHandlers({ peerResult: { connId: 'cid', share: false }, lastActive: new Date(t).toISOString(), now: () => t });
    const { payload, headers } = signedQuery(t);
    assert.equal(reply(await h.presence({ payload, headers, ip: '1.1.1.1' })).state, 'hidden');
  });
  it('hidden when globally paused (V5)', async () => {
    const t = 1_700_000_000_000;
    const { h } = makeHandlers({ paused: true, lastActive: new Date(t).toISOString(), now: () => t });
    const { payload, headers } = signedQuery(t);
    assert.equal(reply(await h.presence({ payload, headers, ip: '1.1.1.1' })).state, 'hidden');
  });
});

describe('presence — verify gate reuse (V6/V8)', () => {
  it('401 unsigned', async () => {
    const { h } = makeHandlers();
    const { payload } = signedQuery();
    assert.equal((await h.presence({ payload, headers: {}, ip: '1.1.1.1' })).status, 401);
  });
  it('401 tampered body', async () => {
    const { h } = makeHandlers();
    const { payload, headers } = signedQuery();
    payload.nonce = 'tampered';
    assert.equal((await h.presence({ payload, headers, ip: '1.1.1.1' })).status, 401);
  });
  it('401 stale timestamp', async () => {
    const now = 1_700_000_000_000;
    const { h } = makeHandlers({ now: () => now });
    const { payload, headers } = signedQuery(now - 10 * 60 * 1000);
    assert.equal((await h.presence({ payload, headers, ip: '1.1.1.1' })).status, 401);
  });
  it('401 replayed nonce (second use rejected)', async () => {
    const { h } = makeHandlers();
    const sp = signedQuery();
    assert.equal((await h.presence({ payload: sp.payload, headers: sp.headers, ip: '1.1.1.1' })).status, 200);
    assert.equal((await h.presence({ payload: sp.payload, headers: sp.headers, ip: '1.1.1.1' })).status, 401);
  });
  it('400 wrong $type', async () => {
    const { h } = makeHandlers();
    const { payload, headers } = signedQuery(Date.now(), { $type: 'social.mycelium.connect-request.v1' });
    // re-sign over the altered payload so it passes verify and reaches the $type check
    const headers2 = { 'x-myc-did': SENDER_DID, 'x-myc-sig': SENDER.sign(canonicalize(payload)) };
    assert.equal((await h.presence({ payload, headers: headers2, ip: '1.1.1.1' })).status, 400);
  });
  it('503 when no public host', async () => {
    const db = { connections: { async presenceShareForPeer() { return null; } } };
    const h = createFederationHandlers({ db, userId: 'me', identity: LOCAL, getHost: () => '', getHandle: () => null, fetch: fetchSenderDid, lookup: lookupPublic });
    const { payload, headers } = signedQuery();
    assert.equal((await h.presence({ payload, headers, ip: '1.1.1.1' })).status, 503);
  });
});
