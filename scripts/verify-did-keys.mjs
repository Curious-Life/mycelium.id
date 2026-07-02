// verify:did-keys — BU-RESOLVE gate (E2E shared spaces, 2026-06-30).
//
// Proves did:web key resolution selects keys by verification RELATIONSHIP, never by
// array index — the fix for the resolveDidKey index-[0] bug (did.js) that becomes a
// security/deploy footgun the moment a second key (X25519 #key-enc) is published:
// an index pick could hand an X25519 key to Ed25519 signature verification.
//
// Covered: multibase round-trip + codec validation (Ed25519 vs X25519); relationship
// selection under the ADVERSARIAL ordering (#key-enc at verificationMethod[0]);
// resolveDidKey returns the SIGNING key, resolveKeyAgreementKey the ENCRYPTION key;
// fail-closed when a relationship/key is absent (un-upgraded peer).

import crypto from 'node:crypto';
import {
  toMultibase, fromMultibase, ED25519_MULTICODEC, X25519_MULTICODEC,
  selectVerificationMethod, resolveDidKey, resolveKeyAgreementKey,
} from '../src/federation/did.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const threw = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(String(e?.message || e)) : true; } };

// raw public keys as base64url (the JWK 'x' field IS the raw 32-byte key)
const ed = crypto.generateKeyPairSync('ed25519');
const edPubB64 = ed.publicKey.export({ format: 'jwk' }).x;
const xk = crypto.generateKeyPairSync('x25519');
const xPubB64 = xk.publicKey.export({ format: 'jwk' }).x;

// ── 1. Multibase round-trip + codec validation ──────────────────────────────
rec(fromMultibase(toMultibase(edPubB64)) === edPubB64, 'M1. Ed25519 multibase round-trips (default codec)');
rec(fromMultibase(toMultibase(xPubB64, X25519_MULTICODEC), X25519_MULTICODEC) === xPubB64, 'M2. X25519 multibase round-trips (0xec01 codec)');
rec(await threw(() => fromMultibase(toMultibase(xPubB64, X25519_MULTICODEC) /* default expects Ed25519 */), /codec mismatch/),
  'M3. an X25519 multibase parsed as Ed25519 → FAILS CLOSED (codec mismatch)');
rec(toMultibase(edPubB64).startsWith('z') && toMultibase(xPubB64, X25519_MULTICODEC).startsWith('z'), 'M4. both encode as z-base58btc');
// M5 (review LOW-1): a correct-codec but truncated payload must fail closed before
// it reaches signature-verify or ECDH. Build a multibase with the Ed25519 codec but
// only a 4-byte body.
import { b58encode } from '../src/federation/did.js';
const truncated = 'z' + b58encode(Buffer.concat([ED25519_MULTICODEC, Buffer.alloc(4)]));
rec(await threw(() => fromMultibase(truncated), /32-byte/), 'M5. truncated key (right codec, wrong length) → FAILS CLOSED (not a 32-byte key)');

// A did:web doc with BOTH keys, #key-enc deliberately FIRST in verificationMethod
// (the adversarial ordering the old index-[0] code would mis-handle).
const DID = 'did:web:test.example';
const docBoth = {
  id: DID,
  verificationMethod: [
    { id: `${DID}#key-enc`, type: 'Multikey', controller: DID, publicKeyMultibase: toMultibase(xPubB64, X25519_MULTICODEC) }, // X25519 at [0]
    { id: `${DID}#key-1`, type: 'Multikey', controller: DID, publicKeyMultibase: toMultibase(edPubB64) },                     // Ed25519 at [1]
  ],
  authentication: [`${DID}#key-1`],
  assertionMethod: [`${DID}#key-1`],
  keyAgreement: [`${DID}#key-enc`],
};
const docOld = { // un-upgraded peer: only the Ed25519 signing key, no keyAgreement
  id: DID,
  verificationMethod: [{ id: `${DID}#key-1`, type: 'Multikey', controller: DID, publicKeyMultibase: toMultibase(edPubB64) }],
  authentication: [`${DID}#key-1`], assertionMethod: [`${DID}#key-1`],
};

// ── 2. Relationship selection (pure) ────────────────────────────────────────
rec(selectVerificationMethod(docBoth, 'assertionMethod')?.id === `${DID}#key-1`,
  'S1. assertionMethod selects the Ed25519 #key-1 even though #key-enc is at verificationMethod[0]');
rec(selectVerificationMethod(docBoth, 'keyAgreement')?.id === `${DID}#key-enc`,
  'S2. keyAgreement selects the X25519 #key-enc');
rec(selectVerificationMethod(docOld, 'keyAgreement') === null,
  'S3. missing relationship → null (fail-closed), not a wrong-key fallback');

// ── 3. Resolvers end-to-end (SSRF path with injected fetch+lookup) ──────────
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]; // a public IP → passes SSRF
const fetchOf = (doc) => async () => ({ ok: true, status: 200, json: async () => doc });

const sigKey = await resolveDidKey(DID, { fetch: fetchOf(docBoth), lookup });
rec(sigKey === edPubB64,
  'R1. resolveDidKey returns the Ed25519 SIGNING key (NOT the X25519 at index [0]) — the bug is fixed', `got=${sigKey?.slice(0, 12)}…`);
const encKey = await resolveKeyAgreementKey(DID, { fetch: fetchOf(docBoth), lookup });
rec(encKey === xPubB64, 'R2. resolveKeyAgreementKey returns the X25519 ENCRYPTION key', `got=${encKey?.slice(0, 12)}…`);
rec(await threw(() => resolveKeyAgreementKey(DID, { fetch: fetchOf(docOld), lookup }), /keyAgreement/),
  'R3. resolveKeyAgreementKey on an un-upgraded peer (no keyAgreement) → FAILS CLOSED');
rec(await resolveDidKey(DID, { fetch: fetchOf(docOld), lookup }) === edPubB64,
  'R4. resolveDidKey still works on an old single-key doc (backward-compatible)');

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — did:web keys resolved by relationship, codec-validated, fail-closed (BU-RESOLVE)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);
