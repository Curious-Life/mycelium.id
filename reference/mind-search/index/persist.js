/**
 * Encrypted persistence for the inverted index.
 *
 * Solves the boot-time problem: at 100K+ messages, rebuilding the
 * inverted index from D1 takes minutes (decrypt every message, tokenize,
 * insert). Persisting an encrypted snapshot to disk makes warm boot a
 * decrypt-and-load operation (~5 s) instead.
 *
 * Security posture:
 *
 *   • Same envelope as encrypted DB columns. crypto-local.js encrypt()
 *     handles AES-256-GCM, scope tagging, per-user (v2) key derivation.
 *     Disk has the same security profile as the encrypted vector BLOBs
 *     in D1: useless without the master key (which lives only in tmpfs).
 *
 *   • No new dependencies. Existing primitives only.
 *
 *   • Atomic write: tmp + fsync + rename. A crash mid-save cannot corrupt
 *     the target. The rename is atomic within a filesystem (POSIX guarantee).
 *     A crash before rename leaves a .tmp file that callers can detect and
 *     clean up; the target is untouched.
 *
 *   • Mode 0600. Owner-read-write only. Even though the file is
 *     encrypted, we restrict access at the OS layer too — defense in
 *     depth (CLAUDE.md §2).
 *
 *   • Magic-bytes header. Lets us detect "wrong file type" before
 *     attempting decrypt. A 4-byte prefix and a 1-byte version number
 *     means a misconfigured persistPath fails with a clean error rather
 *     than a confusing decryption failure.
 *
 * File layout (v1):
 *
 *   bytes 0..3   magic "MIS1"  (Mind Index Snapshot, format v1)
 *   bytes 4..n   base64 envelope from crypto-local.encrypt()
 *
 * The envelope itself contains the version byte (`v`), scope tag (`s`),
 * IV, ciphertext, and wrapped DEK — that's where the cryptographic
 * structure lives. The "MIS1" prefix is purely a format marker for
 * file-shape validation, not a security boundary.
 *
 * Caller contract:
 *
 *   • saveIndex returns Promise<void>. Throws on filesystem errors.
 *     Failure leaves the previous snapshot intact (atomic write).
 *
 *   • loadIndex returns Promise<InvertedIndex | null>:
 *       - null  →  file does not exist (cold start expected; rebuild from D1)
 *       - throw →  file exists but cannot be loaded; use the typed error
 *                  class to decide tier-fallback behavior
 *
 *   • Errors are mind-search-typed:
 *       IndexUnavailableError   bad magic, truncated header, deserialize fail
 *       DecryptError            envelope decrypt failure (auth tag, etc.)
 *       ScopeMismatchError      caller scope not in envelope's scope tag
 *
 *     None contain plaintext (CLAUDE.md §1). Metadata only: byte counts,
 *     expected vs actual magic, scope tag from envelope.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { encrypt, decrypt } from '../../crypto-local.js';
import { InvertedIndex } from './inverted.js';
import {
  DecryptError,
  IndexUnavailableError,
  ScopeMismatchError,
} from '../errors.js';

const MAGIC = Buffer.from('MIS1', 'latin1'); // 4 bytes, format v1
const HEADER_LEN = MAGIC.length;

const SAVE_FILE_MODE = 0o600;

/**
 * Serialize the index, encrypt with the existing Swiss Vault envelope,
 * and atomically write to `path`.
 *
 * @param {InvertedIndex} index
 * @param {string} filepath
 * @param {string} scope                    e.g. 'personal', 'org'
 * @param {CryptoKey} masterKey
 * @param {string|null} [userId=null]       per-user key derivation (envelope v2)
 * @returns {Promise<{ bytes: number }>}    bytes written
 */
export async function saveIndex(index, filepath, scope, masterKey, userId = null) {
  if (!(index instanceof InvertedIndex)) {
    throw new TypeError('saveIndex: index must be an InvertedIndex');
  }
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new TypeError('saveIndex: filepath must be a non-empty string');
  }
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new TypeError('saveIndex: scope must be a non-empty string');
  }
  if (!masterKey) {
    throw new TypeError('saveIndex: masterKey required');
  }

  // Inner serialization is JSON-encoded text (UTF-8 valid). encrypt()
  // takes a string plaintext, so we pass the JSON directly — no base64
  // wrapping needed at the inner level (the envelope already base64s
  // the ciphertext).
  const serialized = index.serialize().toString('utf8');
  const envelope = await encrypt(serialized, scope, masterKey, userId);

  // Build the final file payload: 4-byte magic + base64 envelope.
  const envelopeBuf = Buffer.from(envelope, 'utf8');
  const payload = Buffer.concat([MAGIC, envelopeBuf], MAGIC.length + envelopeBuf.length);

  // Atomic write: write to .tmp in the same directory (so rename is
  // intra-filesystem and atomic), fsync to flush, then rename. A crash
  // anywhere in this sequence either preserves the previous snapshot
  // intact, or leaves an orphan .tmp file that callers can clean up.
  const tmpPath = `${filepath}.tmp.${process.pid}`;
  let fh;
  try {
    fh = await fs.open(tmpPath, 'w', SAVE_FILE_MODE);
    await fh.writeFile(payload);
    await fh.sync(); // fsync — guarantees the bytes hit the disk
  } finally {
    if (fh) await fh.close();
  }
  await fs.rename(tmpPath, filepath);

  return { bytes: payload.length };
}

/**
 * Load an encrypted snapshot and reconstitute the inverted index.
 *
 * Returns null if the file does not exist — caller treats that as a cold
 * start (rebuild from D1).
 *
 * Throws typed mind-search errors otherwise. The caller's degradation
 * orchestrator (PR 9) reads the error class and decides whether to
 * trigger a rebuild, fall back to Tier 3, or surface to the operator.
 *
 * @param {string} filepath
 * @param {CryptoKey} masterKey
 * @param {string[]|null} allowedScopes  null = admin mode; non-null = enforce
 * @returns {Promise<InvertedIndex | null>}
 */
export async function loadIndex(filepath, masterKey, allowedScopes) {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new TypeError('loadIndex: filepath must be a non-empty string');
  }
  if (!masterKey) {
    throw new TypeError('loadIndex: masterKey required');
  }

  let raw;
  try {
    raw = await fs.readFile(filepath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // Other read errors (EACCES, EIO, etc.) are operational — not
    // recoverable here. Surface as IndexUnavailableError so the tier
    // orchestrator falls back to Tier 3 instead of crashing.
    throw new IndexUnavailableError('snapshot read failed', {
      code: err && err.code ? err.code : 'unknown',
    });
  }

  if (raw.length < HEADER_LEN) {
    throw new IndexUnavailableError('snapshot truncated below header', {
      bytes: raw.length,
      expectedAtLeast: HEADER_LEN,
    });
  }
  const magic = raw.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new IndexUnavailableError('snapshot magic mismatch (not a mind-search index)', {
      bytes: raw.length,
    });
  }

  const envelope = raw.subarray(HEADER_LEN).toString('utf8');

  let plaintext;
  try {
    plaintext = await decrypt(envelope, masterKey, allowedScopes);
  } catch (cause) {
    if (cause && cause.name === 'ScopeViolationError') {
      throw new ScopeMismatchError('snapshot scope not in allowed set', {
        allowedScopesCount: Array.isArray(allowedScopes) ? allowedScopes.length : null,
      });
    }
    throw new DecryptError('snapshot decryption failed', {
      bytes: raw.length,
    }, cause);
  }

  let index;
  try {
    index = InvertedIndex.deserialize(plaintext);
  } catch (cause) {
    throw new IndexUnavailableError('snapshot inner deserialization failed', {
      plaintextBytes: plaintext.length,
    }, cause);
  }
  return index;
}

/**
 * Best-effort cleanup of any orphan .tmp files left behind by an aborted
 * save (process killed mid-write). Caller invokes at agent boot, before
 * the first saveIndex() call.
 *
 * Does not throw — failures are logged-by-caller (no logger access here).
 *
 * @param {string} filepath
 * @returns {Promise<{ removed: number }>}
 */
export async function cleanupOrphanTmpFiles(filepath) {
  const dir = path.dirname(filepath);
  const baseName = path.basename(filepath);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { removed: 0 };
  }
  const prefix = `${baseName}.tmp.`;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const full = path.join(dir, entry);
    try {
      await fs.unlink(full);
      removed++;
    } catch {
      // best-effort
    }
  }
  return { removed };
}
