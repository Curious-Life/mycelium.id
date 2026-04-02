/**
 * MCP Server Setup
 *
 * Writes .claude/settings.json into an agent directory so Claude Code CLI
 * auto-discovers the MYA tools MCP server.
 *
 * Usage:
 *   import { writeMcpSettings } from './mcp/setup.js';
 *   await writeMcpSettings(agentRoot, userId);
 *
 * Or standalone:
 *   node mcp/setup.js <agentRoot> <userId>
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, 'mya-tools.js');
const WEALTH_TOOLS_PATH = path.join(__dirname, 'wealth-tools.js');
const POLYMARKET_TOOLS_PATH = path.join(__dirname, 'polymarket-tools.js');
const OPS_TOOLS_PATH = path.join(__dirname, 'ops-tools.js');
const LINEAR_TOOLS_PATH = path.join(__dirname, 'linear-tools.js');

/**
 * Write .claude/settings.json for MCP server discovery.
 *
 * ENV vars (DB_BACKEND, MYA_WORKER_URL, MYA_WORKER_SECRET, etc.)
 * are inherited from the parent process — only USER_ID, AGENT_ROOT, MEMORY_SCOPE
 * are agent-specific.
 *
 * @param {string} settingsDir - Directory to write .claude/settings.json (Claude Code's cwd)
 * @param {string} userId - User UUID for this agent's owner
 * @param {Object} [options] - Additional options
 * @param {string} [options.agentRoot] - Agent root directory for mind files (defaults to settingsDir)
 * @param {string} [options.memoryScope] - 'all' for personal agent, 'company' for company agent
 * @param {Object} [options.extraEnv] - Additional env vars to pass to the MCP server
 * @param {string[]} [options.extraMcpServers] - Additional MCP servers to register (e.g. ['wealth-tools'])
 */
export async function writeMcpSettings(settingsBase, userId, options = {}) {
  const { memoryScope = 'all', agentRoot, extraEnv = {}, extraMcpServers = [] } = options;
  const settingsDir = path.join(settingsBase, '.claude');
  await fs.mkdir(settingsDir, { recursive: true });

  const sharedEnv = {
    USER_ID: userId,
    AGENT_ROOT: agentRoot || settingsBase,
    MEMORY_SCOPE: memoryScope,
    DB_BACKEND: process.env.DB_BACKEND || 'd1',
    MYA_WORKER_URL: process.env.MYA_WORKER_URL || '',
    MYA_WORKER_SECRET: process.env.MYA_WORKER_SECRET || '', // Legacy fallback
    AGENT_TOKEN: process.env.AGENT_TOKEN || '',
    AGENT_ID: process.env.AGENT_ID || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL || 'http://localhost:3000',
    ...extraEnv,
  };

  const permissions = ['mcp__mya-tools__*'];
  const mcpServers = {
    'mya-tools': {
      command: 'node',
      args: [MCP_SERVER_PATH],
      env: sharedEnv,
    },
  };

  // Register additional MCP servers
  const EXTRA_SERVER_CONFIGS = {
    'wealth-tools': { path: WEALTH_TOOLS_PATH },
    'polymarket-tools': {
      path: POLYMARKET_TOOLS_PATH,
      env: {
        POLYMARKET_API_URL: process.env.POLYMARKET_API_URL || '',
        POLYMARKET_API_USER: process.env.POLYMARKET_API_USER || '',
        POLYMARKET_API_PASSWORD: process.env.POLYMARKET_API_PASSWORD || '',
      },
    },
    'ops-tools': {
      path: OPS_TOOLS_PATH,
      env: {
        OPS_GMAIL_CLIENT_ID: process.env.OPS_GMAIL_CLIENT_ID || '',
        OPS_GMAIL_CLIENT_SECRET: process.env.OPS_GMAIL_CLIENT_SECRET || '',
        OPS_GMAIL_REFRESH_TOKEN: process.env.OPS_GMAIL_REFRESH_TOKEN || '',
        OPS_DRIVE_FOLDER_ID: process.env.OPS_DRIVE_FOLDER_ID || '',
      },
    },
    'linear-tools': {
      path: LINEAR_TOOLS_PATH,
      env: {
        LINEAR_API_KEY: process.env.LINEAR_API_KEY || '',
        LINEAR_TEAM_ID: process.env.LINEAR_TEAM_ID || '',
      },
    },
  };
  for (const serverName of extraMcpServers) {
    const config = EXTRA_SERVER_CONFIGS[serverName];
    if (config) {
      mcpServers[serverName] = {
        command: 'node',
        args: [config.path],
        env: { ...sharedEnv, ...config.env },
      };
      permissions.push(`mcp__${serverName}__*`);
    }
  }

  const settings = {
    permissions: { allow: permissions },
    mcpServers,
  };

  const settingsPath = path.join(settingsDir, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[MCP] Wrote settings to ${settingsPath} (user: ${userId}, scope: ${memoryScope}${extraMcpServers.length ? `, extra: ${extraMcpServers.join(', ')}` : ''})`);
}

// CLI mode: node mcp/setup.js <agentRoot> <userId> [memoryScope]
if (process.argv[1] && process.argv[1].endsWith('setup.js') && process.argv[2]) {
  const agentRoot = process.argv[2];
  const userId = process.argv[3];
  const memoryScope = process.argv[4] || 'all';
  if (!userId) {
    console.error('Usage: node mcp/setup.js <agentRoot> <userId> [all|company]');
    process.exit(1);
  }
  await writeMcpSettings(agentRoot, userId, { memoryScope });
}
