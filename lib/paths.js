/**
 * Standardized Path Management
 *
 * Single source of truth for all agent file paths.
 * Fixes the triple-state-file problem.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Root directory for all agents
const AGENTS_ROOT = process.env.AGENTS_ROOT || process.env.MYA_AGENTS_ROOT || path.join(os.homedir(), 'agents');

/**
 * Get all paths for an agent
 * @param {string} agentId - Agent identifier (e.g., 'company-agent', 'research-agent')
 * @returns {Object} Path object with all file locations
 */
export function getAgentPaths(agentId) {
  const root = path.join(AGENTS_ROOT, agentId);

  return {
    root,
    repo: path.join(root, 'repo'),  // Git repository (for agents cloned from GitHub)

    // Core files
    heartbeat: path.join(root, 'HEARTBEAT.md'),
    state: path.join(root, 'memory', 'state.json'),  // CANONICAL state location

    // Memory directory
    memory: {
      root: path.join(root, 'memory'),
      state: path.join(root, 'memory', 'state.json'),
      identity: path.join(root, 'memory', 'identity.json'),
      goals: path.join(root, 'memory', 'goals.json'),
      context: path.join(root, 'memory', 'context.json'),
      findings: path.join(root, 'memory', 'findings.json'),
      conversations: path.join(root, 'memory', 'conversations.json'),
    },

    // Mind directory (personal agent: internal model, flagged items, dreams, etc.)
    mind: {
      root: path.join(root, 'mind'),
      model: path.join(root, 'mind', 'model.md'),
      flagged: path.join(root, 'mind', 'flagged.md'),
      dreams: path.join(root, 'mind', 'dreams.md'),
      topologyNotes: path.join(root, 'mind', 'topology-notes.md'),
      reflections: path.join(root, 'mind', 'reflections.md'),
      synchronicities: path.join(root, 'mind', 'synchronicities.md'),
      documentIndex: path.join(root, 'mind', 'document-index.md'),
    },

    // Task directories
    tasks: {
      root: path.join(root, 'tasks'),
      queue: path.join(root, 'tasks', 'queue'),
      active: path.join(root, 'tasks', 'active'),
      completed: path.join(root, 'tasks', 'completed'),
      blocked: path.join(root, 'tasks', 'blocked'),
    },

    // Knowledge base
    knowledge: {
      root: path.join(root, 'knowledge'),
      context: path.join(root, 'knowledge', 'context.md'),
      pendingTasks: path.join(root, 'knowledge', 'pending-tasks.json'),  // Legacy format
    },

    // Watchers (persistent subagents)
    watchers: path.join(root, 'memory', 'watchers'),

    // Continuations (deferred task resumptions)
    continuations: path.join(root, 'continuations'),

    // Prompts
    prompts: {
      root: path.join(root, 'prompts'),
      system: path.join(root, 'prompts', 'system.md'),
    },

    // Sessions and outputs
    sessions: path.join(root, 'sessions'),
    outputs: path.join(root, 'outputs'),
    logs: path.join(root, 'logs'),
  };
}

/**
 * Ensure agent directory structure exists
 * Creates all required directories and default files
 *
 * @param {string} agentId - Agent identifier
 */
export async function ensureAgentStructure(agentId) {
  const paths = getAgentPaths(agentId);

  // Create all directories
  const dirs = [
    paths.memory.root,
    paths.mind.root,
    paths.tasks.queue,
    paths.tasks.active,
    paths.tasks.completed,
    paths.tasks.blocked,
    paths.knowledge.root,
    paths.watchers,
    paths.continuations,
    paths.prompts.root,
    paths.sessions,
    paths.outputs,
    paths.logs,
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Create default HEARTBEAT.md if missing
  if (!await exists(paths.heartbeat)) {
    await fs.writeFile(paths.heartbeat, `# HEARTBEAT

This file is your consciousness checkpoint. Read it every awakening cycle.

## Pending Tasks
<!-- Tasks that need your attention. Remove when done. -->

## Alerts
<!-- Time-sensitive items. Clear after addressing. -->

## Notes
<!-- Anything you want to remember between cycles. -->
`);
  }

  // Create default state.json if missing
  if (!await exists(paths.state)) {
    await fs.writeFile(paths.state, JSON.stringify({
      agentId,
      createdAt: new Date().toISOString(),
      lastAwakeTime: null,
      messagesThisHour: 0,
      messagesToday: 0,
      lastMessageTime: null,
      lastHumanMessageTime: null,
      dateKey: new Date().toISOString().split('T')[0],
      hourKey: new Date().toISOString().split(':')[0],
    }, null, 2));
  }

  // Create default identity.json if missing
  if (!await exists(paths.memory.identity)) {
    await fs.writeFile(paths.memory.identity, JSON.stringify({
      name: agentId,
      purpose: 'Define your core purpose here',
      values: [],
      constraints: [],
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  // Create default goals.json if missing
  if (!await exists(paths.memory.goals)) {
    await fs.writeFile(paths.memory.goals, JSON.stringify({
      activeGoals: [],
      completedGoals: [],
      updatedAt: null,
    }, null, 2));
  }

  // Create default context.json if missing
  if (!await exists(paths.memory.context)) {
    await fs.writeFile(paths.memory.context, JSON.stringify({
      recentTopics: [],
      pendingThoughts: [],
      lastInteractions: [],
    }, null, 2));
  }

  // Create .claude directory for MCP settings
  await fs.mkdir(path.join(paths.root, '.claude'), { recursive: true });

  // Migrate legacy state files if they exist
  await migrateState(agentId);

  console.log(`[Paths] Agent structure ensured for: ${agentId}`);
}

/**
 * Check if a file exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>}
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file with default value on error
 * @param {string} filePath - Path to read
 * @param {*} defaultValue - Default value if file doesn't exist or is invalid
 * @returns {Promise<*>}
 */
export async function readFile(filePath, defaultValue = null) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (filePath.endsWith('.json')) {
      return JSON.parse(content);
    }
    return content;
  } catch {
    return defaultValue;
  }
}

/**
 * Write a file (creates directories if needed)
 * @param {string} filePath - Path to write
 * @param {*} content - Content (objects are JSON stringified)
 */
export async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fs.writeFile(filePath, data);
}

/**
 * Migrate legacy state files to canonical location
 * @param {string} agentId - Agent identifier
 */
export async function migrateState(agentId) {
  const paths = getAgentPaths(agentId);

  // Check for legacy state files
  const legacyPaths = [
    path.join(paths.root, 'state.json'),           // Old root location
    path.join(paths.root, '.agent-state.json'),    // API server location
  ];

  let migrated = false;

  for (const legacyPath of legacyPaths) {
    if (await exists(legacyPath)) {
      try {
        const legacyState = await readFile(legacyPath, {});
        const currentState = await readFile(paths.state, {});

        // Merge: keep newer values
        const merged = {
          ...currentState,
          ...legacyState,
          // Always use newer timestamps
          lastAwakeTime: newerTimestamp(currentState.lastAwakeTime, legacyState.lastAwakeTime),
          lastMessageTime: newerTimestamp(currentState.lastMessageTime, legacyState.lastMessageTime),
          lastHumanMessageTime: newerTimestamp(currentState.lastHumanMessageTime, legacyState.lastHumanMessageTime),
          migratedAt: new Date().toISOString(),
        };

        await writeFile(paths.state, merged);

        // Rename legacy file (don't delete, just mark as migrated)
        await fs.rename(legacyPath, legacyPath + '.migrated');

        console.log(`[Paths] Migrated state from ${legacyPath}`);
        migrated = true;
      } catch (error) {
        console.error(`[Paths] Failed to migrate ${legacyPath}:`, error.message);
      }
    }
  }

  return migrated;
}

/**
 * Get the newer of two timestamps
 */
function newerTimestamp(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

/**
 * Get the AGENTS_ROOT directory
 */
export function getAgentsRoot() {
  return AGENTS_ROOT;
}

export default {
  getAgentPaths,
  ensureAgentStructure,
  exists,
  readFile,
  writeFile,
  migrateState,
  getAgentsRoot,
};
