/**
 * Space knowledge namespace — shared context entries within a space.
 *
 * Each entry represents something a space member has shared with the
 * space (a territory, a message, a knowledge item). visibility = 'all'
 * means visible to every member; restrictive values narrow that down.
 *
 * @typedef {object} SpaceKnowledgeNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => string} [randomUUID] — test seam
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function createSpaceKnowledgeNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceKnowledgeNamespace: deps required');
  const { d1Query, firstRow, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createSpaceKnowledgeNamespace: d1Query required');
  }
  if (typeof firstRow !== 'function') {
    throw new TypeError('createSpaceKnowledgeNamespace: firstRow required');
  }

  return {
    /**
     * Write a knowledge entry. `sourceRef` (8th arg) is the C2 addition:
     * a namespaced ref string (`msg:<id>`, `doc:<id>`, `territory:<id>`,
     * `person:<id>`, `synthesis:<hash>`, …). Pass null when there's no
     * single dominant source (e.g. cross-source synthesis).
     */
    async add(spaceId, content, sourceUserId, sourceTerritoryId, sourceType, visibility = 'all', domainTags = null, sourceRef = null) {
      const id = randomUUID();
      await d1Query(
        `INSERT INTO space_knowledge (id, space_id, content, source_user_id, source_territory_id, source_type, visibility, domain_tags, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, spaceId, content, sourceUserId, sourceTerritoryId, sourceType, visibility,
          domainTags ? JSON.stringify(domainTags) : null,
          sourceRef,
        ],
      );
      return id;
    },

    async list(spaceId, { status = 'active', sourceType, visibility, limit = 100 } = {}) {
      let sql = 'SELECT * FROM space_knowledge WHERE space_id = ?';
      const params = [spaceId];
      if (status)     { sql += ' AND status = ?';      params.push(status); }
      if (sourceType) { sql += ' AND source_type = ?'; params.push(sourceType); }
      if (visibility) { sql += ' AND visibility = ?';  params.push(visibility); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async revoke(entryId, spaceId) {
      await d1Query(
        `UPDATE space_knowledge SET status = 'revoked', revoked_at = datetime('now') WHERE id = ? AND space_id = ?`,
        [entryId, spaceId],
      );
    },

    /**
     * Edit an existing entry, preserving the prior version in
     * `space_knowledge_history`. At least one of `content` / `domainTags`
     * must be provided. Row lookup is scoped to (entryId, spaceId) so a
     * caller can't edit an entry from a different space even if they
     * have access to both — the handler's role-gate only covers spaceId.
     *
     * Returns `{ id, updated_fields, prior_length, new_length }` on success,
     * or throws `Error('Entry not found')` if the row is missing or
     * already revoked.
     */
    async edit(entryId, spaceId, { content, domainTags, editedByUserId } = {}) {
      if (typeof editedByUserId !== 'string' || !editedByUserId) {
        throw new TypeError('edit: editedByUserId required');
      }
      const hasContent = typeof content === 'string' && content.length > 0;
      const hasTags = Array.isArray(domainTags);
      if (!hasContent && !hasTags) {
        throw new Error('edit: at least one of content or domainTags required');
      }

      const lookup = await d1Query(
        `SELECT id, content, domain_tags, status FROM space_knowledge
         WHERE id = ? AND space_id = ?`,
        [entryId, spaceId],
      );
      const row = firstRow(lookup);
      if (!row || row.status !== 'active') {
        throw new Error('Entry not found');
      }

      // 1. History row first — if this fails, the update doesn't run.
      await d1Query(
        `INSERT INTO space_knowledge_history
           (entry_id, space_id, prior_content, prior_domain_tags, edited_by_user_id)
         VALUES (?, ?, ?, ?, ?)`,
        [entryId, spaceId, row.content, row.domain_tags, editedByUserId],
      );

      // 2. Overwrite targeted fields.
      const setClauses = [];
      const params = [];
      if (hasContent) { setClauses.push('content = ?'); params.push(content); }
      if (hasTags)    { setClauses.push('domain_tags = ?'); params.push(domainTags.length ? JSON.stringify(domainTags) : null); }
      setClauses.push("updated_at = datetime('now')");
      setClauses.push('version = version + 1');
      params.push(entryId, spaceId);

      await d1Query(
        `UPDATE space_knowledge SET ${setClauses.join(', ')} WHERE id = ? AND space_id = ?`,
        params,
      );

      return {
        id: entryId,
        updated_fields: [hasContent ? 'content' : null, hasTags ? 'domain_tags' : null].filter(Boolean),
        prior_length: (row.content || '').length,
        new_length: hasContent ? content.length : (row.content || '').length,
      };
    },

    async countBySpace(spaceId) {
      const result = await d1Query(
        `SELECT COUNT(*) as c FROM space_knowledge WHERE space_id = ? AND status = 'active'`,
        [spaceId],
      );
      return firstRow(result)?.c || 0;
    },
  };
}
