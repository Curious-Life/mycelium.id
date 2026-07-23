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
// HANDLE PRE-FLIGHT (QA P0.7). Releasing a managed handle needs a claim SIGNED
// WITH THE MASTER KEY. After the wipe the Keychain is gone, so the claim can
// never be produced again — a release that fails during destroy is permanent and
// the name stays squatted forever. There is therefore no such thing as a
// post-destroy retry queue. Instead the release runs as a PRE-FLIGHT, BEFORE any
// deletion, with bounded retries; if it fails the route returns 409 and DELETES
// NOTHING, so the user can reconnect and try again with their vault intact. Only
// an explicit `force: true` proceeds, and the response then states plainly that
// the handle is still registered.
//
// Fully injectable so verify:destroy-route can drive every gate + the happy path
// against a temp dir with fakes — no real Keychain, no real vault.

import express from 'express';
import { verifyRecoveryKey, destroyVault, normalizeReleaseOutcome } from './destroy.js';

export const DESTROY_PHRASE = 'destroy my vault';

/**
 * @param {object} deps
 * @param {(req:any)=>boolean} deps.isTrustedLoopback
 * @param {() => string|null} deps.readMaster        live USER_MASTER (readUserMaster / in-memory pin)
 * @param {() => string} deps.dataDir                app-private root
 * @param {() => string[]} [deps.extraRoots]         absolute roots OUTSIDE dataDir (paths.js destroyExtraRoots)
 * @param {() => void} deps.deleteKeychain
 * @param {() => Promise<void>} [deps.quiesce]       best-effort daemon/job stop
 * @param {(masterHex:string) => Promise<{applicable?:boolean,released?:boolean,reason?:string}>} [deps.revokeRelay]
 *        best-effort server-side handle/DID release. Receives the master key that just
 *        cleared the recovery-key gate (so the claim can be signed PRE-BOOT), and its
 *        RETURN VALUE is the outcome — "did not throw" is NOT success.
 * @param {() => Promise<{attempted:number,revoked:string[],failed:Array<{id:string,reason:string}>}>} [deps.revokeConnectors]
 * @param {(tags:string[]) => Promise<{removed:string[],failed:string[]}>} [deps.deleteOllamaModels]
 * @param {() => Promise<string[]>} [deps.readPulledModels]
 * @param {(m:string)=>void} [deps.log]
 * @param {typeof destroyVault} [deps._destroyVault]  test seam
 */
export function destroyRouter(deps = {}) {
  const {
    isTrustedLoopback, readMaster, dataDir, extraRoots, deleteKeychain,
    quiesce, revokeRelay, revokeConnectors, deleteOllamaModels, readPulledModels,
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
      const { recoveryKey, phrase, force } = req.body || {};
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

      // 4. HANDLE PRE-FLIGHT — the last moment at which a release claim can be
      //    signed. Runs BEFORE anything is deleted, so a failure is recoverable.
      // The gated master is handed to the hook so the release can be SIGNED even
      // pre-boot: env.ENCRYPTION_MASTER_KEY is populated only by boot(), while
      // this route is mounted always and gates straight off the Keychain — so a
      // reset of an unbooted/broken vault (the most common reason to reset) would
      // otherwise be unable to release, and used to say nothing about it.
      let release = { attempted: false, applicable: false, released: false, reason: 'no-hook' };
      if (revokeRelay) {
        try { release = normalizeReleaseOutcome(await revokeRelay(master)); }
        catch (e) { release = { attempted: true, applicable: true, released: false, reason: String(e?.message || e).slice(0, 80) }; }
      }
      // Blocking iff there really WAS a managed handle and it is still taken.
      // `applicable:false` (self-hosted, own-relay, direct, remote off) is not a
      // failure — there is nothing on any control plane to free.
      if (release.attempted && release.applicable && !release.released && force !== true) {
        log('[destroy] halted: managed handle could not be released — nothing deleted');
        return res.status(409).json({
          ok: false,
          error: 'could not release your handle — nothing was deleted',
          handleRelease: release,
          // The client may retry (reconnect and POST again) or proceed knowingly.
          canForce: true,
          hint: 'Your vault is untouched. Reconnect and try again, or destroy anyway — your handle will stay registered and cannot be freed afterwards (the key that signs the release is destroyed with the vault).',
        });
      }

      log('[destroy] gate passed — beginning irreversible wipe');
      const pulledOllamaTags = readPulledModels ? await readPulledModels().catch(() => []) : [];
      const result = await _destroyVault({
        dataDir: dataDir(),
        extraRoots: extraRoots ? extraRoots() : [],
        deleteKeychain, quiesce,
        // The release already happened in the pre-flight; hand the ENGINE the
        // real outcome so its report matches, without a second network call.
        revokeRelay: revokeRelay ? async () => release : undefined,
        revokeConnectors, deleteOllamaModels, pulledOllamaTags, log,
      });

      // Never echo paths/keys. Counts + booleans + short machine reasons only
      // (CLAUDE.md §1/§8). Every step reports its TRUE outcome — a step that did
      // not succeed is never rendered as success.
      const connectors = result.connectors || { attempted: 0, revoked: [], failed: [] };
      return res.json({
        ok: result.failed.length === 0 && result.keychainDeleted === true,
        wiped: result.wiped.length,
        failed: result.failed.length,
        keychainDeleted: result.keychainDeleted,
        // TRUE only when the control plane actually released the name.
        relayRevoked: result.relayRevoked === true,
        handleRelease: result.relayRelease,
        connectors: {
          attempted: connectors.attempted,
          revoked: connectors.revoked.length,
          failed: connectors.failed,
        },
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
