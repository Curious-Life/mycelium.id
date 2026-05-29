/**
 * Tests for lib/noise-nk-server.js — Noise_NK_25519_ChaChaPoly_BLAKE2s
 *
 * Validates:
 * 1. Handshake completes and produces session keys
 * 2. CipherState encrypt/decrypt round-trip
 * 3. Nonce monotonicity (replay rejection)
 * 4. Invalid handshake messages rejected
 * 5. Rekey produces new keys
 * 6. Frame serialization round-trip
 * 7. Cross-party: initiator and responder can communicate
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'sodium-native';
import { hash as blake2sHash } from '@stablelib/blake2s';

import {
  NoiseNKResponder,
  CipherState,
  encryptFrame,
  decryptFrame,
} from '@mycelium/core/noise-nk-server.js';

// ── Helpers ──

/** Generate X25519 keypair for testing. */
function genX25519() {
  const priv = Buffer.alloc(32);
  const pub = Buffer.alloc(32);
  sodium.randombytes_buf(priv);
  sodium.crypto_scalarmult_base(pub, priv);
  return { priv, pub };
}

/**
 * Minimal initiator implementation for testing the responder.
 * Mirrors the Noise NK initiator logic.
 */
function initiatorHandshake(responderStaticPub, payload = Buffer.alloc(0)) {
  const PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_BLAKE2s';
  const PROTOCOL_BYTES = Buffer.from(PROTOCOL_NAME, 'ascii');
  const HASHLEN = 32;

  const initialH = PROTOCOL_BYTES.length <= HASHLEN
    ? Buffer.concat([PROTOCOL_BYTES, Buffer.alloc(HASHLEN - PROTOCOL_BYTES.length)])
    : Buffer.from(blake2sHash(PROTOCOL_BYTES, HASHLEN));

  function hash(data) { return Buffer.from(blake2sHash(data, HASHLEN)); }

  function hmacHash(key, data) {
    const keyBuf = key.length > HASHLEN ? blake2sHash(key, HASHLEN) : key;
    return Buffer.from(blake2sHash(data, HASHLEN, { key: new Uint8Array(keyBuf) }));
  }

  function hkdf(ck, ikm, n = 2) {
    const tk = hmacHash(ck, ikm);
    const o1 = hmacHash(tk, Buffer.from([0x01]));
    const o2 = hmacHash(tk, Buffer.concat([o1, Buffer.from([0x02])]));
    if (n === 2) return [o1, o2];
    const o3 = hmacHash(tk, Buffer.concat([o2, Buffer.from([0x03])]));
    return [o1, o2, o3];
  }

  function dh(priv, pub) {
    const out = Buffer.alloc(32);
    sodium.crypto_scalarmult(out, priv, pub);
    return out;
  }

  function nonceFromCounter(c) {
    const n = Buffer.alloc(12);
    n.writeUInt32BE(Number(c >> 32n) >>> 0, 4);
    n.writeUInt32BE(Number(c & 0xFFFFFFFFn) >>> 0, 8);
    return n;
  }

  function aeadEncrypt(key, nonce, ad, pt) {
    const ct = Buffer.alloc(pt.length + 16);
    sodium.crypto_aead_chacha20poly1305_ietf_encrypt(ct, pt, ad.length > 0 ? ad : null, null, nonce, key);
    return ct;
  }

  function aeadDecrypt(key, nonce, ad, ct) {
    const pt = Buffer.alloc(ct.length - 16);
    sodium.crypto_aead_chacha20poly1305_ietf_decrypt(pt, null, ct, ad.length > 0 ? ad : null, nonce, key);
    return pt;
  }

  // SymmetricState
  let h = Buffer.from(initialH);
  let ck = Buffer.from(initialH);
  let cipherKey = null;
  let cipherNonce = 0n;

  function mixHash(d) { h = hash(Buffer.concat([h, d])); }
  function mixKey(ikm) {
    const [newCk, tk] = hkdf(ck, ikm);
    ck = newCk; cipherKey = tk; cipherNonce = 0n;
  }
  function encryptAndHash(pt) {
    if (!cipherKey) { mixHash(pt); return pt; }
    const n = nonceFromCounter(cipherNonce);
    const ct = aeadEncrypt(cipherKey, n, h, pt);
    mixHash(ct);
    cipherNonce += 1n;
    return ct;
  }
  function decryptAndHash(ct) {
    if (!cipherKey) { mixHash(ct); return ct; }
    const n = nonceFromCounter(cipherNonce);
    const pt = aeadDecrypt(cipherKey, n, h, ct);
    mixHash(ct);
    cipherNonce += 1n;
    return pt;
  }
  function split() {
    const [k1, k2] = hkdf(ck, Buffer.alloc(0));
    return [new CipherState(k1), new CipherState(k2)];
  }

  // Pre-message: mix responder's static pubkey
  mixHash(responderStaticPub);

  // Message 1: → e, es
  const { priv: ePriv, pub: ePub } = genX25519();
  mixHash(ePub);

  const dhResult_es = dh(ePriv, responderStaticPub);
  mixKey(dhResult_es);

  const payloadCt = encryptAndHash(payload);
  const msg1 = Buffer.concat([ePub, payloadCt]);

  // Return a function to process the responder's reply
  function processResponse(msg2) {
    const re = msg2.subarray(0, 32);
    mixHash(re);

    const dhResult_ee = dh(ePriv, re);
    mixKey(dhResult_ee);

    const respPayload = decryptAndHash(msg2.subarray(32));

    const [c1, c2] = split();
    return {
      responderPayload: respPayload,
      sendCipher: c1,   // initiator sends with c1
      recvCipher: c2,    // initiator receives with c2
      handshakeHash: Buffer.from(h),
    };
  }

  return { msg1, processResponse };
}

// ── Tests ──

describe('Noise NK Handshake', () => {
  let responderKeys;

  beforeEach(() => {
    responderKeys = genX25519();
  });

  it('completes handshake and produces session keys', () => {
    const responder = new NoiseNKResponder(responderKeys.priv, responderKeys.pub);

    const initiatorPayload = Buffer.from('{"version":1}');
    const { msg1, processResponse } = initiatorHandshake(responderKeys.pub, initiatorPayload);

    const responderPayload = Buffer.from('{"fingerprint":"test"}');
    const result = responder.processHandshake(msg1, responderPayload);

    assert.deepStrictEqual(result.initiatorPayload, initiatorPayload);

    const initiatorResult = processResponse(result.response);
    assert.deepStrictEqual(initiatorResult.responderPayload, responderPayload);

    // Handshake hashes must match
    assert.deepStrictEqual(result.handshakeHash, initiatorResult.handshakeHash);
  });

  it('derived session keys allow bidirectional communication', () => {
    const responder = new NoiseNKResponder(responderKeys.priv, responderKeys.pub);

    const { msg1, processResponse } = initiatorHandshake(responderKeys.pub);
    const rResult = responder.processHandshake(msg1, Buffer.alloc(0));
    const iResult = processResponse(rResult.response);

    // Initiator sends → Responder receives
    const msg = Buffer.from('Hello from initiator');
    const ct = iResult.sendCipher.encrypt(msg);
    const pt = rResult.recvCipher.decrypt(ct);
    assert.deepStrictEqual(pt, msg);

    // Responder sends → Initiator receives
    const reply = Buffer.from('Hello from responder');
    const ct2 = rResult.sendCipher.encrypt(reply);
    const pt2 = iResult.recvCipher.decrypt(ct2);
    assert.deepStrictEqual(pt2, reply);
  });

  it('rejects truncated handshake message', () => {
    const responder = new NoiseNKResponder(responderKeys.priv, responderKeys.pub);
    assert.throws(() => responder.processHandshake(Buffer.alloc(16)));
  });

  it('rejects corrupted handshake message', () => {
    const responder = new NoiseNKResponder(responderKeys.priv, responderKeys.pub);

    const { msg1 } = initiatorHandshake(responderKeys.pub, Buffer.from('test'));
    // Corrupt a byte in the encrypted payload
    const corrupted = Buffer.from(msg1);
    corrupted[33] ^= 0xFF;

    assert.throws(() => responder.processHandshake(corrupted));
  });

  it('rejects handshake with wrong static key', () => {
    const wrongKeys = genX25519();
    const responder = new NoiseNKResponder(responderKeys.priv, responderKeys.pub);

    // Initiator uses wrong responder public key
    const { msg1 } = initiatorHandshake(wrongKeys.pub, Buffer.from('test'));

    // Responder should fail to decrypt (es DH mismatch)
    assert.throws(() => responder.processHandshake(msg1));
  });
});

describe('CipherState', () => {
  it('encrypt/decrypt round-trip', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);

    const encryptor = new CipherState(key);
    const decryptor = new CipherState(key);

    for (let i = 0; i < 10; i++) {
      const msg = Buffer.from(`message ${i}`);
      const ct = encryptor.encrypt(msg);
      const pt = decryptor.decrypt(ct);
      assert.deepStrictEqual(pt, msg);
    }
  });

  it('nonce increments', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);
    const cs = new CipherState(key);

    assert.equal(cs.nonce, 0n);
    cs.encrypt(Buffer.from('a'));
    assert.equal(cs.nonce, 1n);
    cs.encrypt(Buffer.from('b'));
    assert.equal(cs.nonce, 2n);
  });

  it('rekey produces working cipher', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);

    const enc = new CipherState(Buffer.from(key));
    const dec = new CipherState(Buffer.from(key));

    // Encrypt a message
    const ct1 = enc.encrypt(Buffer.from('before rekey'));
    const pt1 = dec.decrypt(ct1);
    assert.deepStrictEqual(pt1, Buffer.from('before rekey'));

    // Rekey both sides
    enc.rekey();
    dec.rekey();

    // Still works after rekey
    const ct2 = enc.encrypt(Buffer.from('after rekey'));
    const pt2 = dec.decrypt(ct2);
    assert.deepStrictEqual(pt2, Buffer.from('after rekey'));
  });

  it('different keys cannot decrypt each other', () => {
    const key1 = Buffer.alloc(32);
    const key2 = Buffer.alloc(32);
    sodium.randombytes_buf(key1);
    sodium.randombytes_buf(key2);

    const enc = new CipherState(key1);
    const dec = new CipherState(key2);

    const ct = enc.encrypt(Buffer.from('secret'));
    assert.throws(() => dec.decrypt(ct));
  });
});

describe('Frame serialization', () => {
  it('encryptFrame/decryptFrame round-trip', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);

    const enc = new CipherState(Buffer.from(key));
    const dec = new CipherState(Buffer.from(key));

    const plaintext = Buffer.from(JSON.stringify({ type: 'chat', data: { message: 'hello' } }));
    const frame = encryptFrame(enc, plaintext);

    // Frame should be: 8 (counter) + plaintext.length + 16 (tag)
    assert.equal(frame.length, 8 + plaintext.length + 16);

    // First 8 bytes are nonce counter (0 for first frame)
    assert.equal(frame.readBigUInt64BE(0), 0n);

    const decrypted = decryptFrame(dec, frame);
    assert.deepStrictEqual(decrypted, plaintext);
  });

  it('rejects too-short frames', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);
    const dec = new CipherState(key);

    assert.throws(() => decryptFrame(dec, Buffer.alloc(20)));
  });

  it('multiple frames with incrementing counters', () => {
    const key = Buffer.alloc(32);
    sodium.randombytes_buf(key);

    const enc = new CipherState(Buffer.from(key));
    const dec = new CipherState(Buffer.from(key));

    for (let i = 0; i < 100; i++) {
      const msg = Buffer.from(`frame ${i}`);
      const frame = encryptFrame(enc, msg);
      assert.equal(frame.readBigUInt64BE(0), BigInt(i));
      const pt = decryptFrame(dec, frame);
      assert.deepStrictEqual(pt, msg);
    }
  });
});

describe('Full handshake + transport', () => {
  it('initiator and responder can exchange multiple messages', () => {
    const rKeys = genX25519();
    const responder = new NoiseNKResponder(rKeys.priv, rKeys.pub);

    const initPayload = Buffer.from(JSON.stringify({ clientNonce: 'abc', version: 1 }));
    const { msg1, processResponse } = initiatorHandshake(rKeys.pub, initPayload);

    const respPayload = Buffer.from(JSON.stringify({ serverNonce: 'def', fingerprint: '1234-5678' }));
    const rResult = responder.processHandshake(msg1, respPayload);
    const iResult = processResponse(rResult.response);

    // Exchange 50 messages each direction via frames
    for (let i = 0; i < 50; i++) {
      // Initiator → Responder
      const iMsg = Buffer.from(JSON.stringify({ id: `req_${i}`, type: 'chat', data: { message: `hello ${i}` } }));
      const iFrame = encryptFrame(iResult.sendCipher, iMsg);
      const iDecrypted = decryptFrame(rResult.recvCipher, iFrame);
      assert.deepStrictEqual(iDecrypted, iMsg);

      // Responder → Initiator
      const rMsg = Buffer.from(JSON.stringify({ id: `req_${i}`, type: 'response', data: { reply: `world ${i}` } }));
      const rFrame = encryptFrame(rResult.sendCipher, rMsg);
      const rDecrypted = decryptFrame(iResult.recvCipher, rFrame);
      assert.deepStrictEqual(rDecrypted, rMsg);
    }
  });
});
