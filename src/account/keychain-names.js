// src/account/keychain-names.js — the macOS Keychain item names for the vault's
// two master keys, defined in ONE place. Both the reader
// (src/crypto/key-source.js) and the writer (src/account/keystore.js) resolve
// names through here so they can never drift. All three are env-overridable so
// tests can pin ephemeral services without touching the real keys.
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function keychainNames({ env = process.env } = {}) {
  return {
    account: clean(env.MYCELIUM_KC_ACCOUNT) || 'mycelium',
    userService: clean(env.MYCELIUM_KC_USER) || 'mycelium-user-master',
    systemService: clean(env.MYCELIUM_KC_SYSTEM) || 'mycelium-system-key',
  };
}

/**
 * Is this the REAL (default) Keychain namespace — i.e. the one that protects a
 * user's actual vault? True only when NONE of the three overrides is set. Tests
 * and dev ceremonies MUST set the overrides (MYCELIUM_KC_ACCOUNT/USER/SYSTEM) to
 * an ephemeral namespace; the keystore refuses a destructive overwrite of the
 * default namespace without an explicit force, so a stray test run that forgets
 * the overrides is blocked rather than silently clobbering the production key.
 */
export function isDefaultNamespace({ env = process.env } = {}) {
  return !clean(env.MYCELIUM_KC_ACCOUNT)
    && !clean(env.MYCELIUM_KC_USER)
    && !clean(env.MYCELIUM_KC_SYSTEM);
}

export default keychainNames;
