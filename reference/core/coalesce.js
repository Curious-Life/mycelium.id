/**
 * Wake Coalescing
 *
 * Prevents multiple simultaneous wakes by coalescing requests within a time window.
 * If cron fires and Discord message arrives simultaneously, only one heartbeat runs.
 */

const COALESCE_MS = 250; // 250ms coalesce window

// Pending wake requests per agent
const pendingWakes = new Map();

/**
 * Request a wake for an agent with coalescing
 *
 * Multiple wake requests within COALESCE_MS will be combined into one.
 *
 * @param {string} agentId - Agent identifier
 * @param {string} reason - Reason for wake (e.g., 'cron', 'discord', 'task')
 * @param {Function} wakeFn - Async function to execute the wake
 * @returns {Promise} Resolves when wake completes
 */
export function requestWake(agentId, reason, wakeFn) {
  const existing = pendingWakes.get(agentId);

  // If there's already a pending wake, add our reason and return its promise
  if (existing) {
    existing.reasons.push(reason);
    console.log(`[Coalesce] Wake for ${agentId} coalesced (reasons: ${existing.reasons.join(', ')})`);
    return existing.promise;
  }

  // Create new pending wake
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const pending = {
    reasons: [reason],
    promise,
    resolve,
    reject,
    timeout: null,
  };

  pendingWakes.set(agentId, pending);

  // Set coalesce timeout
  pending.timeout = setTimeout(async () => {
    const wake = pendingWakes.get(agentId);
    pendingWakes.delete(agentId);

    if (!wake) return;

    const combinedReason = wake.reasons.join('+');
    console.log(`[Coalesce] Executing coalesced wake for ${agentId} (reasons: ${combinedReason})`);

    try {
      const result = await wakeFn(combinedReason);
      wake.resolve(result);
    } catch (error) {
      wake.reject(error);
    }
  }, COALESCE_MS);

  return promise;
}

/**
 * Cancel a pending wake (if not yet executed)
 *
 * @param {string} agentId - Agent identifier
 * @returns {boolean} True if a wake was cancelled
 */
export function cancelWake(agentId) {
  const pending = pendingWakes.get(agentId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingWakes.delete(agentId);
  pending.reject(new Error('Wake cancelled'));

  console.log(`[Coalesce] Wake cancelled for ${agentId}`);
  return true;
}

/**
 * Check if there's a pending wake for an agent
 *
 * @param {string} agentId - Agent identifier
 * @returns {{ pending: boolean, reasons?: string[] }}
 */
export function hasPendingWake(agentId) {
  const pending = pendingWakes.get(agentId);
  if (!pending) return { pending: false };

  return {
    pending: true,
    reasons: pending.reasons,
  };
}

/**
 * Force immediate execution of a pending wake (skip coalesce window)
 *
 * @param {string} agentId - Agent identifier
 * @returns {boolean} True if a wake was forced
 */
export function forceWake(agentId) {
  const pending = pendingWakes.get(agentId);
  if (!pending) return false;

  // Clear the timeout and trigger immediately
  clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => {}, 0); // Trigger on next tick

  console.log(`[Coalesce] Forcing immediate wake for ${agentId}`);
  return true;
}

/**
 * Get status of all pending wakes
 *
 * @returns {Object} Map of agentId to pending reasons
 */
export function getPendingWakes() {
  const status = {};
  for (const [agentId, pending] of pendingWakes.entries()) {
    status[agentId] = {
      reasons: pending.reasons,
      waitingMs: COALESCE_MS,
    };
  }
  return status;
}

export default {
  requestWake,
  cancelWake,
  hasPendingWake,
  forceWake,
  getPendingWakes,
  COALESCE_MS,
};
