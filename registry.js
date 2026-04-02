/**
 * Agent Registry - CRUD operations for agent metadata
 * Stores agent configuration in a JSON file
 */

import fs from 'fs/promises';
import path from 'path';

const AGENTS_DIR = process.env.AGENTS_DIR || '/home/claude/agents';
const REGISTRY_FILE = path.join(AGENTS_DIR, 'registry.json');

/**
 * Ensure registry file exists
 */
async function ensureRegistry() {
  try {
    await fs.access(REGISTRY_FILE);
  } catch {
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    await fs.writeFile(REGISTRY_FILE, JSON.stringify({ agents: [] }, null, 2));
  }
}

/**
 * Read registry from disk
 */
async function readRegistry() {
  await ensureRegistry();
  const data = await fs.readFile(REGISTRY_FILE, 'utf-8');
  return JSON.parse(data);
}

/**
 * Write registry to disk
 */
async function writeRegistry(registry) {
  await ensureRegistry();
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Generate URL-safe slug from name
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Find next available port (3001-3099)
 */
async function getNextPort() {
  const registry = await readRegistry();
  const usedPorts = new Set(registry.agents.map(a => a.port));
  for (let port = 3001; port <= 3099; port++) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error('No available ports (3001-3099 exhausted)');
}

/**
 * List all agents
 */
export async function listAgents() {
  const registry = await readRegistry();
  return registry.agents;
}

/**
 * Get agent by slug
 */
export async function getAgent(slug) {
  const registry = await readRegistry();
  return registry.agents.find(a => a.slug === slug) || null;
}

/**
 * Create new agent
 * @param {Object} options
 * @param {string} options.name - Agent display name
 * @param {string} options.repoUrl - GitHub repo URL or local:// path
 * @param {string} [options.branch] - Git branch (default: main)
 * @param {Object} [options.config] - Additional config
 * @param {string} [options.repoPath] - Override default repo path (for local agents)
 */
export async function createAgent({ name, repoUrl, branch = 'main', config = {}, repoPath: overridePath }) {
  const registry = await readRegistry();

  const slug = slugify(name);

  // Check for duplicate slug
  if (registry.agents.find(a => a.slug === slug)) {
    throw new Error(`Agent with slug "${slug}" already exists`);
  }

  const port = await getNextPort();
  const now = new Date().toISOString();

  const agent = {
    id: `agent-${Date.now()}`,
    name,
    slug,
    repoUrl,
    branch,
    port,
    repoPath: overridePath || path.join(AGENTS_DIR, slug, 'repo'),
    state: 'stopped',
    taskTitle: null,
    plan: [],
    execution: [],
    artifacts: [],
    escalation: null,
    config: {
      model: config.model || 'sonnet',
      autoCommit: config.autoCommit ?? true,
      ...config
    },
    createdAt: now,
    lastActiveAt: now
  };

  registry.agents.push(agent);
  await writeRegistry(registry);

  return agent;
}

/**
 * Update agent
 */
export async function updateAgent(slug, updates) {
  const registry = await readRegistry();
  const index = registry.agents.findIndex(a => a.slug === slug);

  if (index === -1) {
    throw new Error(`Agent "${slug}" not found`);
  }

  // Prevent changing immutable fields
  const { id, slug: _, port, repoPath, createdAt, ...allowedUpdates } = updates;

  registry.agents[index] = {
    ...registry.agents[index],
    ...allowedUpdates,
    lastActiveAt: new Date().toISOString()
  };

  await writeRegistry(registry);
  return registry.agents[index];
}

/**
 * Delete agent
 */
export async function deleteAgent(slug) {
  const registry = await readRegistry();
  const index = registry.agents.findIndex(a => a.slug === slug);

  if (index === -1) {
    throw new Error(`Agent "${slug}" not found`);
  }

  const agent = registry.agents[index];
  registry.agents.splice(index, 1);
  await writeRegistry(registry);

  return agent;
}

/**
 * Update agent state
 */
export async function setAgentState(slug, state) {
  return updateAgent(slug, { state });
}

export default {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentState
};
