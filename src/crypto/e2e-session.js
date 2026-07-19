// src/crypto/e2e-session.js — the E2E session between a paired phone and the Mac
// (docs/E2E-REACHABILITY-DESIGN-2026-07-19.md §2.1, Phase 2). This is the layer that
// makes confidentiality terminate on the two DEVICES: whatever carries the frames (a
// dumb relay, Cloudflare, plain HTTP) only ever sees ciphertext.
//
// A Noise-IK-flavoured handshake, hand-composed on node:crypto (mirrors pair-channel.js;
// CryptoKit implements the same primitives, so the phone and Mac interoperate byte-for-byte):
//   • The phone knows the box's LONG-TERM X25519 key S_b (pinned in person at pairing,
//     Phase 1). It sends a fresh ephemeral e_p and, sealed under HKDF(ECDH(e_p, S_b)),
//     its per-device TOKEN. Deriving that key requires S_b → the phone proves it's
//     talking to the real box; the token proves the phone to the box.
//   • The box replies with its own fresh ephemeral e_b. The SESSION key mixes
//     es = ECDH(·, S_b) (authenticates the box) AND ee = ECDH(e_p, e_b) (forward
//     secrecy — a later compromise of S_b or the token can't decrypt past sessions).
//   • Frames are AES-256-GCM with a monotonic per-direction SEQUENCE number bound in
//     the AAD → replay + reorder are rejected (the pairing seals lacked this).
//
// The phone is the INITIATOR (CryptoKit); the box is the RESPONDER. Both sides + a
// standalone client mirror live here so the gate can drive a full handshake.
//
// ┌─ FROZEN CONTRACT (CryptoKit must match) ──────────────────────────────────────┐
// │ es = X25519(e_p, S_b) ; ee = X25519(e_p, e_b) ; REJECT all-zero.               │
// │ hk = HKDF-SHA256(ikm=es, salt=cnonce(16), info="mycelium-e2e-hs-v1"‖e_p‖S_b,32)│
// │ session = HKDF-SHA256(ikm=es‖ee, salt=cnonce‖sn(32),                            │
// │           info="mycelium-e2e-session-v1"‖e_p‖e_b, L=64)                          │
// │ kC2S = session[0..32) ; kS2C = session[32..64)                                  │
// │ handshake AEAD AAD = "e2e-hs" ‖ dir(0x01 c2s auth / 0x02 s2c confirm) ‖ nonce   │
// │ frame AEAD AAD = seq(uint64 BE, 8 bytes) ‖ dir(0x01 c2s / 0x02 s2c)             │
// │ all AEAD = AES-256-GCM, 12-byte random IV; keys/nonces base64url; iv/ct/tag b64 │
// └────────────────────────────────────────────────────────────────────────────────┘

import crypto from 'node:crypto';
import { newEphemeral, ecdh, _internal } from './pair-channel.js';

const { rawFromPubB64, pubKeyFromRaw } = _internal;
const IV_BYTES = 12;
const NONCE_BYTES = 16; // cnonce / sn are exactly 16 bytes (pinned so CryptoKit can't diverge)
const HS_INFO = Buffer.from('mycelium-e2e-hs-v1');
const SESSION_INFO = Buffer.from('mycelium-e2e-session-v1');
const HS_AAD = Buffer.from('e2e-hs');
const DIR = { c2s: 0x01, s2c: 0x02 };

// ---- AEAD (AES-256-GCM) -------------------------------------------------------
function aeadSeal(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function aeadOpen(key, blob, aad) {
  if (blob == null || !blob.iv || !blob.ct || !blob.tag) throw new Error('e2e: malformed blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(blob.iv), 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(String(blob.tag), 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(String(blob.ct), 'base64')), decipher.final()]);
}

function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

/** Session keys from the two ECDH secrets + both nonces + both ephemerals. Pure +
 *  deterministic — the FROZEN-vector anchor the CryptoKit side pins. */
export function deriveSession({ es, ee, cnonce, sn, epRaw, ebRaw }) {
  const ikm = Buffer.concat([es, ee]);
  const salt = Buffer.concat([cnonce, sn]);
  const info = Buffer.concat([SESSION_INFO, epRaw, ebRaw]);
  const t = hkdf(ikm, salt, info, 96); // widened 64→96 for a dedicated kConfirm (audit D2);
  // HKDF-Expand is prefix-stable, so kC2S/kS2C (and the frozen vector) are unchanged.
  return { kC2S: t.subarray(0, 32), kS2C: t.subarray(32, 64), kConfirm: t.subarray(64, 96) };
}

function hsKey(es, epRaw, boxStaticRaw, cnonce) {
  return hkdf(es, cnonce, Buffer.concat([HS_INFO, epRaw, boxStaticRaw]), 32);
}
const hsAad = (dir, nonce) => Buffer.concat([HS_AAD, Buffer.from([dir]), nonce]);

// ---- Phone (initiator) --------------------------------------------------------
/** Begin: fresh ephemeral + es against the pinned box static key. */
export function initClient(boxStaticPubB64) {
  const eph = newEphemeral();
  const es = ecdh(eph.priv, boxStaticPubB64); // X25519(e_p, S_b); throws on all-zero
  return { ephPriv: eph.priv, epRaw: eph.epkRaw, epB64: eph.epkB64, boxStaticRaw: rawFromPubB64(boxStaticPubB64), es };
}
/** msg1 = { epk, cn, auth(deviceToken) }. */
export function sealClientAuth(state, deviceToken) {
  const cnonce = crypto.randomBytes(16);
  const hk = hsKey(state.es, state.epRaw, state.boxStaticRaw, cnonce);
  const auth = aeadSeal(hk, deviceToken, hsAad(DIR.c2s, cnonce));
  return { msg1: { epk: state.epB64, cn: cnonce.toString('base64url'), auth }, cnonce };
}
/** Finalize on msg2: derive the session, verify the box's confirm. */
export function finalizeClient(state, cnonce, msg2) {
  const ebRaw = rawFromPubB64(msg2.ebk);
  const sn = Buffer.from(String(msg2.sn), 'base64url');
  if (sn.length !== NONCE_BYTES) throw new Error('e2e: bad sn length'); // D3
  const ee = ecdh(state.ephPriv, msg2.ebk); // X25519(e_p, e_b)
  const { kC2S, kS2C, kConfirm } = deriveSession({ es: state.es, ee, cnonce, sn, epRaw: state.epRaw, ebRaw });
  const ok = aeadOpen(kConfirm, msg2.confirm, hsAad(DIR.s2c, sn)).toString('utf8'); // dedicated key (D2)
  if (ok !== 'ok') throw new Error('e2e: bad handshake confirm');
  return newSession(kC2S, kS2C, 'client');
}

// ---- Box (responder) ----------------------------------------------------------
/** Open msg1 → the phone's device token; the caller validates it, then calls
 *  completeServer(). Split so the caller injects db.deviceTokens.matchSync. */
export function openClientAuth(identity, msg1) {
  const epRaw = rawFromPubB64(msg1.epk);
  const cnonce = Buffer.from(String(msg1.cn), 'base64url');
  if (cnonce.length !== NONCE_BYTES) throw new Error('e2e: bad cnonce length'); // D3 — pin so CryptoKit can't diverge
  const es = identity.keyAgreementSharedSecret(msg1.epk); // X25519(S_b, e_p) — raw
  if (es.length !== 32 || es.every((b) => b === 0)) throw new Error('e2e: invalid ECDH (es)');
  const boxStaticRaw = rawFromPubB64(identity.keyAgreementPublicKeyB64);
  const hk = hsKey(es, epRaw, boxStaticRaw, cnonce);
  const deviceToken = aeadOpen(hk, msg1.auth, hsAad(DIR.c2s, cnonce)).toString('utf8');
  return { deviceToken, es, epRaw, cnonce };
}
/** After the caller has validated the token: mint e_b, derive the session, seal confirm. */
export function completeServer(opened) {
  const eph = newEphemeral();
  const ee = ecdh(eph.priv, Buffer.from(opened.epRaw).toString('base64url')); // X25519(e_b, e_p)
  const sn = crypto.randomBytes(NONCE_BYTES);
  const { kC2S, kS2C, kConfirm } = deriveSession({ es: opened.es, ee, cnonce: opened.cnonce, sn, epRaw: opened.epRaw, ebRaw: eph.epkRaw });
  const confirm = aeadSeal(kConfirm, 'ok', hsAad(DIR.s2c, sn)); // dedicated key (D2)
  return { msg2: { ebk: eph.epkB64, sn: sn.toString('base64url'), confirm }, session: newSession(kC2S, kS2C, 'server') };
}

// ---- Session (framed AEAD stream with per-direction sequence) ------------------
/** role: 'client' sends c2s / receives s2c; 'server' is the mirror. */
export function newSession(kC2S, kS2C, role) {
  const sendKey = role === 'client' ? kC2S : kS2C;
  const recvKey = role === 'client' ? kS2C : kC2S;
  const sendDir = role === 'client' ? DIR.c2s : DIR.s2c;
  const recvDir = role === 'client' ? DIR.s2c : DIR.c2s;
  let sendSeq = 0n;
  let recvHigh = -1n; // highest accepted recv seq; strictly-increasing (reject replay/reorder)
  const seqAad = (seq, dir) => {
    const b = Buffer.alloc(9);
    b.writeBigUInt64BE(seq, 0);
    b[8] = dir;
    return b;
  };
  return {
    /** Seal the next outbound frame. */
    seal(plaintext) {
      const seq = sendSeq;
      sendSeq += 1n;
      return { seq: seq.toString(), ...aeadSeal(sendKey, plaintext, seqAad(seq, sendDir)) };
    },
    /** Open an inbound frame; rejects replay, reorder, AND silent gaps — seq must be
     *  exactly the next one (D1: a gap-tolerant policy let an active relay drop a
     *  frame undetected; the transport is ordered HTTP/TCP so consecutive is safe). */
    open(frame) {
      const seq = BigInt(frame.seq);
      if (seq !== recvHigh + 1n) throw new Error('e2e: out-of-order / replayed / dropped frame');
      const pt = aeadOpen(recvKey, frame, seqAad(seq, recvDir)); // throws on tamper BEFORE we advance
      recvHigh = seq;
      return pt;
    },
  };
}

export const _e2e = { deriveSession, hsKey, aeadSeal, aeadOpen, DIR };
