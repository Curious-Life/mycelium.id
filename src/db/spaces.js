/**
 * Spaces namespace — collaborative containers backed by the `users`
 * table with `type = 'space'`. A space has knowledge, conversations,
 * and a per-user role (creator / contributor / member) enforced via
 * `space_access`.
 *
 * Spaces share the `users` table with human users because they appear
 * in the same identity graph — messages can be addressed to a space
 * just like they can to a user. `requireRole` encodes the hierarchy
 * used across portal + agent routes.
 *
 * `delete` is a soft delete (type → 'space_deleted') to preserve
 * referential integrity with messages/conversations that point at
 * the space id.
 *
 * @typedef {object} SpacesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {(val: any) => any} parseJson — tolerant JSON parse
 */

export function createSpacesNamespace(deps) {
  if (!deps) throw new TypeError('createSpacesNamespace: deps required');
  const { d1Query, firstRow, parseJson } = deps;
  if (typeof d1Query !== 'function')   throw new TypeError('createSpacesNamespace: d1Query required');
  if (typeof firstRow !== 'function')  throw new TypeError('createSpacesNamespace: firstRow required');
  if (typeof parseJson !== 'function') throw new TypeError('createSpacesNamespace: parseJson required');

  return {
    async create(spaceId, name, essence, voice, creatorId, handle = null) {
      await d1Query(
        `INSERT INTO users (id, display_name, type, created_by, handle, settings, created_at)
         VALUES (?, ?, 'space', ?, ?, ?, datetime('now'))`,
        [spaceId, name, creatorId, handle, JSON.stringify({ essence, voice })],
      );
      await d1Query(
        `INSERT INTO space_access (space_id, user_id, role, accepted_at, created_at)
         VALUES (?, ?, 'creator', datetime('now'), datetime('now'))`,
        [spaceId, creatorId],
      );
      return { id: spaceId, name, handle };
    },

    async get(spaceId) {
      const result = await d1Query(
        `SELECT u.id, u.display_name as name, u.handle, u.settings, u.created_by, u.created_at,
                (SELECT COUNT(*) FROM space_knowledge WHERE space_id = u.id AND status = 'active') as knowledge_count,
                (SELECT COUNT(*) FROM space_access WHERE space_id = u.id AND revoked_at IS NULL) as member_count,
                (SELECT COUNT(*) FROM space_conversations WHERE space_id = u.id) as conversation_count
         FROM users u WHERE u.id = ? AND u.type = 'space'`,
        [spaceId],
      );
      const row = firstRow(result);
      if (row && row.settings) row.settings = parseJson(row.settings);
      return row;
    },

    async listForUser(userId) {
      const result = await d1Query(
        `SELECT u.id, u.display_name as name, u.handle, u.settings, u.created_by, u.created_at,
                sa.role,
                (SELECT COUNT(*) FROM space_knowledge WHERE space_id = u.id AND status = 'active') as knowledge_count,
                (SELECT COUNT(*) FROM space_access WHERE space_id = u.id AND revoked_at IS NULL) as member_count
         FROM users u
         JOIN space_access sa ON sa.space_id = u.id AND sa.user_id = ?
         WHERE u.type = 'space' AND sa.revoked_at IS NULL
         ORDER BY sa.created_at DESC`,
        [userId],
      );
      return (result.results || []).map(r => ({ ...r, settings: parseJson(r.settings) }));
    },

    async update(spaceId, fields) {
      const sets = [];
      const params = [];
      if (fields.name !== undefined)   { sets.push('display_name = ?'); params.push(fields.name); }
      if (fields.handle !== undefined) { sets.push('handle = ?');        params.push(fields.handle); }
      if (
        fields.essence !== undefined ||
        fields.voice !== undefined ||
        fields.coverDocPath !== undefined
      ) {
        const current = await d1Query('SELECT settings FROM users WHERE id = ?', [spaceId]);
        const settings = parseJson(firstRow(current)?.settings || '{}');
        if (fields.essence !== undefined)      settings.essence       = fields.essence;
        if (fields.voice   !== undefined)      settings.voice         = fields.voice;
        // coverDocPath: agent-authored HTML doc that renders as the
        // space's landing interface. null/empty clears it, falling
        // back to the default Rooms grid.
        if (fields.coverDocPath !== undefined) settings.coverDocPath = fields.coverDocPath || null;
        sets.push('settings = ?');
        params.push(JSON.stringify(settings));
      }
      if (!sets.length) return;
      params.push(spaceId);
      await d1Query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND type = 'space'`, params);
    },

    async delete(spaceId) {
      // Soft delete — preserves referential integrity of messages/conversations.
      await d1Query(`UPDATE users SET type = 'space_deleted' WHERE id = ? AND type = 'space'`, [spaceId]);
    },

    async getRole(spaceId, userId) {
      const result = await d1Query(
        `SELECT role FROM space_access WHERE space_id = ? AND user_id = ? AND revoked_at IS NULL`,
        [spaceId, userId],
      );
      return firstRow(result)?.role || null;
    },

    async requireRole(spaceId, userId, minRole) {
      const role = await this.getRole(spaceId, userId);
      const hierarchy = { creator: 3, contributor: 2, member: 1 };
      if (!role || (hierarchy[role] || 0) < (hierarchy[minRole] || 0)) {
        throw new Error(`Requires ${minRole} role`);
      }
      return role;
    },
  };
}
