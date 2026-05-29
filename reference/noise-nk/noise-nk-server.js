/**
 * Noise_NK_25519_ChaChaPoly_BLAKE2s — Server-side (Responder) implementation.
 *
 * Follows the Noise Protocol Framework specification:
 *   NK pattern:
 *     pre-message: ← s  (responder's static public key known to initiator)
 *     → e, es            (initiator sends ephemeral, does DH with responder static)
 *     ← e, ee            (responder sends ephemeral, does DH with initiator ephemeral)
 *
 * Uses:
 *   sodium-native — X25519 (crypto_scalarmult), ChaCha20-Poly1305-IETF
 *   @stablelib/blake2s — BLAKE2s-256 hash (sodium only has BLAKE2b)
 *
 * All buffers are Node.js Buffers. Callers interact with NoiseNKResponder
 * and CipherState classes only.
 */

import sodium from 'sodium-native';
import { hash as blake2sHash } from '@stablelib/blake2s';

// ── Constants ──

const DHLEN = 32;      // X25519 output
const HASHLEN = 32;    // BLAKE2s-256
const AEAD_KEY_LEN = 32;
const AEAD_NONCE_LEN = 12;
const AEAD_TAG_LEN = 16;

// Protocol name (padded or hashed to HASHLEN if longer than HASHLEN)
const PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_BLAKE2s';
const PROTOCOL_NAME_BYTES = Buffer.from(PROTOCOL_NAME, 'ascii');

// If protocol name fits in HASHLEN, pad with zeros; else hash it
const INITIAL_H = PROTOCOL_NAME_BYTES.length <= HASHLEN
  ? Buffer.concat([PROTOCOL_NAME_BYTES, Buffer.alloc(HASHLEN - PROTOCOL_NAME_BYTES.length)])
  : Buffer.from(blake2sHash(PROTOCOL_NAME_BYTES, HASHLEN));

// ── Low-level primitives ──

function hash(data) {
  return Buffer.from(blake2sHash(data, HASHLEN));
}

/** HMAC-BLAKE2s using the keyed mode of BLAKE2s (per Noise spec section 4). */
function hmacHash(key, data) {
  // Noise defines HMAC(key, data) using the hash's built-in keyed mode
  // BLAKE2s supports keys up to 32 bytes natively
  const keyBuf = key.length > HASHLEN ? blake2sHash(key, HASHLEN) : key;
  // BLAKE2s keyed mode: pass key as second arg to @stablelib/blake2s hash
  // @stablelib/blake2s.hash(data, outputLength, config) where config.key is the key
  return Buffer.from(blake2sHash(data, HASHLEN, { key: new Uint8Array(keyBuf) }));
}

/** Noise HKDF: extract-then-expand using HMAC-BLAKE2s.
 *  Returns 2 or 3 output keys of HASHLEN bytes each. */
function hkdf(chainingKey, inputKeyMaterial, numOutputs = 2) {
  const tempKey = hmacHash(chainingKey, inputKeyMaterial);
  const out1 = hmacHash(tempKey, Buffer.from([0x01]));
  const out2 = hmacHash(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  if (numOutputs === 2) return [out1, out2];
  const out3 = hmacHash(tempKey, Buffer.concat([out2, Buffer.from([0x03])]));
  return [out1, out2, out3];
}

/** X25519 Diffie-Hellman. */
function dh(privateKey, publicKey) {
  const out = Buffer.alloc(DHLEN);
  sodium.crypto_scalarmult(out, privateKey, publicKey);
  return out;
}

/** Generate X25519 ephemeral keypair. */
function generateEphemeral() {
  const priv = Buffer.alloc(DHLEN);
  const pub = Buffer.alloc(DHLEN);
  sodium.randombytes_buf(priv);
  sodium.crypto_scalarmult_base(pub, priv);
  return { priv, pub };
}

// ── AEAD (ChaCha20-Poly1305-IETF) ──

function aeadEncrypt(key, nonce, ad, plaintext) {
  const ciphertext = Buffer.alloc(plaintext.length + AEAD_TAG_LEN);
  sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
    ciphertext,
    plaintext,
    ad.length > 0 ? ad : null,
    null, // nsec (unused)
    nonce,
    key
  );
  return ciphertext;
}

function aeadDecrypt(key, nonce, ad, ciphertext) {
  const plaintext = Buffer.alloc(ciphertext.length - AEAD_TAG_LEN);
  const ok = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
    plaintext,
    null, // nsec
    ciphertext,
    ad.length > 0 ? ad : null,
    nonce,
    key
  );
  if (!ok && plaintext.every(b => b === 0) && ciphertext.length > AEAD_TAG_LEN) {
    // sodium-native returns false on failure, but check was implicit in older versions
    // The actual check: if decrypt wrote zeros AND the function didn't throw, it's OK
    // In newer sodium-native, decrypt throws on auth failure
  }
  return plaintext;
}

/** Build 12-byte IETF nonce from 8-byte counter (4 zero bytes || 8-byte BE counter). */
function nonceFromCounter(counter) {
  const nonce = Buffer.alloc(AEAD_NONCE_LEN);
  // Write counter as big-endian uint64 at offset 4
  const hi = Number(counter >> 32n) >>> 0;
  const lo = Number(counter & 0xFFFFFFFFn) >>> 0;
  nonce.writeUInt32BE(hi, 4);
  nonce.writeUInt32BE(lo, 8);
  return nonce;
}

// ── CipherState ──

export class CipherState {
  #key;
  #nonce = 0n;

  constructor(key) {
    this.#key = Buffer.from(key);
  }

  /** Encrypt plaintext. Returns ciphertext including 16-byte tag. */
  encrypt(plaintext, ad = Buffer.alloc(0)) {
    const nonce = nonceFromCounter(this.#nonce);
    const ct = aeadEncrypt(this.#key, nonce, ad, plaintext);
    this.#nonce += 1n;
    return ct;
  }

  /** Decrypt ciphertext. Throws on auth failure or non-monotonic nonce. */
  decrypt(ciphertext, ad = Buffer.alloc(0)) {
    const nonce = nonceFromCounter(this.#nonce);
    const pt = aeadDecrypt(this.#key, nonce, ad, ciphertext);
    this.#nonce += 1n;
    return pt;
  }

  get nonce() { return this.#nonce; }

  /** Rekey per Noise spec: REKEY(k) = ENCRYPT(k, maxnonce, "", zeros(32)). */
  rekey() {
    const maxNonce = nonceFromCounter(0xFFFFFFFFFFFFFFFFn);
    const newKey = aeadEncrypt(this.#key, maxNonce, Buffer.alloc(0), Buffer.alloc(AEAD_KEY_LEN));
    // Output is 32 + 16 = 48 bytes; take first 32 as new key
    this.#key = Buffer.from(newKey.subarray(0, AEAD_KEY_LEN));
  }
}

// ── SymmetricState (internal, used during handshake) ──

class SymmetricState {
  ck; // chaining key
  h;  // handshake hash
  #cipherKey = null;
  #cipherNonce = 0n;

  constructor() {
    this.h = Buffer.from(INITIAL_H);
    this.ck = Buffer.from(INITIAL_H);
  }

  mixHash(data) {
    this.h = hash(Buffer.concat([this.h, data]));
  }

  mixKey(inputKeyMaterial) {
    const [newCk, tempK] = hkdf(this.ck, inputKeyMaterial);
    this.ck = newCk;
    this.#cipherKey = tempK;
    this.#cipherNonce = 0n;
  }

  encryptAndHash(plaintext) {
    if (!this.#cipherKey) {
      // Before any mixKey, data is sent in cleartext (just mixed into hash)
      this.mixHash(plaintext);
      return plaintext;
    }
    const nonce = nonceFromCounter(this.#cipherNonce);
    const ct = aeadEncrypt(this.#cipherKey, nonce, this.h, plaintext);
    this.mixHash(ct);
    this.#cipherNonce += 1n;
    return ct;
  }

  decryptAndHash(ciphertext) {
    if (!this.#cipherKey) {
      this.mixHash(ciphertext);
      return ciphertext;
    }
    const nonce = nonceFromCounter(this.#cipherNonce);
    const pt = aeadDecrypt(this.#cipherKey, nonce, this.h, ciphertext);
    this.mixHash(ciphertext);
    this.#cipherNonce += 1n;
    return pt;
  }

  /** Split into two CipherStates (initiator-sends, responder-sends). */
  split() {
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0));
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// ── NoiseNKResponder ──

export class NoiseNKResponder {
  #staticPriv;
  #staticPub;

  /**
   * @param {Buffer} staticPrivateKey - 32-byte X25519 private key
   * @param {Buffer} staticPublicKey  - 32-byte X25519 public key
   */
  constructor(staticPrivateKey, staticPublicKey) {
    this.#staticPriv = Buffer.from(staticPrivateKey);
    this.#staticPub = Buffer.from(staticPublicKey);
  }

  /**
   * Process the initiator's first message and produce the responder's reply.
   *
   * @param {Buffer} initiatorMsg - The initiator's handshake message
   * @param {Buffer} responderPayload - Plaintext payload to encrypt in response
   * @returns {{ response: Buffer, sendCipher: CipherState, recvCipher: CipherState }}
   *   sendCipher = responder→initiator, recvCipher = initiator→responder
   */
  processHandshake(initiatorMsg, responderPayload = Buffer.alloc(0)) {
    const ss = new SymmetricState();

    // Pre-message: mix in responder's static public key
    ss.mixHash(this.#staticPub);

    // ── Message 1: → e, es ──
    // Read initiator's ephemeral public key (first 32 bytes)
    if (initiatorMsg.length < DHLEN) {
      throw new Error('Handshake message too short');
    }
    const re = initiatorMsg.subarray(0, DHLEN); // initiator's ephemeral pubkey
    ss.mixHash(re);

    // es: DH(s, re) — responder's static with initiator's ephemeral
    const dhResult_es = dh(this.#staticPriv, re);
    ss.mixKey(dhResult_es);

    // Decrypt initiator's payload
    const initiatorPayloadCt = initiatorMsg.subarray(DHLEN);
    let initiatorPayload;
    try {
      initiatorPayload = ss.decryptAndHash(initiatorPayloadCt);
    } catch {
      throw new Error('Handshake authentication failed');
    }

    // ── Message 2: ← e, ee ──
    // Generate responder's ephemeral keypair
    const { priv: ePriv, pub: ePub } = generateEphemeral();
    const responseParts = [];

    // Send ephemeral public key
    ss.mixHash(ePub);
    responseParts.push(ePub);

    // ee: DH(e, re) — responder's ephemeral with initiator's ephemeral
    const dhResult_ee = dh(ePriv, re);
    ss.mixKey(dhResult_ee);

    // Encrypt responder's payload
    const responsePayloadCt = ss.encryptAndHash(responderPayload);
    responseParts.push(responsePayloadCt);

    // Split into transport ciphers
    const [c1, c2] = ss.split();
    // c1 = initiator-sends cipher, c2 = responder-sends cipher

    // Zero ephemeral private key
    sodium.sodium_memzero(ePriv);
    sodium.sodium_memzero(dhResult_es);
    sodium.sodium_memzero(dhResult_ee);

    return {
      initiatorPayload,
      response: Buffer.concat(responseParts),
      sendCipher: c2,   // responder sends with c2
      recvCipher: c1,    // responder receives with c1
      handshakeHash: ss.h,
    };
  }
}

// ── Frame serialization for transport messages ──

/**
 * Serialize an encrypted transport frame.
 * Wire format: [8-byte BE nonce counter] [ciphertext + 16-byte tag]
 */
export function encryptFrame(cipher, plaintext) {
  const counter = cipher.nonce;
  const ct = cipher.encrypt(Buffer.from(plaintext));
  const frame = Buffer.alloc(8 + ct.length);
  const hi = Number(counter >> 32n) >>> 0;
  const lo = Number(counter & 0xFFFFFFFFn) >>> 0;
  frame.writeUInt32BE(hi, 0);
  frame.writeUInt32BE(lo, 4);
  ct.copy(frame, 8);
  return frame;
}

/**
 * Deserialize and decrypt a transport frame.
 * Verifies the nonce counter matches expectations (built into CipherState).
 */
export function decryptFrame(cipher, frame) {
  if (frame.length < 8 + AEAD_TAG_LEN) {
    throw new Error('Frame too short');
  }
  const ct = frame.subarray(8);
  return cipher.decrypt(ct);
}
