// Two-key unlock + KCV (D4 + D6).
//
// USER_MASTER and SYSTEM_KEY are independent 64-char hex strings (32 bytes
// each). Hex carries no checksum, so each key gets its own Key-Check Value:
// a stored envelope of a known constant. On unlock we decrypt each KCV with
// its key — any failure (wrong/truncated/missing key) means the vault stays
// LOCKED. Fail closed: we never touch a vault row before both KCVs verify.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { importMasterKey, encrypt, encryptWithSystemKey, decrypt } from './crypto-local.js';

const KCV_CONST = 'mycelium-kcv-v1';

/** Load a 64-char hex key into an HKDF CryptoKey (throws on malformed hex). */
export async function loadKey(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error('key must be a 64-char hex string (32 bytes)');
  }
  return importMasterKey(hex.trim());
}

/**
 * Unlock the vault with both keys, creating the KCV file on first run and
 * verifying it on every subsequent run.
 * @returns {Promise<{ userKey: CryptoKey, systemKey: CryptoKey }>}
 */
export async function unlock({ userHex, systemHex, kcvPath }) {
  const userKey = await loadKey(userHex);
  const systemKey = await loadKey(systemHex);

  if (existsSync(kcvPath)) {
    const kcv = JSON.parse(readFileSync(kcvPath, 'utf8'));
    let u, s;
    try { u = await decrypt(kcv.user, userKey); }
    catch { throw new Error('USER_MASTER KCV failed — wrong key. Vault stays locked.'); }
    try { s = await decrypt(kcv.system, null, null, { systemKey }); }
    catch { throw new Error('SYSTEM_KEY KCV failed — wrong key. Vault stays locked.'); }
    if (u !== KCV_CONST || s !== KCV_CONST) {
      throw new Error('KCV constant mismatch — vault stays locked.');
    }
  } else {
    mkdirSync(dirname(kcvPath), { recursive: true });
    const kcv = {
      v: 1,
      user: await encrypt(KCV_CONST, 'personal', userKey),
      system: await encryptWithSystemKey(KCV_CONST, 'personal', systemKey),
    };
    writeFileSync(kcvPath, JSON.stringify(kcv, null, 2));
  }

  return { userKey, systemKey };
}
