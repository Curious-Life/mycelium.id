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
