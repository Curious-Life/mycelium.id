/**
 * Tasks domain — single tool.
 *
 *   - createTask: capture a task from conversation. Maps the friendly
 *     tool-input names (content/deadline/priority 1-5) onto the D1
 *     schema (title/description/due_date/priority-text/metadata). The
 *     priority mapping is: 1-2 → high, 3-4 → normal, 5 → low.
 *
 * Folder + canvas listing tools were retired in the 2026-05-08 MCP
 * refactor (zero MCP calls in 7d for personal-agent; portal-ws.js calls
 * db.folders.list / db.canvases.list directly).
 *
 * @typedef {object} TasksDeps
 * @property {object} db — needs tasks.create + tasks.list
 * @property {string} userId
 */

export function createTasksDomain(deps) {
  if (!deps) throw new TypeError('createTasksDomain: deps required');
  const { db, userId } = deps;
  if (!db) throw new TypeError('createTasksDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createTasksDomain: userId required');

  const tools = [
    {
      name: 'createTask',
      description: 'Create a task captured from conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          content:     { type: 'string', description: 'What needs to be done' },
          deadline:    { type: 'string', description: 'Optional deadline (ISO date)' },
          priority:    { type: 'number', description: 'Priority 1-5 (default 3)' },
          projectPath: { type: 'string', description: 'Related project document path' },
        },
        required: ['content'],
      },
    },
    {
      name: 'listTasks',
      description: 'List captured tasks, newest first. By default shows pending tasks; pass status to filter (e.g. "completed") or "all" to include every status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status: "pending" (default), "completed", or "all".' },
          limit:  { type: 'number', description: 'Max tasks to return (default 50, max 200).' },
        },
      },
    },
  ];

  const handlers = {
    createTask: async (args) => {
      // The `tasks` table schema is: id, user_id, title, description,
      // status, priority (text), due_date, metadata (JSON), created_at,
      // completed_at. Tool input uses friendlier names — map them to
      // the columns.
      const content = (args.content || '').trim();
      if (!content) return 'Error: content is required';
      const title = content.length > 200 ? content.slice(0, 197) + '...' : content;
      const description = content.length > 200 ? content : null;
      const priorityNum = Number(args.priority) || 3;
      const priorityText = priorityNum <= 2 ? 'high' : priorityNum >= 5 ? 'low' : 'normal';
      const metadata = args.projectPath ? JSON.stringify({ project_path: args.projectPath }) : null;

      await db.tasks.create({
        user_id: userId,
        title,
        description,
        due_date: args.deadline || null,
        priority: priorityText,
        metadata,
        status: 'pending',
      });
      return `Task created: "${title}"${args.deadline ? ` (deadline: ${args.deadline})` : ''} priority=${priorityText}`;
    },

    listTasks: async (args = {}) => {
      const status = (!args.status || args.status === 'all') ? undefined : args.status;
      const rows = await db.tasks.list(userId, { status, limit: args.limit });
      if (!rows.length) {
        return status ? `No ${status} tasks.` : 'No tasks yet.';
      }
      const label = status ? `${status} tasks` : 'tasks';
      const lines = rows.map((t) => {
        const pri = t.priority && t.priority !== 'normal' ? ` [${t.priority}]` : '';
        const due = t.due_date ? ` (due ${t.due_date})` : '';
        const mark = t.status === 'completed' ? '✓' : '○';
        return `${mark} ${t.title}${pri}${due}`;
      });
      return `## ${rows.length} ${label}\n\n${lines.join('\n')}`;
    },
  };

  return { tools, handlers };
}
