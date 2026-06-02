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

export default keychainNames;
