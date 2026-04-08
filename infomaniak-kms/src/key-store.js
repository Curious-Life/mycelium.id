/**
 * KMS Key Store — In-memory KEK storage with sodium mlock'd buffers.
 *
 * Each customer KEK is a 256-bit key stored in a sodium_malloc'd buffer
 * (mlock'd, MADV_DONTDUMP, auto-zeroed on free). Keys exist ONLY in
 * memory — never written to disk. On restart, must be restored from
 * encrypted backup.
 */

import sodium from 'sodium-native';
import { webcrypto } from 'crypto';

const { subtle } = webcrypto;

// Map<customerId, { kek: Buffer (sodium_malloc), createdAt: Date, kekHash: string }>
const store = new Map();

/**
 * Store a KEK for a customer.
 * @param {string} customerId
 * @param {string} kekHex — 64 hex chars (256-bit key)
 */
export function storeKek(customerId, kekHex) {
  if (store.has(customerId)) {
    throw new Error(`KEK already exists for ${customerId} — use rotateKek() to replace`);
  }
  if (!kekHex || kekHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(kekHex)) {
    throw new Error('KEK must be 64 hex characters');
  }

  const kek = sodium.sodium_malloc(32);
  const hexBuf = Buffer.from(kekHex, 'hex');
  hexBuf.copy(kek);
  // Zero the intermediate buffer
  hexBuf.fill(0);

  const kekHash = hashKek(kek);
  store.set(customerId, { kek, createdAt: new Date(), kekHash });
}

/**
 * Get KEK hex for a customer. Returns null if not found.
 * @param {string} customerId
 * @returns {string|null} 64-char hex
 */
export function getKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) return null;
  return Buffer.from(entry.kek).toString('hex');
}

/**
 * Check if a customer has a KEK stored.
 * @param {string} customerId
 * @returns {boolean}
 */
export function hasKek(customerId) {
  return store.has(customerId);
}

/**
 * Delete a customer's KEK. Zeros the buffer with sodium_memzero().
 * After this, the customer's data is permanently undecryptable.
 * @param {string} customerId
 * @returns {boolean} true if deleted, false if not found
 */
export function deleteKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) return false;
  sodium.sodium_memzero(entry.kek);
  store.delete(customerId);
  return true;
}

/**
 * Rotate: generate new random KEK, replace old.
 * Old buffer is zeroed before replacement.
 * @param {string} customerId
 * @returns {{ oldKekHash: string, newKekHash: string }}
 */
export function rotateKek(customerId) {
  const entry = store.get(customerId);
  if (!entry) throw new Error(`No KEK for ${customerId}`);

  const oldKekHash = entry.kekHash;

  // Generate new random KEK
  const newKek = sodium.sodium_malloc(32);
  sodium.randombytes_buf(newKek);
  const newKekHash = hashKek(newKek);

  // Zero old KEK
  sodium.sodium_memzero(entry.kek);

  // Replace in store
  store.set(customerId, { kek: newKek, createdAt: new Date(), kekHash: newKekHash });

  return { oldKekHash, newKekHash };
}

/**
 * Get count of stored customers.
 * @returns {number}
 */
export function customerCount() {
  return store.size;
}

/**
 * List all customer IDs (for admin/backup purposes).
 * @returns {string[]}
 */
export function listCustomers() {
  return Array.from(store.keys());
}

/**
 * Get metadata about a customer's KEK (no key material exposed).
 * @param {string} customerId
 * @returns {{ createdAt: string, kekHash: string } | null}
 */
export function getKekMeta(customerId) {
  const entry = store.get(customerId);
  if (!entry) return null;
  return { createdAt: entry.createdAt.toISOString(), kekHash: entry.kekHash };
}

/**
 * Export all KEKs as AES-256-GCM encrypted blob.
 * @param {string} backupKeyHex — 64 hex chars (256-bit backup key)
 * @returns {Promise<Buffer>} encrypted blob
 */
export async function exportEncrypted(backupKeyHex) {
  const entries = [];
  for (const [customerId, entry] of store) {
    entries.push({
      customerId,
      kekHex: Buffer.from(entry.kek).toString('hex'),
      createdAt: entry.createdAt.toISOString(),
    });
  }

  const plaintext = Buffer.from(JSON.stringify(entries), 'utf-8');

  // Import backup key
  const keyBytes = Buffer.from(backupKeyHex, 'hex');
  const backupKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);

  // Encrypt
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, backupKey, plaintext);

  // Format: version(1) + iv(12) + ciphertext(variable)
  const blob = Buffer.alloc(1 + 12 + ct.byteLength);
  blob[0] = 1; // version
  Buffer.from(iv).copy(blob, 1);
  Buffer.from(ct).copy(blob, 13);

  // Zero plaintext with KEK material
  plaintext.fill(0);

  return blob;
}

/**
 * Import KEKs from encrypted backup blob.
 * @param {Buffer} blob
 * @param {string} backupKeyHex — 64 hex chars
 * @returns {Promise<number>} count of restored KEKs
 */
export async function importEncrypted(blob, backupKeyHex) {
  if (blob[0] !== 1) throw new Error(`Unknown backup version: ${blob[0]}`);

  const iv = blob.subarray(1, 13);
  const ct = blob.subarray(13);

  const keyBytes = Buffer.from(backupKeyHex, 'hex');
  const backupKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);

  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, backupKey, ct);
  const entries = JSON.parse(Buffer.from(pt).toString('utf-8'));

  let restored = 0;
  for (const entry of entries) {
    if (store.has(entry.customerId)) {
      // Skip — don't overwrite existing live key
      continue;
    }
    storeKek(entry.customerId, entry.kekHex);
    restored++;
  }

  // Zero decrypted plaintext
  Buffer.from(pt).fill(0);

  return restored;
}

// ── Internal helpers ──

function hashKek(kekBuffer) {
  const hash = sodium.sodium_malloc(32);
  sodium.crypto_generichash(hash, kekBuffer);
  const hex = Buffer.from(hash).toString('hex').substring(0, 16);
  sodium.sodium_memzero(hash);
  return hex;
}
