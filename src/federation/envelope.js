// src/federation/envelope.js — the sealed, signed federation ENVELOPE (transport P3).
//
// A store-and-forward envelope carries a small signaling payload (connect-request,
// connect-response, message, key-grant) from one box to another via the zero-knowledge
// relay queue (mycelium-managed /v1/queue/*). The relay stores it OPAQUE and learns
// only {recipient handle, timing, size} — never the sender, never the content.
//
// Two-tier, reusing ONLY vetted primitives (no new crypto):
//   1. a random 32-byte CEK is sealed to the recipient's published X25519 key via
//      sealToX25519 (src/crypto/space-seal.js — the HPKE base-mode seal already
//      adversarially reviewed for E2E spaces). Only the recipient's private key opens it.
//   2. the inner record (sender_did + sig + payload + replay fields) is AES-256-GCM'd
//      under that CEK; the sender's Ed25519 signature is INSIDE that ciphertext (sealed-
//      sender), and the AEAD tag (AAD = {v,to}) authenticates the cleartext outer.
//
// DOMAIN SEPARATION (why reusing the space seal is safe): sealToX25519 binds
// {space_id, gen, recipient_did} into the HKDF info AND the GCM AAD, making a seal
// non-transplantable. We seal envelopes under a SENTINEL space_id (ENVELOPE_CTX_SPACE)
// that no real space ever uses, so a federation-envelope CEK can NEVER be opened as a
// space CEK, or vice versa — cryptographic separation for free.
//
// SEALED-SENDER: every sender-identifying field (sender_did, sender_seq, nonce, ts) AND the
// sender's signature live INSIDE the encrypted body; the cleartext wire is only {v, to, seal,
// body}. `to` is the recipient the relay already routes to, so nothing on the wire lets an
// observer learn — or even key-iterate to confirm — the SENDER. Open is UNSEAL→DECRYPT→VERIFY
// (the sender_did + sig are sealed, so authentication is only possible post-decrypt).
// Residual: recipient-DID blinding (the relay still sees the recipient) is deferred.
//
// Pure: node crypto + sign.js + space-seal.js. No storage, no network. resolvePeerKey
// (the sender's verify key from their DID) is injected so this module stays transport-
// and DID-scheme-agnostic (did:web today, did:key in P6).

import crypto from 'node:crypto';
import { canonicalize, verifyDetached } from './sign.js';
import { sealToX25519, openSealed } from '../crypto/space-seal.js';

const ENVELOPE_VERSION = 2;
const IV_BYTES = 12;
// The sentinel that domain-separates envelope seals from real space seals (see header).
const ENVELOPE_CTX_SPACE = 'mycelium-federation-envelope:v2';

function sealContext(recipientDid) {
  return { space_id: ENVELOPE_CTX_SPACE, gen: 0, recipient_did: String(recipientDid) };
}

// The body AEAD's AAD — the CLEARTEXT outer header {v, to}. Binds the ciphertext to the
// recipient + version so it can't be lifted into a different envelope. Sender-identifying
// fields are NOT here (they live inside the encrypted body — sealed-sender).
function contextBytes({ v, to }) {
  return Buffer.from(canonicalize({ v, to }), 'utf8');
}

/**
 * Seal + sign a federation envelope for a recipient (sealed-sender; see module header).
 * @param {object} payload  the $type record to deliver (canonicalized then encrypted)
 * @param {object} o
 * @param {string} o.recipientKeyAgreementPubB64  recipient's X25519 key (from their DID doc)
 * @param {string} o.recipientDid  recipient did — bound into `to` + the seal context
 * @param {string} o.senderDid     our did — the recipient resolves it to verify the sig
 * @param {(bytes:string)=>string} o.sign  Ed25519 detached-sign over canonical bytes (identity.sign)
 * @param {string} o.nonce         unique per envelope (durable replay defense, recipient side)
 * @param {number} o.ts            epoch ms
 * @param {number} o.senderSeq     monotonic per (sender→recipient) — ordering + replay defense
 * @returns {object} the wire envelope { v, to, seal, body } — NO sig, NO sender fields in the clear
 */
export function sealEnvelope(payload, { recipientKeyAgreementPubB64, recipientDid, senderDid, sign, nonce, ts, senderSeq }) {
  if (!recipientKeyAgreementPubB64) throw new Error('sealEnvelope: recipient keyAgreement key required');
  if (!recipientDid || !senderDid) throw new Error('sealEnvelope: recipientDid + senderDid required');
  if (typeof sign !== 'function') throw new Error('sealEnvelope: sign required');
  if (typeof nonce !== 'string' || !nonce) throw new Error('sealEnvelope: nonce required');
  if (!Number.isFinite(ts) || !Number.isInteger(senderSeq)) throw new Error('sealEnvelope: ts + integer senderSeq required');

  const cek = crypto.randomBytes(32);
  const seal = sealToX25519(cek, recipientKeyAgreementPubB64, sealContext(recipientDid));

  // SEALED-SENDER: the sender_did AND the sender's signature both live INSIDE the ciphertext.
  // The sig is over the inner record, so NOTHING on the wire ({v,to,seal,body}) is verifiable
  // against a public sender key — a relay/observer holding the participant DID set cannot
  // iterate keys to de-anonymise the sender (the Signal sealed-sender rationale). Integrity of
  // the cleartext outer is covered by the AEAD: the seal fixes the CEK and {v,to} is the AAD,
  // so tampering v/to/seal/body all fail the GCM tag — no outer signature needed.
  // `to` is inside the SIGNED inner (not just the AEAD AAD) so the sender's signature binds
  // the intended RECIPIENT — else a legit recipient could re-seal the still-signed inner to a
  // third party (surreptitious forwarding / re-addressing). openEnvelope asserts inner.to == env.to.
  const inner = { to: String(recipientDid), sender_did: String(senderDid), sender_seq: senderSeq, nonce, ts, payload };
  const signed = { ...inner, sig: sign(canonicalize(inner)) };

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(contextBytes({ v: ENVELOPE_VERSION, to: String(recipientDid) }));
  const ct = Buffer.concat([cipher.update(Buffer.from(canonicalize(signed), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };

  return { v: ENVELOPE_VERSION, to: String(recipientDid), seal, body }; // NO sig, NO sender on the wire
}

/**
 * Verify + open a federation envelope. Fail-closed at every step. Order is
 * UNSEAL→DECRYPT→VERIFY (the sender's sig is sealed inside the ciphertext).
 * @param {object} env  the wire envelope
 * @param {object} o
 * @param {object} o.identity  our createIdentity() — provides the X25519 unseal
 * @param {(did:string)=>Promise<string>|string} o.resolvePeerKey  sender did → their base64url Ed25519 verify key
 * @param {string} o.expectedTo  REQUIRED — our own did. The envelope's `to` is signed but a
 *   sender can still seal to our key while LABELING `to` as someone else; without this check
 *   downstream logic that routes on `env.to` would act on an unverified label. Fail-closed.
 * @returns {Promise<{payload:object, senderDid:string, nonce:string, ts:number, senderSeq:number}>}
 */
export async function openEnvelope(env, { identity, resolvePeerKey, expectedTo } = {}) {
  if (!env || typeof env !== 'object') throw new Error('openEnvelope: malformed envelope');
  if (env.v !== ENVELOPE_VERSION) throw new Error(`openEnvelope: unsupported version ${env.v}`);
  if (!env.seal || !env.body || !env.to) throw new Error('openEnvelope: missing fields'); // no wire sig — it's sealed
  if (typeof resolvePeerKey !== 'function') throw new Error('openEnvelope: resolvePeerKey required');
  if (!identity || typeof identity.keyAgreementSharedSecret !== 'function') throw new Error('openEnvelope: identity required');
  // Addressing is fail-CLOSED: refuse to open unless the caller states our own did AND the
  // envelope is addressed to exactly it (checked against US, not a self-asserted label).
  if (!expectedTo) throw new Error('openEnvelope: expectedTo (our own did) is required');
  if (env.to !== expectedTo) throw new Error('openEnvelope: not addressed to this box');

  // SEALED-SENDER: nothing on the wire authenticates the sender to an observer. We unseal +
  // decrypt (auth by the seal-to-us + the AEAD tag over {v,to}), THEN verify the sender's
  // signature which was itself sealed inside the ciphertext.

  // 1. Unseal the CEK — bound to OUR did + the sentinel context (a seal for another recipient,
  //    or a space CEK, yields a different key/AAD → throws). Also authenticates the outer
  //    {v,to,seal}: the seal fixes the CEK and {v,to} is the body AAD, so any outer tamper
  //    breaks the GCM tag below.
  let cek;
  try { cek = openSealed(env.seal, identity, sealContext(env.to)); } catch { throw new Error('openEnvelope: unseal failed'); }

  // 2. AEAD-decrypt the body (AAD = the cleartext {v,to}) → the SIGNED inner record.
  const { iv, ct, tag } = env.body;
  if (!iv || !ct || !tag) throw new Error('openEnvelope: malformed body');
  let signed;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cek, Buffer.from(String(iv), 'base64'));
    decipher.setAAD(contextBytes({ v: env.v, to: env.to }));
    decipher.setAuthTag(Buffer.from(String(tag), 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(String(ct), 'base64')), decipher.final()]);
    signed = JSON.parse(plaintext.toString('utf8'));
  } catch { throw new Error('openEnvelope: body decryption failed'); }
  if (!signed || typeof signed !== 'object' || typeof signed.sender_did !== 'string' || typeof signed.sig !== 'string' || typeof signed.to !== 'string') {
    throw new Error('openEnvelope: malformed inner');
  }

  // 3. Authenticate the SENDER: resolve their key from the (now-decrypted) sender_did and
  //    verify the INNER signature over the inner record (minus sig). An attacker can't forge
  //    Alice's sig without her key, and can't read/alter the sealed sender_did without the CEK
  //    → no impersonation, no swap. The verification is only possible AFTER decrypt, so no
  //    wire-visible value is verifiable against a public sender key (sealed-sender).
  const { sig, ...inner } = signed;
  let pub;
  try { pub = await resolvePeerKey(inner.sender_did); } catch { throw new Error('openEnvelope: unresolvable sender did'); }
  if (!verifyDetached(pub, canonicalize(inner), sig)) throw new Error('openEnvelope: signature verification failed');
  // The sender SIGNED the intended recipient — refuse a re-addressed / surreptitiously-
  // forwarded envelope (a legit recipient re-sealing the still-signed inner to a third party).
  if (inner.to !== env.to) throw new Error('openEnvelope: inner recipient mismatch (re-addressed)');

  return { payload: inner.payload, senderDid: inner.sender_did, nonce: inner.nonce, ts: inner.ts, senderSeq: inner.sender_seq };
}

export const _internal = { ENVELOPE_CTX_SPACE, ENVELOPE_VERSION, sealContext };
