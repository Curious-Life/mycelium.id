/**
 * Sharing contexts namespace — buckets of territories that a user can
 * selectively share with specific connections. The social graph says
 * *who* you know; a context says *what facet of yourself* they see.
 *
 * Primitives:
 *   - `sharing_contexts` rows — named buckets (Work Self, Private
 *     Self, ...). Four defaults are created on first use via
 *     `ensureDefaults`. A default context can't be renamed or
 *     deleted (the `is_default = 0` clause on rename/remove enforces
 *     this at the SQL level).
 *   - `context_territories` — junction linking a context to the
 *     territories it exposes.
 *   - `context_grants` — junction linking a context to accepted
 *     connections. A connection only sees a territory if some
 *     *non-private* context that contains the territory has granted
 *     the connection access.
 *
 * `canSeeTerritory` is the visibility gate used at portal render
 * time. It only matches non-private contexts (`sc.is_private = 0`)
 * and only accepted connections (`c.status = 'accepted'`) — so a
 * private context can hold territories for future sharing without
 * ever being visible, and rejected/blocked/pending connections can't
 * peek.
 *
 * @typedef {object} ContextsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {() => string} [randomUUID] — test seam; defaults to node:crypto.randomUUID
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createContextsNamespace(deps) {
  if (!deps) throw new TypeError('createContextsNamespace: deps required');
  const { d1Query, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createContextsNamespace: d1Query required');

  return {
    async list(userId) {
      const result = await d1Query(
        `SELECT sc.*, COUNT(ct.territory_id) as territory_count
         FROM sharing_contexts sc
         LEFT JOIN context_territories ct ON ct.context_id = sc.id
         WHERE sc.user_id = ?
         GROUP BY sc.id ORDER BY sc.is_default DESC, sc.created_at`,
        [userId],
      );
      return result.results || [];
    },

    async create(userId, { name, is_private = false }) {
      if (!name || name.length > 50) throw new Error('Name required (max 50 chars)');
      const id = randomUUID();
      await d1Query(
        `INSERT INTO sharing_contexts (id, user_id, name, is_private, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [id, userId, name, is_private ? 1 : 0],
      );
      return id;
    },

    async rename(userId, contextId, name) {
      if (!name || name.length > 50) throw new Error('Name required (max 50 chars)');
      // `is_default = 0` clause prevents renaming the four defaults.
      await d1Query(
        `UPDATE sharing_contexts SET name = ? WHERE id = ? AND user_id = ? AND is_default = 0`,
        [name, contextId, userId],
      );
    },

    async remove(userId, contextId) {
      // Same non-default guard as rename.
      await d1Query(
        `DELETE FROM sharing_contexts WHERE id = ? AND user_id = ? AND is_default = 0`,
        [contextId, userId],
      );
    },

    async addTerritory(contextId, territoryId) {
      await d1Query(
        `INSERT OR IGNORE INTO context_territories (context_id, territory_id, added_at)
         VALUES (?, ?, datetime('now'))`,
        [contextId, territoryId],
      );
    },

    async removeTerritory(contextId, territoryId) {
      await d1Query(
        `DELETE FROM context_territories WHERE context_id = ? AND territory_id = ?`,
        [contextId, territoryId],
      );
    },

    async getTerritories(contextId) {
      const result = await d1Query(
        `SELECT ct.territory_id, tp.name, tp.essence, tp.realm_id
         FROM context_territories ct
         LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id
         WHERE ct.context_id = ?`,
        [contextId],
      );
      return result.results || [];
    },

    async grant(contextId, connectionId) {
      await d1Query(
        `INSERT OR IGNORE INTO context_grants (context_id, connection_id, granted_at)
         VALUES (?, ?, datetime('now'))`,
        [contextId, connectionId],
      );
    },

    async revoke(contextId, connectionId) {
      await d1Query(
        `DELETE FROM context_grants WHERE context_id = ? AND connection_id = ?`,
        [contextId, connectionId],
      );
    },

    async getGrants(contextId) {
      const result = await d1Query(
        `SELECT cg.connection_id, c.user_a, c.user_b, up.handle
         FROM context_grants cg
         JOIN connections c ON c.id = cg.connection_id
         LEFT JOIN user_profiles up ON up.user_id = c.user_a OR up.user_id = c.user_b
         WHERE cg.context_id = ?`,
        [contextId],
      );
      return result.results || [];
    },

    /** Ensure the four default contexts exist for a user (idempotent). */
    async ensureDefaults(userId) {
      const defaults = [
        { name: 'Work Self',     is_private: false },
        { name: 'Social Self',   is_private: false },
        { name: 'Creative Self', is_private: false },
        { name: 'Private Self',  is_private: true  },
      ];
      for (const ctx of defaults) {
        await d1Query(
          `INSERT OR IGNORE INTO sharing_contexts (id, user_id, name, is_private, is_default, created_at)
           VALUES (?, ?, ?, ?, 1, datetime('now'))`,
          [randomUUID(), userId, ctx.name, ctx.is_private ? 1 : 0],
        );
      }
    },

    /**
     * Visibility gate: is viewerUserId allowed to see territoryId that
     * belongs to ownerUserId?
     *
     * Yes iff there exists a (context, grant) pair where:
     *   1. context belongs to ownerUserId and is NOT private
     *   2. context contains the territory
     *   3. context has granted access to a connection
     *   4. that connection involves viewerUserId and is accepted
     */
    async canSeeTerritory(ownerUserId, viewerUserId, territoryId) {
      const result = await d1Query(
        `SELECT 1 FROM context_territories ct
         JOIN context_grants cg ON cg.context_id = ct.context_id
         JOIN connections c ON c.id = cg.connection_id AND c.status = 'accepted'
         JOIN sharing_contexts sc ON sc.id = ct.context_id AND sc.user_id = ? AND sc.is_private = 0
         WHERE ct.territory_id = ? AND (c.user_a = ? OR c.user_b = ?)
         LIMIT 1`,
        [ownerUserId, territoryId, viewerUserId, viewerUserId],
      );
      return (result.results?.length || 0) > 0;
    },
  };
}
