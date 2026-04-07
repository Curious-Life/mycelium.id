#!/usr/bin/env node
/**
 * Generate VPS identity key pairs.
 *
 *   1. Ed25519 signing key pair  (rotation proofs, identity attestation)
 *   2. X25519  static key pair   (Noise NK handshake ECDH)
 *
 * Private keys  → /run/mycelium/   (tmpfs, mode 0400)
 * Public keys   → /etc/mycelium/   (mode 0644)
 * Fingerprint   → BLAKE2s-256(signPub || noisePub), first 16 bytes, hex-dashed
 *
 * Usage:  node scripts/generate-vps-identity.js [--force]
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import sodium from 'sodium-native';
import { hash } from '@stablelib/blake2s';

const PRIV_DIR = '/run/mycelium';
const PUB_DIR  = '/etc/mycelium';

const SIGN_SK  = `${PRIV_DIR}/vps-sign.key`;
const NOISE_SK = `${PRIV_DIR}/vps-noise.key`;
const SIGN_PK  = `${PUB_DIR}/vps-sign.pub`;
const NOISE_PK = `${PUB_DIR}/vps-noise.pub`;
const FP_FILE  = `${PUB_DIR}/vps-identity.fingerprint`;

const force = process.argv.includes('--force');

// Refuse to overwrite unless --force
const existing = [SIGN_SK, NOISE_SK, SIGN_PK, NOISE_PK].filter(existsSync);
if (existing.length > 0 && !force) {
  console.error('Identity keys already exist. Pass --force to overwrite.');
  console.error('Existing:', existing.join(', '));
  process.exit(1);
}

// Ensure directories exist
for (const dir of [PRIV_DIR, PUB_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// 1. Ed25519 signing key pair
const signPk = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);   // 32
const signSk = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);   // 64
sodium.crypto_sign_keypair(signPk, signSk);

// 2. X25519 static key pair
const noiseSk = Buffer.alloc(32);
const noisePk = Buffer.alloc(32);
sodium.randombytes_buf(noiseSk);
sodium.crypto_scalarmult_base(noisePk, noiseSk);

// Write private keys (tmpfs, owner read-only)
writeFileSync(SIGN_SK,  signSk,  { mode: 0o400 });
writeFileSync(NOISE_SK, noiseSk, { mode: 0o400 });

// Write public keys
writeFileSync(SIGN_PK,  signPk,  { mode: 0o644 });
writeFileSync(NOISE_PK, noisePk, { mode: 0o644 });

// Fingerprint: BLAKE2s-256(signPub || noisePub), first 16 bytes
const combined = new Uint8Array(64);
combined.set(signPk, 0);
combined.set(noisePk, 32);
const digest = hash(combined, 32);
const fp = Array.from(digest.slice(0, 16))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('')
  .match(/.{4}/g)
  .join('-');

writeFileSync(FP_FILE, fp + '\n', { mode: 0o644 });
console.log(fp);
