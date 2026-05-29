/**
 * VPS identity helper — reads the VPS Noise static public key from a
 * build-time environment variable and derives a human-readable fingerprint.
 */

import { hash } from '@stablelib/blake2s';

const VPS_NOISE_PUB_HEX: string = import.meta.env.VITE_VPS_NOISE_PUB || '';

export function getVpsNoisePublicKey(): Uint8Array | null {
  if (!VPS_NOISE_PUB_HEX || VPS_NOISE_PUB_HEX.length !== 64) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(VPS_NOISE_PUB_HEX.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function getVpsFingerprint(): string | null {
  const pub = getVpsNoisePublicKey();
  if (!pub) return null;
  // Fingerprint: BLAKE2s-128(zeros(32) || noisePub) — matching server's
  // computeFingerprint with null signPub
  const combined = new Uint8Array(64);
  combined.set(pub, 32);
  const fp = hash(combined, 16);
  return Array.from(fp)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{4}/g)!
    .join('-');
}

export function isSecureChannelConfigured(): boolean {
  return getVpsNoisePublicKey() !== null;
}
