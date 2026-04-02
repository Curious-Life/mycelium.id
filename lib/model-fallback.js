/**
 * Model Fallback Chain
 *
 * Provides resilient model execution with fallback to alternative models/profiles.
 */

import { isProfileInCooldown, markProfileFailure, markProfileGood } from './cooldowns.js';
import { classifyError, getRecoveryAction, sleep, ErrorReason } from './error-classifier.js';

/**
 * Default model configuration with fallback chain.
 * Follows Anthropic's recommendation: capable model first, cheaper fallback.
 *
 * Primary: Sonnet 4.5 (best balance of capability and cost)
 * Fallback: Haiku 4.5 (fast, cheap, sufficient for most fallback scenarios)
 */
export const DEFAULT_MODEL_CONFIG = {
  primary: {
    provider: 'anthropic',
    model: 'sonnet',
    profile: 'default',
  },
  fallbacks: [
    {
      provider: 'anthropic',
      model: 'haiku',
      profile: 'default',
    },
  ],
};

/**
 * Model fallback configs by task type.
 * Think tasks fall back from opus → sonnet → haiku.
 * Chat tasks fall back from sonnet → haiku.
 * Spawn tasks use haiku only (cheapest).
 */
export const TASK_MODEL_CONFIGS = {
  think: {
    primary: { provider: 'anthropic', model: 'opus', profile: 'default' },
    fallbacks: [
      { provider: 'anthropic', model: 'sonnet', profile: 'default' },
      { provider: 'anthropic', model: 'haiku', profile: 'default' },
    ],
  },
  chat: {
    primary: { provider: 'anthropic', model: 'sonnet', profile: 'default' },
    fallbacks: [
      { provider: 'anthropic', model: 'haiku', profile: 'default' },
    ],
  },
  spawn: {
    primary: { provider: 'anthropic', model: 'sonnet', profile: 'default' },
    fallbacks: [
      { provider: 'anthropic', model: 'haiku', profile: 'default' },
    ],
  },
  research: {
    primary: { provider: 'anthropic', model: 'sonnet', profile: 'default' },
    fallbacks: [
      { provider: 'anthropic', model: 'haiku', profile: 'default' },
    ],
  },
};

/**
 * Run a task with automatic model fallback
 *
 * @param {Object} options
 * @param {Function} options.run - Async function that takes a model config and executes the task
 * @param {Object} options.config - Model configuration (optional, uses DEFAULT_MODEL_CONFIG)
 * @param {number} options.maxRetries - Max retries per model (default: 2)
 * @param {Function} options.onFallback - Callback when falling back (optional)
 * @returns {Promise<{ result: *, model: Object, attempts: Array }>}
 */
export async function runWithFallback({
  run,
  config = DEFAULT_MODEL_CONFIG,
  maxRetries = 2,
  onFallback = null,
}) {
  const candidates = [config.primary, ...config.fallbacks];
  const attempts = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateKey = `${candidate.provider}:${candidate.model}:${candidate.profile}`;

    // Check cooldown
    const cooldownStatus = await isProfileInCooldown(candidateKey);
    if (cooldownStatus.inCooldown) {
      attempts.push({
        ...candidate,
        skipped: true,
        reason: cooldownStatus.reason,
        cooldownUntil: cooldownStatus.until,
      });
      continue;
    }

    // Try this candidate with retries
    let lastError = null;
    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        const result = await run(candidate);

        // Success! Mark profile as good
        await markProfileGood(candidateKey);

        return {
          result,
          model: candidate,
          attempts,
          retries: retry,
        };
      } catch (error) {
        lastError = error;
        const recovery = getRecoveryAction(error);

        attempts.push({
          ...candidate,
          error: recovery.reason,
          errorMessage: error.message,
          retry,
        });

        // Handle based on recovery action
        if (recovery.action === 'fail') {
          // Don't retry, don't fallback
          throw error;
        }

        if (recovery.action === 'fallback') {
          // Mark profile and move to next candidate
          await markProfileFailure(candidateKey, recovery.reason, recovery.permanent);
          break; // Exit retry loop, try next candidate
        }

        if (recovery.action === 'retry') {
          // Retry with same candidate
          if (retry < maxRetries) {
            if (recovery.waitMs) {
              await sleep(recovery.waitMs);
            }
            continue; // Retry
          }
          // Max retries reached, try next candidate
          break;
        }

        if (recovery.action === 'compact') {
          // Special case: context overflow
          // The caller needs to handle this
          throw Object.assign(error, { needsCompaction: true });
        }
      }
    }

    // Notify of fallback
    if (onFallback && i < candidates.length - 1) {
      onFallback({
        failed: candidate,
        next: candidates[i + 1],
        error: lastError,
      });
    }
  }

  // All candidates failed
  const error = new Error(`All models failed after ${attempts.length} attempts`);
  error.attempts = attempts;
  throw error;
}

/**
 * Create a model-specific run function for Claude Code
 * This wraps the spawn logic to use the specified model
 *
 * @param {Object} model - Model configuration
 * @returns {string} Model argument for Claude Code CLI
 */
export function getModelArg(model) {
  // Claude Code uses simple model names
  // Maps model identifiers to Claude Code CLI --model values
  const modelMap = {
    'sonnet': 'sonnet',
    'haiku': 'haiku',
    'opus': 'opus',
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-haiku-4-5-20251001': 'haiku',
    'claude-opus-4-6': 'opus',
    // Legacy IDs
    'claude-sonnet-4-5-20250514': 'sonnet',
    'claude-3-5-haiku-20241022': 'haiku',
    'claude-opus-4-5-20251101': 'opus',
  };

  return modelMap[model.model] || 'sonnet';
}

/**
 * Simple single-model runner (no fallback)
 * Useful when you want to explicitly control the model
 *
 * @param {Function} run - Task function
 * @param {Object} model - Model config
 * @returns {Promise<*>}
 */
export async function runWithModel(run, model) {
  const candidateKey = `${model.provider}:${model.model}:${model.profile || 'default'}`;

  // Check cooldown
  const cooldownStatus = await isProfileInCooldown(candidateKey);
  if (cooldownStatus.inCooldown) {
    throw new Error(`Model ${candidateKey} is in cooldown until ${cooldownStatus.until}`);
  }

  try {
    const result = await run(model);
    await markProfileGood(candidateKey);
    return result;
  } catch (error) {
    const recovery = getRecoveryAction(error);
    await markProfileFailure(candidateKey, recovery.reason, recovery.permanent);
    throw error;
  }
}

export default {
  runWithFallback,
  runWithModel,
  getModelArg,
  DEFAULT_MODEL_CONFIG,
  TASK_MODEL_CONFIGS,
};
