// src/federation/sign.js — canonicalization + detached-signature verification for
// the inter-instance federation protocol (Tier-0).
//
// The wire contract (proven in spike/federation-tier0/): a sender canonicalizes
// the request envelope, signs the canonical bytes with its box ed25519 identity
// (src/identity/identity.js), and transmits EXACTLY those canonical bytes plus
// `X-Myc-Did` + `X-Myc-Sig` headers. The receiver verifies the signature over the
// RAW received body bytes against the sender's published did:web key — so the two
// sides never need to agree on a re-serialization, only on "sign what you send".
//
// canonicalize() is still provided (and used sender-side) so the bytes a sender
// emits are deterministic regardless of object key order / nesting — hygiene that
// also lets a receiver re-derive the canonical form if it ever needs to.
//
// Pure: only node-built-in crypto via identity.js. No storage, no network.

import { verifyWithPublicKey } from '../identity/identity.js';

/**
 * Deterministic JSON serialization: object keys sorted recursively at every
 * level, arrays preserved in order. Stable across engines/insertions.
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

/**
 * Verify a detached base64url signature over the raw request body against a
 * base64url ed25519 public key. Never throws (bad input → false).
 * @param {string} publicKeyB64
 * @param {string|Buffer} rawBody  the bytes as received on the wire
 * @param {string} sigB64
 * @returns {boolean}
 */
export function verifyDetached(publicKeyB64, rawBody, sigB64) {
  if (!publicKeyB64 || !sigB64) return false;
  return verifyWithPublicKey(publicKeyB64, rawBody, sigB64);
}
