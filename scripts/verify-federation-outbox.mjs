// verify:federation-outbox — the send-retry outbox (federation transport P5 delivery robustness).
// A DM whose live delivery FAILED (relay/peer unreachable at send time) is left 'failed' by
// sendMessage; a background sweep must re-attempt it and, on the FIRST successful re-enqueue,
// flip it to 'delivered' so it is never swept again (self-terminating → no relay-queue bloat).
//   O1  send while the relay is DOWN → row 'failed', nothing enqueued; then relay UP → outbox
//       re-delivers → row 'delivered', enqueued exactly once
//   O2  a second sweep with no failed rows → no-op (retried=0), the delivered row is NOT re-sent
//   O3  mid-batch failure does NOT abort the batch: msg A's enqueue fails, later msg B still
//       delivers in the same sweep (A stays 'failed' for next time)
//   O4  loop wiring: the pull loop flushes the outbox ONLY on a cycle where the relay was
//       reachable (pull succeeded) — never on a relay-down cycle (which would just hammer it)
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createIdentity } from '../src/identity/identity.js';
import { createConnectionsNamespace } from '../src/db/connections.js';
import { createFederationPullLoop } from '../src/federation/pull-loop.js';
import { buildDidDocument } from '../src/federation/did.js';
import { openEnvelope } from '../src/federation/envelope.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const alice = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
const bob = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'bob' });
const DID = { alice: 'did:web:alice.mycelium.id', bob: 'did:web:bob.mycelium.id' };
const bobDoc = buildDidDocument('bob.mycelium.id', bob.publicKeyB64, null, bob.keyAgreementPublicKeyB64, 'https://relay.mycelium.id');

let relayUp = true;       // toggles the relay's /v1/queue/enqueue reachability
let failNextEnqueues = 0; // reject the next N enqueues even when relayUp (mid-batch failure model)
const enqueues = [];
const okJson = (o, s = 200) => ({ ok: s >= 200 && s < 300, status: s, async json() { return o; }, async text() { return JSON.stringify(o); } });
function shimFetch(urlStr, init = {}) {
  const u = new URL(urlStr); const body = init.body ? JSON.parse(init.body) : null;
  if (u.pathname === '/v1/queue/enqueue') {
    if (!relayUp) return Promise.reject(new Error('ECONNREFUSED (relay down)'));
    if (failNextEnqueues > 0) { failNextEnqueues--; return Promise.reject(new Error('enqueue rejected (transient)')); }
    enqueues.push({ body }); return Promise.resolve(okJson({ ok: true, id: 'q' + enqueues.length }));
  }
  if (u.pathname === '/.well-known/did.json') return Promise.resolve(okJson(bobDoc)); // bob's box serves its DID doc
  if (u.pathname === '/.well-known/webfinger') return Promise.resolve(okJson({ links: [{ rel: 'https://mycelium.id/rel/federation', href: `https://${u.hostname}/federation` }] }));
  return Promise.resolve(okJson({}, 404));
}
const testLookup = async (h) => (/\.mycelium\.id$/.test(h) ? [{ address: '93.184.216.34', family: 4 }] : (() => { throw new Error('unmapped'); })());

// REAL sqlite storage (not a hand-rolled fake) so the production SQL — the send_attempts cap,
// the ORDER BY priority, the WHERE — actually executes and is what the gate tests. (A fake d1
// that re-implements filtering in JS would mask a wrong ORDER BY / cap in the real query.)
const sq = new Database(':memory:');
sq.exec(`
  CREATE TABLE connections (id TEXT PRIMARY KEY, user_a TEXT, user_b TEXT, status TEXT, initiated_by TEXT,
    remote_instance TEXT, remote_user_handle TEXT, remote_did TEXT,
    remote_relay_inbox TEXT, remote_key_agreement TEXT, remote_keys_cached_at TEXT, created_at TEXT);
  CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, handle TEXT, signature TEXT, depth_score REAL, breadth_score REAL, public_realms_json TEXT);
  CREATE TABLE peer_messages (id TEXT PRIMARY KEY, user_id TEXT, connection_id TEXT, direction TEXT, content TEXT,
    send_nonce TEXT, send_attempts INTEGER NOT NULL DEFAULT 0, remote_nonce TEXT, status TEXT, read INTEGER DEFAULT 0, created_at TEXT);
`);
sq.prepare(`INSERT INTO connections (id,user_a,user_b,status,remote_instance,remote_user_handle,remote_did,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
  .run('conn-1', 'alice-user', DID.bob, 'accepted', 'bob.mycelium.id', 'bob', DID.bob);
sq.prepare(`INSERT INTO user_profiles (user_id,handle) VALUES (?,?)`).run('alice-user', 'alice');
const d1Query = async (sql, params = []) => {
  const st = sq.prepare(sql);
  if (/^\s*SELECT/i.test(sql)) return { results: st.all(...params) };
  const info = st.run(...params); return { results: [], meta: { changes: info.changes } };
};
// Deterministic monotonic created_at (sqlite's datetime('now') is only second-resolution → ties).
let clock = 0;
const stamp = (id) => sq.prepare('UPDATE peer_messages SET created_at = ? WHERE id = ?').run(String(clock++).padStart(9, '0'), id);
const rowOf = (id) => sq.prepare('SELECT status, send_attempts, send_nonce FROM peer_messages WHERE id = ?').get(id) || {};
const statusOf = (id) => rowOf(id).status;
// Unseal a captured enqueue body as Bob would, returning the inner payload (to read its nonce).
const unsealTo = async (envelopeStr) => (await openEnvelope(JSON.parse(envelopeStr), { identity: bob, resolvePeerKey: (d) => (d === DID.alice ? alice.publicKeyB64 : null), expectedTo: DID.bob })).payload;
const conns = createConnectionsNamespace({
  d1Query, sign: (b) => alice.sign(b), did: () => DID.alice, selfInstance: () => 'alice.mycelium.id',
  selfDid: DID.alice, fetch: shimFetch, lookup: testLookup,
});
// Every send stamps a monotonic created_at so insertion order is the sort order in the real query.
const send = async (text) => { const m = await conns.sendMessage('alice-user', 'conn-1', text); stamp(m.id); return m; };

try {
  // O1 — send while the relay is DOWN, then flush the outbox once it's back.
  relayUp = false;
  const m1 = await send('hi while relay down');
  const storedNonce = rowOf(m1.id).send_nonce; // persisted at send time
  const failedAtSend = m1.status === 'failed' && enqueues.length === 0 && !!storedNonce;
  relayUp = true;
  const r1 = await conns.federationOutbox('alice-user');
  rec('O1. relay down at send → failed; relay up → outbox re-delivers (enqueued once, row delivered)',
    failedAtSend && r1.retried === 1 && r1.delivered === 1 && statusOf(m1.id) === 'delivered' && enqueues.length === 1,
    `sendStatus=${m1.status} sentEnq=0? ${enqueues.length === 1} retried=${r1.retried} delivered=${r1.delivered} finalStatus=${statusOf(m1.id)}`);

  // O1b — IDEMPOTENT RETRY: the enqueued envelope's payload nonce must be the SAME nonce that was
  // persisted at send time (not a fresh one). The receiver dedups a DM on that nonce, so reuse is
  // what prevents a double-delivery when an earlier attempt actually landed (lost relay response).
  const wireNonce = (await unsealTo(enqueues[enqueues.length - 1].body.envelope)).nonce;
  rec('O1b. retry REUSES the persisted payload nonce (receiver-dedup idempotent; no double-deliver)',
    !!wireNonce && wireNonce === storedNonce, `stored=${String(storedNonce).slice(0, 8)} wire=${String(wireNonce).slice(0, 8)} equal=${wireNonce === storedNonce}`);

  // O2 — self-terminating: a second sweep finds nothing failed and re-sends nothing.
  const enqBefore = enqueues.length;
  const r2 = await conns.federationOutbox('alice-user');
  rec('O2. second sweep is a no-op (delivered row not re-swept) — no relay-queue bloat',
    r2.retried === 0 && r2.delivered === 0 && enqueues.length === enqBefore,
    `retried=${r2.retried} delivered=${r2.delivered} newEnqueues=${enqueues.length - enqBefore}`);

  // O3 — mid-batch failure must NOT abort the batch: A's enqueue fails, later B still delivers.
  relayUp = false;
  const a = await send('msg A'); // → failed (older)
  const b = await send('msg B'); // → failed (newer)
  relayUp = true; failNextEnqueues = 1; // A (first, older) fails; B succeeds
  const enqBefore3 = enqueues.length;
  const r3 = await conns.federationOutbox('alice-user');
  rec('O3. mid-batch enqueue failure does not abort the batch (A stays failed, B delivered)',
    r3.retried === 2 && r3.delivered === 1 && statusOf(a.id) === 'failed' && statusOf(b.id) === 'delivered' && (enqueues.length - enqBefore3) === 1,
    `retried=${r3.retried} delivered=${r3.delivered} A=${statusOf(a.id)} B=${statusOf(b.id)} enq=${enqueues.length - enqBefore3}`);

  // O4 — loop wiring: outbox flushes ONLY on a reachable cycle (pull succeeded), never on a
  // relay-down cycle (backoff path returns before the outbox flush).
  const stubDb = { rawQuery: async () => ({ results: [] }), connections: {} };
  let pullOk = false, outboxCalls = 0;
  const stubClient = { pull: async () => { if (!pullOk) throw new Error('relay down'); return []; }, ack: async () => ({ acked: 0 }) };
  const loopDown = createFederationPullLoop({ db: stubDb, userId: 'u', identity: alice, selfDid: DID.alice, resolvePeerKey: () => alice.publicKeyB64, client: stubClient, outbox: async () => { outboxCalls++; } });
  await loopDown.tick(); // relay down → must NOT flush outbox
  const notOnDown = outboxCalls === 0;
  pullOk = true; outboxCalls = 0;
  const loopUp = createFederationPullLoop({ db: stubDb, userId: 'u', identity: alice, selfDid: DID.alice, resolvePeerKey: () => alice.publicKeyB64, client: stubClient, outbox: async () => { outboxCalls++; } });
  await loopUp.tick(); // relay reachable → flushes outbox exactly once
  rec('O4. pull loop flushes outbox only on a relay-reachable cycle (never during backoff)',
    notOnDown && outboxCalls === 1, `flushOnDown=${!notOnDown} flushOnUp=${outboxCalls}`);

  // O5 — REENTRANCY LATCH: a slow flush can outlast intervalMs; a second overlapping tick must be
  // a no-op (else two concurrent flushes re-select the same failed rows → double-enqueue).
  let releaseFlush; const flushGate = new Promise((r) => { releaseFlush = r; });
  let concurrentFlushes = 0;
  const slowLoop = createFederationPullLoop({ db: stubDb, userId: 'u', identity: alice, selfDid: DID.alice, resolvePeerKey: () => alice.publicKeyB64, client: { pull: async () => [], ack: async () => ({ acked: 0 }) }, outbox: async () => { concurrentFlushes++; await flushGate; } });
  const t1 = slowLoop.tick();   // enters, starts the slow flush, holds
  const t2 = slowLoop.tick();   // overlaps → latch must make this a no-op
  releaseFlush(); await Promise.all([t1, t2]);
  rec('O5. reentrancy latch: an overlapping tick does not start a second concurrent outbox flush',
    concurrentFlushes === 1, `concurrentFlushes=${concurrentFlushes}`);

  // O6 — CAP + PRIORITY: a message already at the attempt cap is NOT re-swept (dead peer left
  // alone), and among failed rows the LOWER send_attempts is served first (a stuck backlog can't
  // starve a fresher message). Two failed rows, limit 1: the fresher (attempts 0) must win.
  sq.exec(`DELETE FROM peer_messages`);
  const seed = sq.prepare(`INSERT INTO peer_messages (id,user_id,connection_id,direction,content,send_nonce,send_attempts,status,created_at) VALUES (?,?,?,'out',?,?,?,'failed',?)`);
  seed.run('capped', 'alice-user', 'conn-1', 'dead', 'n-capped', 10, '000000001'); // at the cap → excluded
  seed.run('stuck', 'alice-user', 'conn-1', 'stuck', 'n-stuck', 3, '000000002');    // some attempts, oldest live
  seed.run('fresh', 'alice-user', 'conn-1', 'fresh', 'n-fresh', 0, '000000003');    // newest but fewest attempts
  relayUp = true; failNextEnqueues = 0;
  const r6 = await conns.federationOutbox('alice-user', { limit: 1 });
  rec('O6. lowest-attempts served first (a stuck/newer-but-fewer-attempts msg isn\'t starved)',
    r6.retried === 1 && statusOf('fresh') === 'delivered' && statusOf('stuck') === 'failed' && statusOf('capped') === 'failed',
    `retried=${r6.retried} fresh=${statusOf('fresh')} stuck=${statusOf('stuck')} capped=${statusOf('capped')}`);

  // O7 — CAP in isolation: a message at the attempt cap is the ONLY candidate → the sweep must
  // skip it entirely (retried=0), so a permanently-dead peer is left alone, not retried forever.
  sq.exec(`DELETE FROM peer_messages`);
  sq.prepare(`INSERT INTO peer_messages (id,user_id,connection_id,direction,content,send_nonce,send_attempts,status,created_at) VALUES ('only','alice-user','conn-1','out','dead','n-only',10,'failed','000000001')`).run();
  const r7 = await conns.federationOutbox('alice-user');
  rec('O7. a message at the attempt cap is not swept (dead peer left alone; not retried forever)',
    r7.retried === 0 && statusOf('only') === 'failed' && rowOf('only').send_attempts === 10,
    `retried=${r7.retried} status=${statusOf('only')} attempts=${rowOf('only').send_attempts}`);
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — send-retry outbox: failed DMs re-deliver, self-terminating on success, batch-tolerant, flushed only when the relay is reachable' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
