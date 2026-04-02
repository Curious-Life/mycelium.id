/**
 * Timeout Configuration
 *
 * Simplified timeout config per user requirements:
 * - Chat: 10 minutes
 * - Research/Build: 60 minutes
 */

export const TIMEOUTS = {
  // Task-type based timeouts
  chat: 60 * 60 * 1000,       // 60 min for Discord chat
  think: 60 * 60 * 1000,      // 60 min for autonomous awakening
  research: 60 * 60 * 1000,   // 60 min for research tasks
  build: 60 * 60 * 1000,      // 60 min for build tasks

  // Fallback
  default: 60 * 60 * 1000,    // 60 min default

  // Grace period before hard kill (allows state save)
  gracePeriod: 30 * 1000,     // 30 sec

  // Keepalive interval for SSE streams
  keepalive: 15 * 1000,       // 15 sec
};

/**
 * Get timeout for a task type
 * @param {string} taskType - Type of task (chat, think, research, build)
 * @returns {number} Timeout in milliseconds
 */
export function getTimeout(taskType) {
  return TIMEOUTS[taskType] || TIMEOUTS.default;
}

/**
 * Get timeout with grace period info
 * @param {string} taskType - Type of task
 * @returns {{ timeout: number, gracePeriod: number }}
 */
export function getTimeoutConfig(taskType) {
  return {
    timeout: getTimeout(taskType),
    gracePeriod: TIMEOUTS.gracePeriod,
  };
}

export default TIMEOUTS;
