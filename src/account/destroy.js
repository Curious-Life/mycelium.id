// Destroy-the-entire-vault (factory reset) — the NODE-side wipe engine.
// Design + locked decisions: docs/DATA-DESTROY-VAULT-DESIGN-2026-07-03.md.
//
// This is the single most destructive operation in the product. Two invariants
// make it safe:
//   1. RECOVERY-KEY GATE — the caller must prove ownership with the recovery key
//      (verifyRecoveryKey, constant-time vs the live master). A session alone can
//      never destroy the vault. The gate lives at the call site (the future REST
//      route); this module exports the check so there is ONE implementation.
//   2. CONTENT-FIRST, KEYS-LAST — every decryptable artifact (DB, search sidecar,
//      blobs, mind-files, app-private Ollama models) is deleted BEFORE any key
//      material (KCV, then the Keychain). A crash mid-wipe can therefore leave
//      "keys present, data gone" (safe) but never "data present, keys silently
//      gone". deleteKeychain() is the point of no return and runs strictly last.
//
// Everything else (quiesce daemons, revoke the relay handle/DID server-side,
// remove Mycelium-pulled models from a shared Ollama daemon) is a BEST-EFFORT
// hook injected by the caller — a failing hook is recorded, never thrown, and
// never blocks the local wipe (fail-open on the network, fail-closed on the gate).
//
// Pure + fully injectable (fs / exec / hooks) so verify:destroy-vault can drive
// it against a temp data dir with a fake Keychain and assert the ordering.

import { promises as nodeFs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { normalizeKey } from './keystore.js';

/**
 * Constant-time recovery-key check. Returns true iff `provided` normalises to the
 * same 64-hex master as `actual` (the live USER_MASTER from readUserMaster() or
 * the in-memory pin). Length-mismatch → false without leaking via timing.
 */
export function verifyRecoveryKey(provided, actual) {
  // normalizeKey THROWS on anything that isn't a 64-hex key — so a malformed /
  // wrong-length / non-string input fails closed here without leaking which.
  let a, b;
  try { a = normalizeKey(provided); b = normalizeKey(actual); }
  catch { return false; }
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch { return false; }
}

/**
 * The on-disk artifacts a destroy removes, derived from the app-data root.
 * A REPRESENTATIVE list of the artifacts under the app-data dir (for docs/tests).
 * NOT an allowlist — destroyVault wipes the whole dir recursively (below), so this
 * is only illustrative of what lives there.
 * @param {string} dataDir  app-data root (~/Library/Application Support/id.mycelium.app)
 */
export function destroyTargets(dataDir) {
  const f = (n) => join(dataDir, n);
  return {
    // Content, derived, config, key-check value, AND the full-vault copies that
    // accumulate (snapshots/, *.corrupt-*, *.bak-*) — all inside dataDir, all
    // removed by the recursive wipe.
    illustrative: [
      f('mycelium.db'), f('mycelium.search.db'), f('auth.db'), f('kcv.json'),
      f('vault-lock.json'), f('remote.json'), f('Caddyfile'), f('frpc.toml'),
      f('uploads'), f('mind'), f('ollama'), f('snapshots'), f('caddy'), f('models'),
      f('mycelium.db.corrupt-*'), f('*.bak-*'),
    ],
  };
}

/** rm a single path recursively+force; ENOENT is success, other errors → failed[]. */
async function rmPath(fs, p, wiped, failed) {
  try { await fs.rm(p, { recursive: true, force: true }); wiped.push(p); }
  catch (e) { if (e?.code !== 'ENOENT') failed.push({ target: p, error: String(e?.code || e) }); }
}

/**
 * Execute the local wipe. Caller MUST have already passed verifyRecoveryKey.
 *
 * Wipes the ENTIRE app-private data dir recursively (so no full-vault snapshot /
 * corrupt-copy / bak companion can survive — an allowlist would fail open on any
 * unlisted artifact), PLUS any roots that live OUTSIDE dataDir (e.g. the mind-file
 * agent root, which resolves to `<agentRoot>/mind` and is not under dataDir).
 *
 * @param {object} opts
 * @param {string} opts.dataDir        app-private root — its CONTENTS are wiped (dir kept for relaunch)
 * @param {string[]} [opts.extraRoots] absolute paths OUTSIDE dataDir to also wipe (e.g. agentRoot/mind).
 *        Each must be a non-empty absolute path; a value that resolves to '/' or '' is refused (fail-closed).
 * @param {object} [opts.fs]           node:fs/promises (injected for tests)
 * @param {() => Promise<void>} [opts.quiesce]        stop daemons/jobs (best-effort)
 * @param {() => Promise<any>}  [opts.revokeRelay]    server-side handle/DID revoke (best-effort)
 * @param {(tags:string[]) => Promise<{removed:string[],failed:string[]}>} [opts.deleteOllamaModels]
 *        remove Mycelium-pulled tags from a shared daemon (best-effort)
 * @param {string[]} [opts.pulledOllamaTags]          tags from the pulled-model manifest
 * @param {() => void} [opts.deleteKeychain]          keystore.deleteKeychain — runs LAST
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{wiped:string[], failed:Array<{target:string,error:string}>, keychainDeleted:boolean, relayRevoked:boolean, ollama:{removed:string[],failed:string[]}}>}
 */
export async function destroyVault(opts = {}) {
  const {
    dataDir, extraRoots = [], fs = nodeFs, quiesce, revokeRelay, deleteOllamaModels,
    pulledOllamaTags = [], deleteKeychain, log = () => {},
  } = opts;
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('destroyVault: dataDir required (fail-closed)');
  // Never recurse from a root that would blast the filesystem.
  const isSafeRoot = (p) => typeof p === 'string' && p.length > 1 && p.startsWith('/') && p !== '/';
  if (!isSafeRoot(dataDir)) throw new Error('destroyVault: refusing unsafe dataDir (fail-closed)');

  const wiped = [];
  const failed = [];
  const result = { wiped, failed, keychainDeleted: false, relayRevoked: false, ollama: { removed: [], failed: [] } };

  // 0. Quiesce writers first so nothing races the delete (best-effort, never throws).
  if (quiesce) { try { await quiesce(); } catch (e) { failed.push({ target: 'quiesce', error: String(e?.message || e) }); } }

  // 1. Revoke the relay handle + DID server-side (best-effort, non-blocking — a
  //    network failure must not block the local wipe). Done before local teardown
  //    so the box is still reachable to make the call.
  if (revokeRelay) {
    try { await revokeRelay(); result.relayRevoked = true; }
    catch (e) { failed.push({ target: 'relay-revoke', error: String(e?.message || e) }); }
  }

  // 2. Remove Mycelium-pulled models from a shared Ollama daemon (best-effort).
  //    App-private models under <dataDir>/ollama are removed by the recursive wipe.
  if (deleteOllamaModels && pulledOllamaTags.length) {
    try { result.ollama = await deleteOllamaModels(pulledOllamaTags); }
    catch (e) { failed.push({ target: 'ollama-shared', error: String(e?.message || e) }); }
  }

  // 3. RECURSIVE WIPE of the whole app-private dir — every DECRYPTABLE artifact
  //    (db + triads, search sidecar, uploads, mind, app-private ollama, remote
  //    configs, AND full-vault snapshots/*.corrupt-*/*.bak-* that accumulate).
  //    Delete the CONTENTS (keep dataDir itself so relaunch can reuse it).
  let entries = [];
  try { entries = await fs.readdir(dataDir); }
  catch (e) { if (e?.code !== 'ENOENT') failed.push({ target: dataDir, error: String(e?.code || e) }); }
  for (const name of entries) await rmPath(fs, join(dataDir, name), wiped, failed);

  // 3b. Roots OUTSIDE dataDir (the mind-file agentRoot etc.), each fail-closed.
  for (const root of extraRoots) {
    if (!isSafeRoot(root)) { failed.push({ target: String(root), error: 'unsafe-extra-root-skipped' }); continue; }
    await rmPath(fs, root, wiped, failed);
  }

  // 4. KEYCHAIN — the point of no return, strictly LAST (after ALL fs deletion).
  //    Until this runs, keys may outlive data (safe); data never outlives keys.
  //    After it, even a leftover copy is undecryptable without the user's own key.
  if (deleteKeychain) {
    try { deleteKeychain(); result.keychainDeleted = true; log('[destroy] keychain deleted'); }
    catch (e) { failed.push({ target: 'keychain', error: String(e?.message || e) }); }
  }

  return result;
}
