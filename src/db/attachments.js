/**
 * Attachments namespace — file uploads (R2 + Stream) metadata.
 *
 * listByUser / countByUser share filter logic: `type='file'` expands
 * to file/text/pdf/document; `onlyTypes` is an additional IN filter;
 * `search` does LIKE over file_name + description.
 *
 * SECURITY: delete() requires user_id in WHERE. insert() writes
 * arbitrary-key records (caller-controlled columns). update() allows
 * partial field changes.
 *
 * @typedef {object} AttachmentsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

export function createAttachmentsNamespace(deps) {
  if (!deps) throw new TypeError('createAttachmentsNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createAttachmentsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createAttachmentsNamespace: firstRow required');

  function buildFilters({ type, search, onlyTypes }) {
    const conditions = ['user_id = ?'];
    const params = [];
    if (type) {
      if (type === 'file') {
        conditions.push("file_type IN ('file', 'text', 'pdf', 'document')");
      } else {
        conditions.push('file_type = ?');
        params.push(type);
      }
    }
    if (onlyTypes && onlyTypes.length > 0) {
      conditions.push(`file_type IN (${onlyTypes.map(() => '?').join(', ')})`);
      params.push(...onlyTypes);
    }
    if (search) {
      conditions.push('(file_name LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    return { where: conditions.join(' AND '), filterParams: params };
  }

  return {
    async insert(record) {
      const cols = Object.keys(record).join(', ');
      const placeholders = Object.keys(record).map(() => '?').join(', ');
      const result = await d1Query(
        `INSERT INTO attachments (${cols}) VALUES (${placeholders}) RETURNING id`,
        Object.values(record),
      );
      return firstRow(result);
    },

    async getById(id) {
      const result = await d1Query(
        `SELECT id, user_id, r2_key, local_path, stream_uid, file_name, file_type, file_size, transcript, description, metadata, created_at FROM attachments WHERE id = ?`,
        [id],
      );
      return firstRow(result);
    },

    async getByIds(ids, userId) {
      if (!ids.length) return [];
      // Worker safety guard: SELECT on user-data tables requires
      // user_id (or agent_id) in WHERE. Caller must pass the userId
      // they're authenticating against — reading attachments by raw
      // id alone returns 403 from the Worker's sql-safety guardian.
      // Backwards-compat: if userId omitted, fall back to env (older
      // callers); new callers should pass it explicitly.
      const effectiveUserId = userId || process.env.MYA_USER_ID || process.env.USER_ID;
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, r2_key, stream_uid, file_name, file_type, file_size, transcript, description FROM attachments WHERE user_id = ? AND id IN (${placeholders})`,
        [effectiveUserId, ...ids],
      );
      return result.results || [];
    },

    async listByUser(userId, opts = {}) {
      const { limit = 50, offset = 0 } = opts;
      const { where, filterParams } = buildFilters(opts);
      const params = [userId, ...filterParams, limit, offset];
      const result = await d1Query(
        `SELECT id, user_id, r2_key, stream_uid, file_name, file_type, file_size, transcript, description, metadata, created_at FROM attachments WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params,
      );
      return result.results || [];
    },

    async countByUser(userId, opts = {}) {
      const { where, filterParams } = buildFilters(opts);
      const params = [userId, ...filterParams];
      const result = await d1Query(
        `SELECT COUNT(*) as count FROM attachments WHERE ${where}`,
        params,
      );
      return firstRow(result)?.count || 0;
    },

    async update(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      await d1Query(
        `UPDATE attachments SET ${sets} WHERE id = ?`,
        [...Object.values(fields), id],
      );
    },

    async delete(id, userId) {
      await d1Query(
        `DELETE FROM attachments WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
    },
  };
}
