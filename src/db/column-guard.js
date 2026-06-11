// src/db/column-guard.js — defense-in-depth against identifier injection in the
// db namespaces that build INSERT/UPDATE column lists from an object's keys
// (DB-COL, 2026-06-11). Today every caller passes fixed-key objects, but a future
// `insert(req.body)` would interpolate attacker-controlled keys as SQL
// identifiers — and, because the encryption adapter re-parses the column list to
// decide what to encrypt, a crafted key could also subvert that. Validate that
// every key is a plain SQL identifier before it reaches the query string.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Assert every key is a safe column identifier; throw on anything else.
 * @param {string[]} keys
 * @param {string} table  for the error message
 * @returns {string[]} keys (for chaining)
 */
export function assertSafeColumns(keys, table) {
  for (const k of keys) {
    if (typeof k !== 'string' || !IDENT.test(k)) {
      throw new Error(`unsafe column identifier ${JSON.stringify(k)} for table '${table}' — refusing to build SQL`);
    }
  }
  return keys;
}
