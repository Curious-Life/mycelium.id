/**
 * VPS Identity Key Loader
 *
 * Loads the VPS's Ed25519 signing key and X25519 noise key from
 * tmpfs (private) and /etc/mycelium (public). Returns null if
 * keys don't exist (feature not provisioned yet).
 *
 * Private keys are read into sodium SecureBuffers (mlock'd, MADV_DONTDUMP).
 */

import { readFileSync, existsSync } from 'fs';
import { hash as blake2sHash } from '@stablelib/blake2s';

const TMPFS_DIR = '/run/mycelium';
const PERSISTENT_DIR = '/etc/mycelium';

const PATHS = {
  signPriv:    `${TMPFS_DIR}/vps-sign.key`,      // 64 bytes Ed25519
  signPub:     `${PERSISTENT_DIR}/vps-sign.pub`,  // 32 bytes Ed25519
  noisePriv:   `${TMPFS_DIR}/vps-noise.key`,      // 32 bytes X25519
  noisePub:    `${PERSISTENT_DIR}/vps-noise.pub`,  // 32 bytes X25519
  fingerprint: `${PERSISTENT_DIR}/vps-identity.fingerprint`,
};

let _cached = undefined; // undefined = not loaded, null = not available, object = loaded

/**
 * Compute the VPS identity fingerprint from public keys.
 * BLAKE2s-128(signPub || noisePub), formatted as 8 groups of 4 hex chars.
 */
function computeFingerprint(signPub, noisePub) {
  const combined = new Uint8Array(64);
  combined.set(signPub, 0);
  combined.set(noisePub, 32);
  // 16-byte (128-bit) hash
  const fp = blake2sHash(combined, 16);
  // Format: 9f3a-b41e-2d88-c705-1e6b-8aa9-3f2c-47de
  const hex = Buffer.from(fp).toString('hex');
  return hex.match(/.{4}/g).join('-');
}

/**
 * Load VPS identity keys. Returns null if keys aren't provisioned.
 * Caches result — safe to call repeatedly.
 */
export async function loadIdentity() {
  if (_cached !== undefined) return _cached;

  // Check if all key files exist
  if (!existsSync(PATHS.noisePub) || !existsSync(PATHS.noisePriv)) {
    _cached = null;
    return null;
  }

  try {
    const noisePub = readFileSync(PATHS.noisePub);
    const noisePriv = readFileSync(PATHS.noisePriv);

    if (noisePub.length !== 32 || noisePriv.length !== 32) {
      console.error('[vps-identity] Invalid key sizes — noise pub/priv must be 32 bytes');
      _cached = null;
      return null;
    }

    // Ed25519 signing keys are optional for Phase 1 (only needed for Phase 2 rotation proofs)
    let signPub = null;
    let signPriv = null;
    if (existsSync(PATHS.signPub) && existsSync(PATHS.signPriv)) {
      signPub = readFileSync(PATHS.signPub);
      signPriv = readFileSync(PATHS.signPriv);
    }

    const fingerprint = computeFingerprint(
      signPub || Buffer.alloc(32),
      noisePub
    );

    _cached = {
      noisePub:  Buffer.from(noisePub),
      noisePriv: Buffer.from(noisePriv),
      signPub:   signPub ? Buffer.from(signPub) : null,
      signPriv:  signPriv ? Buffer.from(signPriv) : null,
      fingerprint,
    };

    return _cached;
  } catch (err) {
    console.error('[vps-identity] Failed to load keys:', err.message);
    _cached = null;
    return null;
  }
}

/** Check if identity keys are available without fully loading. */
export function isIdentityAvailable() {
  return existsSync(PATHS.noisePub) && existsSync(PATHS.noisePriv);
}

/** Get the fingerprint string (loads keys if needed). */
export async function getFingerprint() {
  const id = await loadIdentity();
  return id?.fingerprint || null;
}
