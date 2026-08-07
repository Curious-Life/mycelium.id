// src/account/router.js — the first-run account ceremony + recovery, mounted at
// /api/v1/account. This is the ONLY data surface that runs BEFORE the vault is
// open ("setup mode"), so a brand-new user can create their vault from the UI
// with no terminal. Same trust model as the rest of V1: single-user, bound to
// localhost. As defence in depth (these routes mint/return the master key) we
// also refuse any non-loopback caller.
import express from 'express';
import Busboy from 'busboy';
import { existsSync } from 'node:fs';
import { unlock } from '../crypto/keys.js';
import { streamVaultArchive, restoreVaultArchive, ARCHIVE_EXT, BACKUP_SOFT_LIMIT_BYTES } from './backup.js';
import { mindDir, voiceSamplesRoot } from '../paths.js';
import {
  generateUserMaster, deriveSystemKey, normalizeKey,
  writeKeychain, readUserMaster, deleteKeychain, keychainAvailable,
  saveRecoveryKeyToKeychain, openInStore,
} from './keystore.js';
import {
  sealKeys, unsealKeys, lockExists, readLock, writeLock, removeLock, MIN_PASSPHRASE_LENGTH,
} from './passphrase-lock.js';
import { getSessionKeys } from './session-keys.js';
import { vaultPresence } from './vault-presence.js';
import { isTrustedLoopback } from '../http/loopback.js';

// 500s: log the real error server-side (key-free by construction — these paths
// never carry key material) and return ONLY a generic message to the client, so a
// deep internal error (a path, a schema/migration detail) never echoes out the
// HTTP boundary. The stable `error:` code is what the UI keys on, not the prose.
function sanitizeErr(err) {
  try { console.error('[account] request failed:', err?.message || err); } catch { /* never throw from logging */ }
  return 'Something went wrong — check the app logs for details.';
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.isInitialized   is the vault open (booted) yet?
 * @param {(keys:{userHex:string,systemHex:string}) => Promise<void>} deps.completeBoot
 * @param {string} deps.kcvPath  path to the vault's KCV (to verify a restore key)
 * @param {string} [deps.lockFile]  path to the passphrase seal (co-located w/ KCV)
 * @param {string} [deps.dbPath]  path to mycelium.db (for backup/restore-backup)
 * @param {string} [deps.uploadsRoot]  uploads dir (for backup/restore-backup)
 * @param {string} [deps.remoteConfigPath]  remote.json (optional, non-secret, in backup)
 */
export function accountRouter({ isInitialized, completeBoot, getBootError, getBootPhase, kcvPath, lockFile, dbPath, uploadsRoot, remoteConfigPath }) {
  const router = express.Router();

  // D-130 REVIEW BLOCKER (round 1) — the vault-MUTATING ceremonies must refuse
  // while a boot is IN FLIGHT. Listen-before-boot made this surface reachable
  // during a minutes-long boot (the awaited off-loop snapshot on a large
  // restore); an overwrite-restore or a destroy racing an active migration is
  // the concurrent-writer corruption class the init lock exists to prevent —
  // and the portal's booting re-poll is client politeness, not a guarantee
  // (§2 defense in depth: the SERVER refuses). 409 + booting so the client
  // knows to wait; /status stays readable throughout.
  const refuseWhileBooting = (req, res, next) => {
    const phase = typeof getBootPhase === 'function' ? getBootPhase() : null;
    if (phase) return res.status(409).json({ error: 'booting', bootPhase: phase, message: 'The vault is opening — try again when it finishes.' });
    next();
  };
  for (const p of ['/setup', '/restore', '/restore-backup', '/unlock']) router.post(p, refuseWhileBooting);
  router.use(express.json({ limit: '64kb' }));

  // Defence in depth (these routes mint/return the master key): reject anything
  // that did not arrive as a genuine loopback request. isTrustedLoopback also
  // rejects reverse-proxied (X-Forwarded-For-bearing) requests — so this surface
  // stays unreachable even if it is ever path-routed through the relay (V-1).
  router.use((req, res, next) => {
    if (isTrustedLoopback(req)) return next();
    return res.status(403).json({ error: 'forbidden' });
  });

  // The UI gates on this: needsSetup → /setup, locked → /unlock, else the app.
  router.get('/status', (_req, res) => {
    const open = Boolean(isInitialized());
    // D-080: ask the DATA, not just the sidecar. This used to be
    // existsSync(kcvPath) alone, so a vault whose verifier was missing published
    // needsSetup:true and the UI offered to create a new one over it.
    const vaultExists = vaultPresence({ dbPath, kcvPath }).any;
    const passphraseEnabled = lockExists(lockFile);
    res.json({
      open,
      initialized: open,            // back-compat alias (the only field pre-Phase-3)
      needsSetup: !vaultExists,     // no vault has ever been created on this machine
      locked: !open && vaultExists && passphraseEnabled,
      // Vault FILES are present but the Keychain can't open them (a hand-copied
      // data dir, or the moment right after a restore-from-backup lands the files):
      // the user must paste their recovery key. The boot path auto-opens when the
      // Keychain holds matching keys, so open=false + files + no passphrase ⇒ key.
      needsRecoveryKey: !open && vaultExists && !passphraseEnabled,
      passphraseEnabled,
      // Why boot couldn't open an existing vault (key_mismatch | at_rest_migration_failed
      // | boot_failed), so the UI shows the specific recovery instead of "not set up".
      // null when the vault is open or genuinely uncreated.
      bootError: (typeof getBootError === 'function' ? getBootError() : null) || null,
      // D-130 — a boot is IN FLIGHT (e.g. the awaited off-loop vault copy on a
      // large restore). The portal must show "opening" + re-poll, and MUST NOT
      // route to /setup: open:false + booting:true over a populated vault is the
      // D-080 create-over-a-real-vault hazard shape. bootPhase: 'snapshot' |
      // 'migrating' | 'starting' (content-free).
      booting: Boolean(typeof getBootPhase === 'function' ? getBootPhase() : null),
      bootPhase: (typeof getBootPhase === 'function' ? getBootPhase() : null) || null,
      keychainAvailable: keychainAvailable(),
    });
  });

  // First run: generate a key, store it, open the vault, return the key ONCE.
  router.post('/setup', async (_req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_initialized' });
    // FAIL CLOSED (D-080), the second independent layer (CLAUDE.md §2). The boot
    // path now aborts before setup mode is ever served, but this endpoint mints a
    // NEW master key and boots a NEW vault, so it must refuse on its own evidence
    // rather than trusting that the caller only got here legitimately. It used to
    // guard on isInitialized() alone and never asked whether a mycelium.db was
    // sitting right there.
    const present = vaultPresence({ dbPath, kcvPath });
    if (present.any) {
      console.error('[account] REFUSED /setup: a vault already exists on this device (D-080)');
      return res.status(409).json({
        error: 'vault_exists',
        message: 'A vault already exists on this device. Unlock it with its recovery key, or restore a backup — creating a new one here would leave the existing vault unopenable.',
      });
    }
    if (!keychainAvailable()) {
      return res.status(400).json({ error: 'keychain_unavailable', message: 'The macOS Keychain is required to store your key.' });
    }
    try {
      const userHex = generateUserMaster();
      const systemHex = deriveSystemKey(userHex);
      writeKeychain(userHex, systemHex);     // persist BEFORE boot so a restart re-opens it
      await completeBoot({ userHex, systemHex, reason: 'setup' });
      // The recovery key is returned ONCE here — no-store so it never caches.
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      return res.json({ recoveryKey: userHex });
    } catch (err) {
      return res.status(500).json({ error: 'setup_failed', message: sanitizeErr(err) });
    }
  });

  // New machine / cleared Keychain: paste the recovery key to re-open the vault.
  router.post('/restore', async (req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_initialized' });
    if (!keychainAvailable()) return res.status(400).json({ error: 'keychain_unavailable' });
    // FAIL CLOSED (data-loss guard): the recovery key only DECRYPTS data that is
    // already on this device — it is not a cloud restore. With no vault file, a
    // key paste used to silently create a fresh EMPTY vault and report success
    // (completeBoot → ensureVaultSchema), so device loss = total data loss even
    // with the key. Require the vault to be present first: restore a .myvault
    // backup (POST /restore-backup) — or hand-copy the data dir — THEN paste the
    // key. See the vault-backup and remote-access design §4.
    if (!existsSync(kcvPath)) {
      // D-080: distinguish "nothing here" from "the db is here but its verifier
      // is not". Both refuse (a key cannot be verified without a KCV, and
      // minting one would lock the real key out — see unlock()), but saying "no
      // vault on this device" while mycelium.db sits beside it is the same lie
      // that cost a vault, and it invites the user to create a new one.
      const dbHere = vaultPresence({ dbPath }).db;
      return res.status(409).json({
        error: dbHere ? 'kcv_missing' : 'no_vault',
        message: dbHere
          ? 'This vault is missing its kcv.json key-verifier, so a recovery key cannot be checked against it. Restore kcv.json (or the whole .myvault backup) alongside the existing mycelium.db, then try again. The vault data has not been touched.'
          : 'There is no vault on this device yet. Restore a backup first, or create a new vault.',
      });
    }
    let userHex;
    try { userHex = normalizeKey(req.body?.recoveryKey); }
    catch { return res.status(400).json({ error: 'invalid_key', message: 'Enter your 64-character recovery key.' }); }
    const systemHex = deriveSystemKey(userHex);
    // Verify the key against the existing KCV BEFORE writing anything — a wrong
    // key is rejected (unlock throws), never stored.
    // dbPath is passed even though the guard above makes the mint branch
    // unreachable today: that pair is a TOCTOU (restore-backup moves kcv.json
    // aside on the same always-mounted router), and this was the one unlock()
    // call left in src/ that skipped its own guard.
    try { await unlock({ userHex, systemHex, kcvPath, dbPath }); }
    catch { return res.status(400).json({ error: 'wrong_key', message: 'That key does not match this vault.' }); }
    try {
      // force: the user explicitly pasted a recovery key to (re)open THIS vault.
      // When a vault exists it was KCV-verified just above; any prior Keychain
      // value is backed up by kcWrite before being replaced.
      writeKeychain(userHex, systemHex, { force: true });
      removeLock(lockFile); // a recovery-key restore turns OFF any passphrase lock
      await completeBoot({ userHex, systemHex, reason: 'restore' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'restore_failed', message: sanitizeErr(err) });
    }
  });

  // Re-view the recovery key later (Settings → Security). localhost-only above.
  router.get('/recovery-key', (_req, res) => {
    const key = readUserMaster();
    if (!key) return res.status(404).json({ error: 'no_key' });
    // The single most sensitive value in the system. Loopback-gated above; ALSO
    // forbid any caching (browser disk cache, devtools, any intermediary) so it
    // never persists outside this response, and leave an audit line (NEVER the
    // value) so an unexpected reveal is observable.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    console.info('[account] recovery key revealed (GET /recovery-key, loopback)');
    res.json({ recoveryKey: key });
  });

  // One-click "save a copy to this Mac's Keychain". The key is read server-side
  // and handed to Keychain Access — it never returns to the client. This is an
  // ON-DEVICE CONVENIENCE, NOT a backup: a login-Keychain item lives on this Mac,
  // so it is gone if the machine is lost. The only real backup is an OFF-machine
  // copy of the 64-hex key (download/print/copy-into-a-syncing-manager), which is
  // why this does NOT satisfy the onboarding backup gate. { target: 'keychain' }.
  // (D-027: the former `target:'1password'` op-CLI branch was removed — it blamed
  // the user for a per-process authorization limit a GUI app cannot satisfy.)
  router.post('/recovery-key/save', (req, res) => {
    const key = readUserMaster();
    if (!key) return res.status(404).json({ error: 'no_key' });
    const target = req.body?.target;
    if (target !== 'keychain') return res.status(400).json({ error: 'bad_target' });
    try {
      saveRecoveryKeyToKeychain(key);
      openInStore('keychain'); // best-effort: reveal it natively so the user SEES it
      return res.json({ ok: true, opened: 'keychain', item: 'Mycelium Recovery Key' });
    } catch (err) {
      // sanitizeErr logs key-free server-side and returns only a generic message.
      return res.status(500).json({ error: 'save_failed', message: sanitizeErr(err) });
    }
  });

  // ── Vault backup / restore-from-backup ──────────────────────────────────────
  // GET /backup — stream a ZERO-KNOWLEDGE snapshot of the vault (a `.myvault`
  // zip: ciphertext mycelium.db snapshot + kcv.json verifier + encrypted uploads
  // + non-secret remote.json; auth.db is excluded). Loopback-only (inherited gate
  // above). The output is ciphertext — useless without the recovery key — but we
  // still require the vault to be OPEN so a fresh/locked device can't be drained.
  router.get('/backup', async (_req, res) => {
    if (!isInitialized()) return res.status(409).json({ error: 'vault_not_open' });
    if (!dbPath || !vaultPresence({ dbPath, kcvPath }).any) return res.status(400).json({ error: 'no_vault' });
    try {
      // D-122: STREAMED, never buffered. The old buildVaultArchive path materialised the
      // whole archive in memory and failed outright on the operator's ~3 GB vault (the one
      // backup that mattered had to be hand-built with `zip -0`). streamVaultArchive keeps
      // peak memory at one read chunk regardless of vault size. No Content-Length (chunked
      // transfer); the manifest header still precedes the body because the manifest is
      // computed from stats before the first byte streams.
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="mycelium-vault-${stamp}${ARCHIVE_EXT}"`);
      // ⚠️ LOAD-BEARING, not an optimization. The compression middleware's NO_COMPRESS
      // path filter evaluates req.path at FIRST-WRITE time, when the router context has
      // reduced it to '/backup' — so the anchored /api\/v1\/account/ pattern misses and
      // gzip wraps this response. That wrapper does not forward write() callbacks, which
      // deadlocks any callback-paced streamer (found live: the D-122 stream hung exactly
      // there). no-transform is honored by compression independent of its path filter,
      // and is also simply TRUE of this body: a ciphertext archive must never be
      // transformed in flight.
      res.setHeader('Cache-Control', 'no-transform');
      await streamVaultArchive({
        dbPath, kcvPath, uploadsRoot, remoteConfigPath, mindRoot: mindDir(), voiceSamplesRoot: voiceSamplesRoot(),
        out: res,
        // Fires before the first body byte, so the header still makes it out.
        onManifest: (m) => res.setHeader('X-Vault-Manifest', JSON.stringify({ v: m.v, createdAt: m.createdAt, uploadCount: m.uploadCount })),
      });
      return; // streamVaultArchive's finalize() ended the response
    } catch (err) {
      // D-077's lesson: a failure mid-stream must never complete a whole-looking body.
      // If headers already went out, DESTROY the socket so the client sees a broken
      // download instead of a silently short archive; otherwise answer a clean 500.
      if (res.headersSent) { try { res.destroy(err instanceof Error ? err : new Error(String(err))); } catch { /* */ } return; }
      return res.status(500).json({ error: 'backup_failed', message: sanitizeErr(err) });
    }
  });

  // POST /restore-backup (multipart `file`) — land a `.myvault` archive on disk so
  // the existing /restore key paste can open the REAL data. Refuses to clobber an
  // existing vault unless field overwrite=true (then the prior db/kcv/uploads are
  // moved aside, never destroyed). Does NOT open the vault — that's /restore.
  router.post('/restore-backup', async (req, res) => {
    if (isInitialized()) return res.status(409).json({ error: 'already_initialized' });
    if (!dbPath) return res.status(500).json({ error: 'misconfigured', message: 'backup paths not wired' });

    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 5 * BACKUP_SOFT_LIMIT_BYTES } }); }
    catch { return res.status(400).json({ error: 'bad_request', message: 'expected a multipart upload.' }); }
    const fields = {};
    let buf = null, truncated = false;
    bb.on('field', (name, val) => { if (typeof val === 'string' && val.length <= 64) fields[name] = val; });
    bb.on('file', (name, stream) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { buf = Buffer.concat(chunks); });
    });
    bb.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'upload_failed' }); });
    bb.on('close', async () => {
      if (truncated) return res.status(413).json({ error: 'too_large', message: 'That backup file is too large to upload.' });
      if (!buf || !buf.length) return res.status(400).json({ error: 'no_file', message: 'Choose a .myvault backup file.' });
      const overwrite = fields.overwrite === 'true' || fields.overwrite === '1';
      try {
        const { manifest, movedAside } = await restoreVaultArchive({ buffer: buf, dbPath, kcvPath, uploadsRoot, mindRoot: mindDir(), voiceSamplesRoot: voiceSamplesRoot(), overwrite });
        return res.json({ ok: true, needsKey: true, manifest: { createdAt: manifest.createdAt, uploadCount: manifest.uploadCount }, replaced: movedAside.length > 0 });
      } catch (err) {
        if (err?.code === 'vault_exists') return res.status(409).json({ error: 'vault_exists', message: 'A vault already exists on this device. Confirm to replace it.' });
        if (err?.code === 'vault_in_use') return res.status(409).json({ error: 'vault_in_use', message: String(err.message) });
        if (err?.code === 'invalid_archive') return res.status(400).json({ error: 'invalid_archive', message: String(err.message) });
        return res.status(500).json({ error: 'restore_backup_failed', message: sanitizeErr(err) });
      }
    });
    req.pipe(bb);
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
      await completeBoot({ userHex: keys.userHex, systemHex: keys.systemHex, reason: 'unlock' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'unlock_failed', message: sanitizeErr(err) });
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
      return res.status(500).json({ error: 'enable_failed', message: sanitizeErr(err) });
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
      return res.status(500).json({ error: 'disable_failed', message: sanitizeErr(err) });
    }
  });

  return router;
}

export default accountRouter;
