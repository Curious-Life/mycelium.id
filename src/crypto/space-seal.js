// src/crypto/space-seal.js — E2E shared-spaces sealed box (the SpaceCrypto KEY layer
// of the "Space Key Lockbox", docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md).
//
// Seals a per-space Content Encryption Key (CEK) to one member's published X25519
// keyAgreement key, so ONLY that member can unwrap it. This is anonymous public-key
// encryption (HPKE base mode / libsodium crypto_box_seal): an EPHEMERAL X25519
// keypair per seal → ECDH → HKDF → AES-256-GCM. Zero new dependencies: all
// primitives are Node's OpenSSL-backed crypto (X25519 ECDH, HKDF-SHA256, AES-256-GCM),
// already used across keystore.js / crypto-local.js. Composition only — no hand-rolled
// cipher or KDF.
//
// SEMANTIC (review note): `recipient_did` is a CONTEXT LABEL, not a cryptographic
// recipient authorization — the X25519 KEY gates *who* can open (only the holder of
// the matching private key). `recipient_did` only gates *which context* a blob is
// valid in. The calling layer (BU-CEK) MUST seal with `recipient_did` matching the
// key owner, and must derive "who may read" from the key/membership, never from this
// label.
//
// CONTEXT BINDING (E8): the seal is bound to {space_id, gen, recipient_did} in BOTH
// the HKDF info AND the GCM AAD, so a sealed blob is NON-TRANSPLANTABLE — a CEK sealed
// for {space-1, gen-3, alice} cannot be opened as gen-4, as another space, or for
// another recipient. The KEM context (ephemeral pubkey + recipient pubkey) is also
// folded into the KDF, closing unknown-key-share / key-reuse attacks.
//
// FORWARD SECRECY note: the ephemeral private key is discarded after each seal, so a
// later compromise of the SENDER cannot recover past seals (the recipient's long-term
// X25519 key still can — inherent to anonymous PKE).

import crypto from 'node:crypto';

const IV_BYTES = 12;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // reconstruct a raw X25519 pub
const HKDF_LABEL = 'mycelium-space-seal:v1';

/** Canonical context bytes — bound in BOTH the KDF info and the GCM AAD. Fixed key
 *  order + canonical types so seal and open compute byte-identical context. */
function canonicalContext(ctx) {
  if (ctx == null || ctx.space_id == null || ctx.gen == null || ctx.recipient_did == null) {
    throw new Error('seal context requires space_id, gen, recipient_did');
  }
  if (!Number.isInteger(ctx.gen)) throw new Error('seal context gen must be an integer');
  return Buffer.from(JSON.stringify({
    space_id: String(ctx.space_id),
    gen: Number(ctx.gen),
    recipient_did: String(ctx.recipient_did),
  }), 'utf8');
}

function rawX25519Pub(pubB64) {
  const raw = Buffer.from(String(pubB64), 'base64url');
  if (raw.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return raw;
}

/** Derive the AES key from the ECDH shared secret, folding in the KEM context
 *  (ephemeral pubkey ‖ recipient pubkey) and the {space,gen,recipient} context. */
function deriveSealKey(sharedSecret, ephPubRaw, recipientPubRaw, ctxBytes) {
  const info = Buffer.concat([Buffer.from(HKDF_LABEL), ctxBytes, ephPubRaw, recipientPubRaw]);
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), info, 32));
}

/**
 * Seal a 32-byte CEK to a recipient's X25519 keyAgreement public key.
 * @param {Buffer} cek32  the 32-byte content key to seal
 * @param {string} recipientPubB64  recipient's X25519 keyAgreement key (base64url)
 * @param {{space_id,gen,recipient_did}} context  bound into the seal (non-transplantable)
 * @returns {{eph:string, iv:string, ct:string, tag:string}} the sealed blob (base64)
 */
export function sealToX25519(cek32, recipientPubB64, context) {
  if (!Buffer.isBuffer(cek32) || cek32.length !== 32) throw new Error('sealToX25519: cek must be a 32-byte Buffer');
  const ctxBytes = canonicalContext(context);
  const recipientPubRaw = rawX25519Pub(recipientPubB64);
  const recipientPub = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, recipientPubRaw]), format: 'der', type: 'spki' });

  // Fresh ephemeral keypair per seal (forward secrecy + a unique key/IV each time).
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPubRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });

  const key = deriveSealKey(shared, ephPubRaw, recipientPubRaw, ctxBytes);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ctxBytes);
  const ct = Buffer.concat([cipher.update(cek32), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    eph: Buffer.from(ephPubRaw).toString('base64url'),
    iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'),
  };
}

/**
 * Open a sealed blob with the recipient identity's X25519 key. The SAME context must
 * be supplied (the caller knows which space/gen/recipient this seal is for) — a wrong
 * context yields a different key + AAD → throws (non-transplantable).
 * @param {object} blob  {eph,iv,ct,tag} from sealToX25519
 * @param {object} identity  createIdentity() — provides keyAgreementSharedSecret + keyAgreementPublicKeyB64
 * @param {{space_id,gen,recipient_did}} context  must equal the seal-time context
 * @returns {Buffer} the 32-byte CEK
 */
export function openSealed(blob, identity, context) {
  if (blob == null || !blob.eph || !blob.iv || !blob.ct || !blob.tag) throw new Error('openSealed: malformed blob');
  if (!identity || typeof identity.keyAgreementSharedSecret !== 'function' || !identity.keyAgreementPublicKeyB64) {
    throw new Error('openSealed: identity must expose keyAgreementSharedSecret + keyAgreementPublicKeyB64');
  }
  const ctxBytes = canonicalContext(context);
  const ephPubRaw = rawX25519Pub(blob.eph);
  const recipientPubRaw = rawX25519Pub(identity.keyAgreementPublicKeyB64);
  // ECDH(my_priv, eph_pub) == ECDH(eph_priv, my_pub) = the seal-time shared secret.
  const shared = identity.keyAgreementSharedSecret(blob.eph);

  const key = deriveSealKey(shared, ephPubRaw, recipientPubRaw, ctxBytes);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(blob.iv), 'base64'));
  decipher.setAAD(ctxBytes);
  decipher.setAuthTag(Buffer.from(String(blob.tag), 'base64'));
  const cek = Buffer.concat([decipher.update(Buffer.from(String(blob.ct), 'base64')), decipher.final()]); // throws on mismatch
  if (cek.length !== 32) throw new Error('openSealed: unsealed key is not 32 bytes');
  return cek;
}

export const _internal = { canonicalContext, deriveSealKey, HKDF_LABEL };
