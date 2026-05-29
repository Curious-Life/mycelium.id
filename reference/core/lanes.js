/**
 * Lane-Based Request Serialization
 *
 * Prevents race conditions by serializing requests per agent.
 * Each agent has its own "lane" with a queue of pending tasks.
 */

// Lane storage (in-memory)
const lanes = new Map();

/**
 * Get or create a lane
 * @param {string} laneId - Lane identifier (e.g., 'agent:company-agent')
 * @returns {Object} Lane object with queue and state
 */
function getLane(laneId) {
  if (!lanes.has(laneId)) {
    lanes.set(laneId, {
      queue: [],
      active: null,
      processing: false,
    });
  }
  return lanes.get(laneId);
}

/**
 * Enqueue a task in a lane
 * Returns a promise that resolves when the task completes
 *
 * @param {string} laneId - Lane identifier
 * @param {Function} taskFn - Async function to execute
 * @param {Object} metadata - Optional metadata (e.g. { username, channel, taskType })
 * @returns {Promise} Resolves with task result
 */
export function enqueue(laneId, taskFn, metadata = {}) {
  return new Promise((resolve, reject) => {
    const lane = getLane(laneId);

    // Add to queue
    lane.queue.push({
      taskFn,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      metadata,
    });

    // Log if queue is getting long
    if (lane.queue.length > 5) {
      console.warn(`[Lanes] ${laneId} queue depth: ${lane.queue.length}`);
    }

    // Start processing if not already
    pump(laneId);
  });
}

/**
 * Process the next task in a lane's queue
 * @param {string} laneId - Lane identifier
 */
async function pump(laneId) {
  const lane = getLane(laneId);

  // Already processing or nothing to do
  if (lane.processing || lane.queue.length === 0) {
    return;
  }

  lane.processing = true;
  const entry = lane.queue.shift();
  lane.active = entry;

  // Log wait time if significant
  const waitedMs = Date.now() - entry.enqueuedAt;
  if (waitedMs > 5000) {
    console.log(`[Lanes] ${laneId} task waited ${waitedMs}ms in queue`);
  }

  try {
    const result = await entry.taskFn();
    entry.resolve(result);
  } catch (error) {
    entry.reject(error);
  } finally {
    lane.active = null;
    lane.processing = false;

    // Process next task (use setImmediate to avoid stack overflow)
    setImmediate(() => pump(laneId));
  }
}

/**
 * Get status of all lanes (for diagnostics)
 * @returns {Object} Lane status by laneId
 */
export function getLaneStatus() {
  const status = {};

  for (const [laneId, lane] of lanes.entries()) {
    status[laneId] = _buildLaneInfo(lane);
  }

  return status;
}

/**
 * Get info for a single lane (for /queue endpoint)
 * @param {string} laneId - Lane identifier
 * @returns {Object|null} Lane info or null if lane doesn't exist
 */
export function getLaneInfo(laneId) {
  const lane = lanes.get(laneId);
  if (!lane) return null;
  return _buildLaneInfo(lane);
}

function _buildLaneInfo(lane) {
  return {
    processing: lane.processing,
    queueLength: lane.queue.length,
    hasActive: !!lane.active,
    active: lane.active ? {
      enqueuedAt: lane.active.enqueuedAt,
      ...lane.active.metadata,
    } : null,
    queued: lane.queue.map(entry => ({
      enqueuedAt: entry.enqueuedAt,
      ...entry.metadata,
    })),
  };
}

/**
 * Clear a lane's queue (emergency)
 * @param {string} laneId - Lane identifier
 * @returns {number} Number of tasks cleared
 */
export function clearLane(laneId) {
  const lane = lanes.get(laneId);
  if (!lane) return 0;

  const cleared = lane.queue.length;

  // Reject all pending tasks
  for (const entry of lane.queue) {
    entry.reject(new Error('Lane cleared'));
  }

  lane.queue = [];
  console.log(`[Lanes] Cleared ${cleared} tasks from ${laneId}`);
  return cleared;
}

/**
 * Drain queued entries matching a predicate (for message coalescing)
 * Removes and returns matching entries from the queue.
 *
 * @param {string} laneId - Lane identifier
 * @param {Function} matchFn - Predicate: (metadata) => boolean
 * @returns {Array<{metadata, resolve, reject, enqueuedAt}>} Drained entries
 */
export function drainMatching(laneId, matchFn) {
  const lane = lanes.get(laneId);
  if (!lane) return [];

  const drained = [];
  lane.queue = lane.queue.filter(entry => {
    if (matchFn(entry.metadata)) {
      drained.push(entry);
      return false;
    }
    return true;
  });

  if (drained.length > 0) {
    console.log(`[Lanes] Drained ${drained.length} matching entries from ${laneId}`);
  }
  return drained;
}

/**
 * Cancel the active task in a lane (via AbortController in metadata)
 * @param {string} laneId - Lane identifier
 * @returns {boolean} Whether there was an active task to cancel
 */
export function cancelActive(laneId) {
  const lane = lanes.get(laneId);
  if (!lane?.active?.metadata?.abortController) return false;

  console.log(`[Lanes] Cancelling active task in ${laneId}`);
  lane.active.metadata.abortController.abort();
  return true;
}

/**
 * Create a lane-wrapped function
 * Useful for wrapping existing functions to serialize their calls
 *
 * @param {string} laneId - Lane identifier
 * @param {Function} fn - Function to wrap
 * @returns {Function} Wrapped function
 */
export function withLane(laneId, fn) {
  return (...args) => enqueue(laneId, () => fn(...args));
}

export default {
  enqueue,
  getLaneStatus,
  getLaneInfo,
  clearLane,
  drainMatching,
  cancelActive,
  withLane,
};
