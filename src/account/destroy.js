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

import { promises as nodeFs, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
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

/**
 * A path this engine is willing to `rm -rf`. Absolute, not the filesystem root,
 * not the user's home, and at least two segments deep — so a mis-set relocation
 * override (MYCELIUM_UPLOADS_ROOT=/Users/me) can never turn a factory reset into
 * a home-directory wipe. A refused root is RECORDED in failed[], never silent.
 *
 * CASE-INSENSITIVE / FIRMLINK DEFENSE (review round-3, CRITICAL). String equality
 * against $HOME is NOT enough: on macOS's default case-INSENSITIVE APFS, and
 * through system firmlinks, a spelling that is string-distinct from $HOME still
 * resolves to the SAME inode —
 *   /users/alice                       (lowercased)  → same file as /Users/alice
 *   /System/Volumes/Data/Users/alice   (firmlink)    → same file as /Users/alice
 * — and would slip a plain `===` guard, letting a mis-set MYCELIUM_UPLOADS_ROOT
 * blast the whole home directory. So the guard compares the CANONICAL identity
 * (device+inode via statSync) of the candidate against every forbidden root, which
 * also collapses symlinks. FAIL CLOSED on any stat error that is NOT "absent": a
 * path we cannot resolve (EACCES/ELOOP/…) is refused; only a genuinely
 * non-existent leaf (ENOENT — e.g. an already-checkpointed `-wal` sidecar in a
 * relocated file family) stays wipeable, because rm of a missing path is a no-op
 * and a missing path cannot alias an (always-present) forbidden root.
 */
export function isSafeDestroyRoot(p, { home = os.homedir() } = {}) {
  if (typeof p !== 'string' || p.length <= 1 || !p.startsWith('/')) return false;
  // Normalise a trailing separator FIRST, so '/' , '//', '/Users/' and '$HOME/'
  // cannot slip past the equality checks below on a cosmetic difference.
  const q = p.replace(/\/+$/, '');
  if (!q || q === '/') return false;
  // '/x' → ['x'] (1 segment). Require ≥2 real segments: '/Users' and '/tmp'
  // are refused; '/tmp/mycelium' and '/Users/me/vault' are allowed.
  const segs = q.split('/').filter(Boolean);
  if (segs.length < 2) return false;

  // The roots this engine must NEVER recurse into. Normalise trailing separators
  // so a cosmetic difference can't slip the literal check below.
  const forbidden = ['/', '/Users', home]
    .filter((f) => typeof f === 'string' && f)
    .map((f) => f.replace(/\/+$/, '') || '/');

  // Layer 1 — literal string match. Fast, and the ONLY signal for a forbidden
  // root that does not exist on this filesystem (e.g. '/Users' on Linux CI, where
  // the inode probe below finds nothing to compare against).
  if (forbidden.includes(q)) return false;

  // Layer 2 — CANONICAL (device+inode) identity, defeating case-insensitive
  // spellings and firmlinks/symlinks that a string compare misses.
  let cSt;
  try { cSt = statSync(q); }
  catch (e) { return e?.code === 'ENOENT'; } // absent → wipeable no-op; any other error → fail closed
  for (const f of forbidden) {
    let fSt;
    try { fSt = statSync(f); } catch { continue; } // forbidden root absent here → cannot be aliased
    if (fSt.dev === cSt.dev && fSt.ino === cSt.ino) return false;
  }
  return true;
}

/**
 * Coerce whatever a revokeRelay hook returned into the honest outcome shape.
 * FAIL CLOSED: anything that is not an explicit `released === true` is reported
 * as not-released, so a legacy hook that returns nothing can never be mistaken
 * for a success. `applicable:false` means "there was no managed handle" — the
 * caller must render that as "nothing to release", never as "released".
 */
export function normalizeReleaseOutcome(r) {
  if (!r || typeof r !== 'object') {
    return { attempted: true, applicable: true, released: false, reason: 'no-outcome-reported' };
  }
  const applicable = r.applicable !== false;
  const released = r.released === true;
  return {
    attempted: true,
    applicable,
    released,
    reason: released ? undefined : String(r.reason || 'unknown').slice(0, 80),
    ...(Number.isFinite(r.attempts) ? { attempts: r.attempts } : {}),
  };
}

/** Coerce a revokeConnectors return into {attempted, revoked[], failed[]}; fail closed. */
export function normalizeConnectorOutcome(r) {
  const revoked = Array.isArray(r?.revoked) ? r.revoked.map(String) : [];
  const failedRaw = Array.isArray(r?.failed) ? r.failed : [];
  const failedList = failedRaw.map((f) => ({
    id: String(f?.id ?? '?'),
    reason: String(f?.reason ?? 'unknown').slice(0, 80),
  }));
  const attempted = Number.isFinite(r?.attempted) ? Number(r.attempted) : revoked.length + failedList.length;
  return { attempted, revoked, failed: failedList };
}

/**
 * A relocated artifact that is KEY MATERIAL rather than content: the key-check
 * value (kcv.json) and the passphrase-lock seal (vault-lock.json). Matched on the
 * basename, which paths.js fixes for both.
 */
const KEY_MATERIAL_BASENAMES = new Set(['kcv.json', 'vault-lock.json']);
function isKeyMaterialPath(p) {
  if (typeof p !== 'string') return false;
  return KEY_MATERIAL_BASENAMES.has(p.slice(p.lastIndexOf('/') + 1));
}

/**
 * Stable partition of the extra roots into [content…, keyMaterial…] so the
 * content-first/keys-last invariant holds INSIDE the extraRoots pass too. Stable
 * (not a comparator sort) so the relative order of everything else is untouched.
 */
export function orderKeyMaterialLast(roots) {
  const list = Array.isArray(roots) ? roots : [];
  const content = [];
  const keys = [];
  for (const r of list) (isKeyMaterialPath(r) ? keys : content).push(r);
  return [...content, ...keys];
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
 * @param {string[]} [opts.extraRoots] absolute paths OUTSIDE dataDir to also wipe — the mind trees
 *        AND every artifact an env override relocated out of dataDir (paths.js destroyExtraRoots:
 *        MYCELIUM_DB + its wal/shm/search sidecars, MYCELIUM_AUTH_DB (passkeys), MYCELIUM_KCV,
 *        MYCELIUM_UPLOADS_ROOT, MYCELIUM_VAULT_LOCK, MYCELIUM_REMOTE_CONFIG, voice samples).
 *        Each must satisfy isSafeDestroyRoot (absolute, ≥2 segments, not '/' and not $HOME);
 *        anything else is REFUSED and recorded in failed[], never silently skipped.
 * @param {object} [opts.fs]           node:fs/promises (injected for tests)
 * @param {() => Promise<void>} [opts.quiesce]        stop daemons/jobs (best-effort)
 * @param {() => Promise<{applicable?:boolean, released?:boolean, reason?:string}>} [opts.revokeRelay]
 *        server-side handle/DID release (best-effort). Its RETURN VALUE is the
 *        outcome — "did not throw" is NOT success (QA P0.7).
 * @param {() => Promise<{attempted:number, revoked:string[], failed:Array<{id:string,reason:string}>}>} [opts.revokeConnectors]
 *        best-effort upstream OAuth revoke for every connected connector (QA P0.9)
 * @param {(tags:string[]) => Promise<{removed:string[],failed:string[]}>} [opts.deleteOllamaModels]
 *        remove Mycelium-pulled tags from a shared daemon (best-effort)
 * @param {string[]} [opts.pulledOllamaTags]          tags from the pulled-model manifest
 * @param {() => void} [opts.deleteKeychain]          keystore.deleteKeychain — runs LAST
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{wiped:string[], failed:Array<{target:string,error:string}>, keychainDeleted:boolean, relayRevoked:boolean, relayRelease:object, connectors:object, ollama:{removed:string[],failed:string[]}}>}
 */
export async function destroyVault(opts = {}) {
  const {
    dataDir, extraRoots = [], fs = nodeFs, quiesce, revokeRelay, revokeConnectors, deleteOllamaModels,
    pulledOllamaTags = [], deleteKeychain, log = () => {},
  } = opts;
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('destroyVault: dataDir required (fail-closed)');
  // Never recurse from a root that would blast the filesystem (or the user's home).
  const isSafeRoot = (p) => isSafeDestroyRoot(p);
  if (!isSafeRoot(dataDir)) throw new Error('destroyVault: refusing unsafe dataDir (fail-closed)');

  const wiped = [];
  const failed = [];
  const result = {
    wiped, failed, keychainDeleted: false,
    // relayRevoked stays for back-compat, but is now DERIVED from the real
    // outcome below — it is true ONLY when the control plane actually released.
    relayRevoked: false,
    relayRelease: { attempted: false, applicable: false, released: false, reason: 'not-attempted' },
    connectors: { attempted: 0, revoked: [], failed: [] },
    ollama: { removed: [], failed: [] },
  };

  // 0. Quiesce writers first so nothing races the delete (best-effort, never throws).
  if (quiesce) { try { await quiesce(); } catch (e) { failed.push({ target: 'quiesce', error: String(e?.message || e) }); } }

  // 1. Release the relay handle + DID server-side (best-effort, non-blocking — a
  //    network failure must not block the local wipe). Done before local teardown
  //    so the box is still reachable AND the master key still exists to sign the
  //    claim.
  //
  //    HONESTY (QA P0.7): releaseManagedHandle NEVER THROWS by contract, so the
  //    old `try { await revokeRelay(); relayRevoked = true }` reported success on
  //    every failure — the user was told their handle was freed while it was
  //    still squatted. The hook's RETURN VALUE is now the outcome, and an
  //    undefined/garbage return fails CLOSED (unknown ≠ succeeded).
  if (revokeRelay) {
    try {
      const r = await revokeRelay();
      result.relayRelease = normalizeReleaseOutcome(r);
    } catch (e) {
      result.relayRelease = { attempted: true, applicable: true, released: false, reason: String(e?.message || e).slice(0, 80) };
      failed.push({ target: 'relay-revoke', error: String(e?.message || e) });
    }
    result.relayRevoked = result.relayRelease.released === true;
  }

  // 1b. Revoke each connected connector's OAuth grant UPSTREAM (QA P0.9). Must
  //     happen while the vault (which holds the tokens) is still readable, i.e.
  //     BEFORE the wipe. Best-effort + never blocks: a throw is recorded, and the
  //     per-connector outcome is reported truthfully — an unreachable provider
  //     still holds a live grant and the user has to be told so.
  if (revokeConnectors) {
    try {
      result.connectors = normalizeConnectorOutcome(await revokeConnectors());
    } catch (e) {
      result.connectors = { attempted: 0, revoked: [], failed: [{ id: '*', reason: String(e?.message || e).slice(0, 80) }] };
      failed.push({ target: 'connector-revoke', error: String(e?.message || e) });
    }
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

  // 3b. Roots OUTSIDE dataDir (the mind trees + every relocated artifact), each
  //     fail-closed. CONTENT-FIRST, KEYS-LAST applies WITHIN this list too: the
  //     key-check value and the passphrase seal are ordered after the content
  //     roots, so a crash mid-loop can leave "key material present, content gone"
  //     (safe) but never the inverse. The Keychain itself still runs after all of
  //     this (step 4) — this only tightens the ordering of the fs roots.
  for (const root of orderKeyMaterialLast(extraRoots)) {
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
