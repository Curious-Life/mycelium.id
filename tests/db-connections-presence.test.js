// tests/db-connections-presence.test.js — outbound presence querier (queryPresence):
// the full sign-request / verify-signed-reply path and the render mapping incl. the
// load-bearing "unreachable → grey if last-known-shared, else no dot" (gate V7).
// Design: docs/DESIGN-connection-presence-indicator-2026-06-18.md
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectionsNamespace } from '../src/db/connections.js';
import { buildDidDocument } from '../src/federation/did.js';
import { canonicalize } from '../src/federation/sign.js';
import { createIdentity } from '../src/identity/identity.js';

const PEER = createIdentity({ masterHex: 'a'.repeat(64), handle: 'bob' });
const PEER_HOST = 'bob.mycelium.id';
const PEER_DID = `did:web:${PEER_HOST}`;
const ME = createIdentity({ masterHex: 'b'.repeat(64), handle: 'alice' });
const ME_HOST = 'alice.mycelium.id';

const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];

// One accepted remote connection row, shaped as connections.list() returns it.
const CONN = { id: 'conn1', remote_instance: PEER_HOST, remote_user_handle: 'bob', remote_did: PEER_DID, status: 'accepted' };

// d1Query stub: list() (the only query queryPresence issues) returns our one row.
function d1QueryStub() {
  return async (sql) => {
    if (/FROM connections/i.test(sql) && /accepted/i.test(sql)) return { results: [CONN] };
    return { results: [] };
  };
}

// fetch stub: serves WebFinger + the peer did.json + a signed /presence reply whose
// `state` is `replyState`. `unreachable:true` makes the /presence POST throw.
function makeFetch({ replyState = 'online', unreachable = false } = {}) {
  return async (url, init = {}) => {
    if (url.includes('/.well-known/webfinger')) {
      return { ok: true, status: 200, async json() { return { links: [{ rel: ['federation'], href: `https://${PEER_HOST}/federation` }] }; } };
    }
    if (url === `https://${PEER_HOST}/.well-known/did.json`) {
      return { ok: true, status: 200, async json() { return buildDidDocument(PEER_HOST, PEER.publicKeyB64); } };
    }
    if (url === `https://${PEER_HOST}/federation/presence`) {
      if (unreachable) throw new Error('ECONNREFUSED');
      const reqNonce = JSON.parse(init.body).nonce;
      const body = { state: replyState, nonce: reqNonce, ts: Date.now() }; // echo nonce
      const raw = canonicalize(body);
      const headers = new Map([['x-myc-did', PEER_DID], ['x-myc-sig', PEER.sign(raw)]]);
      return { ok: true, status: 200, headers: { get: (k) => headers.get(k.toLowerCase()) }, async text() { return raw; } };
    }
    return { ok: false, status: 404, headers: { get: () => null }, async text() { return ''; } };
  };
}

function makeConns(fetchImpl, now = () => Date.now()) {
  return createConnectionsNamespace({
    d1Query: d1QueryStub(),
    sign: (s) => ME.sign(s), did: () => `did:web:${ME_HOST}`, selfInstance: () => ME_HOST,
    fetch: fetchImpl, lookup: lookupPublic, now,
  });
}

describe('queryPresence — render mapping', () => {
  it('online reply → green (online)', async () => {
    const c = makeConns(makeFetch({ replyState: 'online' }));
    assert.equal((await c.queryPresence('me'))[CONN.id], 'online');
  });

  it('offline reply → grey (offline)', async () => {
    const c = makeConns(makeFetch({ replyState: 'offline' }));
    assert.equal((await c.queryPresence('me'))[CONN.id], 'offline');
  });

  it('hidden reply → no dot (none)', async () => {
    const c = makeConns(makeFetch({ replyState: 'hidden' }));
    assert.equal((await c.queryPresence('me'))[CONN.id], 'none');
  });

  it('unreachable on first contact → no dot (none)', async () => {
    const c = makeConns(makeFetch({ unreachable: true }));
    assert.equal((await c.queryPresence('me'))[CONN.id], 'none');
  });

  it('result map is memoized within the TTL (no re-query)', async () => {
    let calls = 0;
    const c = makeConns(async (url, init) => { if (url.endsWith('/presence')) calls++; return makeFetch({ replyState: 'online' })(url, init); });
    await c.queryPresence('me');
    await c.queryPresence('me'); // within 45s → served from memo
    assert.equal(calls, 1, 'second call within TTL must not re-query the peer');
  });

  it('V7: unreachable AFTER a known-shared contact → grey (offline), not gone', async () => {
    // Reachable+online once (seeds last-known-shared); advance past the 45s memo;
    // peer now unreachable → must map to grey (offline), not vanish (none).
    let down = false;
    let clock = 1_700_000_000_000;
    const c = makeConns((url, init) => makeFetch({ replyState: 'online', unreachable: down })(url, init), () => clock);
    assert.equal((await c.queryPresence('me'))[CONN.id], 'online'); // seeds last-known-shared=true
    down = true;
    clock += 60_000; // past PRESENCE_RESULT_TTL_MS (45s) → re-query
    assert.equal((await c.queryPresence('me'))[CONN.id], 'offline'); // grey, from last-known-shared
  });

  it('V7b: unreachable AFTER a hidden contact → no dot (none)', async () => {
    let down = false;
    let clock = 1_700_000_000_000;
    const c = makeConns((url, init) => makeFetch({ replyState: 'hidden', unreachable: down })(url, init), () => clock);
    assert.equal((await c.queryPresence('me'))[CONN.id], 'none'); // last-known-shared=false
    down = true;
    clock += 60_000;
    assert.equal((await c.queryPresence('me'))[CONN.id], 'none'); // stays gone
  });
});
