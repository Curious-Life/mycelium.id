// verify:federation-wire — the connections.js egress routing (federation transport P3b-2b):
// requestRemote/sendMessage route a connect/message through the RelayQueue (seal→enqueue)
// when the peer advertises a #relay-inbox, else the direct box→box HTTP path.
//   W1  peer advertises #relay-inbox → request() ENQUEUES a sealed envelope; the peer's
//       /federation/connect is NEVER called (async store-and-forward, box may be offline)
//   W2  the enqueued envelope opens with the recipient's identity → the connect-request;
//       zero-knowledge (no sender handle plaintext on the wire)
//   W3  peer with NO #relay-inbox → request() falls back to a direct /federation/connect POST
//   W4  a live DM to a relay-capable connection also routes via the queue
//   W5  the relay is DOWN (enqueue 404) → delivery falls back to direct HTTP and succeeds
//   W6  relay AND direct both down → honest transient error, never a false "no user found"
//
// MUTATION-TESTED: reverting the relay→direct fall-through in federationDeliver
//   (`relayError = e` back to `throw e`, src/db/connections.js) → W5 REDs.
// MUTATION-TESTED: removing the `!res.ok` delivery check in transport.send
//   (src/federation/transport.js) → W6 REDs (the 502 reads as delivered, nothing throws).
// Both restored → GO. Run 2026-07-27; W5/W6 were written against the live production
// failure (a control plane serving no /v1/queue/*, which took federation down for ~9 days).
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { createConnectionsNamespace } from '../src/db/connections.js';
import { buildDidDocument } from '../src/federation/did.js';
import { openEnvelope } from '../src/federation/envelope.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const alice = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
const bob = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'bob' });
const carol = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'carol' });
const DID = { alice: 'did:web:alice.mycelium.id', bob: 'did:web:bob.mycelium.id', carol: 'did:web:carol.mycelium.id' };
const RESOLVE = { [DID.bob]: bob.publicKeyB64, [DID.alice]: alice.publicKeyB64, [DID.carol]: carol.publicKeyB64 };

// DID docs: Bob advertises a #relay-inbox (relay-capable); Carol does not (direct-only).
const DOCS = {
  'bob.mycelium.id': buildDidDocument('bob.mycelium.id', bob.publicKeyB64, null, bob.keyAgreementPublicKeyB64, 'https://relay.mycelium.id'),
  'carol.mycelium.id': buildDidDocument('carol.mycelium.id', carol.publicKeyB64, null, carol.keyAgreementPublicKeyB64),
};

const captured = { enqueues: [], directConnects: [] };
// Fault injection for W5/W6 (the relay-outage fallback). `relayDown` makes the relay's
// /v1/queue/enqueue answer 404 — exactly what a control plane running a build without
// /v1/queue/* returns, the real-world condition that took federation down. `directDown`
// additionally fails the peer's own /federation/connect.
const fault = { relayDown: false, directDown: false };
const okJson = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } });
const notFound = () => okJson({ error: 'nf' }, 404);
function shimFetch(urlStr, init = {}) {
  const u = new URL(urlStr);
  const body = init.body ? JSON.parse(init.body) : null;
  if (u.pathname === '/v1/queue/enqueue') {
    captured.enqueues.push({ host: u.hostname, body });
    if (fault.relayDown) return Promise.resolve(notFound()); // relay without /v1/queue/* mounted
    return Promise.resolve(okJson({ ok: true, id: 'q1' }));
  }
  if (u.pathname === '/federation/connect') {
    captured.directConnects.push({ host: u.hostname });
    if (fault.directDown) return Promise.resolve(okJson({ error: 'down' }, 502));
    return Promise.resolve(okJson({ ok: true }, 202));
  }
  if (u.pathname === '/.well-known/did.json') { const d = DOCS[u.hostname]; return Promise.resolve(d ? okJson(d) : notFound()); }
  if (u.pathname === '/.well-known/webfinger') { // for the direct fallback (Carol)
    return Promise.resolve(okJson({ subject: `acct:${u.searchParams.get('resource')}`, links: [{ rel: 'https://mycelium.id/rel/federation', href: `https://${u.hostname}/federation` }] }));
  }
  return Promise.resolve(notFound());
}
const testLookup = async (host) => (/\.mycelium\.id$/.test(host) ? [{ address: '93.184.216.34', family: 4 }] : (() => { throw new Error(`unmapped ${host}`); })());

// Alice's connections namespace (the SENDER). Fake D1: no existing conn, alice's profile, capture inserts.
const inserts = [];
const fakeD1 = async (sql, params) => {
  if (/SELECT id, status FROM connections/.test(sql)) return { results: [] };
  if (/COUNT\(\*\) as c FROM connections/.test(sql)) return { results: [{ c: 0 }] };
  if (/FROM user_profiles WHERE user_id/.test(sql)) return { results: [{ handle: 'alice', signature: null, depth_score: 1, breadth_score: 1, public_realms_json: null }] };
  if (/INSERT INTO connections/.test(sql)) { inserts.push(params); return { results: [] }; }
  if (/INSERT INTO peer_messages/.test(sql) || /UPDATE peer_messages/.test(sql)) return { results: [] };
  if (/SELECT \* FROM connections WHERE id/.test(sql)) return { results: [{ id: params[0], user_a: 'alice-user', user_b: DID.bob, status: 'accepted', remote_instance: 'bob.mycelium.id', remote_user_handle: 'bob', remote_did: DID.bob }] };
  return { results: [] };
};
const conns = createConnectionsNamespace({
  d1Query: fakeD1, sign: (b) => alice.sign(b), did: () => DID.alice, selfInstance: () => 'alice.mycelium.id',
  selfDid: DID.alice, fetch: shimFetch, lookup: testLookup,
});

try {
  // W1 — relay-capable peer → enqueue, no direct connect
  await conns.request('alice-user', 'bob@bob.mycelium.id');
  const enq = captured.enqueues.find((e) => e.host === 'relay.mycelium.id');
  rec('W1. relay-capable peer → sealed envelope ENQUEUED; peer /federation/connect NEVER called',
    !!enq && enq.body?.recipient === 'bob' && captured.directConnects.filter((d) => d.host === 'bob.mycelium.id').length === 0,
    `enqueued=${!!enq} recipient=${enq?.body?.recipient} directConnects=${captured.directConnects.length}`);

  // W2 — the enqueued envelope opens with Bob's identity → the connect-request. SEALED-SENDER:
  // the payload content AND the sender_did are both off the wire — the relay learns neither.
  const env = JSON.parse(enq.body.envelope);
  const opened = await openEnvelope(env, { identity: bob, resolvePeerKey: (d) => RESOLVE[d], expectedTo: DID.bob });
  const contentEncrypted = !enq.body.envelope.includes('"from_handle":"alice"') && !enq.body.envelope.includes('a mind');
  const senderHidden = env.sender_did === undefined && !enq.body.envelope.includes(DID.alice); // sealed-sender
  rec('W2. envelope opens → connect-request; SEALED-SENDER (content + sender_did both off the wire)',
    opened.payload.$type === 'social.mycelium.connect-request.v1' && opened.senderDid === DID.alice && contentEncrypted && senderHidden,
    `type=${opened.payload.$type} contentEnc=${contentEncrypted} senderHidden=${senderHidden}`);

  // W3 — non-relay peer (Carol) → direct /federation/connect, no enqueue
  captured.enqueues.length = 0; captured.directConnects.length = 0;
  await conns.request('alice-user', 'carol@carol.mycelium.id');
  rec('W3. peer without #relay-inbox → direct /federation/connect (no enqueue)',
    captured.directConnects.some((d) => d.host === 'carol.mycelium.id') && captured.enqueues.length === 0,
    `directConnects=${captured.directConnects.length} enqueues=${captured.enqueues.length}`);

  // W4 — a live DM to a relay-capable connection also routes via the queue
  captured.enqueues.length = 0; captured.directConnects.length = 0;
  const msg = await conns.sendMessage('alice-user', 'conn-1', 'hello bob');
  const dmEnq = captured.enqueues.find((e) => e.host === 'relay.mycelium.id');
  rec('W4. DM to a relay-capable peer → enqueued (offline-tolerant); status delivered',
    !!dmEnq && dmEnq.body?.recipient === 'bob' && msg.status === 'delivered',
    `enqueued=${!!dmEnq} status=${msg.status}`);
  // W5 — THE RELAY-OUTAGE FALLBACK. Bob still advertises #relay-inbox, but the relay answers
  // 404 (a control plane without /v1/queue/* — the exact 2026-07 production condition). The
  // send MUST fall through to the direct transport and SUCCEED, not throw. Before the fix
  // this threw, so a relay outage was a total federation outage on a reachable peer.
  captured.enqueues.length = 0; captured.directConnects.length = 0;
  fault.relayDown = true;
  let w5err = null;
  try { await conns.request('alice-user', 'bob@bob.mycelium.id'); } catch (e) { w5err = e; }
  rec('W5. relay enqueue fails → FALLS BACK to direct /federation/connect and succeeds',
    !w5err && captured.enqueues.length > 0 && captured.directConnects.some((d) => d.host === 'bob.mycelium.id'),
    `threw=${w5err ? w5err.message : 'no'} relayAttempts=${captured.enqueues.length} directConnects=${captured.directConnects.length}`);

  // W6 — BOTH transports down → the failure must be reported as TRANSIENT ("couldn't reach"),
  // never as "no user found". classifyDeliveryFailure keys on the DIRECT error, so a dead relay
  // must not be able to masquerade as a non-existent peer and delete the pending row.
  captured.enqueues.length = 0; captured.directConnects.length = 0;
  fault.directDown = true;
  let w6err = null;
  try { await conns.request('alice-user', 'bob@bob.mycelium.id'); } catch (e) { w6err = e; }
  rec('W6. relay AND direct both down → honest transient error, never "no user found"',
    !!w6err && /couldn't reach/i.test(w6err.message) && !/no user/i.test(w6err.message),
    `msg=${w6err ? w6err.message : '(did not throw)'}`);
  fault.relayDown = false; fault.directDown = false;
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — connect/message route via RelayQueue when the peer advertises a #relay-inbox (sealed, offline-tolerant), else direct HTTP' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
