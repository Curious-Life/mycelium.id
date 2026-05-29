/**
 * Agent tasks namespace — inter-agent delegation state machine.
 *
 * pending → in_progress → completed/failed → reported.
 * Distinct from `tasks` (user-facing todos).
 *
 * @typedef {object} AgentTasksNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for lifecycle timestamps
 */

export function createAgentTasksNamespace(deps) {
  if (!deps) throw new TypeError('createAgentTasksNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createAgentTasksNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createAgentTasksNamespace: firstRow required');

  return {
    async create(task) {
      const cols = Object.keys(task).join(', ');
      const placeholders = Object.keys(task).map(() => '?').join(', ');
      const result = await d1Query(
        `INSERT INTO agent_tasks (${cols}) VALUES (${placeholders}) RETURNING id`,
        Object.values(task),
      );
      return firstRow(result);
    },

    async getPending(agentId, limit = 10) {
      const result = await d1Query(
        `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT ?`,
        [agentId, limit],
      );
      return result.results || [];
    },

    async getInProgress(agentId) {
      const result = await d1Query(
        `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'in_progress'`,
        [agentId],
      );
      return result.results || [];
    },

    async start(taskId) {
      await d1Query(
        `UPDATE agent_tasks SET status = 'in_progress', started_at = ? WHERE id = ?`,
        [now().toISOString(), taskId],
      );
    },

    async complete(taskId, result, summary) {
      await d1Query(
        `UPDATE agent_tasks SET status = 'completed', completed_at = ?, result = ?, summary = ? WHERE id = ?`,
        [now().toISOString(), result, summary, taskId],
      );
    },

    async fail(taskId, errorMessage) {
      await d1Query(
        `UPDATE agent_tasks SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
        [now().toISOString(), errorMessage, taskId],
      );
    },

    async getToReport(agentId) {
      const result = await d1Query(
        `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'completed' AND reported_at IS NULL`,
        [agentId],
      );
      return result.results || [];
    },

    async markReported(taskId) {
      await d1Query(
        `UPDATE agent_tasks SET reported_at = ? WHERE id = ?`,
        [now().toISOString(), taskId],
      );
    },
  };
}
