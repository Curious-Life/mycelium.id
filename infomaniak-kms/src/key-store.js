/**
 * KMS Key Store — In-memory KEK storage with sodium mlock'd buffers.
 *
 * Supports two modes per customer:
 *   - 'plaintext': KEK in sodium_malloc'd buffer (legacy/migration)
 *   - 'urk-wrapped': KEK wrapped with AES-KW using User Recovery Key
 *     derived from passkey PRF. Multiple wrapped copies (one per passkey).
 *
 * In URK-wrapped mode, the KMS cannot read the KEK without the user's
 * passkey — even the operator with admin certs sees only wrapped blobs.
 */

import sodium from 'sodium-native';
import { webcrypto } from 'crypto';

const { subtle } = webcrypto;

/**
 * Store entry per customer:
 *   mode: 'plaintext' | 'urk-wrapped'
 *   kek: Buffer (sodium_malloc) — only in plaintext mode
 *   wrappedKeks: Map<credentialId, Buffer(40)> — only in urk-wrapped mode
 *   kekHash: string — BLAKE2b hash of the KEK (for audit, set at creation time)
 *   createdAt: Date
 */
const store = new Map();

// ── AES-KW helpers ──

async function wrapKekWithUrk(kekBytes, urkBytes) {
  const urkKey = await subtle.importKey('raw', urkBytes, 'AES-KW', false, ['wrapKey']);
  const kekKey = await subtle.importKey('raw', kekBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const wrapped = await subtle.wrapKey('raw', kekKey, urkKey, 'AES-KW');
  return Buffer.from(wrapped); // 40 bytes (32 key + 8 AES-KW integrity)
}

async function unwrapKekWithUrk(wrappedBlob, urkBytes) {
  const urkKey = await subtle.importKey('raw', urkBytes, 'AES-KW', false, ['unwrapKey']);
  const kekKey = await subtle.unwrapKey(
    'raw', wrappedBlob, urkKey, 'AES-KW',
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const exported = await subtle.exportKey('raw', kekKey);
  return Buffer.from(exported).toString('hex'); // 64-char hex
}

// ── Plaintext mode (legacy + migration) ──

/**
 * Store a plaintext KEK for a customer.
 * @param {string} customerId
 * @param {string} kekHex — 64 hex chars
 */
export function storeKek(customerId, kekHex) {
  if (store.has(customerId)) {
    throw new Error(`KEK already exists for ${customerId} — use rotateKek() or migrateToUrk()`);
  }
  if (!kekHex || kekHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(kekHex)) {
    throw new Error('KEK must be 64 hex characters');
  }

  const kek = sodium.sodium_malloc(32);
  const hexBuf = Buffer.from(kekHex, 'hex');
  hexBuf.copy(kek);
  hexBuf.fill(0);

  store.set(customerId, {
    mode: 'plaintext',
    kek,
    wrappedKeks: null,
    kekHash: hashKek(kek),
    createdAt: new Date(),
  });
}

/**
 * Get plaintext KEK hex. Returns null if not found or if URK-wrapped.
 * @param {string} customerId
 * @returns {string|null}
 */
export function getKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) return null;
  if (entry.mode === 'urk-wrapped') return null; // Can't get plaintext in URK mode
  return Buffer.from(entry.kek).toString('hex');
}

// ── URK-wrapped mode ──

/**
 * Unwrap a KEK using the provided URK from the user's passkey.
 * @param {string} customerId
 * @param {string} credentialId — base64url credential ID
 * @param {Buffer} urkBytes — 32-byte URK
 * @returns {Promise<string>} 64-char hex KEK
 */
export async function unwrapKek(customerId, credentialId, urkBytes) {
  const entry = store.get(customerId);
  if (!entry) throw new Error(`No KEK for ${customerId}`);
  if (entry.mode !== 'urk-wrapped') throw new Error(`Customer ${customerId} is in plaintext mode, not URK-wrapped`);
  if (!entry.wrappedKeks?.has(credentialId)) throw new Error(`No wrapped KEK for credential ${credentialId}`);

  const wrappedBlob = entry.wrappedKeks.get(credentialId);
  return await unwrapKekWithUrk(wrappedBlob, urkBytes);
}

/**
 * Migrate a customer from plaintext to URK-wrapped mode.
 * Wraps the existing plaintext KEK with the URK, stores the wrapped blob,
 * then zeros the plaintext KEK from memory.
 * @param {string} customerId
 * @param {string} credentialId
 * @param {Buffer} urkBytes — 32-byte URK
 */
export async function migrateToUrk(customerId, credentialId, urkBytes) {
  const entry = store.get(customerId);
  if (!entry) throw new Error(`No KEK for ${customerId}`);
  if (entry.mode === 'urk-wrapped') throw new Error(`Already URK-wrapped`);

  // Wrap plaintext KEK with URK
  const wrapped = await wrapKekWithUrk(entry.kek, urkBytes);

  // Zero the plaintext KEK
  sodium.sodium_memzero(entry.kek);

  // Transition to URK-wrapped mode
  entry.mode = 'urk-wrapped';
  entry.kek = null;
  entry.wrappedKeks = new Map();
  entry.wrappedKeks.set(credentialId, wrapped);
}

/**
 * Add a new credential's wrapped KEK blob.
 * Used when registering additional passkeys. The caller (VPS) must provide
 * the pre-wrapped blob (it has the plaintext KEK in cache and wraps with
 * the new passkey's URK).
 * @param {string} customerId
 * @param {string} credentialId
 * @param {Buffer} wrappedBlob — 40-byte AES-KW wrapped KEK
 */
export function addWrappedCredential(customerId, credentialId, wrappedBlob) {
  const entry = store.get(customerId);
  if (!entry) throw new Error(`No KEK for ${customerId}`);

  if (entry.mode === 'plaintext') {
    // Auto-transition: first wrapped credential makes it URK-wrapped
    entry.mode = 'urk-wrapped';
    if (entry.kek) sodium.sodium_memzero(entry.kek);
    entry.kek = null;
    entry.wrappedKeks = new Map();
  }

  if (wrappedBlob.length !== 40) throw new Error(`Wrapped blob must be 40 bytes (got ${wrappedBlob.length})`);
  entry.wrappedKeks.set(credentialId, Buffer.from(wrappedBlob));
}

/**
 * Remove a credential's wrapped KEK (passkey revocation).
 * @param {string} customerId
 * @param {string} credentialId
 * @returns {boolean}
 */
export function removeWrappedCredential(customerId, credentialId) {
  const entry = store.get(customerId);
  if (!entry || !entry.wrappedKeks) return false;
  return entry.wrappedKeks.delete(credentialId);
}

/**
 * Store a pre-wrapped KEK blob for a customer (onboarding in URK mode).
 * @param {string} customerId
 * @param {string} credentialId
 * @param {Buffer} wrappedBlob — 40-byte AES-KW wrapped KEK
 * @param {string} kekHash — hash of the original KEK (for audit)
 */
export function storeWrappedKek(customerId, credentialId, wrappedBlob, kekHash) {
  if (store.has(customerId)) {
    throw new Error(`KEK already exists for ${customerId}`);
  }

  const wrappedKeks = new Map();
  wrappedKeks.set(credentialId, Buffer.from(wrappedBlob));

  store.set(customerId, {
    mode: 'urk-wrapped',
    kek: null,
    wrappedKeks,
    kekHash: kekHash || 'unknown',
    createdAt: new Date(),
  });
}

// ── Common operations ──

/**
 * Get customer entry metadata (no key material).
 * @param {string} customerId
 * @returns {{ mode: string, createdAt: string, kekHash: string, credentialCount?: number } | null}
 */
export function getEntry(customerId) {
  const entry = store.get(customerId);
  if (!entry) return null;
  return {
    mode: entry.mode,
    createdAt: entry.createdAt.toISOString(),
    kekHash: entry.kekHash,
    credentialCount: entry.wrappedKeks?.size || 0,
  };
}

export function hasKek(customerId) {
  return store.has(customerId);
}

export function deleteKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) return false;
  if (entry.kek) sodium.sodium_memzero(entry.kek);
  if (entry.wrappedKeks) entry.wrappedKeks.clear();
  store.delete(customerId);
  return true;
}

export function rotateKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) throw new Error(`No KEK for ${customerId}`);
  if (entry.mode === 'urk-wrapped') {
    throw new Error('Cannot rotate URK-wrapped KEK server-side — rotation requires user passkey');
  }

  const oldKekHash = entry.kekHash;
  const newKek = sodium.sodium_malloc(32);
  sodium.randombytes_buf(newKek);
  const newKekHash = hashKek(newKek);

  sodium.sodium_memzero(entry.kek);
  entry.kek = newKek;
  entry.kekHash = newKekHash;
  entry.createdAt = new Date();

  return { oldKekHash, newKekHash };
}

export function customerCount() { return store.size; }

export function listCustomers() { return Array.from(store.keys()); }

export function getKekMeta(customerId) {
  const entry = store.get(customerId);
  if (!entry) return null;
  return {
    mode: entry.mode,
    createdAt: entry.createdAt.toISOString(),
    kekHash: entry.kekHash,
    credentialCount: entry.wrappedKeks?.size || 0,
  };
}

// ── Backup (handles both modes) ──

export async function exportEncrypted(backupKeyHex) {
  const entries = [];
  for (const [customerId, entry] of store) {
    if (entry.mode === 'plaintext') {
      entries.push({
        customerId,
        mode: 'plaintext',
        kekHex: Buffer.from(entry.kek).toString('hex'),
        kekHash: entry.kekHash,
        createdAt: entry.createdAt.toISOString(),
      });
    } else {
      const wrappedEntries = {};
      for (const [credId, blob] of entry.wrappedKeks) {
        wrappedEntries[credId] = blob.toString('base64');
      }
      entries.push({
        customerId,
        mode: 'urk-wrapped',
        wrappedKeks: wrappedEntries,
        kekHash: entry.kekHash,
        createdAt: entry.createdAt.toISOString(),
      });
    }
  }

  const plaintext = Buffer.from(JSON.stringify(entries), 'utf-8');
  const keyBytes = Buffer.from(backupKeyHex, 'hex');
  const backupKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, backupKey, plaintext);

  const blob = Buffer.alloc(1 + 12 + ct.byteLength);
  blob[0] = 2; // version 2 (supports URK-wrapped entries)
  Buffer.from(iv).copy(blob, 1);
  Buffer.from(ct).copy(blob, 13);
  plaintext.fill(0);

  return blob;
}

export async function importEncrypted(blob, backupKeyHex) {
  const version = blob[0];
  if (version !== 1 && version !== 2) throw new Error(`Unknown backup version: ${version}`);

  const iv = blob.subarray(1, 13);
  const ct = blob.subarray(13);
  const keyBytes = Buffer.from(backupKeyHex, 'hex');
  const backupKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, backupKey, ct);
  const entries = JSON.parse(Buffer.from(pt).toString('utf-8'));

  let restored = 0;
  for (const entry of entries) {
    if (store.has(entry.customerId)) continue;

    if (entry.mode === 'urk-wrapped' && entry.wrappedKeks) {
      const wrappedKeks = new Map();
      for (const [credId, b64] of Object.entries(entry.wrappedKeks)) {
        wrappedKeks.set(credId, Buffer.from(b64, 'base64'));
      }
      store.set(entry.customerId, {
        mode: 'urk-wrapped',
        kek: null,
        wrappedKeks,
        kekHash: entry.kekHash || 'restored',
        createdAt: new Date(entry.createdAt),
      });
    } else {
      // v1 or plaintext mode
      storeKek(entry.customerId, entry.kekHex);
    }
    restored++;
  }

  Buffer.from(pt).fill(0);
  return restored;
}

// ── Internal ──

function hashKek(kekBuffer) {
  const hash = sodium.sodium_malloc(32);
  sodium.crypto_generichash(hash, kekBuffer);
  const hex = Buffer.from(hash).toString('hex').substring(0, 16);
  sodium.sodium_memzero(hash);
  return hex;
}
