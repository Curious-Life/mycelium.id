// verify:space-seal — BU-SEAL gate (E2E shared spaces, 2026-06-30).
//
// The sealed box must: round-trip a CEK to a member's X25519 key; keep the CEK
// confidential (owner/relay see only the blob); and be NON-TRANSPLANTABLE — a seal
// for {space,gen,recipient} cannot be opened under a different context or by a
// different recipient (E8). Plus tamper-evident + fresh ephemeral key per seal.

import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { sealToX25519, openSealed } from '../src/crypto/space-seal.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const alice = createIdentity({ masterHex: 'aa'.repeat(32) });
const bob = createIdentity({ masterHex: 'bb'.repeat(32) }); // a different member / non-recipient
const CTX = { space_id: 'space-1', gen: 3, recipient_did: 'did:web:alice.example' };
const cek = crypto.randomBytes(32);
const blob = sealToX25519(cek, alice.keyAgreementPublicKeyB64, CTX);

// ── round-trip + confidentiality ────────────────────────────────────────────
rec(openSealed(blob, alice, CTX).equals(cek), 'S1. recipient unseals the exact CEK (round-trip)');
rec(!!blob.eph && !!blob.ct && !!blob.tag && !blob.ct.includes(cek.toString('base64')) , 'S2. blob carries only {eph,iv,ct,tag} — the CEK is not in cleartext');
rec(!Buffer.from(blob.ct, 'base64').equals(cek), 'S3. ciphertext != the raw CEK (it is encrypted, not stored)');

// ── non-transplantable across CONTEXT (E8) ──────────────────────────────────
rec(throws(() => openSealed(blob, alice, { ...CTX, gen: 4 })),
  'S4. open under a DIFFERENT generation → FAILS CLOSED (a removed member’s gen-3 seal can’t open gen-4)');
rec(throws(() => openSealed(blob, alice, { ...CTX, space_id: 'space-2' })), 'S5. open under a different space → FAILS CLOSED');
rec(throws(() => openSealed(blob, alice, { ...CTX, recipient_did: 'did:web:mallory.example' })), 'S6. open under a different recipient_did → FAILS CLOSED');

// ── non-transplantable across RECIPIENT ─────────────────────────────────────
rec(throws(() => openSealed(blob, bob, CTX)),
  'S7. a DIFFERENT identity (bob) cannot open a blob sealed to alice — even with the right context (ECDH differs)');
const blobForBob = sealToX25519(cek, bob.keyAgreementPublicKeyB64, { ...CTX, recipient_did: 'did:web:bob.example' });
rec(throws(() => openSealed(blobForBob, alice, { ...CTX, recipient_did: 'did:web:bob.example' })), 'S8. alice cannot open a blob sealed to bob');

// ── tamper-evident ──────────────────────────────────────────────────────────
const flip64 = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
const flip64url = (b64) => { const b = Buffer.from(b64, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
rec(throws(() => openSealed({ ...blob, ct: flip64(blob.ct) }, alice, CTX)), 'S9. flipped ciphertext → FAILS CLOSED');
rec(throws(() => openSealed({ ...blob, tag: flip64(blob.tag) }, alice, CTX)), 'S10. flipped tag → FAILS CLOSED');
rec(throws(() => openSealed({ ...blob, eph: flip64url(blob.eph) }, alice, CTX)), 'S11. tampered ephemeral pubkey → FAILS CLOSED (KEM binding)');

// ── fresh ephemeral key per seal (no nonce/key reuse) ───────────────────────
const b2 = sealToX25519(cek, alice.keyAgreementPublicKeyB64, CTX);
rec(b2.eph !== blob.eph && b2.ct !== blob.ct, 'S12. each seal uses a FRESH ephemeral key → distinct blob (no key/nonce reuse)');
rec(openSealed(b2, alice, CTX).equals(cek), 'S13. the second independent seal also opens to the same CEK');

// ── input validation ────────────────────────────────────────────────────────
rec(throws(() => sealToX25519(Buffer.alloc(16), alice.keyAgreementPublicKeyB64, CTX)), 'S14. non-32-byte CEK → rejected at seal');
rec(throws(() => sealToX25519(cek, alice.keyAgreementPublicKeyB64, { ...CTX, gen: 3.5 })), 'S15. non-integer gen context → rejected');
rec(throws(() => openSealed({ iv: blob.iv, ct: blob.ct, tag: blob.tag }, alice, CTX)), 'S16. blob missing eph → rejected');

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — CEK sealed to a member’s X25519 key; confidential, tamper-evident, non-transplantable across context+recipient (BU-SEAL)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);
