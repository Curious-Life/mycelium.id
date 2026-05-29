/**
 * Agent secret policy — single source of truth for "which secret keys can
 * the operator set for which agent, and which PM2 processes need to
 * restart when those keys change."
 *
 * Pure-logic. The reader scans `agents/*.json` once at boot (or on
 * demand in tests via injected fs) and builds a map of:
 *
 *     { agentId → { discordBotTokenEnv, discordBotProcessName,
 *                   telegramBotTokenEnv, telegramBotProcessName } }
 *
 * Consumed by:
 *   - packages/server/routes/portal-settings.js — PUT /portal/settings/secret
 *     uses {@link allowedKeysForAgent} to allowlist body.key per body.agentId
 *     (replacing the prior hardcoded 3-key array + hardcoded
 *     `agent: 'personal-agent'` write); uses {@link pmProcessNamesForKey}
 *     to know which PM2 processes to restart after a successful save.
 *   - Future: token-health monitor (PR 3.1) iterates known agents to know
 *     which provider state to probe.
 *
 * Why a separate module: the original sweep (2026-05-06) found Discord
 * token env-var naming inconsistent across bots (DISCORD_RESEARCH_BOT_TOKEN
 * vs DISCORD_INTEL_BOT_TOKEN vs DISCORD_PERSONAL_BOT_TOKEN — no derivation
 * rule gets all of them right). agents/*.json now carries explicit
 * discordBotTokenEnv / telegramBotTokenEnv / *ProcessName fields; this
 * module is a thin reader so deviations live in declarative data, not
 * derivation logic.
 *
 * Universal-naming compliance: the policy never embeds an agent display
 * name (Mya/Ada/Apollo/etc.) — only the canonical agent_id (functional
 * name) and the explicit env-var/process-name strings declared in JSON.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {object} AgentSecretPolicy
 * @property {string|null} discordBotTokenEnv     e.g. "DISCORD_PERSONAL_BOT_TOKEN" or null
 * @property {string|null} discordBotProcessName  e.g. "personal-discord-bot" or null
 * @property {string|null} telegramBotTokenEnv    e.g. "TELEGRAM_BOT_TOKEN" or null
 * @property {string|null} telegramBotProcessName e.g. "personal-telegram-bot" or null
 * @property {string|null} memoryScope            e.g. "personal" | "moms" | "research" — used for secret encryption scope
 */

/** @typedef {Record<string, AgentSecretPolicy>} AgentSecretPolicyMap */

/**
 * Build the policy map from `agents/*.json`.
 *
 * @param {object} [opts]
 * @param {string} [opts.agentsDir] absolute path; defaults to `<cwd>/agents`
 * @param {(dir: string) => string[]} [opts.readDir] injectable for tests
 * @param {(file: string) => string} [opts.readFile] injectable for tests
 * @returns {AgentSecretPolicyMap}
 */
export function loadAgentSecretPolicy(opts = {}) {
  const agentsDir = opts.agentsDir || join(process.cwd(), 'agents');
  const readDir = opts.readDir || ((d) => readdirSync(d));
  const readFile = opts.readFile || ((f) => readFileSync(f, 'utf-8'));

  /** @type {AgentSecretPolicyMap} */
  const map = {};

  let files;
  try { files = readDir(agentsDir); } catch { return map; }

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('_')) continue;  // _template.json — declarative skeleton, not a real agent

    let json;
    try { json = JSON.parse(readFile(join(agentsDir, f))); }
    catch { continue; }

    if (!json || typeof json.id !== 'string' || !json.id) continue;

    map[json.id] = {
      discordBotTokenEnv:     stringOrNull(json.discordBotTokenEnv),
      discordBotProcessName:  stringOrNull(json.discordBotProcessName),
      telegramBotTokenEnv:    stringOrNull(json.telegramBotTokenEnv),
      telegramBotProcessName: stringOrNull(json.telegramBotProcessName),
      memoryScope:            stringOrNull(json.memoryScope),
    };
  }

  return map;
}

/**
 * Look up one agent's policy. Returns null for unknown agents — caller
 * should treat as "this agent cannot have secrets set via the portal."
 */
export function policyForAgent(map, agentId) {
  if (!map || typeof agentId !== 'string') return null;
  return map[agentId] || null;
}

/**
 * The keys an operator is allowed to PUT for this agent.
 *
 * Composition:
 *   - Discord token (if the agent has a Discord bot)
 *   - Telegram token (if the agent has a Telegram bot)
 *   - OWNER_TELEGRAM_ID (universal binding — only meaningful for agents
 *     with Telegram, since it controls who's authorized to talk to that
 *     bot)
 *
 * Returns a sorted array of unique strings. Empty array for unknown
 * agents or agents with no bot bindings (e.g. qa-agent).
 */
export function allowedKeysForAgent(map, agentId) {
  const policy = policyForAgent(map, agentId);
  if (!policy) return [];

  const keys = new Set();
  if (policy.discordBotTokenEnv)  keys.add(policy.discordBotTokenEnv);
  if (policy.telegramBotTokenEnv) {
    keys.add(policy.telegramBotTokenEnv);
    keys.add('OWNER_TELEGRAM_ID');
  }
  return [...keys].sort();
}

/**
 * The PM2 process names that need to restart for a given (agent, key)
 * pair. Empty array means "no restart wired" — the caller MAY still
 * record the secret successfully; the operator just has to restart
 * manually.
 *
 * Restart rules:
 *   - discord token  → discord bot only
 *   - telegram token → telegram bot only
 *   - OWNER_TELEGRAM_ID → telegram bot (binding gates inbound auth)
 */
export function pmProcessNamesForKey(map, agentId, key) {
  const policy = policyForAgent(map, agentId);
  if (!policy) return [];

  const procs = [];
  if (key === policy.discordBotTokenEnv && policy.discordBotProcessName) {
    procs.push(policy.discordBotProcessName);
  }
  if ((key === policy.telegramBotTokenEnv || key === 'OWNER_TELEGRAM_ID') && policy.telegramBotProcessName) {
    procs.push(policy.telegramBotProcessName);
  }
  return procs;
}

/**
 * The encryption scope a secret should be written under for the given
 * agent. Reads `memoryScope` from agents/*.json. Falls back to 'personal'
 * for unknown agents (preserves the legacy hardcode behavior).
 *
 * Used by the portal-settings route to compute the `scope` argument for
 * putEncryptedSecret when the request body doesn't supply one.
 */
export function scopeForAgent(map, agentId) {
  const policy = policyForAgent(map, agentId);
  return (policy && policy.memoryScope) || 'personal';
}

function stringOrNull(v) {
  return (typeof v === 'string' && v.length > 0) ? v : null;
}
