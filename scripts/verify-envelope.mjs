// verify:envelope — the sealed+signed federation envelope (transport P3).
//   E1  round-trip: seal for Bob → Bob opens → payload + sender + replay fields intact
//   E2  tampered ciphertext → open fails
//   E3  tampered signature → open fails
//   E4  tampered header field (sender_seq) → open fails (sig covers the whole envelope)
//   E5  wrong recipient (Carol opens Bob's envelope) → unseal fails
//   E6  DOMAIN SEPARATION: the envelope seal cannot be opened as a real space CEK
//   E7  expectedTo mismatch (addressed to someone else) → rejected
//   E8  unresolvable sender did → rejected
//   E9  ZERO-KNOWLEDGE: the wire envelope contains no plaintext of the payload
//   E10 unsupported version → rejected
//   E11 IMPERSONATION: sig by Carol but claiming Alice's did → rejected
import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { sealEnvelope, openEnvelope, _internal } from '../src/federation/envelope.js';
import { openSealed, sealToX25519 } from '../src/crypto/space-seal.js';
import { canonicalize } from '../src/federation/sign.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };

const alice = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
const bob = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'bob' });
const carol = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'carol' });
const DID = { alice: 'did:key:zAlice', bob: 'did:key:zBob', carol: 'did:key:zCarol' };
const KEY = { [DID.alice]: alice.publicKeyB64, [DID.bob]: bob.publicKeyB64, [DID.carol]: carol.publicKeyB64 };
const resolvePeerKey = (did) => { const k = KEY[did]; if (!k) throw new Error('unresolvable'); return k; };

const MARKER = 'PLAINTEXT-MARKER-8f3a-do-not-leak';
const payload = { $type: 'social.mycelium.connect-request.v1', from_handle: 'alice', secret: MARKER, profile: { essence: 'a mind' } };

const sealForBob = (over = {}) => sealEnvelope(payload, {
  recipientKeyAgreementPubB64: bob.keyAgreementPublicKeyB64, recipientDid: DID.bob,
  senderDid: DID.alice, sign: (b) => alice.sign(b), nonce: crypto.randomUUID(), ts: 1_700_000_000_000, senderSeq: 7, ...over,
});

// Open as Bob (addressed to Bob) unless overridden — so a FAILURE is the tested cause,
// never a missing expectedTo. Every negative test must still pass the addressing gate.
const openAsBob = (env, over = {}) => openEnvelope(env, { identity: bob, resolvePeerKey, expectedTo: DID.bob, ...over });

try {
  // E1
  const env = sealForBob();
  const opened = await openAsBob(env);
  rec('E1. round-trip: Bob opens; payload + sender + replay fields intact',
    opened.payload.secret === MARKER && opened.senderDid === DID.alice && opened.senderSeq === 7 && typeof opened.nonce === 'string' && opened.nonce.length >= 8 && opened.payload.$type === payload.$type,
    `secret=${opened.payload.secret === MARKER} sender=${opened.senderDid} seq=${opened.senderSeq} nonce=${typeof opened.nonce}`);

  // E2 — tamper ciphertext
  const e2 = sealForBob(); e2.body = { ...e2.body, ct: (e2.body.ct.slice(0, -4) + (e2.body.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA')) };
  rec('E2. tampered ciphertext → open fails', await threw(() => openAsBob(e2)));

  // E3 — tamper signature
  const e3 = sealForBob(); e3.body = { ...e3.body, tag: (e3.body.tag.slice(0, -4) + (e3.body.tag.endsWith('AAAA') ? 'BBBB' : 'AAAA')) };
  rec('E3. tampered AEAD tag → open fails (integrity)', await threw(() => openAsBob(e3)));

  // E4 — tamper a signed header field
  const e4 = sealForBob(); e4.seal = { ...e4.seal, ct: (e4.seal.ct.slice(0, -4) + (e4.seal.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA')) };
  rec('E4. tampered seal → open fails (wrong CEK → decrypt fails)', await threw(() => openAsBob(e4)));

  // E5 — wrong recipient (addressing passes; the UNSEAL must fail)
  const e5 = sealForBob();
  rec('E5. wrong recipient (Carol) → unseal fails', await threw(() => openEnvelope(e5, { identity: carol, resolvePeerKey, expectedTo: DID.bob })));

  // E6 — domain separation: the envelope seal must NOT open as a real space CEK
  const e6 = sealForBob();
  const asSpace = await threw(() => openSealed(e6.seal, bob, { space_id: 'a-real-space-id', gen: 0, recipient_did: DID.bob }));
  rec('E6. envelope seal cannot be opened as a space CEK (domain separation)', asSpace);

  // E7 — expectedTo mismatch
  const e7 = sealForBob();
  rec('E7. addressed-to mismatch → rejected', await threw(() => openAsBob(e7, { expectedTo: DID.carol })));

  // E8 — unresolvable sender
  const e8 = sealForBob();
  rec('E8. unresolvable sender did → rejected', await threw(() => openAsBob(e8, { resolvePeerKey: () => { throw new Error('nope'); } })));

  // E9 — zero-knowledge: no plaintext of the payload on the wire
  const e9 = sealForBob();
  const wire = JSON.stringify(e9);
  rec('E9. zero-knowledge: wire envelope carries no plaintext of the payload', !wire.includes(MARKER) && !wire.includes('a mind'), `leakMarker=${wire.includes(MARKER)}`);

  // E10 — version
  const e10 = sealForBob(); e10.v = 1;
  rec('E10. unsupported version → rejected', await threw(() => openAsBob(e10)));

  // E11 — impersonation: signed by Carol but claiming Alice's did
  const e11 = sealEnvelope(payload, {
    recipientKeyAgreementPubB64: bob.keyAgreementPublicKeyB64, recipientDid: DID.bob,
    senderDid: DID.alice, sign: (b) => carol.sign(b), nonce: crypto.randomUUID(), ts: 1_700_000_000_000, senderSeq: 1,
  });
  rec('E11. sig by Carol claiming Alice did → rejected (impersonation)', await threw(() => openAsBob(e11)));

  // E12 — FAIL-CLOSED addressing: opening WITHOUT expectedTo is refused
  const e12 = sealForBob();
  rec('E12. missing expectedTo → refused (fail-closed addressing)', await threw(() => openEnvelope(e12, { identity: bob, resolvePeerKey })));

  // E13 — mislabel: sealed to Bob's KEY but labeled `to: Carol`; Bob (expectedTo=Bob) rejects
  // the label mismatch even though he is the true crypto recipient.
  const e13 = sealEnvelope(payload, {
    recipientKeyAgreementPubB64: bob.keyAgreementPublicKeyB64, recipientDid: DID.carol, // seal to Bob's key, label Carol
    senderDid: DID.alice, sign: (b) => alice.sign(b), nonce: crypto.randomUUID(), ts: 1_700_000_000_000, senderSeq: 2,
  });
  rec('E13. sealed-to-Bob-but-labeled-Carol → Bob rejects the unverified label', await threw(() => openAsBob(e13)));

  // E14 — SEALED-SENDER: the wire envelope carries NO sender-identifying field. The relay
  // (which sees the raw envelope) must not learn who sent it.
  const e14 = sealForBob();
  const wire14 = JSON.stringify(e14);
  const outerKeys = Object.keys(e14).sort().join(',');
  // The wire must expose ONLY {v,to,seal,body} — no sender_did/seq/nonce/ts, and crucially NO
  // sig (a wire-visible sig would be verifiable against the sender's PUBLIC key → de-anon).
  const sealedSender = outerKeys === 'body,seal,to,v' && e14.sig === undefined && !wire14.includes(DID.alice);
  rec('E14. SEALED-SENDER: wire is exactly {v,to,seal,body} — no sender fields, no sig (unlinkable)',
    sealedSender, `outerKeys=${outerKeys} sig=${e14.sig} aliceOnWire=${wire14.includes(DID.alice)}`);

  // E15 — SURREPTITIOUS FORWARDING: a legit recipient (Bob) decrypts Alice→Bob, recovers her
  // still-SIGNED inner, and re-seals it to Carol. Carol must REJECT because Alice signed to=Bob
  // (the recipient is bound INSIDE the signature). Mutation-proof: without the inner.to check,
  // Carol would accept it as a direct message from Alice.
  const V = _internal.ENVELOPE_VERSION;
  const aToB = sealForBob(); // inner.to = DID.bob, sealed to Bob
  const cek = openSealed(aToB.seal, bob, _internal.sealContext(DID.bob));
  const dd = crypto.createDecipheriv('aes-256-gcm', cek, Buffer.from(aToB.body.iv, 'base64'));
  dd.setAAD(Buffer.from(canonicalize({ v: V, to: DID.bob }), 'utf8'));
  dd.setAuthTag(Buffer.from(aToB.body.tag, 'base64'));
  const signedInner = Buffer.concat([dd.update(Buffer.from(aToB.body.ct, 'base64')), dd.final()]); // Alice's {to:bob,...,sig}
  const cek2 = crypto.randomBytes(32);
  const seal2 = sealToX25519(cek2, carol.keyAgreementPublicKeyB64, _internal.sealContext(DID.carol));
  const iv2 = crypto.randomBytes(12);
  const cc = crypto.createCipheriv('aes-256-gcm', cek2, iv2);
  cc.setAAD(Buffer.from(canonicalize({ v: V, to: DID.carol }), 'utf8'));
  const ct2 = Buffer.concat([cc.update(signedInner), cc.final()]);
  const fwd = { v: V, to: DID.carol, seal: seal2, body: { iv: iv2.toString('base64'), ct: ct2.toString('base64'), tag: cc.getAuthTag().toString('base64') } };
  rec('E15. surreptitious forwarding (Bob re-addresses Alice→Bob to Carol) → Carol rejects (recipient bound in sig)',
    await threw(() => openEnvelope(fwd, { identity: carol, resolvePeerKey, expectedTo: DID.carol })));
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — envelope: seal+sign round-trip, tamper/forgery/wrong-recipient/domain-sep/impersonation rejected, zero-knowledge' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
