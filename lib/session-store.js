/**
 * Session Store - Claude Code Session Mapping & Crash Recovery
 *
 * Claude Code manages actual conversation history via native sessions.
 * This module only tracks:
 * 1. Thread → Claude Code session UUID mapping (which conversation is which)
 * 2. Active session metadata for crash recovery
 * 3. Internal session IDs for checkpoint linkage (legacy compat)
 *
 * Session mapping: "Discord channel/thread X uses Claude Code session UUID Y".
 * Each session tracks its own lastActivity for independent expiry.
 * On crash recovery or new message, we --resume the right session.
 *
 * Default expiry: 7 days per session. Collab threads: 24 hours.
 */

import { writeFile, readFile, appendFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

const SESSIONS_DIR = 'sessions';
const SESSION_META_FILE = 'session-meta.json';

// Default session expiry: 7 days of inactivity
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
// Collab thread expiry: 24 hours (one-off conversations)
const COLLAB_MAX_AGE = 24 * 60 * 60 * 1000;

// ============================================
// Session Metadata (Claude Code UUID mappings)
// ============================================

/**
 * Load session metadata for an agent
 *
 * Shape (v2 — per-session activity tracking):
 * {
 *   activeSession: "uuid-from-claude-code" | null,
 *   threadSessions: {
 *     "discord_1234567890": {
 *       sessionId: "uuid-from-claude-code",
 *       lastActivity: "2026-02-06T11:41:54Z",
 *       channelName: "#general",
 *       messageCount: 15
 *     },
 *     "discord_9876543210": {
 *       sessionId: "another-uuid",
 *       lastActivity: "2026-02-05T09:00:00Z",
 *       channelName: "Ada — competitor research",
 *       messageCount: 3
 *     }
 *   }
 * }
 *
 * Migrates from v1 (string values) transparently on load.
 *
 * @param {string} agentRoot - Root directory of the agent
 * @returns {Promise<Object>} Session metadata
 */
export async function loadSessionMetadata(agentRoot) {
  const filePath = path.join(agentRoot, SESSION_META_FILE);
  try {
    const content = await readFile(filePath, 'utf8');
    const meta = JSON.parse(content);

    // Migrate v1 → v2: string sessionId values → object with metadata
    let migrated = false;
    for (const [key, value] of Object.entries(meta.threadSessions || {})) {
      if (typeof value === 'string') {
        meta.threadSessions[key] = {
          sessionId: value,
          lastActivity: meta.lastActivity || new Date().toISOString(),
          messageCount: 0,
        };
        migrated = true;
      }
    }
    if (migrated) {
      delete meta.lastActivity; // v1 field, no longer needed
      await saveSessionMetadata(agentRoot, meta);
    }

    return meta;
  } catch {
    return {
      activeSession: null,
      threadSessions: {},
    };
  }
}

/**
 * Save session metadata
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {Object} metadata - Session metadata to save
 */
async function saveSessionMetadata(agentRoot, metadata) {
  const filePath = path.join(agentRoot, SESSION_META_FILE);
  try {
    await writeFile(filePath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error('[SessionStore] Failed to save session metadata:', error.message);
  }
}

/**
 * Update the Claude Code session UUID for a thread/key.
 * Each session tracks its own lastActivity independently.
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} threadKey - Thread identifier (e.g., "discord_1234567890", "activeSession")
 * @param {string} claudeSessionId - Claude Code session UUID
 * @param {Object} [extra] - Optional metadata (channelName, etc.)
 */
export async function updateSessionMapping(agentRoot, threadKey, claudeSessionId, extra = {}) {
  const meta = await loadSessionMetadata(agentRoot);

  if (threadKey === 'activeSession') {
    meta.activeSession = claudeSessionId;
  } else {
    const existing = meta.threadSessions[threadKey] || {};
    meta.threadSessions[threadKey] = {
      sessionId: claudeSessionId,
      lastActivity: new Date().toISOString(),
      channelName: extra.channelName || existing.channelName || null,
      messageCount: (existing.messageCount || 0) + 1,
      // Track estimated token usage for proactive compaction
      estimatedTokens: extra.addTokens
        ? (existing.estimatedTokens || 0) + extra.addTokens
        : claudeSessionId ? (existing.estimatedTokens || 0) : 0,
    };
    // Context compaction: store summary when session overflows, clear on new valid session
    if (extra.contextSummary) {
      meta.threadSessions[threadKey].contextSummary = extra.contextSummary;
      meta.threadSessions[threadKey].estimatedTokens = 0; // Reset after compaction
    } else if (claudeSessionId) {
      delete meta.threadSessions[threadKey].contextSummary;
    }
  }

  await saveSessionMetadata(agentRoot, meta);
}

/**
 * Get Claude Code session UUID for a thread.
 * Each session has independent expiry based on its own lastActivity.
 *
 * Default expiry: 7 days for channel sessions, 24h for collab threads.
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} threadKey - Thread identifier (e.g., "discord_1234567890")
 * @param {number} [maxAge] - Max session age in ms. Auto-detects if not specified:
 *                             7 days for channels, 24h for collab threads.
 * @returns {Promise<string|null>} Claude Code session UUID or null if expired/not found
 */
export async function getSessionForThread(agentRoot, threadKey, maxAge) {
  const meta = await loadSessionMetadata(agentRoot);
  const entry = meta.threadSessions[threadKey];

  if (!entry) return null;

  // Handle v2 (object) entries
  const sessionId = typeof entry === 'string' ? entry : entry.sessionId;
  const lastActivity = typeof entry === 'string' ? meta.lastActivity : entry.lastActivity;

  if (!sessionId) return null;

  // Auto-detect expiry if not specified
  if (maxAge === undefined) {
    // Collab threads (created by auto-threading) are shorter-lived
    maxAge = threadKey.includes('collab') ? COLLAB_MAX_AGE : DEFAULT_MAX_AGE;
  }

  // Check per-session activity
  if (lastActivity) {
    const age = Date.now() - new Date(lastActivity).getTime();
    if (age > maxAge) return null;
  }

  return sessionId;
}

/**
 * Get context summary for a thread (from compacted/overflowed session).
 * Returns null if no summary exists. The summary is stored when a session
 * overflows and is used to provide continuity when starting a fresh session.
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} threadKey - Thread identifier
 * @returns {Promise<string|null>} Context summary or null
 */
export async function getContextSummary(agentRoot, threadKey) {
  const meta = await loadSessionMetadata(agentRoot);
  const entry = meta.threadSessions[threadKey];
  return entry?.contextSummary || null;
}

/**
 * Check if a session's estimated tokens exceed a threshold (proactive compaction).
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} threadKey - Thread identifier
 * @param {number} [maxTokens=200000] - Token threshold
 * @returns {Promise<{needsCompaction: boolean, estimatedTokens: number}>}
 */
export async function checkSessionTokens(agentRoot, threadKey, maxTokens = 200000) {
  const meta = await loadSessionMetadata(agentRoot);
  const entry = meta.threadSessions[threadKey];
  const estimatedTokens = entry?.estimatedTokens || 0;
  return {
    needsCompaction: estimatedTokens >= maxTokens,
    estimatedTokens,
  };
}

/**
 * Clear a thread's session mapping (e.g., on session error or forced reset)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} threadKey - Thread identifier
 */
export async function clearSessionMapping(agentRoot, threadKey) {
  const meta = await loadSessionMetadata(agentRoot);
  delete meta.threadSessions[threadKey];
  await saveSessionMetadata(agentRoot, meta);
}

/**
 * Get a summary of all active sessions for an agent.
 * Useful for /status endpoint and debugging.
 *
 * @param {string} agentRoot - Root directory of the agent
 * @returns {Promise<Array>} Array of { threadKey, sessionId, lastActivity, channelName, messageCount, ageHours }
 */
export async function listActiveSessions(agentRoot) {
  const meta = await loadSessionMetadata(agentRoot);
  const now = Date.now();

  return Object.entries(meta.threadSessions || {}).map(([threadKey, entry]) => {
    const sessionId = typeof entry === 'string' ? entry : entry.sessionId;
    const lastActivity = typeof entry === 'string' ? null : entry.lastActivity;
    const ageMs = lastActivity ? now - new Date(lastActivity).getTime() : null;

    return {
      threadKey,
      sessionId: sessionId?.slice(0, 8) + '...',
      lastActivity,
      channelName: entry.channelName || null,
      messageCount: entry.messageCount || 0,
      ageHours: ageMs ? Math.round(ageMs / 3600000 * 10) / 10 : null,
    };
  });
}

// ============================================
// Legacy Session Store (checkpoint/crash recovery)
// Kept for backward compat with checkpoint.js and runner.js
// ============================================

/**
 * Get sessions directory for an agent
 */
function getSessionsDir(agentRoot) {
  return path.join(agentRoot, SESSIONS_DIR);
}

/**
 * Get session file path
 */
function getSessionPath(agentRoot, sessionId) {
  return path.join(getSessionsDir(agentRoot), `${sessionId}.jsonl`);
}

/**
 * Generate a unique internal session ID (for checkpoint linkage)
 * @returns {string} Session ID in format sess_<uuid-prefix>
 */
export function generateSessionId() {
  return `sess_${randomUUID().split('-')[0]}`;
}

/**
 * Save messages to a session (append-only)
 * Used by runner.js for checkpoint/crash recovery
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Internal session identifier
 * @param {Array} messages - Array of message objects
 * @param {Object} metadata - Optional metadata (taskType, deliveryContext, etc.)
 */
export async function saveSession(agentRoot, sessionId, messages, metadata = {}) {
  const dir = getSessionsDir(agentRoot);
  const filePath = getSessionPath(agentRoot, sessionId);

  try {
    await mkdir(dir, { recursive: true });

    const entry = {
      ts: Date.now(),
      messages,
      ...metadata,
    };

    const line = JSON.stringify(entry) + '\n';
    await appendFile(filePath, line);

    return true;
  } catch (error) {
    console.error('[SessionStore] Failed to save session:', error.message);
    return false;
  }
}

/**
 * Load the latest state of a session
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Internal session identifier
 * @returns {Object|null} Latest session entry or null
 */
export async function loadSession(agentRoot, sessionId) {
  const filePath = getSessionPath(agentRoot, sessionId);

  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) return null;

    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Load full session history (all entries)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Internal session identifier
 * @returns {Array} Array of all session entries
 */
export async function loadSessionHistory(agentRoot, sessionId) {
  const filePath = getSessionPath(agentRoot, sessionId);

  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Get all messages from a session (flattened)
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Internal session identifier
 * @returns {Array} Flattened array of all messages
 */
export async function getSessionMessages(agentRoot, sessionId) {
  const latest = await loadSession(agentRoot, sessionId);
  return latest?.messages || [];
}

/**
 * Append a single message to session
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {string} sessionId - Internal session identifier
 * @param {Object} message - Message to append {role, content}
 */
export async function appendMessage(agentRoot, sessionId, message) {
  const current = await getSessionMessages(agentRoot, sessionId);
  const updated = [...current, message];
  await saveSession(agentRoot, sessionId, updated);
  return updated;
}

/**
 * Clean up old sessions
 *
 * @param {string} agentRoot - Root directory of the agent
 * @param {number} maxAge - Max age in ms (default 7 days)
 */
export async function cleanupOldSessions(agentRoot, maxAge = 7 * 24 * 60 * 60 * 1000) {
  const dir = getSessionsDir(agentRoot);

  try {
    const { readdir, stat, unlink } = await import('fs/promises');
    const files = await readdir(dir);

    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      const filePath = path.join(dir, file);
      const fileStat = await stat(filePath);

      if (Date.now() - fileStat.mtimeMs > maxAge) {
        await unlink(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SessionStore] Cleaned up ${cleaned} old session(s)`);
    }
  } catch {
    // Directory doesn't exist or other error
  }
}

export default {
  // Claude Code session mapping
  loadSessionMetadata,
  updateSessionMapping,
  getSessionForThread,
  getContextSummary,
  checkSessionTokens,
  clearSessionMapping,
  listActiveSessions,
  // Constants
  DEFAULT_MAX_AGE,
  COLLAB_MAX_AGE,
  // Legacy: internal session store for checkpoints
  generateSessionId,
  saveSession,
  loadSession,
  loadSessionHistory,
  getSessionMessages,
  appendMessage,
  cleanupOldSessions,
};
