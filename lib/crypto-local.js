/**
 * Local AES-256-GCM decryption — Node.js port of worker/src/services/crypto.ts
 *
 * Uses Node.js WebCrypto (crypto.subtle) which is API-compatible with
 * the Cloudflare Workers crypto. Zero npm dependencies.
 */

import { webcrypto } from 'crypto';
const { subtle } = webcrypto;

const DEK_BITS = 256;
const TAG_LENGTH = 128;
const HKDF_HASH = 'SHA-256';
const HKDF_SALT = new Uint8Array(32);

const scopeKeyCache = new Map();

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function isEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return !!(obj.v === 1 && obj.s && obj.iv && obj.ct && obj.dk);
  } catch { return false; }
}

async function importMasterKey(hexKey) {
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

async function deriveScopeKey(masterKey, scope) {
  const cached = scopeKeyCache.get(scope);
  if (cached) return cached;

  const info = new TextEncoder().encode(`mycelium:scope:${scope}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    masterKey,
    DEK_BITS,
  );
  const scopeKey = await subtle.importKey('raw', derivedBits, 'AES-KW', false, ['unwrapKey']);
  scopeKeyCache.set(scope, scopeKey);
  return scopeKey;
}

async function decrypt(encoded, masterKey) {
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (envelope.v !== 1) throw new Error(`Unknown envelope version: ${envelope.v}`);

  const scopeKey = await deriveScopeKey(masterKey, envelope.s);

  // Unwrap DEK
  const wrappedDk = fromBase64(envelope.dk);
  const dek = await subtle.unwrapKey(
    'raw',
    wrappedDk.buffer.slice(wrappedDk.byteOffset, wrappedDk.byteOffset + wrappedDk.byteLength),
    scopeKey,
    'AES-KW',
    { name: 'AES-GCM', length: DEK_BITS },
    false,
    ['decrypt'],
  );

  // Decrypt content
  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);
  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength), tagLength: TAG_LENGTH },
    dek,
    ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
  );

  return new TextDecoder().decode(decrypted);
}

export { importMasterKey, decrypt, isEncrypted };
