/**
 * Ephemeral Sub-Task Spawner (Tier 2)
 *
 * Lets persistent (Tier 1) agents spawn short-lived specialist agents
 * for focused tasks. Runs in-process as async functions — no PM2 processes,
 * no ports, no Express servers.
 *
 * Key properties:
 * - Fresh --print invocation (no --resume — ephemeral = stateless)
 * - Isolated context (specialist only sees what you pass)
 * - AbortController for TTL enforcement
 * - Guardrails: max per parent, max total, max TTL
 *
 * Usage:
 *   const result = await spawnTask(parentRuntime, {
 *     role: 'financial-analyst',
 *     task: 'Analyze Q4 revenue trends',
 *     context: 'Revenue data: ...',
 *     model: 'haiku',
 *   });
 */

import { randomBytes } from 'crypto';
import { createRuntime } from './runtime.js';
import { runClaudeCode } from './runner.js';
import { logEvent } from './events.js';

// ============================================
// Guardrails
// ============================================

const LIMITS = {
  maxPerParent: 3,
  maxTotal: 10,
  defaultTtlMs: 30 * 60 * 1000,    // 30 minutes
  maxTtlMs: 120 * 60 * 1000,       // 2 hours
  cleanupAfterMs: 24 * 60 * 60 * 1000,  // 24 hours
};

// Track active spawns: Map<parentAgentId, Set<taskId>>
const activeSpawns = new Map();

// Recent results for retrieval: Map<taskId, result>
const recentResults = new Map();

// ============================================
// Core Spawn Function
// ============================================

/**
 * Spawn a focused sub-agent for a specific task.
 * Runs in-process with isolated context and returns results directly.
 *
 * @param {Object} parentRuntime - Parent agent's runtime context
 * @param {Object} config
 * @param {string} config.role - Specialist role (e.g., 'financial-analyst', 'copywriter')
 * @param {string} config.task - Specific instructions
 * @param {string} [config.context] - Only what the specialist needs
 * @param {string} [config.model='sonnet'] - Model to use (sonnet default, haiku for trivial only)
 * @param {number} [config.maxTurns=10] - Max tool use cycles
 * @param {number} [config.ttlMs] - Time-to-live in ms (default: 30 min)
 * @returns {Promise<{taskId: string, status: string, result?: string, error?: string}>}
 */
export async function spawnTask(parentRuntime, { role, task, context, model = 'sonnet', maxTurns = 10, ttlMs }) {
  const nanoid = randomBytes(4).toString('hex');
  const taskId = `ephemeral-${role}-${nanoid}`;
  const ttl = Math.min(ttlMs || LIMITS.defaultTtlMs, LIMITS.maxTtlMs);

  // Guardrail: energy budget
  try {
    const { getAgentEnergyState } = await import('./energy-state.js');
    const energy = await getAgentEnergyState(parentRuntime.agentId);
    if (energy.level === 'critical') {
      throw new Error('Energy critical — spawns disabled to conserve budget.');
    }
    if (energy.level === 'low' && model === 'opus') {
      model = 'sonnet';
      console.log(`[Spawner] Energy low — downshifted ${taskId} from opus to sonnet`);
    }
  } catch (e) {
    if (e.message.includes('Energy critical')) throw e;
    // energy module not available — continue without guardrail
  }

  // Guardrail: max per parent
  const parentSpawns = activeSpawns.get(parentRuntime.agentId) || new Set();
  if (parentSpawns.size >= LIMITS.maxPerParent) {
    throw new Error(`Already have ${LIMITS.maxPerParent} active sub-tasks. Wait for one to finish.`);
  }

  // Guardrail: max total
  const totalActive = [...activeSpawns.values()].reduce((s, set) => s + set.size, 0);
  if (totalActive >= LIMITS.maxTotal) {
    throw new Error(`System limit of ${LIMITS.maxTotal} concurrent spawns reached.`);
  }

  // Track
  parentSpawns.add(taskId);
  activeSpawns.set(parentRuntime.agentId, parentSpawns);

  // Isolated child runtime — propagated trace, fresh context
  const childRuntime = createRuntime(taskId, {
    traceId: parentRuntime.traceId,
    parentSpanId: parentRuntime.agentId,
    agentPath: `${parentRuntime.agentPath} -> ${role}`,
    model,
    tier: 2,
  });

  logEvent(childRuntime, 'spawn.start', {
    payload: { parentAgentId: parentRuntime.agentId, role, model, maxTurns, ttlMs: ttl },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('TTL expired'), ttl);

  try {
    const systemPrompt = `You are a specialist ${role}. Complete the assigned task thoroughly and return your findings concisely.`;
    const fullPrompt = context ? `Context:\n${context}\n\nTask:\n${task}` : task;

    // Fresh --print invocation, NO --resume (ephemeral = stateless)
    // Uses parent's repo cwd so specialist can read files if needed
    const { result: output } = await runClaudeCode(fullPrompt, {
      systemPrompt,
      model,
      maxTurns,
      signal: controller.signal,
      cwd: parentRuntime.paths.repo,
      taskType: 'research',
      // No agentRoot — don't write checkpoints for ephemeral tasks
      // No resumeSessionId — ephemeral tasks are one-shot
    });

    logEvent(childRuntime, 'spawn.complete', {
      payload: { parentAgentId: parentRuntime.agentId, role, resultLength: output?.length || 0 },
    });

    const result = { taskId, status: 'completed', result: output };
    recentResults.set(taskId, result);
    return result;
  } catch (error) {
    const aborted = controller.signal.aborted;
    logEvent(childRuntime, 'spawn.error', {
      payload: { parentAgentId: parentRuntime.agentId, role, error: error.message, aborted },
    });

    const result = { taskId, status: aborted ? 'timeout' : 'error', error: error.message };
    recentResults.set(taskId, result);
    return result;
  } finally {
    clearTimeout(timeout);
    parentSpawns.delete(taskId);

    // Schedule cleanup of result data
    setTimeout(() => {
      recentResults.delete(taskId);
    }, LIMITS.cleanupAfterMs);
  }
}

// ============================================
// Status & Retrieval
// ============================================

/**
 * List active spawns for all parents or a specific parent
 * @param {string} [parentAgentId] - Filter by parent (optional)
 * @returns {Object} Active spawn info
 */
export function listActiveSpawns(parentAgentId) {
  if (parentAgentId) {
    const spawns = activeSpawns.get(parentAgentId);
    return {
      parentAgentId,
      active: spawns ? [...spawns] : [],
      count: spawns?.size || 0,
    };
  }

  const all = {};
  for (const [parent, spawns] of activeSpawns) {
    all[parent] = {
      active: [...spawns],
      count: spawns.size,
    };
  }
  return all;
}

/**
 * Get spawn result (if available)
 * @param {string} taskId - Spawn task ID
 * @returns {Object|null} Spawn result or null
 */
export function getSpawnResult(taskId) {
  return recentResults.get(taskId) || null;
}

/**
 * Get guardrail limits
 */
export function getSpawnLimits() {
  return { ...LIMITS };
}

export default {
  spawnTask,
  listActiveSpawns,
  getSpawnResult,
  getSpawnLimits,
};
