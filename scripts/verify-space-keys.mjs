// verify:space-keys — BU-KEY gate (E2E shared spaces, 2026-06-30).
//
// The box derives + publishes an INDEPENDENT X25519 keyAgreement key so peers can
// seal the per-space Content Encryption Key to it (Space Key Lockbox). Proves:
// deterministic derivation, key SEPARATION from the Ed25519 signing key, ECDH
// round-trip (the basis for the sealed box), did.json publishing (#key-enc +
// keyAgreement, with #key-1 kept at verificationMethod[0] so old resolvers still
// pick the SIGNING key), a full resolve round-trip via BU-RESOLVE's
// resolveKeyAgreementKey, and backward-compat (no keyAgreement key → no #key-enc).

import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { buildDidDocument, resolveDidKey, resolveKeyAgreementKey, fromMultibase, X25519_MULTICODEC } from '../src/federation/did.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const MASTER = 'ab'.repeat(32);           // 64-hex
const id = createIdentity({ masterHex: MASTER });
const id2 = createIdentity({ masterHex: MASTER });

// ── derivation ──────────────────────────────────────────────────────────────
rec(typeof id.keyAgreementPublicKeyB64 === 'string' && Buffer.from(id.keyAgreementPublicKeyB64, 'base64url').length === 32,
  'K1. identity exposes a 32-byte X25519 keyAgreement public key');
rec(id.keyAgreementPublicKeyB64 === id2.keyAgreementPublicKeyB64, 'K2. derivation is deterministic from the master key');
// K3 (review LOW): tie the published keyAgreement key to the CORRECT, SEPARATE HKDF
// info. Comparing only PUBLIC keys is a false-green — with the same seed the Ed25519
// and X25519 public keys still differ in bytes while the private scalars become
// identical (the cross-protocol entanglement key separation prevents). So re-derive
// X25519 from each info and assert the published key matches the keyAgreement info
// and NOT the signing info — this catches an info-collapse regression.
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const deriveKaPub = (master, info) => {
  const seed = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(master, 'hex'), Buffer.alloc(0), Buffer.from(info), 32));
  const priv = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64url');
};
const expectedKa = deriveKaPub(MASTER, 'mycelium-keyagreement-v1');
const ifCollapsed = deriveKaPub(MASTER, 'mycelium-identity-v1'); // what a same-info regression would yield
rec(id.keyAgreementPublicKeyB64 === expectedKa && id.keyAgreementPublicKeyB64 !== ifCollapsed && id.keyAgreementPublicKeyB64 !== id.publicKeyB64,
  'K3. keyAgreement key derives from the SEPARATE "mycelium-keyagreement-v1" info (NOT the signing info) — catches an info-collapse regression');

// ── ECDH round-trip (the sealed-box basis) ──────────────────────────────────
const peer = crypto.generateKeyPairSync('x25519');
const peerPubB64 = Buffer.from(peer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64url');
const ssFromId = id.keyAgreementSharedSecret(peerPubB64);
const idKaPub = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(id.keyAgreementPublicKeyB64, 'base64url')]), format: 'der', type: 'spki' });
const ssFromPeer = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: idKaPub });
rec(Buffer.isBuffer(ssFromId) && ssFromId.length === 32 && ssFromId.equals(ssFromPeer),
  'K4. keyAgreementSharedSecret ECDH round-trips with a peer (32-byte shared secret)');
rec((() => { try { id.keyAgreementSharedSecret('!!notbase64!!'); return false; } catch { return true; } })(),
  'K5. keyAgreementSharedSecret fails closed on a malformed peer key');

// ── did.json publishing ─────────────────────────────────────────────────────
const HOST = 'alice.example';
const DID = `did:web:${HOST}`;
const doc = buildDidDocument(HOST, id.publicKeyB64, undefined, id.keyAgreementPublicKeyB64);
rec(doc?.verificationMethod?.[0]?.id === `${DID}#key-1`,
  'D1. #key-1 (Ed25519 signing) stays at verificationMethod[0] — old index-resolvers still pick the signing key');
rec(doc?.verificationMethod?.[1]?.id === `${DID}#key-enc` && Array.isArray(doc.keyAgreement) && doc.keyAgreement[0] === `${DID}#key-enc`,
  'D2. #key-enc (X25519) appended + keyAgreement relationship published');
rec(fromMultibase(doc.verificationMethod[1].publicKeyMultibase, X25519_MULTICODEC) === id.keyAgreementPublicKeyB64,
  'D3. published #key-enc multibase decodes (X25519 codec) to the identity keyAgreement key');

// backward-compat: no keyAgreement key → no #key-enc / keyAgreement
const docOld = buildDidDocument('bob.example', id.publicKeyB64, undefined);
rec(docOld.verificationMethod.length === 1 && !docOld.keyAgreement,
  'D4. omitting the keyAgreement key → no #key-enc, no keyAgreement (backward-compatible)');

// ── full resolve round-trip via BU-RESOLVE (injected fetch+lookup) ──────────
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const fetchDoc = async () => ({ ok: true, status: 200, json: async () => doc });
rec(await resolveKeyAgreementKey(DID, { fetch: fetchDoc, lookup }) === id.keyAgreementPublicKeyB64,
  'R1. resolveKeyAgreementKey resolves the published X25519 key end-to-end');
rec(await resolveDidKey(DID, { fetch: fetchDoc, lookup }) === id.publicKeyB64,
  'R2. resolveDidKey still resolves the Ed25519 SIGNING key (not the X25519) from the 2-key doc');

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — X25519 keyAgreement key derived (separated), ECDH round-trips, published + resolved (BU-KEY)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);
