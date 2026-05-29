/**
 * step_up_tokens namespace — fresh-auth tokens for high-risk operations.
 *
 * Per migration 144_step_up_tokens.sql + 147_step_up_session_chain.sql.
 * Service layer: packages/server/services/auth-step-up.js.
 *
 * SECURITY contract:
 *
 *   1. consume() is the ONE place that mutates consumed_at; the WHERE
 *      clause atomically selects rows where consumed_at IS NULL, so a
 *      double-consume is rejected at the SQL layer (returns 0 changed
 *      rows). The service treats `false` as a replay attempt.
 *
 *   2. findByToken() returns ALL columns including the session_token
 *      chain (H1.3) so a future audit guardian can verify chained=true
 *      across all live tokens.
 *
 *   3. insert() is straight-INSERT — there is no ON CONFLICT path. A PK
 *      collision (1-in-2^122 odds for randomUUID) hard-fails. We never
 *      paper over collisions for security-credentials tables.
 *
 *   4. No bulk delete. Token rotation is via TTL (expires_at) + the
 *      step-up-token-integrity probe (Phase 0b stub) verifying old
 *      consumed rows aren't lying around with consumed_at NULL.
 *
 * @typedef {object} StepUpTokensNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

export function createStepUpTokensNamespace(deps) {
  if (!deps) throw new TypeError('createStepUpTokensNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createStepUpTokensNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createStepUpTokensNamespace: firstRow required');

  return {
    /**
     * Insert a fresh step-up token. Throws on PK collision (UUID collision
     * is so rare it indicates a bug, not a race; surface loud).
     *
     * @param {object} row
     * @param {string} row.token
     * @param {string} row.user_id
     * @param {'up'|'uv'|'uv_urk'} row.tier
     * @param {string} row.op_type
     * @param {string|null} row.op_target
     * @param {string} row.challenge
     * @param {string} row.expires_at
     * @param {string|null} [row.session_token] — H1.3 audit chain
     */
    async insert(row) {
      await d1Query(
        `INSERT INTO step_up_tokens
           (token, user_id, tier, op_type, op_target, challenge, expires_at, session_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.token,
          row.user_id,
          row.tier,
          row.op_type,
          row.op_target ?? null,
          row.challenge,
          row.expires_at,
          row.session_token ?? null,
        ],
      );
    },

    /** Lookup by token. Returns full row including session_token, or null. */
    async findByToken(token) {
      const result = await d1Query(
        `SELECT token, user_id, tier, op_type, op_target, challenge,
                expires_at, consumed_at, session_token, created_at
         FROM step_up_tokens
         WHERE token = ?`,
        [token],
      );
      return firstRow(result) || null;
    },

    /**
     * Atomic single-shot consume. Returns true if THIS call performed the
     * consume; false if the row was already consumed (or absent).
     *
     * The WHERE consumed_at IS NULL clause is the security primitive here:
     * D1 returns changes=0 if the row was already consumed, which the
     * service translates into Unauthorized('step_up_token_consumed').
     */
    async consume({ token, consumed_at }) {
      const result = await d1Query(
        `UPDATE step_up_tokens
         SET consumed_at = ?
         WHERE token = ? AND consumed_at IS NULL`,
        [consumed_at, token],
      );
      return (result?.meta?.changes ?? 0) > 0;
    },
  };
}
