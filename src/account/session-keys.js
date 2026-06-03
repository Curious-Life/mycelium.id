// src/account/session-keys.js — the two master-key hexes for THIS process, held
// in memory after the vault opens (completeBoot calls setSessionKeys).
//
// Why this exists: in passphrase-lock mode the keys are NOT in the macOS Keychain
// at rest, so a consumer that re-resolves keys independently — the clustering
// child spawn in src/jobs.js, which calls resolveKeys() to populate the child's
// env — would fail. It reads the in-memory keys from here instead, falling back
// to resolveKeys() in normal (Keychain) mode. We hold BOTH keys (not just the
// user key) because legacy vaults have an INDEPENDENT system key that can't be
// derived from the user key.
//
// Memory-only. Never logged, never written to disk, cleared on lock.
let _keys = null;

/** Pin the session keys (called once the vault is open). */
export function setSessionKeys(k) {
  if (k && typeof k.userHex === 'string' && typeof k.systemHex === 'string') {
    _keys = { userHex: k.userHex, systemHex: k.systemHex };
  }
}

/** The in-memory keys, or null if the vault hasn't been opened this process. */
export function getSessionKeys() { return _keys; }

/** Forget the keys (e.g. on an in-process re-lock). */
export function clearSessionKeys() { _keys = null; }
