/**
 * Tasks namespace — user-level task list (user-visible todos).
 *
 * Distinct from the `agent_tasks` namespace which tracks inter-agent
 * delegation. This table is the user-facing task tracker.
 *
 * @typedef {object} TasksNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

export function createTasksNamespace(deps) {
  if (!deps) throw new TypeError('createTasksNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createTasksNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createTasksNamespace: firstRow required');

  return {
    async create(task) {
      const cols = Object.keys(task).join(', ');
      const placeholders = Object.keys(task).map(() => '?').join(', ');
      const result = await d1Query(
        `INSERT INTO tasks (${cols}) VALUES (${placeholders}) RETURNING *`,
        Object.values(task),
      );
      return firstRow(result);
    },

    /**
     * List a user's tasks, newest first. Optional status filter
     * ('pending'/'completed'/...); omit for all. Capped at 200.
     */
    async list(userId, { status, limit = 50 } = {}) {
      let sql = 'SELECT * FROM tasks WHERE user_id = ?';
      const params = [userId];
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(Math.min(Math.max(limit, 1), 200));
      const result = await d1Query(sql, params);
      return result?.results || [];
    },
  };
}
