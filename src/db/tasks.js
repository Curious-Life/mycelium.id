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
  };
}
