/**
 * Google services passthrough — two tools (drive, calendar) that forward
 * their args to the corresponding service plugin via
 * `dispatchServiceCall`. The actual logic lives in
 * `@mycelium/core/services/{drive,calendar}-plugin.js`, which is loaded
 * for side-effects at module scope by agent-tools.js.
 *
 * The `gmail` tool was retired in the 2026-05-08 MCP refactor (zero MCP
 * calls in 7d for personal-agent). The gmail-plugin.js module is still
 * loaded and reachable via `@mycelium/core/services/service-plugin`'s
 * `getPlugin('gmail')` for any non-MCP fallback paths (e.g.,
 * agent-server.js:1734).
 *
 * @typedef {object} ServicesDeps
 * @property {(name: string, args: object) => Promise<any>} dispatchServiceCall
 */

export function createServicesDomain(deps) {
  if (!deps) throw new TypeError('createServicesDomain: deps required');
  const { dispatchServiceCall } = deps;
  if (typeof dispatchServiceCall !== 'function') {
    throw new TypeError('createServicesDomain: dispatchServiceCall required');
  }

  const tools = [
    {
      name: 'drive',
      description: 'Access Google Drive files. Actions: list (files in folder), read (file content — exports Google Docs as text), upload (upload file), mkdir (create folder), share (share with someone), search (search across Drive).',
      inputSchema: {
        type: 'object',
        properties: {
          action:     { type: 'string', enum: ['list', 'read', 'upload', 'mkdir', 'share', 'search'] },
          fileId:     { type: 'string', description: 'File ID (for read, share actions)' },
          folderId:   { type: 'string', description: 'Folder ID (for list, upload). Default: root' },
          query:      { type: 'string', description: 'Search query (for search, list filter)' },
          maxResults: { type: 'number', description: 'Max results (default 20)' },
          filename:   { type: 'string', description: 'Filename (for upload)' },
          content:    { type: 'string', description: 'File content as text or base64 (for upload)' },
          mimeType:   { type: 'string', description: 'MIME type (for upload)' },
          name:       { type: 'string', description: 'Folder name (for mkdir)' },
          parentId:   { type: 'string', description: 'Parent folder ID (for mkdir). Default: root' },
          email:      { type: 'string', description: 'Email to share with (for share)' },
          role:       { type: 'string', enum: ['reader', 'writer', 'commenter'], description: 'Share role (default: reader)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'calendar',
      description: 'Manage Google Calendar events. Actions: list (upcoming events), get (event details), create (new event), update (modify event), delete (remove event), search (find events by keyword), calendars (list available calendars).',
      inputSchema: {
        type: 'object',
        properties: {
          action:      { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'search', 'calendars'] },
          calendarId:  { type: 'string', description: 'Calendar ID (default: "primary")' },
          eventId:     { type: 'string', description: 'Event ID (for get, update, delete)' },
          query:       { type: 'string', description: 'Search query (for search action)' },
          summary:     { type: 'string', description: 'Event title (for create, update)' },
          description: { type: 'string', description: 'Event description' },
          location:    { type: 'string', description: 'Event location' },
          startTime:   { type: 'string', description: 'Start time ISO 8601 (e.g. 2026-04-05T10:00:00+03:00)' },
          endTime:     { type: 'string', description: 'End time ISO 8601' },
          allDay:      { type: 'boolean', description: 'All-day event (use date not dateTime)' },
          timeMin:     { type: 'string', description: 'Filter: events after this time' },
          timeMax:     { type: 'string', description: 'Filter: events before this time' },
          maxResults:  { type: 'number', description: 'Max results (default 10)' },
          attendees:   { type: 'string', description: 'Comma-separated emails to invite' },
        },
        required: ['action'],
      },
    },
  ];

  async function dispatch(name, args) {
    return JSON.stringify(await dispatchServiceCall(name, args));
  }

  const handlers = {
    drive:    (args) => dispatch('drive', args),
    calendar: (args) => dispatch('calendar', args),
  };

  return { tools, handlers };
}
