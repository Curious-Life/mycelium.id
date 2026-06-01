/**
 * Registration tokens namespace — one-time codes for first-login /
 * re-register flows.
 *
 * SECURITY: codes are stored SHA-256 hashed — never plaintext. Reads
 * hash the input before comparing (validate tries hashed first then
 * falls back to plaintext for legacy rows).
 *
 * @typedef {object} RegistrationTokensNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {(code: string) => string} hashTokenSync — SHA-256 hex, constant-time not required here
 */

export function createRegistrationTokensNamespace(deps) {
  if (!deps) throw new TypeError('createRegistrationTokensNamespace: deps required');
  const { d1Query, firstRow, hashTokenSync } = deps;
  if (typeof d1Query !== 'function')       throw new TypeError('createRegistrationTokensNamespace: d1Query required');
  if (typeof firstRow !== 'function')      throw new TypeError('createRegistrationTokensNamespace: firstRow required');
  if (typeof hashTokenSync !== 'function') throw new TypeError('createRegistrationTokensNamespace: hashTokenSync required');

  return {
    async create(code, userId) {
      const hashed = hashTokenSync(code);
      await d1Query(
        `INSERT INTO registration_tokens (code, created_by) VALUES (?, ?)`,
        [hashed, userId],
      );
    },

    async validate(code) {
      const hashed = hashTokenSync(code);
      // Hashed first (new storage format).
      let result = await d1Query(
        `SELECT created_by as user_id FROM registration_tokens WHERE code = ? AND used_by IS NULL`,
        [hashed],
      );
      // Fall back to plaintext for legacy rows.
      if (!firstRow(result)) {
        result = await d1Query(
          `SELECT created_by as user_id FROM registration_tokens WHERE code = ? AND used_by IS NULL`,
          [code],
        );
      }
      return firstRow(result);
    },

    async delete(code) {
      const hashed = hashTokenSync(code);
      await d1Query(`DELETE FROM registration_tokens WHERE code = ?`, [hashed]);
      // Legacy cleanup — removes plaintext rows if any persisted pre-hash.
      await d1Query(`DELETE FROM registration_tokens WHERE code = ?`, [code]);
    },
  };
}
