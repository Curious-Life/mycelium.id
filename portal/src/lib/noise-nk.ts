/**
 * Noise_NK_25519_ChaChaPoly_BLAKE2s — Browser-side (Initiator) implementation.
 *
 * Byte-identical handshake output to the server-side implementation in
 * lib/noise-nk-server.js (which uses sodium-native + @stablelib/blake2s).
 *
 * NK pattern:
 *   pre-message: <- s  (responder's static public key known to initiator)
 *   -> e, es            (initiator sends ephemeral, does DH with responder static)
 *   <- e, ee            (responder sends ephemeral, does DH with initiator ephemeral)
 *
 * Uses @stablelib packages (pure JS, browser-compatible):
 *   @stablelib/x25519           — X25519 ECDH
 *   @stablelib/chacha20poly1305 — ChaCha20-Poly1305 AEAD
 *   @stablelib/blake2s          — BLAKE2s-256 hash (with keyed mode for HMAC)
 */

import { generateKeyPair, sharedKey } from '@stablelib/x25519';
import { ChaCha20Poly1305 } from '@stablelib/chacha20poly1305';
import { hash as blake2sHash } from '@stablelib/blake2s';

// ── Constants ──

const DHLEN = 32;
const HASHLEN = 32;
const AEAD_KEY_LEN = 32;
const AEAD_NONCE_LEN = 12;
const AEAD_TAG_LEN = 16;

const PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_BLAKE2s';
const PROTOCOL_NAME_BYTES = new TextEncoder().encode(PROTOCOL_NAME); // 33 bytes

// If protocol name fits in HASHLEN, pad with zeros; else hash it.
// 33 > 32, so we hash.
const INITIAL_H: Uint8Array = PROTOCOL_NAME_BYTES.length <= HASHLEN
  ? padTo32(PROTOCOL_NAME_BYTES)
  : blake2sHash(PROTOCOL_NAME_BYTES, HASHLEN);

function padTo32(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(HASHLEN);
  out.set(data);
  return out;
}

// ── Low-level primitives ──

function hash(data: Uint8Array): Uint8Array {
  return blake2sHash(data, HASHLEN);
}

/** HMAC-BLAKE2s using BLAKE2s keyed mode (per Noise spec section 4). */
function hmacHash(key: Uint8Array, data: Uint8Array): Uint8Array {
  const keyBuf = key.length > HASHLEN ? blake2sHash(key, HASHLEN) : key;
  return blake2sHash(data, HASHLEN, { key: new Uint8Array(keyBuf) });
}

/**
 * Noise HKDF: extract-then-expand using HMAC-BLAKE2s.
 * Returns 2 or 3 output keys of HASHLEN bytes each.
 */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, numOutputs: 2 | 3 = 2): Uint8Array[] {
  const tempKey = hmacHash(chainingKey, inputKeyMaterial);
  const out1 = hmacHash(tempKey, new Uint8Array([0x01]));
  const out2 = hmacHash(tempKey, concat(out1, new Uint8Array([0x02])));
  if (numOutputs === 2) return [out1, out2];
  const out3 = hmacHash(tempKey, concat(out2, new Uint8Array([0x03])));
  return [out1, out2, out3];
}

/** X25519 Diffie-Hellman. */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return sharedKey(privateKey, publicKey);
}

/** Concatenate Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ── AEAD (ChaCha20-Poly1305-IETF) ──

function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = new ChaCha20Poly1305(key);
  // seal returns ciphertext + 16-byte tag
  return cipher.seal(nonce, plaintext, ad.length > 0 ? ad : undefined);
}

function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const cipher = new ChaCha20Poly1305(key);
  const result = cipher.open(nonce, ciphertext, ad.length > 0 ? ad : undefined);
  if (result === null) {
    throw new Error('AEAD authentication failed');
  }
  return result;
}

/** Build 12-byte IETF nonce from counter (4 zero bytes || 8-byte BE counter). */
function nonceFromCounter(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(AEAD_NONCE_LEN);
  const hi = Number((counter >> 32n) & 0xFFFFFFFFn) >>> 0;
  const lo = Number(counter & 0xFFFFFFFFn) >>> 0;
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setUint32(4, hi, false); // big-endian
  view.setUint32(8, lo, false); // big-endian
  return nonce;
}

// ── CipherState ──

export class CipherState {
  private _key: Uint8Array;
  private _nonce: bigint = 0n;

  constructor(key: Uint8Array) {
    this._key = new Uint8Array(key);
  }

  /** Encrypt plaintext. Returns ciphertext including 16-byte tag. */
  encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    const nonce = nonceFromCounter(this._nonce);
    const ct = aeadEncrypt(this._key, nonce, ad, plaintext);
    this._nonce += 1n;
    return ct;
  }

  /** Decrypt ciphertext. Returns plaintext. Throws on auth failure. */
  decrypt(ciphertext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    const nonce = nonceFromCounter(this._nonce);
    const pt = aeadDecrypt(this._key, nonce, ad, ciphertext);
    this._nonce += 1n;
    return pt;
  }

  get nonce(): bigint {
    return this._nonce;
  }

  /** Rekey per Noise spec: REKEY(k) = ENCRYPT(k, maxnonce, "", zeros(32)), take first 32 bytes. */
  rekey(): void {
    const maxNonce = nonceFromCounter(0xFFFFFFFFFFFFFFFFn);
    const newKey = aeadEncrypt(this._key, maxNonce, new Uint8Array(0), new Uint8Array(AEAD_KEY_LEN));
    // Output is 32 + 16 = 48 bytes; take first 32 as new key
    this._key = new Uint8Array(newKey.subarray(0, AEAD_KEY_LEN));
  }
}

// ── SymmetricState (internal, used during handshake) ──

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  private _cipherKey: Uint8Array | null = null;
  private _cipherNonce: bigint = 0n;

  constructor() {
    this.h = new Uint8Array(INITIAL_H);
    this.ck = new Uint8Array(INITIAL_H);
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [newCk, tempK] = hkdf(this.ck, inputKeyMaterial);
    this.ck = newCk;
    this._cipherKey = tempK;
    this._cipherNonce = 0n;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this._cipherKey) {
      // Before any mixKey, data is sent in cleartext (just mixed into hash)
      this.mixHash(plaintext);
      return plaintext;
    }
    const nonce = nonceFromCounter(this._cipherNonce);
    const ct = aeadEncrypt(this._cipherKey, nonce, this.h, plaintext);
    this.mixHash(ct);
    this._cipherNonce += 1n;
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this._cipherKey) {
      this.mixHash(ciphertext);
      return ciphertext;
    }
    const nonce = nonceFromCounter(this._cipherNonce);
    const pt = aeadDecrypt(this._cipherKey, nonce, this.h, ciphertext);
    this.mixHash(ciphertext);
    this._cipherNonce += 1n;
    return pt;
  }

  /** Split into two CipherStates (initiator-sends, responder-sends). */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0));
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// ── NoiseNKInitiator ──

export class NoiseNKInitiator {
  private _responderStaticPub: Uint8Array;
  private _ephemeralPriv: Uint8Array | null = null;
  private _ephemeralPub: Uint8Array | null = null;
  private _ss: SymmetricState | null = null;

  /**
   * @param responderStaticPubKey 32-byte X25519 public key of the responder (server)
   */
  constructor(responderStaticPubKey: Uint8Array) {
    if (responderStaticPubKey.length !== DHLEN) {
      throw new Error(`Responder static public key must be ${DHLEN} bytes`);
    }
    this._responderStaticPub = new Uint8Array(responderStaticPubKey);
  }

  /**
   * Generate the first handshake message (-> e, es).
   * Optionally include a plaintext payload (encrypted under the es key).
   */
  createInitiatorMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const ss = new SymmetricState();
    this._ss = ss;

    // Pre-message: mix in responder's static public key
    ss.mixHash(this._responderStaticPub);

    // Generate initiator's ephemeral keypair
    const { publicKey: ePub, secretKey: ePriv } = generateKeyPair();
    this._ephemeralPriv = ePriv;
    this._ephemeralPub = ePub;

    // e: send ephemeral public key, mix into hash
    ss.mixHash(ePub);

    // es: DH(e, rs) — initiator's ephemeral with responder's static
    const dhResult_es = dh(ePriv, this._responderStaticPub);
    ss.mixKey(dhResult_es);

    // Encrypt initiator's payload
    const payloadCt = ss.encryptAndHash(payload);

    // Message = ephemeral pubkey || encrypted payload
    return concat(ePub, payloadCt);
  }

  /**
   * Process the responder's reply (<- e, ee) and derive transport ciphers.
   */
  processResponderMessage(msg: Uint8Array): {
    payload: Uint8Array;
    sendCipher: CipherState;
    recvCipher: CipherState;
    handshakeHash: Uint8Array;
  } {
    if (!this._ss || !this._ephemeralPriv) {
      throw new Error('Must call createInitiatorMessage() first');
    }
    const ss = this._ss;

    if (msg.length < DHLEN) {
      throw new Error('Responder message too short');
    }

    // Read responder's ephemeral public key (first 32 bytes)
    const re = msg.subarray(0, DHLEN);
    ss.mixHash(re);

    // ee: DH(e, re) — initiator's ephemeral with responder's ephemeral
    const dhResult_ee = dh(this._ephemeralPriv, re);
    ss.mixKey(dhResult_ee);

    // Decrypt responder's payload
    const responderPayloadCt = msg.subarray(DHLEN);
    const payload = ss.decryptAndHash(responderPayloadCt);

    // Split into transport ciphers
    const [c1, c2] = ss.split();
    // c1 = initiator-sends cipher, c2 = responder-sends cipher

    const handshakeHash = new Uint8Array(ss.h);

    // Zero ephemeral private key
    this._ephemeralPriv.fill(0);
    this._ephemeralPriv = null;
    this._ephemeralPub = null;
    this._ss = null;

    return {
      payload,
      sendCipher: c1,  // initiator sends with c1
      recvCipher: c2,  // initiator receives with c2
      handshakeHash,
    };
  }
}

// ── Frame serialization for transport messages ──

/**
 * Serialize an encrypted transport frame.
 * Wire format: [8-byte BE nonce counter] [ciphertext + 16-byte tag]
 */
export function encryptFrame(cipher: CipherState, plaintext: Uint8Array): Uint8Array {
  const counter = cipher.nonce;
  const ct = cipher.encrypt(plaintext);
  const frame = new Uint8Array(8 + ct.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const hi = Number((counter >> 32n) & 0xFFFFFFFFn) >>> 0;
  const lo = Number(counter & 0xFFFFFFFFn) >>> 0;
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  frame.set(ct, 8);
  return frame;
}

/**
 * Deserialize and decrypt a transport frame.
 * Verifies the nonce counter matches expectations (built into CipherState).
 */
export function decryptFrame(cipher: CipherState, frame: Uint8Array): Uint8Array {
  if (frame.length < 8 + AEAD_TAG_LEN) {
    throw new Error('Frame too short');
  }
  const ct = frame.subarray(8);
  return cipher.decrypt(ct);
}
