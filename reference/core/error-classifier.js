/**
 * Error Classification and Recovery
 *
 * Classifies errors into categories and provides recovery strategies.
 */

import * as Sentry from '@sentry/node';

export const ErrorReason = {
  RATE_LIMIT: 'rate_limit',       // 429 - wait and retry
  AUTH: 'auth',                    // 401/403 - try different key
  BILLING: 'billing',              // 402 - out of credits
  TIMEOUT: 'timeout',              // Request timed out
  CONTEXT_OVERFLOW: 'context',     // Too much history
  MODEL_ERROR: 'model',            // Model returned garbage
  NETWORK: 'network',              // Connection failed
  PROCESS_ERROR: 'process',        // Subprocess crashed
  EMPTY_OUTPUT: 'empty_output',    // Claude Code exited 0 but produced no/empty output
  UNKNOWN: 'unknown',
};

/**
 * Classify an error into a reason category
 * @param {Error} error - The error to classify
 * @returns {string} ErrorReason value
 */
export function classifyError(error) {
  if (!error) return ErrorReason.UNKNOWN;

  // HTTP status codes
  const status = error.status || error.statusCode || error.code;
  if (status === 429) return ErrorReason.RATE_LIMIT;
  if (status === 401 || status === 403) return ErrorReason.AUTH;
  if (status === 402) return ErrorReason.BILLING;
  if (status === 408) return ErrorReason.TIMEOUT;

  // Error messages
  const msg = (error.message || '').toLowerCase();

  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) {
    return ErrorReason.RATE_LIMIT;
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline')) {
    return ErrorReason.TIMEOUT;
  }
  if (msg.includes('context') || msg.includes('too long') || msg.includes('token limit')) {
    return ErrorReason.CONTEXT_OVERFLOW;
  }
  if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid key')) {
    return ErrorReason.AUTH;
  }
  if (msg.includes('billing') || msg.includes('payment') || msg.includes('credit')) {
    return ErrorReason.BILLING;
  }
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch failed')) {
    return ErrorReason.NETWORK;
  }
  if (msg.includes('exited with code') || msg.includes('sigterm') || msg.includes('sigkill')) {
    return ErrorReason.PROCESS_ERROR;
  }
  if (msg.includes('empty') && (msg.includes('output') || msg.includes('result'))) {
    return ErrorReason.EMPTY_OUTPUT;
  }

  // Error codes (Node.js)
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(error.code)) {
    return ErrorReason.NETWORK;
  }

  return ErrorReason.UNKNOWN;
}

/**
 * Recovery actions for each error type
 * Returns: { action: 'retry'|'fallback'|'fail', waitMs?: number, maxRetries?: number }
 */
export const RECOVERY_ACTIONS = {
  [ErrorReason.RATE_LIMIT]: {
    action: 'fallback',
    waitMs: 60000,  // 60 sec before retry with same profile
  },

  [ErrorReason.AUTH]: {
    action: 'fallback',  // Try different profile
    permanent: true,     // Mark profile as broken
  },

  [ErrorReason.BILLING]: {
    action: 'fallback',  // Try different profile
    permanent: true,     // Mark profile as broken
    alert: true,         // Should alert human
  },

  [ErrorReason.TIMEOUT]: {
    action: 'retry',
    waitMs: 5000,
    maxRetries: 2,
  },

  [ErrorReason.CONTEXT_OVERFLOW]: {
    action: 'compact',   // Special: need to compact context
  },

  [ErrorReason.NETWORK]: {
    action: 'retry',
    waitMs: 2000,
    maxRetries: 3,
  },

  [ErrorReason.PROCESS_ERROR]: {
    action: 'retry',
    waitMs: 1000,
    maxRetries: 2,
  },

  [ErrorReason.MODEL_ERROR]: {
    action: 'fallback',  // Try different model
  },

  [ErrorReason.EMPTY_OUTPUT]: {
    action: 'retry',     // Retry with fresh session (caller should clear resume ID)
    waitMs: 1000,
    maxRetries: 1,
  },

  [ErrorReason.UNKNOWN]: {
    action: 'fail',      // Don't retry unknown errors
  },
};

/**
 * Get recovery action for an error
 * @param {Error} error - The error
 * @returns {Object} Recovery action config
 */
export function getRecoveryAction(error) {
  const reason = classifyError(error);
  return {
    reason,
    ...RECOVERY_ACTIONS[reason],
  };
}

/**
 * Report an error to Sentry with classification context.
 * @param {Error} error - The error
 * @param {Object} [extra] - Additional context (agentId, taskType, etc.)
 */
export function captureError(error, extra = {}) {
  const reason = classifyError(error);
  Sentry.withScope((scope) => {
    scope.setTag('error.reason', reason);
    scope.setLevel(reason === ErrorReason.BILLING ? 'fatal' : 'error');
    if (extra.agentId) scope.setTag('agent', extra.agentId);
    if (extra.taskType) scope.setTag('taskType', extra.taskType);
    scope.setExtras(extra);
    Sentry.captureException(error);
  });
}

/**
 * Sleep helper
 * @param {number} ms - Milliseconds to sleep
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  ErrorReason,
  classifyError,
  getRecoveryAction,
  captureError,
  RECOVERY_ACTIONS,
  sleep,
};
