// verify:federation-pull — the box's RECEIVE automation (federation transport P4).
//   L1  fresh connect-request → dispatched to receiveRemote; envelope acked; recorded in federation_seen
//   L2  DEDUP: re-pulling the same envelope → NOT re-dispatched (durable), still acked
//   L3  poison (non-JSON) + forged (tampered) → dropped (acked), never dispatched, no crash
//   L4  SENDER RESTART: a lower-seq NEW envelope (fresh nonce) is still DELIVERED (nonce-only dedup)
//   L5  dispatch by type: connect-response → receiveResponse; message → receiveMessage
//   L6  TRANSIENT dispatch failure → NOT acked (left for retry); next cycle reprocesses
//   L7  relay unreachable (pull throws) → cycle throws; tick backs off (skips cycles), never crashes
// Real federation_seen sqlite + real openEnvelope + a fake queue client; receive* stubbed to record.
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createIdentity } from '../src/identity/identity.js';
import { sealEnvelope } from '../src/federation/envelope.js';
import { createFederationPullLoop } from '../src/federation/pull-loop.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const sqlite = new Database(':memory:');
sqlite.exec(readFileSync(new URL('../migrations/0052_federation_seen.sql', import.meta.url), 'utf8'));
const rawQuery = async (sql, params = []) => {
  const stmt = sqlite.prepare(sql);
  if (/^\s*SELECT/i.test(sql)) return { results: stmt.all(...params) };
  stmt.run(...params); return { results: [] };
};

const calls = []; // recorded dispatches
let failNext = null; // (fn) => throw once, for L6
const mkReceiver = (name) => async (arg) => { if (failNext === name) { failNext = null; throw new Error('transient vault write'); } calls.push({ name, arg }); };
const db = {
  rawQuery,
  connections: { receiveRemote: mkReceiver('receiveRemote'), receiveResponse: mkReceiver('receiveResponse'), receiveMessage: mkReceiver('receiveMessage') },
};

const alice = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
const bob = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'bob' });
const DID = { alice: 'did:web:alice.mycelium.id', bob: 'did:web:bob.mycelium.id' };
const resolvePeerKey = (d) => ({ [DID.alice]: alice.publicKeyB64, [DID.bob]: bob.publicKeyB64 }[d]);

let _seq = 0;
const seal = (payload, over = {}) => JSON.stringify(sealEnvelope(payload, {
  recipientKeyAgreementPubB64: bob.keyAgreementPublicKeyB64, recipientDid: DID.bob, senderDid: DID.alice,
  sign: (b) => alice.sign(b), nonce: crypto.randomUUID(), ts: Date.now(), senderSeq: ++_seq, ...over,
}));
const connectReq = { $type: 'social.mycelium.connect-request.v1', from_handle: 'alice', profile: { essence: 'a mind' } };

// Fake queue client: `queue` holds {id, envelope}; pull returns a snapshot; ack removes.
let queue = []; let pullThrows = false;
const client = {
  pull: async () => { if (pullThrows) throw new Error('relay unreachable'); return queue.slice(); },
  ack: async (ids) => { queue = queue.filter((q) => !ids.includes(q.id)); return { acked: ids.length }; },
};
const loop = createFederationPullLoop({ db, userId: 'bob-user', identity: bob, selfDid: DID.bob, resolvePeerKey, client });
const enq = (envelope) => queue.push({ id: `q${queue.length}-${crypto.randomUUID().slice(0, 6)}`, envelope });

try {
  // L1 — fresh connect-request
  const e1 = seal(connectReq);
  enq(e1);
  await loop.cycle();
  const gotReq = calls.find((c) => c.name === 'receiveRemote');
  const seen1 = (await rawQuery('SELECT COUNT(*) AS c FROM federation_seen')).results[0].c;
  rec('L1. fresh connect-request → receiveRemote dispatched; acked; recorded in federation_seen',
    !!gotReq && gotReq.arg.fromDid === DID.alice && gotReq.arg.fromHandle === 'alice' && queue.length === 0 && seen1 === 1,
    `dispatched=${!!gotReq} fromDid=${gotReq?.arg?.fromDid} queueAfter=${queue.length} seen=${seen1}`);

  // L2 — dedup: re-enqueue the SAME envelope (same sender_did+nonce)
  calls.length = 0; enq(e1);
  await loop.cycle();
  rec('L2. re-pull same envelope → NOT re-dispatched (durable dedup); still acked',
    calls.length === 0 && queue.length === 0, `redispatched=${calls.length} queueAfter=${queue.length}`);

  // L3 — poison + forged
  calls.length = 0;
  enq('not-json-at-all');
  const tampered = seal(connectReq); const tp = JSON.parse(tampered); tp.body.ct = tp.body.ct.slice(0, -4) + 'AAAA'; enq(JSON.stringify(tp));
  await loop.cycle();
  rec('L3. poison + forged → dropped (acked), never dispatched, no crash',
    calls.length === 0 && queue.length === 0, `dispatched=${calls.length} queueAfter=${queue.length}`);

  // L4 — SENDER RESTART: a NEW envelope (fresh nonce) with a LOWER seq than one already seen
  // must still be DELIVERED. The send-seq resets on a sender restart, so dropping "seq <= seen"
  // would silently lose all post-restart traffic; replay is guarded by the NONCE, not the seq.
  calls.length = 0;
  enq(seal(connectReq, { senderSeq: 1 })); // seq 1 <= alice's max-seen (from L1), but a fresh nonce
  await loop.cycle();
  rec('L4. lower-seq NEW envelope (sender restart) → still DELIVERED (nonce-only dedup, no seq drop)',
    calls.some((c) => c.name === 'receiveRemote') && queue.length === 0, `dispatched=${calls.length}`);

  // L5 — dispatch by type: connect-response + message
  calls.length = 0;
  enq(seal({ $type: 'social.mycelium.connect-response.v1', from_handle: 'alice', action: 'accept' }));
  enq(seal({ $type: 'social.mycelium.message.v1', from_handle: 'alice', content: 'hi bob', nonce: crypto.randomUUID() }));
  await loop.cycle();
  const resp = calls.find((c) => c.name === 'receiveResponse'); const msg = calls.find((c) => c.name === 'receiveMessage');
  rec('L5. connect-response → receiveResponse; message → receiveMessage',
    !!resp && resp.arg.action === 'accept' && !!msg && msg.arg.content === 'hi bob', `resp=${!!resp} msg=${!!msg}`);

  // L6 — transient dispatch failure → NOT acked; next cycle reprocesses
  calls.length = 0;
  const e6 = seal(connectReq); enq(e6);
  failNext = 'receiveRemote';       // first dispatch throws
  await loop.cycle();
  const afterFail = queue.length;   // still queued (not acked)
  await loop.cycle();               // retry succeeds
  const gotOnRetry = calls.find((c) => c.name === 'receiveRemote');
  rec('L6. transient dispatch failure → left un-acked; retried next cycle → succeeds',
    afterFail === 1 && !!gotOnRetry && queue.length === 0, `afterFail=${afterFail} retried=${!!gotOnRetry} queueEnd=${queue.length}`);

  // L7 — relay unreachable → tick backs off, never throws out
  pullThrows = true; let threw7 = false;
  try { await loop.tick(); } catch { threw7 = true; } // tick must swallow + back off
  rec('L7. relay unreachable → tick backs off (no crash)', !threw7);
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
} finally { sqlite.close(); }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — pull loop: pull→open→dedup→dispatch→ack, durable dedup, poison-drop, sender-restart-safe, transient-retry, relay-down backoff' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
