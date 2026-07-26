/**
 * Attachments namespace — file uploads (R2 + Stream) metadata.
 *
 * listByUser filter logic: `type='file'` expands to file/text/pdf/document;
 * `onlyTypes` is an additional IN filter; `search` does LIKE over file_name +
 * description.
 *
 * SECURITY: delete() requires user_id in WHERE. insert() writes
 * arbitrary-key records (caller-controlled columns). update() allows
 * partial field changes.
 *
 * @typedef {object} AttachmentsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */
import { assertSafeColumns } from './column-guard.js';
import { assertUserNamespacedBlobPath } from '../paths.js';

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
      assertSafeColumns(Object.keys(record || {}), 'attachments');
      // Multi-tenant floor: a stored blob path must be namespaced under its own
      // user (the unscoped refcount blob-GC relies on this). Fail-closed here so
      // no upload/import caller can persist a foreign-prefixed local_path. Null
      // (legacy r2-only rows) is allowed.
      if (record?.local_path != null) assertUserNamespacedBlobPath(record.local_path, record.user_id);
      const cols = Object.keys(record).join(', ');
      const placeholders = Object.keys(record).map(() => '?').join(', ');
      const result = await d1Query(
        `INSERT INTO attachments (${cols}) VALUES (${placeholders}) RETURNING id`,
        Object.values(record),
      );
      return firstRow(result);
    },

    async getById(id, userId) {
      // user_id in the WHERE is the SQL-layer enforcement; callers still
      // re-check row.user_id (defense in depth). Optional for backward compat,
      // but every caller on user data should pass it (mirrors getByIds).
      const result = await d1Query(
        `SELECT id, user_id, r2_key, local_path, stream_uid, file_name, file_type, file_size, transcript, description, metadata, created_at FROM attachments WHERE id = ?${userId ? ' AND user_id = ?' : ''}`,
        userId ? [id, userId] : [id],
      );
      return firstRow(result);
    },

    // D-001 (round-2 review #1): audio attachments still awaiting a transcript — the work-set for
    // the background transcription drain (src/enrich/transcribe-retry.js), so a `compute-busy`
    // refusal (or any transient failure) during import is eventually retried instead of silently
    // dropped. SELECTS ONLY ids (no transcript, no filename — §1 content-free) and REQUIRES user_id
    // in the WHERE (SQL-layer tenant enforcement). Audio predicate mirrors isAudio()/mediaTypeOf().
    // ══════════════════════════════════════════════════════════════════════════════════════════
    //  D-076: "HAS SOME TEXT" IS NOT "IS DONE" — the predicate that made truncation PERMANENT
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // This filter used to be `transcript IS NULL OR transcript = ''`. transcribe-attachment.js
    // PROGRESSIVELY SAVES every ~10 segments, so the instant a 30-minute recording wrote its first
    // partial the row stopped matching — permanently. Not "capped after 3 attempts": excluded
    // immediately, by construction, with no marker anywhere that anything was missing. Whatever
    // interrupted the decode (a python OOM-kill, a supervisor restart, a blown live-turn budget)
    // became a silent, unrecoverable truncation, and a manual re-transcribe hit the same wall.
    //
    // Eligibility is now "no text OR text known to be incomplete". The incomplete marker is
    // EXPLICIT (`metadata.transcription.incomplete = 1`, written by transcript-coverage.js in the
    // SAME UPDATE as the partial text) and its absence means "not pending" — so every LEGACY row
    // that already holds a good transcript and carries no marker is still excluded, exactly as
    // before. Without that asymmetry this change would re-transcribe the entire existing library.
    //
    // ⚠️ `json_valid` IS LOAD-BEARING, NOT DEFENSIVE NOISE. A bare
    // `json_extract(metadata, '$…')` ABORTS THE WHOLE QUERY with "malformed JSON" the moment any
    // one row's `metadata` is not valid JSON (verified against better-sqlite3 3.49.2) — the drain
    // would stop finding ANY work because of one unrelated legacy row. NULL metadata is fine
    // (json_extract returns NULL), non-JSON text is not.
    //
    // Still SELECTS ONLY ids (no transcript, no filename — §1 content-free) and REQUIRES user_id in
    // the WHERE (SQL-layer tenant enforcement). Audio predicate mirrors isAudio()/mediaTypeOf().
    async listPendingTranscription(userId, { limit = 10 } = {}) {
      const result = await d1Query(
        `SELECT id FROM attachments
           WHERE user_id = ?
             AND local_path IS NOT NULL
             AND (
                   transcript IS NULL OR transcript = ''
                   OR (metadata IS NOT NULL AND json_valid(metadata)
                       AND json_extract(metadata, '$.transcription.incomplete') = 1)
                 )
             -- An EARNED complete=1 beats "has no text". Without this, a genuinely silent recording
             -- (an empty transcript plus complete) still matched the first clause and was fully re-decoded
             -- up to the attempt cap on EVERY boot, because the drain cap is in-memory. The
             -- comment in the no-speech branch of transcribe-attachment.js asserted this already held;
             -- it did not (adversarial review, MEDIUM-9).
             -- SQL THREE-VALUED LOGIC: a row whose coverage record has no complete key at all
             -- makes json_extract return NULL, so ... = 1 is NULL and NOT NULL is NULL — which is
             -- not TRUE, so the row is DROPPED. Written with plain = this clause silently excluded every
             -- partial it was meant to leave alone, i.e. it re-created D-076. IS is the NULL-safe
             -- comparison and always yields 0/1. Pinned by gate check D10.
             AND NOT (metadata IS NOT NULL AND json_valid(metadata)
                      AND json_extract(metadata, '$.transcription.complete') IS 1)
             -- The audio predicate mirrors isAudio()/mediaTypeOf() — EXCEPT that a row already
             -- carrying a transcription coverage record is audio BY CONSTRUCTION (only the
             -- transcriber writes that key). Rows arrive with a NULL or non-audio file_type from
             -- the channel daemon, which decides the kind itself; the live turn would then write a
             -- partial the drain could never select, leaving it stuck while the portal promised
             -- "the rest will be picked up automatically" (adversarial review, MEDIUM-8).
             AND (file_type LIKE 'audio/%' OR file_type IN ('voice', 'audio')
                  OR (metadata IS NOT NULL AND json_valid(metadata)
                      AND json_extract(metadata, '$.transcription.incomplete') = 1))
           ORDER BY created_at ASC
           LIMIT ?`,
        [userId, limit],
      );
      return (result.results || []).map((r) => r.id);
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

    async update(id, fields) {
      // local_path is an INSERT-ONLY storage key: it is set once (namespaced
      // under the owning user) at insert and the reference-counted blob GC keys
      // on it. Refuse to mutate it here — update() cannot see user_id to
      // re-validate the namespacing, so the fail-closed rule is "never via
      // update". No caller sets it today; this keeps the invariant total.
      if (fields && Object.prototype.hasOwnProperty.call(fields, 'local_path')) {
        throw new Error('attachments.update: local_path is insert-only (cross-tenant blob-collision guard)');
      }
      const keys = assertSafeColumns(Object.keys(fields), 'attachments');
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
