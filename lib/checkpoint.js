/**
 * Checkpoint management for task persistence
 *
 * Implements the "restart sentinel" pattern:
 * - Write checkpoint BEFORE task starts
 * - Update checkpoint AFTER task completes/fails
 * - On startup, check for incomplete checkpoints
 *
 * This allows recovery from crashes, timeouts, and restarts.
 */

import { writeFile, readFile, unlink, mkdir, appendFile } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import path from 'path';

const CHECKPOINT_DIR = 'checkpoints';
const ACTIVE_CHECKPOINT_DIR = 'checkpoints/active';
const COMPLETED_HASHES_FILE = 'checkpoints/completed-hashes.jsonl';

/**
 * Get checkpoint file path for a specific session
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Session identifier
 */
function getCheckpointPath(agentRoot, sessionId) {
  return path.join(agentRoot, ACTIVE_CHECKPOINT_DIR, `${sessionId}.json`);
}

/**
 * Get active checkpoints directory
 * @param {string} agentRoot - Root directory of the agent
 */
function getActiveCheckpointDir(agentRoot) {
  return path.join(agentRoot, ACTIVE_CHECKPOINT_DIR);
}

/**
 * Get checkpoint archive directory
 * @param {string} agentRoot - Root directory of the agent
 */
function getCheckpointDir(agentRoot) {
  return path.join(agentRoot, CHECKPOINT_DIR);
}

/**
 * Write a checkpoint before starting a task
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {Object} checkpoint - Checkpoint data
 * @param {string} checkpoint.agentId - Agent identifier
 * @param {string} checkpoint.taskType - Type of task (chat, think, research, build)
 * @param {string} checkpoint.sessionId - Session identifier for history recovery
 * @param {string} checkpoint.promptSummary - First N chars of prompt
 * @param {string} [checkpoint.promptHash] - SHA256 hash of full prompt
 * @param {Object} [checkpoint.deliveryContext] - Where to send notifications
 * @param {string} [checkpoint.model] - Model being used
 * @param {number} [checkpoint.maxTurns] - Max tool use cycles
 * @param {number} [checkpoint.timeout] - Timeout in ms
 * @returns {Promise<Object>} The written checkpoint with generated fields
 */
export async function writeCheckpoint(agentRoot, checkpoint) {
  if (!checkpoint.sessionId) {
    console.error('[Checkpoint] sessionId required for checkpoint');
    return checkpoint;
  }

  const filePath = getCheckpointPath(agentRoot, checkpoint.sessionId);
  const data = {
    id: randomUUID(),
    state: 'running',
    startedAt: new Date().toISOString(),
    ...checkpoint,
  };

  try {
    // Ensure directory exists
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('[Checkpoint] Failed to write checkpoint:', error.message);
    // Don't throw - checkpoint failure shouldn't block task execution
    return data;
  }
}

/**
 * Update checkpoint state (completed, failed, interrupted)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Session identifier
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>} Updated checkpoint or null if not found
 */
export async function updateCheckpoint(agentRoot, sessionId, updates) {
  if (!sessionId) {
    console.error('[Checkpoint] sessionId required for updateCheckpoint');
    return null;
  }

  const filePath = getCheckpointPath(agentRoot, sessionId);
  try {
    const current = JSON.parse(await readFile(filePath, 'utf8'));
    const updated = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(filePath, JSON.stringify(updated, null, 2));
    return updated;
  } catch (error) {
    // No checkpoint to update, or parse error
    return null;
  }
}

/**
 * Clear checkpoint (task completed successfully)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Session identifier
 */
export async function clearCheckpoint(agentRoot, sessionId) {
  if (!sessionId) {
    console.error('[Checkpoint] sessionId required for clearCheckpoint');
    return;
  }

  const filePath = getCheckpointPath(agentRoot, sessionId);
  try {
    await unlink(filePath);
  } catch (error) {
    // File doesn't exist, that's fine
  }
}

/**
 * Read a specific checkpoint by sessionId
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Object|null>} Checkpoint data or null
 */
export async function readCheckpoint(agentRoot, sessionId) {
  if (!sessionId) {
    console.error('[Checkpoint] sessionId required for readCheckpoint');
    return null;
  }

  const filePath = getCheckpointPath(agentRoot, sessionId);
  try {
    const data = await readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // No checkpoint - normal case
    }
    // Corrupt file - log warning and delete it
    console.warn(`[Checkpoint] Corrupt checkpoint file ${sessionId}, deleting:`, error.message);
    try {
      await unlink(filePath);
    } catch (e) {
      // Ignore unlink errors
    }
    return null;
  }
}

/**
 * Read all active checkpoints (for recovery on startup)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @returns {Promise<Object[]>} Array of checkpoint data
 */
export async function readAllCheckpoints(agentRoot) {
  const dir = getActiveCheckpointDir(agentRoot);
  const checkpoints = [];

  try {
    const { readdir } = await import('fs/promises');
    const files = await readdir(dir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(dir, file);
      try {
        const data = await readFile(filePath, 'utf8');
        checkpoints.push(JSON.parse(data));
      } catch (e) {
        // Corrupt checkpoint file - log warning and delete it
        console.warn(`[Checkpoint] Corrupt checkpoint file ${file}, deleting:`, e.message);
        try {
          await unlink(filePath);
        } catch (unlinkErr) {
          // Ignore unlink errors
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist, return empty
  }

  return checkpoints;
}

/**
 * Check if checkpoint is stale (crashed mid-task)
 *
 * @param {Object} checkpoint - The checkpoint to check
 * @param {number} [maxAge=7200000] - Maximum age in ms (default 2 hours)
 * @returns {boolean} True if checkpoint is stale
 */
export function isStaleCheckpoint(checkpoint, maxAge = 2 * 60 * 60 * 1000) {
  if (!checkpoint || checkpoint.state !== 'running') return false;
  const age = Date.now() - new Date(checkpoint.startedAt).getTime();
  return age > maxAge;
}

/**
 * Check if checkpoint represents an interrupted task
 *
 * @param {Object} checkpoint - The checkpoint to check
 * @returns {boolean} True if task was interrupted
 */
export function isInterruptedCheckpoint(checkpoint) {
  return checkpoint && checkpoint.state === 'running';
}

/**
 * Create prompt hash for deduplication
 *
 * @param {string} prompt - The prompt to hash
 * @returns {string} First 16 chars of SHA256 hash
 */
export function hashPrompt(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * Check if a prompt hash was already completed recently (for deduplication)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} promptHash - SHA256 hash of the prompt
 * @param {number} maxAge - Max age in ms to consider (default 5 min)
 * @returns {Promise<boolean>} True if this hash was completed recently
 */
export async function wasRecentlyCompleted(agentRoot, promptHash, maxAge = 5 * 60 * 1000) {
  const filePath = path.join(agentRoot, COMPLETED_HASHES_FILE);
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const now = Date.now();

    for (const line of lines.slice(-100)) { // Only check last 100 entries
      try {
        const entry = JSON.parse(line);
        if (entry.hash === promptHash && (now - entry.ts) < maxAge) {
          console.log(`[Checkpoint] Skipping duplicate prompt (completed ${Math.round((now - entry.ts) / 1000)}s ago)`);
          return true;
        }
      } catch (e) {
        // Skip corrupt lines
      }
    }
  } catch (error) {
    // File doesn't exist, that's fine
  }
  return false;
}

/**
 * Mark a prompt hash as completed (for deduplication)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} promptHash - SHA256 hash of the prompt
 */
export async function markCompleted(agentRoot, promptHash) {
  const filePath = path.join(agentRoot, COMPLETED_HASHES_FILE);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const entry = { hash: promptHash, ts: Date.now() };
    await appendFile(filePath, JSON.stringify(entry) + '\n');
  } catch (error) {
    console.error('[Checkpoint] Failed to mark completed:', error.message);
  }
}

/**
 * Archive a checkpoint (for debugging/history)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {Object} checkpoint - Checkpoint to archive
 */
export async function archiveCheckpoint(agentRoot, checkpoint) {
  try {
    const dir = getCheckpointDir(agentRoot);
    await mkdir(dir, { recursive: true });

    const timestamp = (checkpoint.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
    const filename = `${timestamp}-${checkpoint.id?.slice(0, 8) || 'unknown'}.json`;

    await writeFile(path.join(dir, filename), JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    console.error('[Checkpoint] Failed to archive checkpoint:', error.message);
  }
}

/**
 * Get summary of checkpoint for logging/notifications
 *
 * @param {Object} checkpoint - The checkpoint
 * @returns {string} Human-readable summary
 */
export function getCheckpointSummary(checkpoint) {
  if (!checkpoint) return 'No checkpoint';

  const age = Date.now() - new Date(checkpoint.startedAt).getTime();
  const ageStr = age < 60000 ? `${Math.round(age / 1000)}s` :
    age < 3600000 ? `${Math.round(age / 60000)}m` :
      `${Math.round(age / 3600000)}h`;

  return `[${checkpoint.taskType}] ${checkpoint.state} (${ageStr} ago) - "${checkpoint.promptSummary?.slice(0, 50)}..."`;
}

/**
 * Clean up old archived checkpoints
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {number} [maxAge=604800000] - Max age in ms (default 7 days)
 */
export async function cleanupArchivedCheckpoints(agentRoot, maxAge = 7 * 24 * 60 * 60 * 1000) {
  const dir = getCheckpointDir(agentRoot);
  try {
    const { readdir, stat, unlink } = await import('fs/promises');
    const files = await readdir(dir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(dir, file);
      const fileStat = await stat(filePath);

      if (Date.now() - fileStat.mtimeMs > maxAge) {
        await unlink(filePath);
        console.log(`[Checkpoint] Cleaned up old checkpoint: ${file}`);
      }
    }
  } catch (error) {
    // Directory doesn't exist or other error, that's fine
  }
}

export default {
  writeCheckpoint,
  updateCheckpoint,
  clearCheckpoint,
  readCheckpoint,
  readAllCheckpoints,
  isStaleCheckpoint,
  isInterruptedCheckpoint,
  hashPrompt,
  archiveCheckpoint,
  getCheckpointSummary,
  cleanupArchivedCheckpoints,
  wasRecentlyCompleted,
  markCompleted,
};
