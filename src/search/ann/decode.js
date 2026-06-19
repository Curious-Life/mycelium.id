/**
 * Vector envelope ↔ Float32Array codec.
 *
 * Ported from reference/mind-search/ann/decode.js. Import rewrite: reference
 * imported `decrypt`/`encrypt` from '../../crypto-local.js'; here the wrapped-DEK
 * envelope codec lives at ../../crypto/crypto-local.js and exposes the SAME
 * `encrypt(plaintext, scope, masterKey, userId)` / `decrypt(envelope, masterKey,
 * allowedScopes, opts)` async API (verified at crypto-local.js:351,353) plus
 * `ScopeViolationError`.
 *
 * Vectors travel as: Float32Array → base64 → encrypt() → envelope (D1).
 * Read path reverses. base64 is the lossless string carrier (crypto-local is
 * string-generic; raw float bytes won't round-trip through TextDecoder).
 *
 * NOTE: encrypt/decrypt are async here (the V1 crypto API is async), so the
 * envelope-level helpers below are async too. The bare codec (encodeVector /
 * decodeVectorBytes) stays sync. The live mind-search pipeline does not use the
 * envelope helpers yet — vectors are supplied by the injected embedder — so
 * this surface is exercised by the codec round-trip and reserved for when
 * encrypted vector-at-rest lands.
 *
 * Per CLAUDE.md §1, error messages NEVER include vector contents — only byte
 * counts and dim numbers.
 */

import { encrypt, decrypt } from '../../crypto/crypto-local.js';
import { DecryptError, ScopeMismatchError } from '../errors.js';

const BYTES_PER_FLOAT32 = 4;

/** Encode a Float32Array as a base64 string suitable for encrypt(). */
export function encodeVector(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`encodeVector: expected Float32Array, got ${typeof vec === 'object' ? vec?.constructor?.name : typeof vec}`);
  }
  const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return bytes.toString('base64');
}

/** Inverse of encodeVector — base64 plaintext → Float32Array of dim. */
export function decodeVectorBytes(b64, dim) {
  if (typeof b64 !== 'string') {
    throw new DecryptError('decoded plaintext is not a string', { dim });
  }
  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch (cause) { throw new DecryptError('base64 decode failed', { dim }, cause); }
  const expectedBytes = dim * BYTES_PER_FLOAT32;
  if (buf.length !== expectedBytes) {
    throw new DecryptError('vector length mismatch', { dim, expectedBytes, actualBytes: buf.length });
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * BYTES_PER_FLOAT32);
  return out;
}

/**
 * Decrypt a wrapped-DEK envelope and return the embedded Float32Array.
 * @param {string} envelope
 * @param {Buffer|CryptoKey} masterKey   USER_MASTER key
 * @param {string[]|null} allowedScopes
 * @param {number} dim
 * @returns {Promise<Float32Array>}
 */
export async function decryptVector(envelope, masterKey, allowedScopes, dim) {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new DecryptError('envelope is empty or not a string', { dim });
  }
  if (!masterKey) throw new DecryptError('masterKey required to decrypt vector envelope', { dim });
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`decryptVector: dim must be a positive integer, got ${dim}`);
  }
  let plaintext;
  try {
    plaintext = await decrypt(envelope, masterKey, allowedScopes);
  } catch (cause) {
    if (cause && cause.name === 'ScopeViolationError') {
      throw new ScopeMismatchError('vector envelope scope not in allowed set', {
        dim, allowedScopesCount: Array.isArray(allowedScopes) ? allowedScopes.length : null,
      });
    }
    throw new DecryptError('vector envelope decryption failed', { dim }, cause);
  }
  return decodeVectorBytes(plaintext, dim);
}

/** Encrypt a Float32Array as a wrapped-DEK envelope ready to store in D1. */
export async function encryptVector(vec, scope, masterKey, userId = null) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`encryptVector: expected Float32Array, got ${typeof vec === 'object' ? vec?.constructor?.name : typeof vec}`);
  }
  if (!masterKey) throw new Error('encryptVector: masterKey required');
  return encrypt(encodeVector(vec), scope, masterKey, userId);
}

// ── SQLCipher-collapse codec (Stage A) ───────────────────────────────────────
// Vectors live as RAW little-endian float32 BYTES inside the whole-file-encrypted
// vault — no inner AES-GCM envelope, no base64 (which doubled storage ~2.43×).
// Confidentiality is the SQLCipher file itself. Same byte layout as encodeVector's
// pre-base64 buffer and the Python encode_vector_raw, so a value written by either
// side decodes on the other. @see docs/DESIGN-sqlcipher-stageA-vectors-2026-06-19.md

/**
 * Encode a Float32Array as raw little-endian bytes for direct BLOB storage.
 * @param {Float32Array} vec
 * @returns {Buffer}
 */
export function encodeVectorRaw(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`encodeVectorRaw: expected Float32Array, got ${typeof vec === 'object' ? vec?.constructor?.name : typeof vec}`);
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Shape-aware vector read for the migration window (mirrors Python
 * decode_stored_vector), so a half-migrated column reads correctly:
 *   - Buffer/Uint8Array → RAW little-endian float32 (new rows, no crypto)
 *   - string            → legacy wrapped-DEK envelope (decryptVector)
 * @param {Buffer|Uint8Array|string} value  the stored column value
 * @param {number} dim
 * @param {Buffer|CryptoKey|null} [masterKey]  required only for legacy string rows
 * @param {string[]|null} [allowedScopes]
 * @returns {Promise<Float32Array>}
 */
export async function decodeStoredVector(value, dim, masterKey = null, allowedScopes = null) {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`decodeStoredVector: dim must be a positive integer, got ${dim}`);
  }
  if (value instanceof Uint8Array) { // Buffer extends Uint8Array — covers both
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const expectedBytes = dim * BYTES_PER_FLOAT32;
    if (buf.length !== expectedBytes) {
      throw new DecryptError('raw vector length mismatch', { dim, expectedBytes, actualBytes: buf.length });
    }
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * BYTES_PER_FLOAT32);
    return out;
  }
  // Legacy envelope (string) — still supported until the column is fully backfilled.
  return decryptVector(value, masterKey, allowedScopes, dim);
}
