// verify:federation-peer-cache — the peer keyAgreement+inbox cache (federation transport P4.5).
// A send to an ESTABLISHED peer must not re-fetch the peer's did.json every time — it caches
// the resolved inbox + seal key on the connection row and reuses them, so a DM lands even when
// the peer is fully OFFLINE (their did.json unreachable).
//   C1  first send → resolves (did.json fetched), enqueues, and CACHES on the connection row
//   C2  second send → NO did.json fetch (cache hit), still enqueues
//   C3  STALE cache + peer offline → re-resolve attempted (404) then delivers from stale cache
//   C4  dead inbox (relay rejects) → cache cleared for re-resolve; not falsely delivered
import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { createConnectionsNamespace } from '../src/db/connections.js';
import { buildDidDocument } from '../src/federation/did.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const alice = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
const bob = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'bob' });
const DID = { alice: 'did:web:alice.mycelium.id', bob: 'did:web:bob.mycelium.id' };
const bobDoc = buildDidDocument('bob.mycelium.id', bob.publicKeyB64, null, bob.keyAgreementPublicKeyB64, 'https://relay.mycelium.id');

let didJsonFetches = 0; let bobOffline = false; let enqueueFails = false; const enqueues = [];
const okJson = (o, s = 200) => ({ ok: s >= 200 && s < 300, status: s, async json() { return o; }, async text() { return JSON.stringify(o); } });
function shimFetch(urlStr, init = {}) {
  const u = new URL(urlStr); const body = init.body ? JSON.parse(init.body) : null;
  if (u.pathname === '/v1/queue/enqueue') { if (enqueueFails) return Promise.resolve(okJson({ error: 'gone' }, 404)); enqueues.push({ host: u.hostname, body }); return Promise.resolve(okJson({ ok: true, id: 'q1' })); }
  if (u.pathname === '/.well-known/did.json') { didJsonFetches++; return Promise.resolve(bobOffline ? okJson({ error: 'nf' }, 404) : okJson(bobDoc)); }
  if (u.pathname === '/.well-known/webfinger') return Promise.resolve(okJson({ links: [{ rel: 'https://mycelium.id/rel/federation', href: `https://${u.hostname}/federation` }] }));
  if (u.pathname === '/federation/message') return Promise.resolve(okJson({ ok: true }, 202));
  return Promise.resolve(okJson({}, 404));
}
const testLookup = async (h) => (/\.mycelium\.id$/.test(h) ? [{ address: '93.184.216.34', family: 4 }] : (() => { throw new Error('unmapped'); })());

// Mutable connection row (accepted) with the new cache columns.
const row = { id: 'conn-1', user_a: 'alice-user', user_b: DID.bob, status: 'accepted', remote_instance: 'bob.mycelium.id', remote_user_handle: 'bob', remote_did: DID.bob, remote_relay_inbox: null, remote_key_agreement: null, remote_keys_cached_at: null };
const fakeD1 = async (sql, params) => {
  if (/SELECT \* FROM connections WHERE id/.test(sql)) return { results: params[0] === row.id ? [row] : [] };
  if (/SELECT remote_relay_inbox, remote_key_agreement, remote_keys_cached_at FROM connections WHERE id/.test(sql)) return { results: [{ remote_relay_inbox: row.remote_relay_inbox, remote_key_agreement: row.remote_key_agreement, remote_keys_cached_at: row.remote_keys_cached_at }] };
  if (/UPDATE connections SET remote_relay_inbox = NULL/.test(sql)) { row.remote_relay_inbox = null; row.remote_key_agreement = null; row.remote_keys_cached_at = null; return { results: [] }; }
  if (/UPDATE connections SET remote_relay_inbox = \?/.test(sql)) { row.remote_relay_inbox = params[0]; row.remote_key_agreement = params[1]; row.remote_keys_cached_at = new Date().toISOString().replace('T', ' ').slice(0, 19); return { results: [] }; }
  if (/FROM user_profiles WHERE user_id/.test(sql)) return { results: [{ handle: 'alice', signature: null }] };
  return { results: [] }; // peer_messages insert/update, etc.
};
const conns = createConnectionsNamespace({
  d1Query: fakeD1, sign: (b) => alice.sign(b), did: () => DID.alice, selfInstance: () => 'alice.mycelium.id',
  selfDid: DID.alice, fetch: shimFetch, lookup: testLookup,
});

try {
  // C1 — first DM: resolves + caches
  const m1 = await conns.sendMessage('alice-user', 'conn-1', 'hi 1');
  rec('C1. first send → resolves (did.json fetched), enqueues, caches inbox + key on the row',
    m1.status === 'delivered' && didJsonFetches > 0 && enqueues.length === 1 && row.remote_relay_inbox === 'https://relay.mycelium.id' && row.remote_key_agreement === bob.keyAgreementPublicKeyB64,
    `status=${m1.status} fetches=${didJsonFetches} cachedInbox=${row.remote_relay_inbox} cachedKey=${row.remote_key_agreement === bob.keyAgreementPublicKeyB64}`);

  // C2 — second DM: cache hit, no new did.json fetch
  const fetchesBefore = didJsonFetches;
  const m2 = await conns.sendMessage('alice-user', 'conn-1', 'hi 2');
  rec('C2. second send → cache hit (NO did.json fetch), still enqueues',
    m2.status === 'delivered' && didJsonFetches === fetchesBefore && enqueues.length === 2,
    `status=${m2.status} newFetches=${didJsonFetches - fetchesBefore} enqueues=${enqueues.length}`);

  // C3 — STALE cache + peer OFFLINE: a re-resolve is ATTEMPTED (did.json fetched → 404), then it
  // falls back to the stale cache and still delivers (offline-tolerant; stale-key bounded to TTL).
  row.remote_keys_cached_at = '2000-01-01 00:00:00'; // force stale
  bobOffline = true;
  const fetchesBefore3 = didJsonFetches;
  const m3 = await conns.sendMessage('alice-user', 'conn-1', 'hi 3 while offline');
  rec('C3. stale cache + peer offline → re-resolve attempted (404) then delivers from stale cache',
    m3.status === 'delivered' && didJsonFetches > fetchesBefore3 && enqueues.length === 3,
    `status=${m3.status} reResolveAttempted=${didJsonFetches - fetchesBefore3} enqueues=${enqueues.length}`);

  // C4 — DEAD inbox: the relay rejects the enqueue → the cache is CLEARED so the next send
  // re-resolves (recovers from a moved/gone relay), and the send is not falsely 'delivered'.
  row.remote_relay_inbox = 'https://relay.mycelium.id'; row.remote_key_agreement = bob.keyAgreementPublicKeyB64;
  row.remote_keys_cached_at = new Date().toISOString().replace('T', ' ').slice(0, 19); // fresh
  bobOffline = false; enqueueFails = true;
  const m4 = await conns.sendMessage('alice-user', 'conn-1', 'hi 4 dead inbox');
  rec('C4. relay rejects enqueue → cache cleared (dead-inbox recovery); not falsely delivered',
    m4.status !== 'delivered' && row.remote_relay_inbox === null && row.remote_key_agreement === null && row.remote_keys_cached_at === null,
    `status=${m4.status} cacheCleared=${row.remote_relay_inbox === null}`);
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — peer-key cache: first resolve caches inbox+key, subsequent sends skip did.json, offline peer still reachable via cache' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
