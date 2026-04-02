/**
 * Agent Config Loader
 *
 * Single source of truth for agent definitions. Reads from agents/*.json.
 * Replaces hardcoded AGENT_NAMES, AGENT_REGISTRY, AGENT_BOT_IDS dicts.
 *
 * Adding a new agent = creating agents/my-agent.json. No code edits.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, '..', 'agents');

let _cache = null;

/** Load all agent configs from agents/*.json (cached after first call) */
function loadAll() {
  if (_cache) return _cache;

  const agents = [];
  try {
    const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(AGENTS_DIR, file), 'utf-8');
        const config = JSON.parse(raw);
        if (config.id) agents.push(config);
      } catch (e) {
        console.warn(`[agent-config] Failed to load ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    // agents/ dir doesn't exist — return empty (backward compat)
    console.warn('[agent-config] No agents/ directory found, using empty config');
  }

  _cache = agents;
  return agents;
}

/** Clear the cache (for testing) */
export function clearCache() {
  _cache = null;
}

/** Get all agent configs */
export function getAllAgents() {
  return loadAll();
}

/** Get config for a specific agent ID */
export function getAgentConfig(id) {
  return loadAll().find(a => a.id === id) || null;
}

/** { agentId: displayName } — replaces AGENT_NAMES */
export function getAgentNames() {
  const map = {};
  for (const a of loadAll()) map[a.id] = a.name;
  return map;
}

/** { agentId: { name, port, color, role } } — replaces AGENT_REGISTRY */
export function getAgentRegistry() {
  const map = {};
  for (const a of loadAll()) {
    map[a.id] = { name: a.name, port: a.port, color: a.color, role: a.role };
  }
  return map;
}

/** { agentId: discordBotUserId } — replaces AGENT_BOT_IDS */
export function getAgentBotIds() {
  const map = {};
  for (const a of loadAll()) {
    if (a.discordBotIdEnv) {
      map[a.id] = process.env[a.discordBotIdEnv] || undefined;
    }
  }
  return map;
}

/** { agentId: { url, capabilities } } — replaces FALLBACK_AGENTS in delegation.js */
export function getFallbackAgents() {
  const map = {};
  for (const a of loadAll()) {
    map[a.id] = {
      url: `http://localhost:${a.port}`,
      capabilities: a.capabilities || [],
    };
  }
  return map;
}

/** Get display name for an agent ID (falls back to agentId) */
export function getAgentDisplayName(id) {
  return getAgentConfig(id)?.name || id;
}

/** { shortName: discordBotUserId } — replaces BOT_IDS in collab.js */
export function getCollabBotIds() {
  const map = {};
  for (const a of loadAll()) {
    if (a.discordBotIdEnv) {
      const short = a.name.toLowerCase();
      map[short] = process.env[a.discordBotIdEnv] || undefined;
    }
  }
  return map;
}

/** { agentId: shortName } — replaces AGENT_TO_BOT_NAME in collab.js */
export function getAgentToBotName() {
  const map = {};
  for (const a of loadAll()) {
    if (a.discordBotIdEnv) {
      map[a.id] = a.name.toLowerCase();
    }
  }
  return map;
}
