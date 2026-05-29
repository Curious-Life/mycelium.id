/**
 * Task Continuation System
 *
 * Persists continuation records to disk for deferred task resumption.
 * Handles two failure modes:
 * - Timeout: immediate --resume (handled in-process by agent-server)
 * - Rate limit: deferred --resume after cooldown (picked up by periodic scanner)
 *
 * Storage: ~/agents/<agentId>/continuations/<uuid>.json
 * Pattern follows lib/checkpoint.js
 */

import { writeFile, readFile, unlink, mkdir, readdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

const CONTINUATIONS_DIR = 'continuations';

/**
 * Get continuations directory for an agent
 */
function getContinuationsDir(agentRoot) {
  return path.join(agentRoot, CONTINUATIONS_DIR);
}

/**
 * Get file path for a specific continuation
 */
function getContinuationPath(agentRoot, id) {
  return path.join(agentRoot, CONTINUATIONS_DIR, `${id}.json`);
}

/**
 * Write a continuation record to disk
 *
 * @param {string} agentRoot - Agent root directory
 * @param {Object} data - Continuation data
 * @param {string} data.agentId - Agent identifier
 * @param {string} data.type - 'timeout' or 'rate_limit'
 * @param {string} data.resumeAfter - ISO timestamp for when to resume
 * @param {string} [data.claudeSessionId] - Claude Code session UUID to --resume
 * @param {string} data.taskType - Task type (chat, think, etc.)
 * @param {string} data.model - Model to use
 * @param {number} data.maxTurns - Max tool use cycles
 * @param {string} data.cwd - Working directory
 * @param {string} data.prompt - Prompt summary (first 500 chars)
 * @param {string} data.promptFull - Full prompt text
 * @param {Object} data.deliveryContext - Where to send notifications
 * @param {number} data.attempt - Current attempt number
 * @param {number} data.maxAttempts - Max continuation attempts
 * @param {string} data.originalError - Error message that triggered continuation
 * @returns {Promise<Object>} Written continuation with generated id
 */
export async function writeContinuation(agentRoot, data) {
  const id = randomUUID();
  const continuation = {
    id,
    state: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [],
    ...data,
  };

  const filePath = getContinuationPath(agentRoot, id);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(continuation, null, 2));
    console.log(`[Continuation] Written: ${id.slice(0, 8)} (${data.type}, resume after ${data.resumeAfter})`);
    return continuation;
  } catch (error) {
    console.error('[Continuation] Failed to write:', error.message);
    return continuation;
  }
}

/**
 * Read all pending continuations that are ready to resume
 * (state === 'pending' && resumeAfter <= now)
 *
 * @param {string} agentRoot - Agent root directory
 * @returns {Promise<Object[]>} Ready continuations
 */
export async function readReadyContinuations(agentRoot) {
  const all = await readAllContinuations(agentRoot);
  const now = Date.now();
  return all.filter(c =>
    c.state === 'pending' &&
    (!c.resumeAfter || new Date(c.resumeAfter).getTime() <= now)
  );
}

/**
 * Read all continuations (any state)
 *
 * @param {string} agentRoot - Agent root directory
 * @returns {Promise<Object[]>} All continuations
 */
export async function readAllContinuations(agentRoot) {
  const dir = getContinuationsDir(agentRoot);
  const continuations = [];

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const data = await readFile(filePath, 'utf8');
        continuations.push(JSON.parse(data));
      } catch (e) {
        console.warn(`[Continuation] Corrupt file ${file}, deleting:`, e.message);
        try { await unlink(filePath); } catch { /* ignore */ }
      }
    }
  } catch {
    // Directory doesn't exist — no continuations
  }

  return continuations;
}

/**
 * Update a continuation record
 *
 * @param {string} agentRoot - Agent root directory
 * @param {string} id - Continuation ID
 * @param {Object} updates - Fields to merge
 * @returns {Promise<Object|null>} Updated continuation or null
 */
export async function updateContinuation(agentRoot, id, updates) {
  const filePath = getContinuationPath(agentRoot, id);
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
    console.error(`[Continuation] Failed to update ${id.slice(0, 8)}:`, error.message);
    return null;
  }
}

/**
 * Remove a continuation record
 *
 * @param {string} agentRoot - Agent root directory
 * @param {string} id - Continuation ID
 */
export async function clearContinuation(agentRoot, id) {
  const filePath = getContinuationPath(agentRoot, id);
  try {
    await unlink(filePath);
    console.log(`[Continuation] Cleared: ${id.slice(0, 8)}`);
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Clean up old continuations (completed/failed older than maxAge)
 *
 * @param {string} agentRoot - Agent root directory
 * @param {number} [maxAge=86400000] - Max age in ms (default 24h)
 */
export async function cleanupOldContinuations(agentRoot, maxAge = 24 * 60 * 60 * 1000) {
  const all = await readAllContinuations(agentRoot);
  const now = Date.now();
  let cleaned = 0;

  for (const c of all) {
    if ((c.state === 'completed' || c.state === 'failed') &&
        c.updatedAt && (now - new Date(c.updatedAt).getTime()) > maxAge) {
      await clearContinuation(agentRoot, c.id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Continuation] Cleaned up ${cleaned} old continuation(s)`);
  }
}

export default {
  writeContinuation,
  readReadyContinuations,
  readAllContinuations,
  updateContinuation,
  clearContinuation,
  cleanupOldContinuations,
};
