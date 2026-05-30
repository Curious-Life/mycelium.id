/**
 * Vector envelope ↔ Float32Array codec.
 *
 * Vectors travel as Swiss Vault envelopes over the wire:
 *
 *     Float32Array (3072 bytes for 768D)
 *       └─ encodeVector → base64 string (~4096 chars)
 *           └─ encrypt(scope, masterKey, userId)  ← crypto-local.js
 *               └─ envelope (base64-wrapped JSON, stored in D1)
 *
 * Read path reverses:
 *
 *     envelope from D1
 *       └─ decrypt(masterKey, allowedScopes)
 *           └─ base64 string
 *               └─ decodeVector → Float32Array
 *
 * Why base64 (not raw bytes): crypto-local.js `encrypt()` takes a string
 * plaintext and uses TextEncoder/TextDecoder. Float32 bytes are arbitrary
 * binary — they will NOT round-trip through TextDecoder. base64 is the
 * portable, lossless string carrier. ~33% size overhead on top of 3072 B
 * = ~4 KB per 768D vector encrypted; acceptable.
 *
 * Why this lives here (not in crypto-local.js): vectors are a mind-search
 * concept; crypto-local stays string-generic. If other modules eventually
 * need binary-blob encryption, this codec pattern can be promoted.
 *
 * Errors:
 *   • DecryptError on auth-tag mismatch, base64 corruption, length mismatch.
 *     Wraps the underlying crypto error in `cause` (no plaintext leak).
 *   • ScopeMismatchError when the envelope scope is not in allowedScopes.
 *     Re-thrown from crypto-local's ScopeViolationError so callers get a
 *     mind-search-typed error.
 *
 * Per CLAUDE.md §1, error messages NEVER include vector contents, query
 * text, or decoded plaintext. They include byte counts and dim numbers.
 */

// crypto-local lives at src/crypto/crypto-local.js, but in this branch that
// path is a deliberate foundation placeholder (a sibling unit owns the real
// port). The working module-level envelope API (encrypt/decrypt with the
// signature this codec needs) is the verified spike at spike/crypto. V1's
// in-RAM search path (injected embedder, no encrypted vector envelopes,
// no index persistence) never invokes these — this import only needs to
// resolve so the module loads. Re-point at src/crypto/crypto-local.js once
// the foundation lands the real module-level export.
import { decrypt, encrypt } from '../../../spike/crypto/crypto-local.js';
import { DecryptError, ScopeMismatchError } from '../errors.js';

const BYTES_PER_FLOAT32 = 4;

/**
 * Encode a Float32Array as a base64 string suitable for `encrypt()`.
 *
 * @param {Float32Array} vec
 * @returns {string}    base64-encoded raw float32 bytes
 */
export function encodeVector(vec) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`encodeVector: expected Float32Array, got ${typeof vec === 'object' ? vec?.constructor?.name : typeof vec}`);
  }
  // Slice the underlying ArrayBuffer at the exact byte range the typed
  // array views — important if the vec was sliced from a larger buffer
  // (the .buffer is the WHOLE backing buffer, not just the view).
  const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return bytes.toString('base64');
}

/**
 * Inverse of encodeVector — interpret a base64 plaintext as Float32Array
 * of expected dimension. Validates length; throws DecryptError on mismatch.
 *
 * @param {string} b64
 * @param {number} dim    expected dimension (e.g. 768)
 * @returns {Float32Array}
 */
export function decodeVectorBytes(b64, dim) {
  if (typeof b64 !== 'string') {
    throw new DecryptError('decoded plaintext is not a string', { dim });
  }
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (cause) {
    throw new DecryptError('base64 decode failed', { dim }, cause);
  }
  const expectedBytes = dim * BYTES_PER_FLOAT32;
  if (buf.length !== expectedBytes) {
    throw new DecryptError('vector length mismatch', {
      dim,
      expectedBytes,
      actualBytes: buf.length,
    });
  }
  // Copy into a fresh aligned Float32Array. We don't share the Node Buffer
  // memory because: (a) Buffer pooling can produce non-aligned offsets,
  // (b) callers expect to mutate the returned array without surprising
  // the source, (c) the GC story is simpler.
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = buf.readFloatLE(i * BYTES_PER_FLOAT32);
  }
  return out;
}

/**
 * Decrypt a Swiss Vault envelope and return the embedded Float32Array.
 *
 * @param {string} envelope          base64 envelope from D1
 * @param {CryptoKey} masterKey      USER_MASTER_KEY (loaded from tmpfs)
 * @param {string[]|null} allowedScopes  null = admin mode; non-null = enforce
 * @param {number} dim               expected vector dimension
 * @returns {Promise<Float32Array>}
 */
export async function decryptVector(envelope, masterKey, allowedScopes, dim) {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new DecryptError('envelope is empty or not a string', { dim });
  }
  if (!masterKey) {
    throw new DecryptError('masterKey required to decrypt vector envelope', { dim });
  }
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`decryptVector: dim must be a positive integer, got ${dim}`);
  }

  let plaintext;
  try {
    plaintext = await decrypt(envelope, masterKey, allowedScopes);
  } catch (cause) {
    // crypto-local throws ScopeViolationError for scope failures.
    // Rewrap as mind-search-typed error so the orchestrator can branch.
    if (cause && cause.name === 'ScopeViolationError') {
      throw new ScopeMismatchError('vector envelope scope not in allowed set', {
        dim,
        allowedScopesCount: Array.isArray(allowedScopes) ? allowedScopes.length : null,
      });
    }
    throw new DecryptError('vector envelope decryption failed', { dim }, cause);
  }

  return decodeVectorBytes(plaintext, dim);
}

/**
 * Encrypt a Float32Array as a Swiss Vault envelope.
 *
 * @param {Float32Array} vec
 * @param {string} scope         e.g. 'personal', 'org'
 * @param {CryptoKey} masterKey
 * @param {string|null} userId   per-user key derivation (envelope v2)
 * @returns {Promise<string>}    base64 envelope ready to store in D1
 */
export async function encryptVector(vec, scope, masterKey, userId = null) {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`encryptVector: expected Float32Array, got ${typeof vec === 'object' ? vec?.constructor?.name : typeof vec}`);
  }
  if (!masterKey) {
    throw new Error('encryptVector: masterKey required');
  }
  const b64 = encodeVector(vec);
  return encrypt(b64, scope, masterKey, userId);
}
