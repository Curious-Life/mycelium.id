/**
 * AI provider assignments namespace — desired-state mapping of agents to
 * Claude subscriptions, plus the audit table that records every change.
 *
 * SECURITY: assignments + audit rows hold no encrypted data — agent_id and
 * provider_id are integers/IDs, reason and last_error are operator-supplied
 * non-secret text. Auto-encrypt-by-table in db-d1.js does NOT touch these
 * tables (they're not in the encrypted-table list).
 *
 * Atomicity: routes that write an assignment + an audit row in one logical
 * transaction MUST go through the `*WithAudit` helpers below; those use
 * d1Batch so the assignment + audit insert land atomically. A naked
 * d1Query write of just the assignment is never offered as a public method
 * because forgetting to write the audit row breaks our incident-response
 * contract.
 *
 * @typedef {object} AssignmentsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(stmts: Array<{sql:string, params?:any[]}>) => Promise<any>} d1Batch
 */

export function createAssignmentsNamespace(deps) {
  if (!deps) throw new TypeError('createAssignmentsNamespace: deps required');
  const { d1Query, d1Batch } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createAssignmentsNamespace: d1Query required');
  if (typeof d1Batch !== 'function') throw new TypeError('createAssignmentsNamespace: d1Batch required');

  return {
    /**
     * Read every assignment row for one user. Reconciler reads this every
     * cycle. Sorted by (agent_id ASC) for deterministic output.
     */
    async list(userId) {
      const result = await d1Query(
        `SELECT id, user_id, agent_id, provider_id, desired_state,
                applied_at, last_error, created_at, updated_at
         FROM ai_provider_assignments
         WHERE user_id = ?
         ORDER BY agent_id ASC`,
        [userId],
      );
      return result.results || [];
    },

    /**
     * Read just the audit log for incident-response queries. Newest first.
     */
    async audit(userId, limit = 50) {
      const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
      const result = await d1Query(
        `SELECT id, user_id, actor_user_id, action, agent_id,
                from_provider_id, to_provider_id, reason, ts
         FROM ai_provider_assignments_audit
         WHERE user_id = ?
         ORDER BY ts DESC
         LIMIT ${lim}`,
        [userId],
      );
      return result.results || [];
    },

    /**
     * UPSERT assignment + write audit row in one atomic batch.
     *
     * Action is computed by the caller (route): 'create' if no prior row,
     * 'update' if the agent_id already had a different provider, 'delete'
     * is handled by removeWithAudit below.
     *
     * @param {object} args
     * @param {string} args.userId
     * @param {string} args.agentId
     * @param {number} args.providerId
     * @param {string} args.actorUserId
     * @param {'create'|'update'} args.action
     * @param {number|null} args.fromProviderId
     * @param {string} [args.reason]
     */
    async upsertWithAudit({ userId, agentId, providerId, actorUserId, action, fromProviderId, reason }) {
      // SQLite UPSERT: ON CONFLICT clause keys to the unique (user_id, agent_id) index.
      // Resets desired_state='pending' so the reconciler picks the row up on its
      // next cycle and re-validates. Clears last_error so old failure messages
      // don't linger after a corrective change.
      await d1Batch([
        {
          sql: `INSERT INTO ai_provider_assignments
                  (user_id, agent_id, provider_id, desired_state)
                VALUES (?, ?, ?, 'pending')
                ON CONFLICT(user_id, agent_id) DO UPDATE SET
                  provider_id    = excluded.provider_id,
                  desired_state  = 'pending',
                  applied_at     = NULL,
                  last_error     = NULL,
                  updated_at     = datetime('now')`,
          params: [userId, agentId, providerId],
        },
        {
          sql: `INSERT INTO ai_provider_assignments_audit
                  (user_id, actor_user_id, action, agent_id, from_provider_id, to_provider_id, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [userId, actorUserId, action, agentId, fromProviderId ?? null, providerId, reason ?? null],
        },
      ]);
    },

    /**
     * Delete assignment + audit row in one atomic batch.
     */
    async removeWithAudit({ userId, agentId, actorUserId, fromProviderId, reason }) {
      await d1Batch([
        {
          sql: `DELETE FROM ai_provider_assignments WHERE user_id = ? AND agent_id = ?`,
          params: [userId, agentId],
        },
        {
          sql: `INSERT INTO ai_provider_assignments_audit
                  (user_id, actor_user_id, action, agent_id, from_provider_id, to_provider_id, reason)
                VALUES (?, ?, 'delete', ?, ?, NULL, ?)`,
          params: [userId, actorUserId, agentId, fromProviderId ?? null, reason ?? null],
        },
      ]);
    },

    /**
     * Reconciler-side: mark an assignment as successfully applied. Clears
     * last_error so a previously-failed row that recovers shows clean.
     */
    async markApplied(id) {
      await d1Query(
        `UPDATE ai_provider_assignments
         SET desired_state = 'applied',
             applied_at    = datetime('now'),
             last_error    = NULL,
             updated_at    = datetime('now')
         WHERE id = ?`,
        [id],
      );
    },

    /**
     * Reconciler-side: mark an assignment as failed with an error reason.
     */
    async markFailed(id, error) {
      const msg = typeof error === 'string' ? error : String(error?.message || error || 'unknown');
      await d1Query(
        `UPDATE ai_provider_assignments
         SET desired_state = 'failed',
             last_error    = ?,
             updated_at    = datetime('now')
         WHERE id = ?`,
        [msg.slice(0, 500), id],
      );
    },
  };
}

/**
 * Cascade-state namespace — singleton row keyed 'claude-reconciler' that
 * tracks whether a reconcile cycle is in flight, for crash recovery.
 *
 * @param {AssignmentsNamespaceDeps} deps
 */
export function createCascadeStateNamespace(deps) {
  if (!deps) throw new TypeError('createCascadeStateNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createCascadeStateNamespace: d1Query required');

  const KEY = 'claude-reconciler';

  return {
    /** Read the current state row, or null if it doesn't exist yet. */
    async get() {
      const result = await d1Query(
        `SELECT key, status, attempt, started_at, updated_at
         FROM cascade_state WHERE key = ?`,
        [KEY],
      );
      return result.results?.[0] || null;
    },

    /** Mark the reconciler as in-flight. */
    async beginApplying() {
      await d1Query(
        `INSERT INTO cascade_state (key, status, attempt, started_at)
         VALUES (?, 'applying', 1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           status     = 'applying',
           attempt    = attempt + 1,
           started_at = datetime('now'),
           updated_at = datetime('now')`,
        [KEY],
      );
    },

    /** Mark the reconciler as idle (cycle finished). */
    async endIdle() {
      await d1Query(
        `INSERT INTO cascade_state (key, status, started_at)
         VALUES (?, 'idle', NULL)
         ON CONFLICT(key) DO UPDATE SET
           status     = 'idle',
           started_at = NULL,
           updated_at = datetime('now')`,
        [KEY],
      );
    },
  };
}
