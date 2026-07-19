// src/crypto/pair-channel.js — the QR device-pairing secure channel
// (docs/PHONE-QR-PAIRING-DESIGN-2026-07-19.md §3.3, Unit B).
//
// A direct ephemeral-X25519 ECDH channel between the Mac (ephemeral keypair, shown
// as `epk` in the QR) and the phone (its own X25519 keypair). Both sides derive one
// 80-byte HKDF-SHA256 output bound to the full transcript, split into:
//   ckC2S  (phone→server, e.g. the encrypted device label)
//   ckS2C  (server→phone, e.g. the sealed per-device token)
//   sas    (a 6-digit human-comparison code)
// AES-256-GCM with the direction + pid bound in AAD → a ciphertext is valid in only
// one direction (no reflection). Composition of node:crypto only — no new deps,
// mirrors src/crypto/space-seal.js.
//
// ┌─ FROZEN INTEROP CONTRACT (the iOS CryptoKit side MUST match byte-for-byte) ─┐
// │ • X25519 raw 32-byte keys, base64url (no padding).                          │
// │ • ecdh = X25519(myPriv, peerPub) (crypto.diffieHellman /                    │
// │   CryptoKit sharedSecretFromKeyAgreement). REJECT an all-zero result.       │
// │ • transcript = HKDF-SHA256(                                                 │
// │       ikm  = ecdh (32 bytes),                                               │
// │       salt = pid  (the 16 DECODED bytes, NOT the base64url string),         │
// │       info = "mycelium-pair-v1" ‖ epkRaw(32) ‖ phonePubRaw(32),             │
// │       L    = 80 )                                                           │
// │ • ckC2S = transcript[0..32) · ckS2C = transcript[32..64) · sasIkm = [64..72)│
// │   ckProof = transcript[72..104) (a DEDICATED key for the result proof HMAC — │
// │   never reused as an AEAD key).  (HKDF-Expand is prefix-stable, so widening   │
// │   L from 80→104 does NOT change ckC2S/ckS2C/sas.)                             │
// │ • sas   = (uint32BE(sasIkm[0..4]) % 1_000_000) → 6 digits, zero-padded.     │
// │ • AEAD  = AES-256-GCM, 12-byte random IV, 16-byte tag;                      │
// │   AAD   = pid(16) ‖ dirByte (0x01=c2s, 0x02=s2c);                           │
// │   wire fields iv/ct/tag are base64 (standard, padded).                      │
// │ epk/phonePub are ALWAYS in that fixed order in `info`, regardless of which  │
// │ side derives — so both ends compute the identical transcript.              │
// └────────────────────────────────────────────────────────────────────────────┘

import crypto from 'node:crypto';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // raw X25519 pub → SPKI DER
const HKDF_INFO = Buffer.from('mycelium-pair-v1');
const IV_BYTES = 12;
const TRANSCRIPT_LEN = 104; // ckC2S(32) + ckS2C(32) + sasIkm(8) + ckProof(32) = 104
const DIR = { c2s: 0x01, s2c: 0x02 };

function rawFromPubB64(pubB64) {
  const raw = Buffer.from(String(pubB64), 'base64url');
  if (raw.length !== 32) throw new Error('pair-channel: X25519 public key must be 32 bytes');
  return raw;
}

function pubKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** A fresh ephemeral X25519 keypair (one per pairing session; the private key stays
 *  in the server's in-memory pending store and dies with the process). */
export function newEphemeral() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const epkRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv: privateKey, epkRaw: Buffer.from(epkRaw), epkB64: Buffer.from(epkRaw).toString('base64url') };
}

/** Raw X25519 ECDH. `myPriv` is a KeyObject; `peerPubB64` base64url. Rejects the
 *  all-zero shared secret (low-order / contributory-behaviour guard). */
export function ecdh(myPriv, peerPubB64) {
  const shared = crypto.diffieHellman({ privateKey: myPriv, publicKey: pubKeyFromRaw(rawFromPubB64(peerPubB64)) });
  if (shared.length !== 32 || shared.every((b) => b === 0)) throw new Error('pair-channel: invalid (all-zero) ECDH shared secret');
  return shared;
}

/**
 * Derive the two directional channel keys + the SAS from the shared secret, bound to
 * the full transcript. `epkRaw`/`phonePubRaw` are the 32-byte raw keys in FIXED order.
 * @returns {{ ckC2S: Buffer, ckS2C: Buffer, ckProof: Buffer, sas: string }}
 */
export function deriveChannel({ shared, pidBytes, epkRaw, phonePubRaw }) {
  if (!Buffer.isBuffer(pidBytes) || pidBytes.length !== 16) throw new Error('pair-channel: pid must be 16 bytes');
  if (!Buffer.isBuffer(epkRaw) || epkRaw.length !== 32) throw new Error('pair-channel: epkRaw must be 32 bytes');
  if (!Buffer.isBuffer(phonePubRaw) || phonePubRaw.length !== 32) throw new Error('pair-channel: phonePubRaw must be 32 bytes');
  const info = Buffer.concat([HKDF_INFO, epkRaw, phonePubRaw]);
  const t = Buffer.from(crypto.hkdfSync('sha256', shared, pidBytes, info, TRANSCRIPT_LEN));
  const sasNum = t.readUInt32BE(64) % 1_000_000;
  return {
    ckC2S: t.subarray(0, 32),
    ckS2C: t.subarray(32, 64),
    ckProof: t.subarray(72, 104), // dedicated proof key — never an AEAD key (audit D1)
    sas: String(sasNum).padStart(6, '0'),
  };
}

function aad(pidBytes, dirByte) {
  return Buffer.concat([pidBytes, Buffer.from([dirByte])]);
}

/** Seal `plaintext` (Buffer|string) under a directional channel key. dir ∈ 'c2s'|'s2c'. */
export function sealDir(ck, plaintext, pidBytes, dir) {
  const dirByte = DIR[dir];
  if (!dirByte) throw new Error('pair-channel: dir must be c2s|s2c');
  if (!Buffer.isBuffer(ck) || ck.length !== 32) throw new Error('pair-channel: ck must be 32 bytes');
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', ck, iv);
  cipher.setAAD(aad(pidBytes, dirByte));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Open a directional blob; throws on tamper / wrong key / wrong direction. */
export function openDir(ck, blob, pidBytes, dir) {
  const dirByte = DIR[dir];
  if (!dirByte) throw new Error('pair-channel: dir must be c2s|s2c');
  if (blob == null || !blob.iv || !blob.ct || !blob.tag) throw new Error('pair-channel: malformed blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ck, Buffer.from(String(blob.iv), 'base64'));
  decipher.setAAD(aad(pidBytes, dirByte));
  decipher.setAuthTag(Buffer.from(String(blob.tag), 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(String(blob.ct), 'base64')), decipher.final()]);
}

/** Proof-of-ck for POST /pair/result: HMAC-SHA256(ckProof, "pair-proof-v1" ‖ pid) → hex.
 *  Only a party holding ckProof (i.e. that completed the ECDH from the real QR) can
 *  produce it, so a mere pid-knower cannot fetch/consume the sealed token. Uses the
 *  DEDICATED ckProof key (not an AEAD key) — no encrypt/MAC key reuse (audit D1). */
export function resultProof(ckProof, pidBytes) {
  return crypto.createHmac('sha256', ckProof).update(Buffer.concat([Buffer.from('pair-proof-v1'), pidBytes])).digest('hex');
}

/** Constant-time compare for the proof (hex strings of equal length). */
export function proofEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

export const _internal = { rawFromPubB64, pubKeyFromRaw, HKDF_INFO, DIR, TRANSCRIPT_LEN };
