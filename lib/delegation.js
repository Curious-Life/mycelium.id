/**
 * Inter-Agent Delegation with Dynamic Discovery
 *
 * Replaces hardcoded agent lists with dynamic discovery from PM2 process
 * list + agent cards. Adding agent N+1 doesn't require editing agents 1-N.
 *
 * Key features:
 * - PM2-based discovery with agent card enrichment
 * - Health check before committing to delegation
 * - Timeout tracking for stale delegations
 * - Dynamic tool schema generation for LLM calls
 * - Hardcoded fallback for when PM2 isn't available
 * - Visible delegation: announcements in #agent-collab via Discord
 *
 * Cross-instance communication uses Discord @mentions in #agent-collab
 * instead of HTTP federation. See lib/collab.js for details.
 */

import { getAgentPaths, readFile, writeFile, exists } from './paths.js';
import { createTask, getTask, updateTaskStatus, TaskStatus, TaskPriority } from './tasks.js';
import { requestWake } from './coalesce.js';
import { logEvent, log as eventLog, EventType } from './events.js';
import { announceToCollab, getBotLabel } from './collab.js';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

// ============================================
// Agent Discovery (PM2 + Agent Cards)
// ============================================

// Discovery cache (60s TTL — don't hit PM2 + N HTTP fetches per LLM turn)
let cachedAgents = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

// Fallback agents — loaded from agents/*.json config (used when PM2 isn't available)
import { getFallbackAgents } from './agent-config.js';
const FALLBACK_AGENTS = getFallbackAgents();

/**
 * Discover agents via PM2 process list
 * @returns {Promise<Array<{agentId: string, port: number, tier: number, url: string, discordChannel: string|null}>>}
 */
async function discoverAgents() {
  try {
    const pm2 = await import('pm2');
    return new Promise((resolve, reject) => {
      pm2.default.connect((err) => {
        if (err) return reject(err);
        pm2.default.list((err, processes) => {
          pm2.default.disconnect();
          if (err) return reject(err);
          resolve(
            processes
              .filter(p => p.pm2_env?.AGENT_ID && p.pm2_env.status === 'online')
              .map(p => ({
                agentId: p.pm2_env.AGENT_ID,
                port: parseInt(p.pm2_env.PORT),
                tier: parseInt(p.pm2_env.AGENT_TIER || '1'),
                url: `http://localhost:${p.pm2_env.PORT}`,
                discordChannel: p.pm2_env.DISCORD_CHANNEL || null,
              }))
          );
        });
      });
    });
  } catch {
    // PM2 not available — use fallback
    return Object.entries(FALLBACK_AGENTS).map(([agentId, config]) => ({
      agentId,
      port: parseInt(new URL(config.url).port),
      tier: 1,
      url: config.url,
      discordChannel: null,
    }));
  }
}

/**
 * Discover local agents enriched with agent cards (capabilities, description)
 * @returns {Promise<Array>}
 */
async function discoverLocalAgentsWithCards() {
  const agents = await discoverAgents();
  return Promise.all(agents.map(async (agent) => {
    try {
      const card = await fetch(`${agent.url}/.well-known/agent.json`, {
        signal: AbortSignal.timeout(2000),
      }).then(r => r.json());
      return { ...agent, ...card, isRemote: false };
    } catch {
      // Agent card not available — use basic info + fallback capabilities
      const fallback = FALLBACK_AGENTS[agent.agentId];
      return {
        ...agent,
        capabilities: fallback?.capabilities || [],
        description: `${agent.agentId} agent`,
        isRemote: false,
      };
    }
  }));
}

/**
 * Discover agents via PM2 process list + agent cards.
 * Cross-instance communication uses Discord @mentions instead of HTTP federation.
 * @returns {Promise<Array>}
 */
export async function discoverAgentsWithCards() {
  return discoverLocalAgentsWithCards();
}

/**
 * Get agent info with caching
 * @param {string} agentId - Agent to look up
 * @returns {Promise<Object|null>} Agent info or null
 */
export async function getAgentInfo(agentId) {
  if (!cachedAgents || Date.now() - cacheTime > CACHE_TTL) {
    cachedAgents = await discoverAgentsWithCards();
    cacheTime = Date.now();
  }
  return cachedAgents.find(a => a.agentId === agentId) || null;
}

/**
 * Invalidate discovery cache (call after adding/removing agents)
 */
export function invalidateCache() {
  cachedAgents = null;
  cacheTime = 0;
}

// ============================================
// Dynamic Tool Definitions
// ============================================

/**
 * Build delegation and spawn tool schemas dynamically from discovered agents.
 * Call this before each LLM invocation to get up-to-date tools.
 *
 * @param {Object} runtime - Agent's runtime context
 * @returns {Promise<Array>} Tool definitions for Claude Code
 */
export async function buildDelegationTools(runtime) {
  if (!cachedAgents || Date.now() - cacheTime > CACHE_TTL) {
    cachedAgents = await discoverAgentsWithCards();
    cacheTime = Date.now();
  }

  const delegatable = cachedAgents.filter(a =>
    a.agentId !== runtime.agentId && a.tier === 1
  );

  const tools = [];

  // delegate_to_agent — only if there are other agents
  if (delegatable.length > 0) {
    const agentEnum = delegatable.map(a => a.agentId);
    const agentDescriptions = delegatable
      .map(a => `- ${a.agentId}: ${a.description || 'No description'}`)
      .join('\n');

    tools.push({
      name: 'delegate_to_agent',
      description: `Delegate a task to another team member. Async — they work independently and report back.\n\nAvailable agents:\n${agentDescriptions}\n\nWrite self-contained task descriptions. The receiving agent has NO access to your conversation — they only see task + context.`,
      input_schema: {
        type: 'object',
        properties: {
          target_agent: { type: 'string', enum: agentEnum },
          task: {
            type: 'string',
            description: 'Specific, actionable instructions. Include: what to do, what format to return, and constraints. Bad: "look into competitors". Good: "Research pricing tiers for Notion, Coda, Obsidian team plans. Return comparison table with monthly/annual pricing and key differentiators."',
          },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Use high only when a human is actively waiting. Default: normal.' },
          context: { type: 'string', description: 'Background the agent needs. Only what is relevant — not your full conversation.' },
        },
        required: ['target_agent', 'task'],
      },
    });
  }

  // spawn_specialist — always available for Tier 1 agents (but not for sub-agents)
  if (runtime.tier === 1) {
    tools.push({
      name: 'spawn_specialist',
      description: `Spawn a focused sub-agent for a specific task. Runs in-process with isolated context and returns results directly.

Model selection — choose the right model for the task:
- sonnet (recommended default): Analysis, coding, research, writing, multi-step reasoning
- haiku: Only for trivial tasks — simple lookups, formatting, data extraction, template filling
- opus: Deep strategic thinking, synthesis across many sources (use sparingly)`,
      input_schema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Specialist role (e.g., "financial-analyst", "copywriter")' },
          task: { type: 'string', description: 'Specific instructions for the specialist' },
          context: { type: 'string', description: 'Only what the specialist needs to do the work' },
          model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'sonnet=recommended default, haiku=trivial tasks only, opus=deep reasoning' },
        },
        required: ['role', 'task'],
      },
    });
  }

  return tools;
}

// ============================================
// Delegation (Async, with Health Check)
// ============================================

/**
 * Delegate a task to another Tier 1 agent
 *
 * @param {Object} runtime - Source agent's runtime context
 * @param {Object} params
 * @param {string} params.target_agent - Target agent ID
 * @param {string} params.task - Task description
 * @param {string} [params.priority='normal'] - Priority level
 * @param {string} [params.context] - Context for the target agent
 * @returns {Promise<string>} Human-readable status message
 */
export async function handleDelegation(runtime, { target_agent, task, priority, context }) {
  // Energy check before delegating (opt-in)
  try {
    const { getAgentEnergyState } = await import('./energy-state.js');
    const energy = await getAgentEnergyState(target_agent);
    if (energy.level === 'critical') {
      return `Agent ${target_agent} is energy-critical. Delegating would exceed their budget. I'll handle this myself.`;
    }
  } catch { /* energy module not available */ }

  // Health check before committing
  const targetAgent = await getAgentInfo(target_agent);
  if (!targetAgent) {
    return `Agent ${target_agent} is not currently available. I'll handle this myself.`;
  }

  return delegateLocal(runtime, targetAgent, { target_agent, task, priority, context });
}

/**
 * Delegate to a local agent (filesystem task queue + HTTP wake)
 */
async function delegateLocal(runtime, targetAgent, { target_agent, task, priority, context }) {
  try {
    const health = await fetch(`${targetAgent.url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error('unhealthy');
  } catch {
    logEvent(runtime, 'delegation.target_unavailable', { payload: { targetAgent: target_agent } });
    return `${target_agent} isn't responding right now. I'll handle this directly.`;
  }

  const taskId = `task_${randomBytes(4).toString('hex')}`;
  const timeoutMs = priority === 'high' ? 10 * 60 * 1000 : 30 * 60 * 1000;

  const taskMeta = {
    id: taskId,
    from: runtime.agentId,
    to: target_agent,
    task,
    context,
    priority: priority || 'normal',
    callbackUrl: `http://localhost:${runtime.port}/delegation-callback`,
    traceId: runtime.traceId,
    createdAt: Date.now(),
    timeoutAt: Date.now() + timeoutMs,
  };

  // Write to target agent's task queue
  const targetPaths = getAgentPaths(target_agent);
  const queueDir = path.join(targetPaths.root, 'tasks', 'queue');
  try {
    await fs.mkdir(queueDir, { recursive: true });
    await fs.writeFile(
      path.join(queueDir, `${taskId}.json`),
      JSON.stringify(taskMeta, null, 2),
    );
  } catch (error) {
    console.error(`[Delegation] Failed to write task ${taskId}:`, error.message);
    return `Failed to delegate to ${target_agent}: ${error.message}`;
  }

  // Track locally for timeout detection
  await trackOutboundDelegation(runtime, taskMeta);

  // Wake target agent
  await requestWakeHttp(target_agent, targetAgent.url);

  logEvent(runtime, 'delegation.created', {
    payload: { targetAgent: target_agent, taskId, priority },
  });

  // Announce to #agent-collab (fire-and-forget, uses bold text names to avoid triggering bots)
  const summary = task.length > 100 ? task.slice(0, 100) + '...' : task;
  announceToCollab(runtime.agentId, `📋 Delegating to ${getBotLabel(target_agent)}: ${summary}`);

  return `Task ${taskId} delegated to ${target_agent}. They'll report back within ${timeoutMs / 60000} minutes.`;
}

// delegateRemote removed — cross-instance communication uses Discord @mentions.
// See lib/collab.js getBotMention() for intentional cross-instance conversation starts.

/**
 * Wake a target agent via HTTP POST to /think
 */
async function requestWakeHttp(agentId, agentUrl) {
  const internalHeaders = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_INTERNAL_SECRET) {
    internalHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
  }
  try {
    await fetch(`${agentUrl}/think`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({
        prompt: 'You have new tasks in your queue. Check your task queue and process pending items.',
        trigger: 'task-queue',
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Non-fatal — agent's heartbeat will pick up the task on next awakening
    console.log(`[Delegation] Could not wake ${agentId} — heartbeat will handle it`);
  }
}

// ============================================
// Outbound Delegation Tracking
// ============================================

/**
 * Track an outbound delegation for timeout detection
 */
async function trackOutboundDelegation(runtime, taskMeta) {
  const delegationsFile = path.join(runtime.paths.root, 'memory', 'delegations.json');
  try {
    let data;
    try {
      const content = await fs.readFile(delegationsFile, 'utf-8');
      data = JSON.parse(content);
    } catch {
      data = { delegations: [] };
    }

    data.delegations.push({
      ...taskMeta,
      status: 'pending',
    });

    // Keep only last 100
    if (data.delegations.length > 100) {
      data.delegations = data.delegations.slice(-100);
    }

    await fs.mkdir(path.dirname(delegationsFile), { recursive: true });
    await fs.writeFile(delegationsFile, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Delegation] Failed to track outbound delegation:', error.message);
  }
}

/**
 * Get all outbound delegations for an agent
 */
export async function getOutboundDelegations(runtime) {
  const delegationsFile = path.join(runtime.paths.root, 'memory', 'delegations.json');
  try {
    const content = await fs.readFile(delegationsFile, 'utf-8');
    const data = JSON.parse(content);
    return data.delegations || [];
  } catch {
    return [];
  }
}

/**
 * Mark a delegation as completed/failed
 */
export async function completeDelegation(runtime, taskId, status, result = null) {
  const delegationsFile = path.join(runtime.paths.root, 'memory', 'delegations.json');
  let fromAgent = null;
  try {
    const content = await fs.readFile(delegationsFile, 'utf-8');
    const data = JSON.parse(content);

    const delegation = data.delegations.find(d => d.taskId === taskId || d.id === taskId);
    if (delegation) {
      fromAgent = delegation.from;
      delegation.status = status;
      delegation.completedAt = Date.now();
      if (result) delegation.result = typeof result === 'string' ? result.slice(0, 500) : result;
      await fs.writeFile(delegationsFile, JSON.stringify(data, null, 2));
    }
  } catch {
    // Non-fatal
  }

  // Announce completion to #agent-collab
  const emoji = status === 'completed' ? '✅' : '❌';
  const resultSummary = result ? (typeof result === 'string' ? result.slice(0, 100) : 'done') : status;
  const source = fromAgent ? getBotLabel(fromAgent) : 'unknown';
  announceToCollab(runtime.agentId, `${emoji} ${source} — Task ${taskId} ${status}: ${resultSummary}`);
}

// ============================================
// Stale Delegation Detection
// ============================================

/**
 * Check for stale (timed-out) delegations
 * Call this during heartbeat or periodic health sweep
 *
 * @param {Object} runtime - Agent's runtime context
 * @returns {Array} Stale delegations
 */
export async function checkStaleDelegations(runtime) {
  const delegations = await getOutboundDelegations(runtime);
  const stale = [];

  for (const task of delegations) {
    if (task.status === 'pending' && task.timeoutAt && Date.now() > task.timeoutAt) {
      stale.push(task);
      logEvent(runtime, 'delegation.timeout', {
        payload: { taskId: task.id || task.taskId, targetAgent: task.to || task.from },
      });
    }
  }

  return stale;
}

// Federation registry (publishToRegistry, startRegistryHeartbeat) removed.
// Cross-instance communication uses Discord @mentions in #agent-collab.

// ============================================
// Legacy API (backward compat)
// ============================================

export const KnownAgents = {
  COMPANY: 'company-agent',
  RESEARCH: 'research-agent',
  BUILDER: 'builder-agent',
  QA: 'qa-agent',
  PERSONAL: 'personal-agent',
};

/**
 * Legacy: Delegate a task from one agent to another
 */
export async function delegateTask(fromAgent, toAgent, taskData) {
  console.log(`[Delegation] ${fromAgent} delegating to ${toAgent}: ${taskData.description?.substring(0, 50)}...`);

  const targetPaths = getAgentPaths(toAgent);
  if (!await exists(targetPaths.root)) {
    const { ensureAgentStructure } = await import('./paths.js');
    await ensureAgentStructure(toAgent);
  }

  const task = await createTask(toAgent, {
    ...taskData,
    delegatedFrom: {
      agentId: fromAgent,
      delegatedAt: new Date().toISOString(),
    },
    type: taskData.type || inferTaskType(toAgent),
    priority: taskData.priority || TaskPriority.NORMAL,
  });

  logEvent(EventType.TASK_CREATED, {
    agentId: toAgent,
    taskId: task.id,
    delegatedFrom: fromAgent,
    description: taskData.description,
  });

  requestWake(toAgent, `task_delegated_from_${fromAgent}`, async (reason) => {
    console.log(`[Delegation] Waking ${toAgent} for delegated task: ${reason}`);
  });

  return { success: true, taskId: task.id, delegatedTo: toAgent };
}

/**
 * Legacy: Get pending delegations
 */
export async function getPendingDelegations(agentId) {
  const paths = getAgentPaths(agentId);
  const delegationsFile = path.join(paths.memory.root, 'delegations.json');
  const data = await readFile(delegationsFile, { delegations: [] });
  return data.delegations.filter(d => d.status === 'pending');
}

/**
 * Legacy: Update delegation status
 */
export async function updateDelegationStatus(fromAgent, taskId, status, result = null) {
  const paths = getAgentPaths(fromAgent);
  const delegationsFile = path.join(paths.memory.root, 'delegations.json');
  const data = await readFile(delegationsFile, { delegations: [] });
  const delegation = data.delegations.find(d => d.taskId === taskId);

  if (delegation) {
    delegation.status = status;
    delegation.completedAt = new Date().toISOString();
    if (result) delegation.result = result;
    await writeFile(delegationsFile, data);
  }
}

/**
 * Legacy: Report delegation result
 */
export async function reportDelegationResult(agentId, taskId, result) {
  const task = await getTask(agentId, taskId);
  if (!task || !task.delegatedFrom) return;

  const fromAgent = task.delegatedFrom.agentId;
  await updateDelegationStatus(fromAgent, taskId, 'completed', result);

  requestWake(fromAgent, `delegation_completed_${taskId}`, async () => {
    console.log(`[Delegation] Notifying ${fromAgent} of completed delegation`);
  });
}

/**
 * Legacy: Get agent capabilities (uses discovery cache when available)
 */
export function getAgentCapabilities(agentId) {
  if (cachedAgents) {
    const agent = cachedAgents.find(a => a.agentId === agentId);
    if (agent?.capabilities) return agent.capabilities;
  }
  return FALLBACK_AGENTS[agentId]?.capabilities || ['general'];
}

/**
 * Legacy: Suggest delegation target
 */
export function suggestDelegation(taskDescription) {
  const lower = taskDescription.toLowerCase();
  if (lower.includes('research') || lower.includes('find') || lower.includes('search')) return KnownAgents.RESEARCH;
  if (lower.includes('build') || lower.includes('code') || lower.includes('implement')) return KnownAgents.BUILDER;
  if (lower.includes('review') || lower.includes('test') || lower.includes('check')) return KnownAgents.QA;
  return null;
}

function inferTaskType(agentId) {
  if (agentId.includes('research')) return 'research';
  if (agentId.includes('builder') || agentId.includes('build')) return 'build';
  if (agentId.includes('qa')) return 'analysis';
  return 'other';
}

export default {
  // Discovery + delegation
  discoverAgentsWithCards,
  getAgentInfo,
  invalidateCache,
  buildDelegationTools,
  handleDelegation,
  getOutboundDelegations,
  completeDelegation,
  checkStaleDelegations,
  // Legacy API (backward compat)
  KnownAgents,
  delegateTask,
  getPendingDelegations,
  updateDelegationStatus,
  reportDelegationResult,
  getAgentCapabilities,
  suggestDelegation,
};
