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

/**
 * Can this key actually OPEN the vault file? (D-080.)
 *
 * When kcv.json is missing we have no verifier — but for an encrypted vault the
 * db itself is the verifier: a wrong SQLCipher key cannot read a page. Proving
 * the key against the data is what lets a legitimate recovery (kcv lost, db
 * intact) still work, instead of a missing sidecar bricking a healthy vault.
 *
 * A PLAINTEXT vault opens under ANY key, so nothing can be proven and this
 * returns TRUE (permissive).
 *
 * KNOWN GAP, OPEN, NOT CLOSED HERE (both independent reviews raised it; see the
 * fix handoff). For an UPGRADER — a legacy plaintext vault whose kcv.json is
 * missing — a wrong key mints a verifier and the at-rest migration then encrypts
 * the user's data under it. Closing it needs a rule that refuses a plaintext
 * vault holding real rows, and that rule DIRECTLY CONTRADICTS an asserted product
 * contract: verify:at-rest-default T4 requires the real launch to migrate exactly
 * such a vault (plaintext + rows + no kcv + a fresh key) to ciphertext, and the
 * same fixture idiom recurs across the gate suite (verify:vault-import,
 * verify:full-export-import, …). Whether the app should adopt a verifier-less
 * plaintext vault is a PRODUCT decision with a wide blast radius, not something
 * to change silently. Tracked as a follow-up; the encrypted path below — which is
 * every at-rest vault, i.e. all current production — is cryptographically closed.
 *
 * Returns: true = proven (or nothing provable) · false = NOT proven, refuse.
 */
async function keyOpensVault({ dbPath, userHex }) {
  const [{ vaultIsEncrypted }, { deriveDbKey }, { default: Database }] = await Promise.all([
    import('../db/open.js'), import('../account/keystore.js'), import('better-sqlite3'),
  ]);
  // A zero-byte file is a valid EMPTY sqlite db that opens under ANY key, and it
  // carries no plaintext header — so it reads as "encrypted" and the probe below
  // would pass for anything. Nothing is at stake in it either way.
  let size = 0;
  try { size = (await import('node:fs')).statSync(dbPath).size; } catch { return true; }
  if (size === 0) return true;

  if (!vaultIsEncrypted(dbPath)) return true; // plaintext → nothing to prove against (see the gap above)

  // The probe must not leave a trace: SQLite materialises a -shm beside a WAL db
  // even on a readonly open, and vault-presence promises "nothing is created".
  const fs = await import('node:fs');
  const shm = `${dbPath}-shm`;
  const shmExisted = fs.existsSync(shm);
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true });
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key="x'${deriveDbKey(userHex)}'"`);
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // SQLITE_NOTADB on a wrong key
    return true;
  } catch (e) {
    // DISTINGUISH "wrong key" from "could not look". Telling someone holding the
    // CORRECT key that it "does not open this vault" (a read-only volume, a
    // permissions problem) points them at destructive remedies — the same
    // wrong-diagnosis-drives-destructive-action class as D-080 itself.
    const msg = String(e?.message || e);
    // "malformed" is NOT a wrong key — it is the OPPOSITE. SQLCipher only reaches a
    // b-tree verdict AFTER it has decrypted the page, so "database disk image is
    // malformed" proves the key was RIGHT and the file is damaged. Folding it in with
    // the wrong-key patterns below made a correct key report as `false` = "this key does
    // not open the vault", which is precisely the reported symptom (2026-07-26: owner
    // pastes the correct passkey, app silently behaves as if it were wrong). It is also
    // the exact wrong-diagnosis-drives-destructive-action class the comment above warns
    // about — the remedy it points a user toward is "start over", on an intact-but-
    // repairable vault. @see the vault fail-stop design.
    if (/malformed|SQLITE_CORRUPT/i.test(msg) || String(e?.code || '').startsWith('SQLITE_CORRUPT')) {
      const err = new Error(`this vault is structurally damaged (${e?.code || 'SQLITE_CORRUPT'}: ${msg}). The key is not the problem — the database file is. Refusing to write anything; recover with scripts/vault-repair/ or restore a snapshot.`);
      err.code = 'vault_corrupt';
      throw err;
    }
    if (!/not a database|file is encrypted/i.test(msg)) {
      const err = new Error(`could not verify this key against the vault (${e?.code || 'error'}: ${msg}). Refusing to write anything until the vault can be read.`);
      err.code = 'kcv_unverifiable';
      throw err;
    }
    return false;
  } finally {
    try { db?.close(); } catch { /* */ }
    // D-140 (QA11D): the cleanup itself was a splice hazard. If a sibling process
    // opened the vault DURING this probe, it attached to the -shm the probe
    // materialised; unlinking it here leaves that writer on an orphaned wal-index
    // while the next opener creates a fresh one — two writers, two indexes, the
    // exact split-brain the kill-storm harness's P1 control corrupts with. Only
    // remove the probe's -shm when no live process holds the vault (fail closed:
    // in doubt, leave the file — a stray -shm is cosmetic; a split one is not).
    if (!shmExisted) {
      try {
        const { vaultInUse } = await import('../db/vault-lease.js');
        if (!vaultInUse(dbPath)) fs.rmSync(shm, { force: true });
      } catch { /* leave the file */ }
    }
  }
}


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
 *
 * D-080: pass `dbPath` on any path that can reach a REAL vault. Minting a fresh
 * KCV beside an existing mycelium.db is silent, permanent data loss — and it
 * does it WITHOUT touching a byte of the db, so a byte-identity check does not
 * catch it. The new KCV attests to the wrong key; /account/restore then verifies
 * the user's real recovery key against it and answers "that key does not match
 * this vault" forever, for a vault sitting intact on disk. (Spike 2026-07-27:
 * reproduced end to end.) Omitting `dbPath` leaves the first-run branch
 * unguarded and is only correct for fixtures that own no db.
 *
 * @returns {Promise<{ userKey: CryptoKey, systemKey: CryptoKey }>}
 */
export async function unlock({ userHex, systemHex, kcvPath, dbPath }) {
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
    // FAIL CLOSED (D-080): there is no verifier here, but if the VAULT is here
    // then this key has not been proven against it. Writing a KCV now would
    // silently declare this key the vault's owner and lock the real key out.
    // The caller must recover the vault (its own recovery key / a backup), not
    // re-attest it.
    if (dbPath && existsSync(dbPath) && !(await keyOpensVault({ dbPath, userHex }))) {
      throw new Error(
        'REFUSING to create a key-verifier beside an existing vault: kcv.json is missing and this '
        + 'key does not open mycelium.db. Writing one would attest the wrong key and lock the '
        + "vault's real recovery key out permanently. Restore kcv.json (or the whole .myvault "
        + 'backup) alongside the existing vault, or unlock it with its own recovery key.',
      );
    }
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

/**
 * NON-MUTATING KCV check: does this key pair open the vault at kcvPath?
 *   - returns null  if no KCV exists there (no vault to protect — caller is free)
 *   - returns true  if both KCVs decrypt to the constant (keys match this vault)
 *   - returns false if they do NOT (writing these keys would orphan the data)
 * Never creates or modifies the KCV; safe to call before deciding to write keys.
 */
export async function kcvMatches({ userHex, systemHex, kcvPath }) {
  if (!existsSync(kcvPath)) return null;
  try {
    const kcv = JSON.parse(readFileSync(kcvPath, 'utf8'));
    const userKey = await loadKey(userHex);
    const systemKey = await loadKey(systemHex);
    const u = await decrypt(kcv.user, userKey);
    const s = await decrypt(kcv.system, null, null, { systemKey });
    return u === KCV_CONST && s === KCV_CONST;
  } catch { return false; }
}
