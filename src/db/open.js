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
import { existsSync } from 'node:fs';
import { deriveDbKey } from '../account/keystore.js';
import { isPlaintextSqlite } from '../account/db-cipher-migrate.js';

/** True iff at-rest whole-file encryption is opted in for this process. */
export function atRestEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.MYCELIUM_AT_REST || '').toLowerCase());
}

/** True iff the vault FILE at dbPath is already whole-file encrypted (no plaintext
 *  SQLite magic header). Self-detection so any launcher opens it keyed. */
export function vaultIsEncrypted(dbPath) {
  return !!dbPath && existsSync(dbPath) && !isPlaintextSqlite(dbPath);
}

/**
 * The DB-file key (64-hex) when the vault must open keyed, else null (plaintext).
 * Keyed when EITHER:
 *   - the vault file is ALREADY encrypted (self-detected) — so EVERY launcher (the
 *     GUI app, the Claude-Code MCP servers, the pipeline, any CLI) opens it keyed
 *     WITHOUT needing the MYCELIUM_AT_REST env flag (a Finder launch never carries
 *     env). This is what makes encryption persistent + survivable across launchers; or
 *   - at-rest is opted in via MYCELIUM_AT_REST (to MIGRATE a still-plaintext vault).
 *
 * Returns null for a plaintext vault with at-rest off → plaintext open, unchanged
 * (verify gates open plaintext fixtures → plaintext header → not detected → null).
 *
 * @param {string} userHex  USER_MASTER (64-char hex)
 * @param {string|null} [dbPath]  vault path, for encrypted-file self-detection
 */
export function resolveDbKeyHex(userHex, dbPath = null) {
  if (!vaultIsEncrypted(dbPath) && !atRestEnabled()) return null;
  if (!/^[0-9a-f]{64}$/i.test(userHex || '')) {
    throw new Error('at-rest: a 64-char USER_MASTER hex is required to derive the DB-file key');
  }
  return deriveDbKey(userHex);
}
