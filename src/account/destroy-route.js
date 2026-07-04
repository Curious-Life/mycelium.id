// POST /api/v1/account/destroy — the recovery-key-gated factory-reset route.
// The single most dangerous endpoint in the product; it is defended in depth:
//   1. LOOPBACK ONLY — same fence as every account route (isTrustedLoopback).
//   2. RECOVERY-KEY GATE — the body must carry the recovery key, verified
//      constant-time against the live master (verifyRecoveryKey). An
//      authenticated session ALONE can never destroy the vault — a stolen/
//      replayed Bearer or a malicious portal page can't supply the key.
//   3. TYPED PHRASE — a fixed confirmation string, belt-and-suspenders vs an
//      accidental/programmatic call.
// Only after all three pass does it invoke the (already reviewed) destroyVault
// wipe engine. The engine's own invariants (content-first, keys-last, recursive
// whole-dir wipe, fail-closed roots) do the rest.
//
// Fully injectable so verify:destroy-route can drive every gate + the happy path
// against a temp dir with fakes — no real Keychain, no real vault.

import express from 'express';
import { verifyRecoveryKey, destroyVault } from './destroy.js';

export const DESTROY_PHRASE = 'destroy my vault';

/**
 * @param {object} deps
 * @param {(req:any)=>boolean} deps.isTrustedLoopback
 * @param {() => string|null} deps.readMaster        live USER_MASTER (readUserMaster / in-memory pin)
 * @param {() => string} deps.dataDir                app-private root
 * @param {() => string[]} [deps.extraRoots]         absolute roots OUTSIDE dataDir (e.g. agentRoot/mind)
 * @param {() => void} deps.deleteKeychain
 * @param {() => Promise<void>} [deps.quiesce]       best-effort daemon/job stop
 * @param {() => Promise<any>} [deps.revokeRelay]    best-effort server-side handle/DID revoke
 * @param {(tags:string[]) => Promise<{removed:string[],failed:string[]}>} [deps.deleteOllamaModels]
 * @param {() => Promise<string[]>} [deps.readPulledModels]
 * @param {(m:string)=>void} [deps.log]
 * @param {typeof destroyVault} [deps._destroyVault]  test seam
 */
export function destroyRouter(deps = {}) {
  const {
    isTrustedLoopback, readMaster, dataDir, extraRoots, deleteKeychain,
    quiesce, revokeRelay, deleteOllamaModels, readPulledModels,
    log = () => {}, _destroyVault = destroyVault,
  } = deps;
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  router.post('/destroy', async (req, res) => {
    try {
      // 1. Loopback.
      if (typeof isTrustedLoopback === 'function' && !isTrustedLoopback(req)) {
        return res.status(403).json({ ok: false, error: 'destroy is loopback-only' });
      }
      const { recoveryKey, phrase } = req.body || {};
      // 3. Typed phrase (cheap check first).
      if (phrase !== DESTROY_PHRASE) {
        return res.status(400).json({ ok: false, error: 'confirmation phrase does not match' });
      }
      // 2. Recovery-key gate — the load-bearing one. Fail-closed if we can't read
      // the live master at all (never destroy on an indeterminate key).
      let master = null;
      try { master = readMaster?.(); } catch { master = null; }
      if (!master || !verifyRecoveryKey(recoveryKey, master)) {
        log('[destroy] refused: recovery key mismatch');
        return res.status(403).json({ ok: false, error: 'recovery key does not match — destroy refused' });
      }

      log('[destroy] gate passed — beginning irreversible wipe');
      const pulledOllamaTags = readPulledModels ? await readPulledModels().catch(() => []) : [];
      const result = await _destroyVault({
        dataDir: dataDir(),
        extraRoots: extraRoots ? extraRoots() : [],
        deleteKeychain, quiesce, revokeRelay, deleteOllamaModels, pulledOllamaTags, log,
      });

      // Never echo paths/keys. Counts + booleans only (CLAUDE.md §8).
      return res.json({
        ok: result.failed.length === 0 && result.keychainDeleted === true,
        wiped: result.wiped.length,
        failed: result.failed.length,
        keychainDeleted: result.keychainDeleted,
        relayRevoked: result.relayRevoked,
        ollamaRemoved: result.ollama?.removed?.length ?? 0,
        // The seamless relaunch is the Tauri layer's job; a pure-node caller must
        // quit + reopen (the app boots to onboarding — the vault is gone).
        relaunchRequired: true,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
