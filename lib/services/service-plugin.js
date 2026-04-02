/**
 * Service Plugin Contract & Registry
 *
 * Every external service (Gmail, Drive, WhatsApp, etc.) implements the
 * ServicePlugin shape. The MCP tool dispatcher uses this to route agent
 * tool calls to the correct service.
 *
 * @typedef {Object} ServicePlugin
 * @property {string} id              - Unique identifier ('gmail', 'drive', 'whatsapp')
 * @property {string} name            - Display name ('Gmail', 'Google Drive')
 * @property {string[]} actions       - Available actions (['send', 'search', 'read'])
 * @property {function} isConfigured  - () => boolean
 * @property {function} execute       - (action, params) => Promise<{ success: boolean, data?: any, error?: string }>
 * @property {Object} toolSchema      - MCP tool inputSchema (JSON Schema)
 */

const registry = {};

export function registerPlugin(plugin) {
  if (!plugin.id || !plugin.actions || !plugin.execute) {
    throw new Error(`Invalid plugin: missing id, actions, or execute`);
  }
  registry[plugin.id] = plugin;
}

export function getPlugin(id) {
  return registry[id] || null;
}

export function getAllPlugins() {
  return Object.values(registry);
}

export function getConfiguredPlugins() {
  return Object.values(registry).filter(p => p.isConfigured());
}

/**
 * Unified dispatcher for MCP tool calls.
 * Validates plugin existence, configuration, and action before executing.
 *
 * @param {string} pluginId - Plugin ID ('gmail', 'drive')
 * @param {Object} args - Tool call arguments (must include 'action')
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
export async function dispatchServiceCall(pluginId, args) {
  const plugin = registry[pluginId];

  if (!plugin) {
    return { success: false, error: `Unknown service: ${pluginId}` };
  }

  if (!plugin.isConfigured()) {
    return { success: false, error: `${plugin.name} is not configured. Run: node scripts/google-auth-setup.js` };
  }

  const { action } = args;
  if (!action) {
    return { success: false, error: `Missing 'action' parameter. Available actions: ${plugin.actions.join(', ')}` };
  }

  if (!plugin.actions.includes(action)) {
    return { success: false, error: `Unknown action '${action}' for ${plugin.name}. Available: ${plugin.actions.join(', ')}` };
  }

  try {
    return await plugin.execute(action, args);
  } catch (err) {
    return { success: false, error: `${plugin.name} error: ${err.message}` };
  }
}
