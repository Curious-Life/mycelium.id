// src/account/router.js — the first-run account ceremony + recovery, mounted at
// /api/v1/account. This is the ONLY data surface that runs BEFORE the vault is
// open ("setup mode"), so a brand-new user can create their vault from the UI
// with no terminal. Same trust model as the rest of V1: single-user, bound to
// localhost. As defence in depth (these routes mint/return the master key) we
// also refuse any non-loopback caller.
import express from 'express';
import { existsSync } from 'node:fs';
import { unlock } from '../crypto/keys.js';
import {
  generateUserMaster, deriveSystemKey, normalizeKey,
  writeKeychain, readUserMaster, deleteKeychain, keychainAvailable,
  onePasswordAvailable, saveRecoveryKeyToKeychain, saveRecoveryKeyTo1Password, openInStore,
} from './keystore.js';
import {
  sealKeys, unsealKeys, lockExists, readLock, writeLock, removeLock, MIN_PASSPHRASE_LENGTH,
} from './passphrase-lock.js';
import { getSessionKeys } from './session-keys.js';

/**
 * @param {object} deps
 * @param {() => boolean} deps.isInitialized   is the vault open (booted) yet?
 * @param {(keys:{userHex:string,systemHex:string}) => Promise<void>} deps.completeBoot
 * @param {string} deps.kcvPath  path to the vault's KCV (to verify a restore key)
 * @param {string} [deps.lockFile]  path to the passphrase seal (co-located w/ KCV)
 */
export function accountRouter({ isInitialized, completeBoot, kcvPath, lockFile }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.use((req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(403).json({ error: 'forbidden' });
  });

  // The UI gates on this: needsSetup → /setup, locked → /unlock, else the app.
  router.get('/status', (_req, res) => {
    const open = Boolean(isInitialized());
    const vaultExists = existsSync(kcvPath);
    const passphraseEnabled = lockExists(lockFile);
    res.json({
      open,
      initialized: open,            // back-compat alias (the only field pre-Phase-3)
      needsSetup: !vaultExists,     // no vault has ever been created on this machine
      locked: !open && vaultExists && passphraseEnabled,
      passphraseEnabled,
      keychainAvailable: keychainAvailable(),
      onePasswordAvailable: onePasswordAvailable(),
    });
  });

  // First run: generate a key, store it, open the vault, return the key ONCE.
  router.post('/setup', async (_req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_initialized' });
    if (!keychainAvailable()) {
      return res.status(400).json({ error: 'keychain_unavailable', message: 'The macOS Keychain is required to store your key.' });
    }
    try {
      const userHex = generateUserMaster();
      const systemHex = deriveSystemKey(userHex);
      writeKeychain(userHex, systemHex);     // persist BEFORE boot so a restart re-opens it
      await completeBoot({ userHex, systemHex });
      return res.json({ recoveryKey: userHex });
    } catch (err) {
      return res.status(500).json({ error: 'setup_failed', message: String(err?.message || err) });
    }
  });

  // New machine / cleared Keychain: paste the recovery key to re-open the vault.
  router.post('/restore', async (req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_initialized' });
    if (!keychainAvailable()) return res.status(400).json({ error: 'keychain_unavailable' });
    let userHex;
    try { userHex = normalizeKey(req.body?.recoveryKey); }
    catch { return res.status(400).json({ error: 'invalid_key', message: 'Enter your 64-character recovery key.' }); }
    const systemHex = deriveSystemKey(userHex);
    // If a vault already exists here, verify the key against its KCV BEFORE
    // writing anything — a wrong key is rejected (unlock throws), never stored.
    if (existsSync(kcvPath)) {
      try { await unlock({ userHex, systemHex, kcvPath }); }
      catch { return res.status(400).json({ error: 'wrong_key', message: 'That key does not match this vault.' }); }
    }
    try {
      // force: the user explicitly pasted a recovery key to (re)open THIS vault.
      // When a vault exists it was KCV-verified just above; any prior Keychain
      // value is backed up by kcWrite before being replaced.
      writeKeychain(userHex, systemHex, { force: true });
      removeLock(lockFile); // a recovery-key restore turns OFF any passphrase lock
      await completeBoot({ userHex, systemHex });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'restore_failed', message: String(err?.message || err) });
    }
  });

  // Re-view the recovery key later (Settings → Security). localhost-only above.
  router.get('/recovery-key', (_req, res) => {
    const key = readUserMaster();
    if (!key) return res.status(404).json({ error: 'no_key' });
    res.json({ recoveryKey: key });
  });

  // One-click "save my recovery key" to the Keychain or 1Password. The key is
  // read server-side and handed to the chosen store — it never returns to the
  // client. { target: 'keychain' | '1password' }.
  router.post('/recovery-key/save', (req, res) => {
    const key = readUserMaster();
    if (!key) return res.status(404).json({ error: 'no_key' });
    const target = req.body?.target;
    try {
      if (target === 'keychain') saveRecoveryKeyToKeychain(key);
      else if (target === '1password') saveRecoveryKeyTo1Password(key);
      else return res.status(400).json({ error: 'bad_target' });
      openInStore(target); // best-effort: reveal it natively so the user SEES it
      return res.json({ ok: true, opened: target, item: 'Mycelium Recovery Key' });
    } catch (err) {
      const msg = target === '1password'
        ? 'Could not save to 1Password — is the `op` CLI installed and signed in?'
        : String(err?.message || err);
      return res.status(500).json({ error: 'save_failed', message: msg });
    }
  });

  // ── Optional passphrase lock ────────────────────────────────────────────────
  // Per-IP attempt limiter for /unlock. scrypt already costs ~100ms each; this
  // just caps a runaway script. Single-user localhost → an in-memory map is fine.
  const unlockHits = new Map(); // ip -> { n, resetAt }
  const UNLOCK_MAX = 10, UNLOCK_WINDOW_MS = 60_000;
  function unlockRateLimited(ip) {
    const now = Date.now();
    const rec = unlockHits.get(ip || '');
    if (!rec || now > rec.resetAt) { unlockHits.set(ip || '', { n: 1, resetAt: now + UNLOCK_WINDOW_MS }); return false; }
    rec.n += 1;
    return rec.n > UNLOCK_MAX;
  }

  // POST /unlock { passphrase } — open a passphrase-locked vault for this session.
  // Mirrors /restore: unseal the keys, then completeBoot(). The keys are NOT
  // written back to the Keychain (that would defeat the lock) — they live in the
  // process memory (session-keys) for this run only.
  router.post('/unlock', async (req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_open' });
    if (!lockExists(lockFile)) return res.status(400).json({ error: 'not_locked' });
    if (unlockRateLimited(req.ip)) return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts — wait a minute and try again.' });
    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== 'string' || !passphrase) return res.status(400).json({ error: 'missing_passphrase' });
    let keys;
    try { keys = await unsealKeys(readLock(lockFile), passphrase); }
    catch { return res.status(400).json({ error: 'wrong_passphrase', message: 'That passphrase is incorrect.' }); }
    try {
      await completeBoot({ userHex: keys.userHex, systemHex: keys.systemHex });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'unlock_failed', message: String(err?.message || err) });
    }
  });

  // POST /passphrase/enable { passphrase } — turn ON the lock. The vault must be
  // OPEN (we seal the in-memory session keys, which works for legacy two-key
  // vaults too). ORDER MATTERS: write + verify the seal BEFORE removing the
  // Keychain keys, so a failure can never strip the only copy.
  router.post('/passphrase/enable', async (req, res) => {
    if (!isInitialized()) return res.status(409).json({ error: 'vault_not_open' });
    if (lockExists(lockFile)) return res.status(409).json({ error: 'already_enabled' });
    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return res.status(400).json({ error: 'weak_passphrase', message: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` });
    }
    const sk = getSessionKeys();
    if (!sk) return res.status(409).json({ error: 'keys_unavailable' });
    try {
      writeLock(await sealKeys(sk.userHex, sk.systemHex, passphrase), lockFile);
      // Verify the seal round-trips to the SAME keys before stripping the Keychain.
      const back = await unsealKeys(readLock(lockFile), passphrase);
      if (back.userHex !== sk.userHex.toLowerCase() || back.systemHex !== sk.systemHex.toLowerCase()) {
        removeLock(lockFile);
        return res.status(500).json({ error: 'seal_verify_failed' });
      }
      deleteKeychain(); // plaintext keys leave the Keychain — the lock is now real
      return res.json({ ok: true });
    } catch (err) {
      removeLock(lockFile);
      return res.status(500).json({ error: 'enable_failed', message: String(err?.message || err) });
    }
  });

  // POST /passphrase/disable { passphrase } — turn OFF the lock: verify the
  // passphrase, put the keys back in the Keychain, remove the seal.
  router.post('/passphrase/disable', async (req, res) => {
    if (!isInitialized()) return res.status(409).json({ error: 'vault_not_open' });
    if (!lockExists(lockFile)) return res.status(409).json({ error: 'not_enabled' });
    const passphrase = req.body?.passphrase;
    if (typeof passphrase !== 'string' || !passphrase) return res.status(400).json({ error: 'missing_passphrase' });
    let keys;
    try { keys = await unsealKeys(readLock(lockFile), passphrase); }
    catch { return res.status(400).json({ error: 'wrong_passphrase', message: 'That passphrase is incorrect.' }); }
    try {
      // force: these are the vault's own keys, just unsealed from the verified
      // passphrase seal — they are authoritative. The Keychain was emptied when
      // the lock was enabled, so normally there is nothing to overwrite.
      writeKeychain(keys.userHex, keys.systemHex, { force: true });
      removeLock(lockFile);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'disable_failed', message: String(err?.message || err) });
    }
  });

  return router;
}

export default accountRouter;
