// src/account/passphrase-lock.js — OPTIONAL app passphrase that locks the vault.
//
// When enabled, the two master keys are REMOVED from the macOS Keychain and
// instead sealed in <dataDir>/vault-lock.json with a key derived from the user's
// passphrase. The vault then can't auto-open at boot: the server stays in
// "locked mode" (mirrors first-run setup mode) until the passphrase unseals the
// keys and completeBoot() runs. The recovery key stays an INDEPENDENT escape
// hatch — forgetting the passphrase never loses the vault.
//
// Crypto reuse (no new dependency, no hand-rolled crypto):
//   - KDF: Node's built-in crypto.scryptSync (passphrase + salt -> 32-byte KEK).
//   - Seal: the SAME AES-256-GCM envelope the KCV uses — encrypt()/decrypt()
//     from crypto-local.js, keyed by importMasterKey(KEK). A wrong passphrase
//     fails the GCM tag, so decrypt throws -> fail-closed, exactly like the KCV.
//   - We seal BOTH keys (not just the user key): legacy vaults have an
//     independent SYSTEM_KEY that can't be derived from USER_MASTER.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { lockPath } from '../paths.js';
import { importMasterKey, encrypt, decrypt } from '../crypto/crypto-local.js';

const LOCK_VERSION = 1;
// scrypt cost: N=2^16, r=8, p=1 ≈ 64 MB / ~100 ms — a sensible cost for a desktop
// unlock. maxmem must exceed 128*N*r (~64 MB). The params are stored in the lock
// file so future tuning never orphans an existing lock (unseal reads them back).
const SCRYPT = { N: 1 << 16, r: 8, p: 1, keylen: 32, maxmem: 192 * 1024 * 1024 };
const HEX64 = /^[0-9a-f]{64}$/i;
const SCOPE = 'personal';

export const MIN_PASSPHRASE_LENGTH = 8;

function deriveKEKHex(passphrase, salt, params) {
  const { N, r, p, keylen, maxmem } = params;
  return crypto.scryptSync(String(passphrase), salt, keylen, { N, r, p, maxmem }).toString('hex');
}

/** Seal both master keys under a passphrase. Returns the on-disk lock object. */
export async function sealKeys(userHex, systemHex, passphrase) {
  const u = String(userHex || '').toLowerCase();
  const s = String(systemHex || '').toLowerCase();
  if (!HEX64.test(u) || !HEX64.test(s)) throw new Error('sealKeys: both keys must be 64-char hex');
  const salt = crypto.randomBytes(16);
  const kek = await importMasterKey(deriveKEKHex(passphrase, salt, SCRYPT));
  return {
    v: LOCK_VERSION,
    kdf: 'scrypt',
    n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, maxmem: SCRYPT.maxmem,
    salt: salt.toString('base64'),
    sealU: await encrypt(u, SCOPE, kek),
    sealS: await encrypt(s, SCOPE, kek),
  };
}

/** Unseal both master keys; throws Error('wrong_passphrase') on any mismatch. */
export async function unsealKeys(lock, passphrase) {
  if (!lock || lock.kdf !== 'scrypt' || typeof lock.salt !== 'string' || !lock.sealU || !lock.sealS) {
    throw new Error('invalid_lock');
  }
  const salt = Buffer.from(lock.salt, 'base64');
  const params = {
    N: lock.n, r: lock.r, p: lock.p,
    keylen: lock.keylen || 32, maxmem: lock.maxmem || SCRYPT.maxmem,
  };
  const kek = await importMasterKey(deriveKEKHex(passphrase, salt, params));
  let userHex, systemHex;
  try {
    userHex = await decrypt(lock.sealU, kek);
    systemHex = await decrypt(lock.sealS, kek);
  } catch { throw new Error('wrong_passphrase'); }
  if (!HEX64.test(userHex) || !HEX64.test(systemHex)) throw new Error('wrong_passphrase');
  return { userHex: userHex.toLowerCase(), systemHex: systemHex.toLowerCase() };
}

// File ops take an explicit lockFile so the seal always sits NEXT TO the vault's
// KCV (server-rest co-locates them) — in the packaged app and in isolated tests
// alike. Falls back to the paths.js default for any caller that omits it.
export function lockExists(lockFile) { return existsSync(lockFile || lockPath()); }

export function readLock(lockFile) {
  const p = lockFile || lockPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeLock(lock, lockFile) {
  const p = lockFile || lockPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(lock, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
}

export function removeLock(lockFile) {
  try { rmSync(lockFile || lockPath(), { force: true }); } catch { /* absent — fine */ }
}
