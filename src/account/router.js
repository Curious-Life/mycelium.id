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
  writeKeychain, readUserMaster, keychainAvailable,
} from './keystore.js';

/**
 * @param {object} deps
 * @param {() => boolean} deps.isInitialized   is the vault open (booted) yet?
 * @param {(keys:{userHex:string,systemHex:string}) => Promise<void>} deps.completeBoot
 * @param {string} deps.kcvPath  path to the vault's KCV (to verify a restore key)
 */
export function accountRouter({ isInitialized, completeBoot, kcvPath }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.use((req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(403).json({ error: 'forbidden' });
  });

  // Does the app need a first-run setup screen? The UI gates on this.
  router.get('/status', (_req, res) => {
    res.json({ initialized: Boolean(isInitialized()), keychainAvailable: keychainAvailable() });
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
      writeKeychain(userHex, systemHex);
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

  return router;
}

export default accountRouter;
