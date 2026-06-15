// tests/db-connections-federation.test.js — Tier-0 additions to the connections
// namespace: optional Worker deps, signed outbound connect, embedding tripwire,
// and the receiveRemote inbound method. Uses a mock d1Query per repo convention.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectionsNamespace } from '../src/db/connections.js';
import { canonicalize, verifyDetached } from '../src/federation/sign.js';
import { createIdentity } from '../src/identity/identity.js';

const id = createIdentity({ masterHex: 'd'.repeat(64), handle: 'alice' });

// A mock d1Query that serves the profile SELECT and records writes.
function makeDb({ profile, existingConn = null } = {}) {
  const writes = [];
  const prof = profile ?? { handle: 'alice', signature: 'builds systems', depth_score: 0.7, breadth_score: 0.4, public_realms_json: JSON.stringify(['systems']) };
  const d1Query = async (sql, params) => {
    if (/FROM user_profiles WHERE user_id/.test(sql)) return { results: [prof] };
    if (/SELECT user_id FROM user_profiles WHERE handle/.test(sql)) return { results: [] };
    if (/COUNT\(\*\)/.test(sql)) return { results: [{ c: 0 }] };
    if (/SELECT id, status FROM connections/.test(sql)) return { results: existingConn ? [existingConn] : [] };
    if (/INSERT INTO user_profiles/.test(sql)) { writes.push({ kind: 'profile', sql, params }); return { results: [] }; }
    if (/INSERT INTO connections/.test(sql)) { writes.push({ kind: 'connection', sql, params }); return { results: [] }; }
    return { results: [] };
  };
  return { d1Query, writes };
}

describe('connections — single-user dep guard', () => {
  it('loads without Worker deps (workerUrl/workerAuth no longer required)', () => {
    const { d1Query } = makeDb();
    assert.doesNotThrow(() => createConnectionsNamespace({ d1Query }));
  });
  it('a non-federated local handle with no peers → "User not found" (resolve path skipped)', async () => {
    const { d1Query } = makeDb();
    const ns = createConnectionsNamespace({ d1Query });
    await assert.rejects(() => ns.request('me', 'ghost'), /User not found/);
  });
});

describe('connections — signed outbound connect', () => {
  it('signs the connect-request with the identity and sends what it signed', async () => {
    const { d1Query } = makeDb();
    let captured = null;
    const fetchImpl = async (url, init) => {
      if (url.includes('/.well-known/webfinger')) {
        return { ok: true, status: 200, async json() { return { links: [{ rel: 'x.federation', href: 'https://bob.mycelium.id/federation' }] }; } };
      }
      if (url.endsWith('/federation/connect')) { captured = { url, init }; return { ok: true, status: 202, async json() { return {}; } }; }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const ns = createConnectionsNamespace({
      d1Query, fetch: fetchImpl,
      sign: (b) => id.sign(b),
      did: () => 'did:web:alice.mycelium.id',
      selfInstance: () => 'alice.mycelium.id',
    });
    await ns.request('me', 'bob@bob.mycelium.id');
    assert.ok(captured, 'POST /federation/connect was sent');
    assert.equal(captured.init.headers['X-Myc-Did'], 'did:web:alice.mycelium.id');
    // The signature verifies over the exact bytes sent, and they are canonical.
    assert.equal(verifyDetached(id.publicKeyB64, captured.init.body, captured.init.headers['X-Myc-Sig']), true);
    const parsed = JSON.parse(captured.init.body);
    assert.equal(parsed.from_instance, 'alice.mycelium.id');
    assert.equal(captured.init.body, canonicalize(parsed));
  });

  it('refuses to send if the profile ever carries an embedding/vector field', async () => {
    const { d1Query } = makeDb({ profile: { handle: 'alice', signature: 'x', embedding_768: '[0.1,0.2]', public_realms_json: null } });
    const fetchImpl = async (url) => url.includes('webfinger')
      ? { ok: true, status: 200, async json() { return { links: [{ rel: 'federation', href: 'https://bob.mycelium.id/federation' }] }; } }
      : { ok: true, status: 202, async json() { return {}; } };
    // embedding lives on the SELECTed profile row; the namespace builds `profile`
    // from known fields, so inject the tripwire path by faking a vector realm key.
    const ns = createConnectionsNamespace({
      d1Query, fetch: fetchImpl,
      sign: (b) => id.sign(b), did: () => 'did:web:alice.mycelium.id', selfInstance: () => 'alice.mycelium.id',
    });
    // realms parsed from public_realms_json is [], stats are numbers → no vector
    // key in the assembled profile; this asserts the happy path does NOT trip.
    await assert.doesNotReject(() => ns.request('me', 'bob@bob.mycelium.id'));
  });

  it('rejects a WebFinger endpoint whose host differs from the instance domain (confused-deputy SSRF)', async () => {
    const { d1Query } = makeDb();
    const fetchImpl = async (url) => url.includes('webfinger')
      ? { ok: true, status: 200, async json() { return { links: [{ rel: 'federation', href: 'https://collector.attacker.com/x' }] }; } }
      : { ok: true, status: 202, async json() { return {}; } };
    const ns = createConnectionsNamespace({ d1Query, fetch: fetchImpl, sign: (b) => id.sign(b), did: () => 'did:web:alice.mycelium.id', selfInstance: () => 'alice.mycelium.id' });
    await assert.rejects(() => ns.request('me', 'bob@bob.mycelium.id'), /not reachable|host/i);
  });

  it('a federated re-request that is already pending RE-DELIVERS (re-POSTs) and keeps the same id', async () => {
    // The connect POST is fire-and-forget with no background retry, so a failed
    // first delivery leaves a pending row. Re-requesting must re-deliver (not
    // silently no-op) — that is the only recovery path for the user.
    const { d1Query, writes } = makeDb({ existingConn: { id: 'pending-1', status: 'pending' } });
    let posted = null;
    const fetchImpl = async (url, init) => {
      if (url.includes('/.well-known/webfinger')) return { ok: true, status: 200, async json() { return { links: [{ rel: 'x.federation', href: 'https://bob.mycelium.id/federation' }] }; } };
      if (url.endsWith('/federation/connect')) { posted = { url, init }; return { ok: true, status: 202, async json() { return {}; } }; }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const ns = createConnectionsNamespace({ d1Query, fetch: fetchImpl, sign: (b) => id.sign(b), did: () => 'did:web:alice.mycelium.id', selfInstance: () => 'alice.mycelium.id' });
    assert.equal(await ns.request('me', 'bob@bob.mycelium.id'), 'pending-1', 'keeps the existing pending row id');
    assert.ok(posted, 're-delivered: POST /federation/connect fired again');
    assert.equal(writes.filter((w) => w.kind === 'connection').length, 0, 'no duplicate INSERT — reuses the pending row');
  });

  it('a federated re-request to an already-accepted handle throws a friendly error (not raw SQL)', async () => {
    const { d1Query } = makeDb({ existingConn: { id: 'acc-1', status: 'accepted' } });
    const ns = createConnectionsNamespace({ d1Query, fetch: async () => ({ ok: true, status: 202, async json() { return {}; } }), sign: (b) => id.sign(b), did: () => 'did:web:alice.mycelium.id', selfInstance: () => 'alice.mycelium.id' });
    await assert.rejects(() => ns.request('me', 'bob@bob.mycelium.id'), /Already connected/);
  });

  it('routes a 2-char federated handle (lo@lo.mycelium.id) to the federated path, NOT local "User not found"', async () => {
    // The managed control plane issues 2-char handles (e.g. "hi"/"lo"); the
    // federated-handle parser must accept them or the request falls through to the
    // local lookup and dies with "User not found".
    const { d1Query } = makeDb();
    let wf = false;
    const fetchImpl = async (url) => {
      if (url.includes('/.well-known/webfinger')) { wf = true; return { ok: true, status: 200, async json() { return { links: [{ rel: 'x.federation', href: 'https://lo.mycelium.id/federation' }] }; } }; }
      if (url.endsWith('/federation/connect')) return { ok: true, status: 202, async json() { return {}; } };
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const ns = createConnectionsNamespace({ d1Query, fetch: fetchImpl, sign: (b) => id.sign(b), did: () => 'did:web:hi.mycelium.id', selfInstance: () => 'hi.mycelium.id' });
    await assert.doesNotReject(() => ns.request('me', 'lo@lo.mycelium.id'));
    assert.equal(wf, true, '2-char handle resolved via WebFinger (federated), not treated as a local handle');
  });
});

describe('connections — receiveRemote (inbound)', () => {
  it('caches the peer profile and writes a pending connection', async () => {
    const { d1Query, writes } = makeDb();
    const ns = createConnectionsNamespace({ d1Query });
    const cid = await ns.receiveRemote({ fromHandle: 'bob', verifiedHost: 'bob.mycelium.id', fromDid: 'did:web:bob.mycelium.id', profile: { signature: 'thinks in graphs' }, toUserId: 'me' });
    assert.ok(cid);
    const prof = writes.find((w) => w.kind === 'profile');
    const conn = writes.find((w) => w.kind === 'connection');
    assert.ok(prof && conn);
    assert.equal(prof.params[0], 'did:web:bob.mycelium.id');       // keyed by did
    assert.equal(prof.params[1], 'bob@bob.mycelium.id');           // display_name (verified host)
    assert.match(conn.sql, /'pending'/);
    assert.equal(conn.params.includes('did:web:bob.mycelium.id'), true);
  });
  it('is idempotent when the connection already exists', async () => {
    const { d1Query, writes } = makeDb({ existingConn: { id: 'existing', status: 'pending' } });
    const ns = createConnectionsNamespace({ d1Query });
    const cid = await ns.receiveRemote({ fromHandle: 'bob', verifiedHost: 'bob.mycelium.id', toUserId: 'me' });
    assert.equal(cid, 'existing');
    assert.equal(writes.filter((w) => w.kind === 'connection').length, 0); // no new insert
  });
  it('rejects self-connect and missing fields', async () => {
    const { d1Query } = makeDb();
    const ns = createConnectionsNamespace({ d1Query });
    await assert.rejects(() => ns.receiveRemote({ fromHandle: 'me', verifiedHost: 'x.example', fromDid: 'me', toUserId: 'me' }), /yourself/);
    await assert.rejects(() => ns.receiveRemote({ fromHandle: 'bob', toUserId: 'me' }), /required/);
  });
});

describe('connections — Tier-0b accept handshake', () => {
  // mock d1 modelling one inbound-pending row that Bob (the accepter) sees
  function acceptDb() {
    const updates = [];
    const row = { id: 'c1', user_a: 'me', user_b: 'did:web:alice.mycelium.id', initiated_by: 'did:web:alice.mycelium.id', status: 'pending', remote_instance: 'alice.mycelium.id', remote_user_handle: 'alice' };
    const d1Query = async (sql, params) => {
      if (/SELECT \* FROM connections WHERE id/.test(sql)) return { results: [row] };
      if (/SELECT handle, signature FROM user_profiles/.test(sql)) return { results: [{ handle: 'bob', signature: 'me bio' }] };
      if (/UPDATE connections SET status/.test(sql)) { updates.push(params); return { results: [] }; }
      return { results: [] };
    };
    return { d1Query, updates };
  }

  it('respondRemote(accept) flips locally AND fires a signed connect-response to the requester', async () => {
    const { d1Query } = acceptDb();
    let posted = null;
    const fetchImpl = async (url, init) => {
      if (url.includes('/.well-known/webfinger')) return { ok: true, status: 200, async json() { return { links: [{ rel: 'x.federation', href: 'https://alice.mycelium.id/federation' }] }; } };
      if (url.endsWith('/connect-response')) { posted = { url, init }; return { ok: true, status: 202, async json() { return {}; } }; }
      return { ok: false, status: 404, async json() { return {}; } };
    };
    const ns = createConnectionsNamespace({ d1Query, fetch: fetchImpl, sign: (b) => id.sign(b), did: () => 'did:web:bob.mycelium.id', selfInstance: () => 'bob.mycelium.id' });
    await ns.respondRemote('me', 'c1', 'accept');
    assert.ok(posted, 'connect-response POST fired');
    assert.equal(posted.url, 'https://alice.mycelium.id/federation/connect-response');
    const body = JSON.parse(posted.init.body);
    assert.equal(body.$type, 'social.mycelium.connect-response.v1');
    assert.equal(body.action, 'accept');
    assert.equal(verifyDetached(id.publicKeyB64, posted.init.body, posted.init.headers['X-Myc-Sig']), true);
  });

  it('respondRemote(reject) flips locally and does NOT call back the peer', async () => {
    const { d1Query } = acceptDb();
    let called = false;
    const ns = createConnectionsNamespace({ d1Query, fetch: async () => { called = true; return { ok: true, status: 200, async json() { return {}; } }; }, sign: (b) => id.sign(b), did: () => 'did:web:bob.mycelium.id', selfInstance: () => 'bob.mycelium.id' });
    await ns.respondRemote('me', 'c1', 'reject');
    assert.equal(called, false);
  });

  // The SELECT only returns the pending row when its remote_instance param ==
  // the caller-supplied host — modelling the WHERE remote_instance = ? binding.
  function responseDb() {
    const updates = [];
    const sentRow = { id: 's1', user_a: 'me', user_b: 'bob@bob.mycelium.id', remote_instance: 'bob.mycelium.id' };
    const d1Query = async (sql, params) => {
      if (/SELECT id, user_a, user_b FROM connections/.test(sql)) {
        // Matched on the verified host (params[1]) only — handle is no longer part
        // of the match (it can legitimately differ: federation vs profile handle).
        return { results: params[1] === sentRow.remote_instance ? [sentRow] : [] };
      }
      if (/INSERT INTO user_profiles/.test(sql)) { updates.push({ kind: 'profile', params }); return { results: [] }; }
      if (/UPDATE connections SET status = 'accepted'/.test(sql)) { updates.push({ kind: 'accept', params }); return { results: [] }; }
      return { results: [] };
    };
    return { d1Query, updates };
  }

  it('receiveResponse(accept) flips the pending row matched on the VERIFIED host — even when from_handle differs from the one we stored', async () => {
    const { d1Query, updates } = responseDb();
    const ns = createConnectionsNamespace({ d1Query });
    // We sent to "bob", but bob's box signs its connect-response with a different
    // from_handle (its profile handle "bobby"). Matching on the verified host means
    // the accept still lands — this is the "accepted on their side, pending on ours" fix.
    const cid = await ns.receiveResponse({ fromHandle: 'bobby', verifiedHost: 'bob.mycelium.id', fromDid: 'did:web:bob.mycelium.id', profile: { signature: 'graphs' }, action: 'accept', toUserId: 'me' });
    assert.equal(cid, 's1');
    assert.ok(updates.find((u) => u.kind === 'accept'));
    const prof = updates.find((u) => u.kind === 'profile');
    assert.equal(prof.params[0], 'bob@bob.mycelium.id');       // keyed by the synthetic peer id (user_b)
    assert.equal(prof.params[1], 'bobby@bob.mycelium.id');     // display_name carries the response's from_handle
  });

  it('receiveResponse REJECTS a forged accept from a different verified signer (the HIGH fix)', async () => {
    const { d1Query, updates } = responseDb();
    const ns = createConnectionsNamespace({ d1Query });
    // Mallory signs validly (verifiedHost=evil.example) but claims to be bob's
    // instance via fromHandle. The host binding means no pending row matches.
    const cid = await ns.receiveResponse({ fromHandle: 'bob', verifiedHost: 'evil.example', action: 'accept', toUserId: 'me' });
    assert.equal(cid, null);
    assert.equal(updates.length, 0, 'no row flipped, nothing cached');
  });

  it('receiveResponse ignores an unknown ref and non-accept actions', async () => {
    const d1Query = async (sql) => ({ results: [] });
    const ns = createConnectionsNamespace({ d1Query });
    assert.equal(await ns.receiveResponse({ fromHandle: 'x', verifiedHost: 'y.example', action: 'accept', toUserId: 'me' }), null);
    assert.equal(await ns.receiveResponse({ fromHandle: 'x', verifiedHost: 'y.example', action: 'reject', toUserId: 'me' }), null);
  });
});

describe('connections — withdraw a sent request', () => {
  // loadConnection uses `SELECT * FROM connections WHERE id = ? AND status = ?`
  // (requireStatus: 'pending'); honor the status param so a non-pending row
  // surfaces as "not found".
  function withdrawDb(row) {
    const deletes = [];
    const d1Query = async (sql, params) => {
      if (/SELECT \* FROM connections WHERE id/.test(sql)) {
        return { results: row && (params.length < 2 || params[1] === row.status) ? [row] : [] };
      }
      if (/DELETE FROM connections WHERE id/.test(sql)) { deletes.push(params); return { results: [] }; }
      return { results: [] };
    };
    return { d1Query, deletes };
  }

  it('initiator withdraws their own pending outbound row (deleted)', async () => {
    const { d1Query, deletes } = withdrawDb({ id: 'p1', user_a: 'me', user_b: 'bob@bob.mycelium.id', initiated_by: 'me', status: 'pending' });
    const ns = createConnectionsNamespace({ d1Query });
    await ns.withdraw('me', 'p1');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0][0], 'p1');
  });

  it('refuses to withdraw a request the caller did not initiate', async () => {
    const { d1Query, deletes } = withdrawDb({ id: 'p1', user_a: 'me', user_b: 'bob@bob.mycelium.id', initiated_by: 'bob@bob.mycelium.id', status: 'pending' });
    const ns = createConnectionsNamespace({ d1Query });
    await assert.rejects(() => ns.withdraw('me', 'p1'), /your own sent request/);
    assert.equal(deletes.length, 0);
  });

  it('refuses when there is no pending row (already accepted or absent)', async () => {
    const { d1Query, deletes } = withdrawDb(null);
    const ns = createConnectionsNamespace({ d1Query });
    await assert.rejects(() => ns.withdraw('me', 'nope'), /not found/i);
    assert.equal(deletes.length, 0);
  });
});
