/**
 * Runtime Context Factory
 *
 * Creates a frozen runtime context that threads through all agent operations.
 * This is the single source of truth for agent identity, paths, configuration,
 * and trace context.
 *
 * Model Selection:
 *   runtime.models maps task types to model names.
 *   Use getModelForTask(runtime, 'think') to resolve the right model.
 *   Agents running on capable models (Opus) naturally choose appropriate
 *   sub-models via the spawn system.
 *
 * Usage:
 *   const runtime = createRuntime('research-agent');
 *   // Pass runtime to all lib functions instead of loose params
 */

import os from 'os';
import { getAgentPaths, ensureAgentStructure } from './paths.js';
import { initDb, tryGetDb } from './db.js';

/**
 * Default per-task-type model map.
 * Override via MODEL_THINK, MODEL_CHAT, MODEL_SPAWN env vars,
 * or pass overrides.models to createRuntime.
 *
 * Follows Anthropic's recommendation:
 * - Opus for complex reasoning, strategic planning (think cycles)
 * - Sonnet for standard interactions, coding tasks (chat)
 * - Sonnet for focused sub-tasks (spawn) — haiku only for trivial lookups
 */
const DEFAULT_MODELS = {
  think: 'opus',     // Autonomous thinking, strategic planning, complex tasks
  chat: 'sonnet',    // Interactive chat, coding, standard work
  spawn: 'sonnet',   // Ephemeral sub-tasks, focused specialists (haiku for trivial only)
  research: 'sonnet', // Research tasks (deeper than spawn, lighter than think)
  default: 'sonnet', // Fallback for unknown task types
};

/**
 * Create a frozen runtime context for an agent
 *
 * @param {string} agentId - Agent identifier (e.g., 'company-agent', 'research-agent')
 * @param {Object} [overrides] - Override defaults (used by spawner for child runtimes)
 * @param {string} [overrides.traceId] - Trace ID propagated through spawn chains
 * @param {string} [overrides.parentSpanId] - Parent span for trace tree
 * @param {string} [overrides.agentPath] - Human-readable agent chain (e.g., "mya → ada → analyst")
 * @param {string} [overrides.model] - Model override
 * @param {number} [overrides.tier] - Agent tier (1 = persistent, 2 = ephemeral)
 * @param {number} [overrides.port] - Port override
 * @param {string} [overrides.instanceId] - Instance ID for federation
 * @param {string} [overrides.publicUrl] - Public URL for federation
 * @returns {Readonly<Object>} Frozen runtime context
 */
export function createRuntime(agentId, overrides = {}) {
  const paths = getAgentPaths(agentId);

  const port = overrides.port || parseInt(process.env.PORT || '3002');

  return Object.freeze({
    agentId,
    paths,

    // Trace context — flows through spawn chains
    traceId: overrides.traceId || `trace_${Date.now()}_${agentId}`,
    parentSpanId: overrides.parentSpanId || null,
    agentPath: overrides.agentPath || agentId,

    // Config — single model (legacy, still used as base default)
    model: overrides.model || process.env.MODEL || 'sonnet',
    tier: overrides.tier || parseInt(process.env.AGENT_TIER || '1'),
    port,

    // Per-task-type model map — resolves via getModelForTask()
    models: Object.freeze({
      ...DEFAULT_MODELS,
      // Env var overrides (MODEL_THINK=opus, MODEL_CHAT=sonnet, etc.)
      ...(process.env.MODEL_THINK ? { think: process.env.MODEL_THINK } : {}),
      ...(process.env.MODEL_CHAT ? { chat: process.env.MODEL_CHAT } : {}),
      ...(process.env.MODEL_SPAWN ? { spawn: process.env.MODEL_SPAWN } : {}),
      ...(process.env.MODEL_RESEARCH ? { research: process.env.MODEL_RESEARCH } : {}),
      // Override default to match the base MODEL env
      default: overrides.model || process.env.MODEL || 'sonnet',
      // Explicit overrides from caller (e.g., registry config)
      ...(overrides.models || {}),
    }),

    // Instance identity — for federation (Phase 6)
    instanceId: overrides.instanceId || process.env.INSTANCE_ID || `instance_${os.hostname()}`,
    publicUrl: overrides.publicUrl || process.env.PUBLIC_URL || `http://localhost:${port}`,

    // Feature flags
    features: Object.freeze({
      hasDb: !!process.env.MYA_WORKER_URL,
      hasDiscord: !!process.env.DISCORD_BOT_TOKEN,
      hasR2: !!process.env.R2_ACCESS_KEY_ID,
      heartbeatEnabled: process.env.HEARTBEAT_ENABLED === 'true',
    }),
  });
}

/**
 * Create runtime with database initialized
 *
 * Separate from createRuntime() because:
 * 1. DB initialization is async
 * 2. Not all agents need DB (ephemeral sub-tasks, standalone mode)
 * 3. Keeps createRuntime() synchronous and fast
 *
 * @param {string} agentId - Agent identifier
 * @param {Object} [overrides] - Same as createRuntime
 * @returns {Promise<Readonly<Object>>} Runtime with database initialized
 */
export async function createRuntimeWithDb(agentId, overrides = {}) {
  const base = createRuntime(agentId, overrides);

  if (!base.features.hasDb) {
    return base;
  }

  try {
    await initDb();
    return base;
  } catch (error) {
    console.error('[Runtime] Failed to initialize database:', error.message);
    return base;
  }
}

/** @deprecated Use createRuntimeWithDb instead */
export const createRuntimeWithSupabase = createRuntimeWithDb;

/**
 * Ensure agent directory structure exists
 * Convenience wrapper that uses the runtime's agentId
 *
 * @param {Object} runtime - Runtime context
 */
export async function ensureAgentReady(runtime) {
  await ensureAgentStructure(runtime.agentId);
}

/**
 * Get the appropriate model for a given task type.
 *
 * @param {Object} runtime - Runtime context
 * @param {string} taskType - Task type (think, chat, spawn, research, etc.)
 * @returns {string} Model name (e.g., 'opus', 'sonnet', 'haiku')
 */
export function getModelForTask(runtime, taskType) {
  return runtime.models?.[taskType] || runtime.models?.default || runtime.model;
}

/**
 * Get the DEFAULT_MODELS configuration (for logging/diagnostics).
 */
export function getDefaultModels() {
  return { ...DEFAULT_MODELS };
}

export default { createRuntime, createRuntimeWithDb, createRuntimeWithSupabase, ensureAgentReady, getModelForTask, getDefaultModels };
