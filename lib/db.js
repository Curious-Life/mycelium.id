/**
 * Database Abstraction Layer
 *
 * All database access in mycelium goes through this module.
 * Backend: Cloudflare D1 + Vectorize via MYA Worker proxy.
 *
 * Usage:
 *   import { initDb, getDb } from './db.js';
 *   await initDb();                      // call once at startup
 *   const db = getDb();                  // get singleton
 *   await db.messages.insert(row);       // use it
 *
 * Config (env vars):
 *   MYA_WORKER_URL            — MYA Worker proxy URL (required)
 *   MYA_WORKER_SECRET         — Shared auth secret (required)
 */

let _db = null;

/**
 * Initialize the database backend. Call once at startup.
 */
export async function initDb() {
  const { createD1Backend } = await import('./db-d1.js');
  _db = createD1Backend();
  return _db;
}

/**
 * Get the initialized database instance. Throws if not initialized.
 * @returns {DbInterface}
 */
export function getDb() {
  if (!_db) {
    throw new Error('Database not initialized — call initDb() first');
  }
  return _db;
}

/**
 * Get the database instance without throwing.
 * Returns null if not initialized. Useful for fire-and-forget callers.
 * @returns {DbInterface|null}
 */
export function tryGetDb() {
  return _db;
}

/**
 * @typedef {Object} DbInterface
 *
 * @property {Object} messages
 * @property {Function} messages.insert - Insert message row(s)
 * @property {Function} messages.selectRecent - Get recent messages for context
 * @property {Function} messages.selectByAgent - Get messages by agent (paginated)
 * @property {Function} messages.listAgentIds - List distinct agent IDs
 * @property {Function} messages.hybridSearch - Keyword + semantic search
 * @property {Function} messages.matchMessages - Semantic similarity search
 * @property {Function} messages.matchDocuments - Semantic document search
 *
 * @property {Object} events
 * @property {Function} events.insert - Fire-and-forget event insert
 *
 * @property {Object} agentTasks
 * @property {Function} agentTasks.create - Create a new task
 * @property {Function} agentTasks.getPending - Get pending tasks for agent
 * @property {Function} agentTasks.getInProgress - Get in-progress tasks for agent
 * @property {Function} agentTasks.start - Mark task as in_progress
 * @property {Function} agentTasks.complete - Mark task as completed
 * @property {Function} agentTasks.fail - Mark task as failed
 * @property {Function} agentTasks.getToReport - Get completed but unreported tasks
 * @property {Function} agentTasks.markReported - Mark task as reported
 *
 * @property {Object} attachments
 * @property {Function} attachments.insert - Create attachment record
 *
 * @property {Object} users
 * @property {Function} users.getTimezone - Get user's timezone
 *
 * @property {Object} userIdentities
 * @property {Function} userIdentities.lookupByDiscord - Discord ID → user_id
 * @property {Function} userIdentities.list - List identities for user
 * @property {Function} userIdentities.unlink - Remove identity link
 * @property {Function} userIdentities.link - Link via RPC
 *
 * @property {Object} sessions
 * @property {Function} sessions.getByToken - Validate session token
 *
 * @property {Object} oauthStates
 * @property {Function} oauthStates.insert - Store OAuth state
 * @property {Function} oauthStates.validate - Validate and return OAuth state
 * @property {Function} oauthStates.delete - Delete OAuth state
 *
 * @property {Object} documents
 * @property {Function} documents.get - Get single document by path
 * @property {Function} documents.upsert - Create or update document
 * @property {Function} documents.list - List documents (optional category filter)
 * @property {Function} documents.pin - Pin a document
 * @property {Function} documents.unpin - Unpin a document
 *
 * @property {Object} tasks
 * @property {Function} tasks.create - Create a user task
 *
 * @property {Object} folders
 * @property {Function} folders.list - List folders for user
 *
 * @property {Object} canvases
 * @property {Function} canvases.list - List canvases for user
 * @property {Function} canvases.addDocument - Add document to canvas
 *
 * @property {Object} search
 * @property {Function} search.matchTerritories - Semantic territory search
 * @property {Function} search.matchRealms - Semantic realm search
 * @property {Function} search.matchThemes - Semantic theme search
 *
 * @property {Object} topology
 * @property {Function} topology.getCoFiring - Get co-firing territories
 * @property {Function} topology.getOrphans - Get orphan territories
 * @property {Function} topology.getBridges - Get bridge territories
 * @property {Function} topology.getGaps - Get co-fire gaps
 * @property {Function} topology.getCluster - Get territory cluster
 */
