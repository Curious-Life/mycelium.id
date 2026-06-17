// At-rest blindness (A′) opt-in resolver — the SINGLE source of truth for
// whether the vault opens as whole-file SQLCipher and with which DB-file key.
//
// Default OFF: returns null → the adapter opens the vault as PLAINTEXT, byte-for-
// byte unchanged. This is what keeps the ~104 raw-read verify gates (which open
// plaintext temp fixtures with a bare `new Database`) green — encrypting by boot
// default would break them (design D5: "OPT-IN PER ENTRY POINT, never boot-default").
//
// Enabled ONLY when MYCELIUM_AT_REST is truthy — the operator's step-5 switch.
// When on, the DB-file key is HKDF-derived from USER_MASTER (keystore.deriveDbKey),
// held in process memory only, never logged/stored. @see db-cipher-migrate.js,
// docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md.
import { deriveDbKey } from '../account/keystore.js';

/** True iff at-rest whole-file encryption is opted in for this process. */
export function atRestEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.MYCELIUM_AT_REST || '').toLowerCase());
}

/**
 * The DB-file key (64-hex) when at-rest is enabled, else null (plaintext open).
 * @param {string} userHex  USER_MASTER (64-char hex)
 */
export function resolveDbKeyHex(userHex) {
  if (!atRestEnabled()) return null;
  if (!/^[0-9a-f]{64}$/i.test(userHex || '')) {
    throw new Error('at-rest: a 64-char USER_MASTER hex is required to derive the DB-file key');
  }
  return deriveDbKey(userHex);
}
