import { createHash } from 'node:crypto';
import { assertSafeColumns, clampLimit } from './column-guard.js';
import { buildAgentIdFilter, resolveAgentIds } from '../agent-id-aliases.js';

/**
 * Read AGENT_SCOPES env at call time. Returns null in admin mode
 * (unset / unparseable) so backfill scripts that import this namespace
 * with no AGENT_SCOPES still see every scope. Returns an array of
 * scope strings otherwise — used as the default SQL-level filter in
 * selectRecent / selectTimeline so an agent never even fetches rows
 * outside its bound scopes (defense in depth above crypto-local's
 * decrypt-time scope guardian, which leaves ciphertext on deny and
 * showed up as encrypted strings in the portal after the moms-scope
 * isolation fix on 2026-05-28).
 */
function _envAllowedScopes() {
  const raw = process.env.AGENT_SCOPES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Messages namespace — the hottest write path in the system.
 *
 * Every agent inbound / outbound, every Discord / Telegram / WhatsApp
 * message, every portal chat — they all land here. The namespace
 * handles insertion (single + batched with D1 param-limit splitting),
 * pagination, agent+scope filtering, timeline reads, and hybrid
 * (FTS5 + vector) search.
 *
 * `selectByAgent` and `listAgentIds` read process.env.MYA_USER_ID as
 * the tenant id. That coupling to env is preserved from the
 * pre-extraction code — tenant resolution happens at the caller.
 *
 * Wave 4b (2026-05-04): vectorQuery + hybridSearch deps removed.
 * matchMessages uses mind-search; matchDocuments uses scan-matchers.
 * Legacy Vectorize + Worker hybrid path retired with the BGE shutdown.
 *
 * @typedef {object} MessagesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(statements: Array<{sql: string, params: any[]}>) => Promise<any[]>} d1Batch
 * @property {(result: any) => any} firstRow
 */

export function createMessagesNamespace(deps) {
  if (!deps) throw new TypeError('createMessagesNamespace: deps required');
  const { d1Query, d1Batch, firstRow } = deps;
  if (typeof d1Query !== 'function')      throw new TypeError('createMessagesNamespace: d1Query required');
  if (typeof d1Batch !== 'function')      throw new TypeError('createMessagesNamespace: d1Batch required');
  if (typeof firstRow !== 'function')     throw new TypeError('createMessagesNamespace: firstRow required');

  return {
    async insert(rows) {
      const arr = Array.isArray(rows) ? rows : [rows];
      assertSafeColumns(Object.keys(arr[0] || {}), 'messages');
      const placeholders = arr.map(() =>
        `(${Object.keys(arr[0]).map(() => '?').join(', ')})`,
      ).join(', ');
      const cols = Object.keys(arr[0]).join(', ');
      const params = arr.flatMap((r) => Object.values(r));

      const result = await d1Query(
        `INSERT INTO messages (${cols}) VALUES ${placeholders} RETURNING id`,
        params,
      );
      return result.results || [];
    },

    /**
     * Update only the metadata column on an existing row. Used by
     * /chat/triage to persist the inbound row at the start of triage,
     * then UPDATE it once the REPLY/NO_REPLY decision is made — keeps
     * the row durable even if Claude crashes mid-flight.
     *
     * userId is REQUIRED in the WHERE clause: the Worker safety guard
     * rejects unfiltered UPDATEs on user-data tables (the same guard
     * that catches accidental cross-tenant writes). The id alone is
     * unique by random hex, but the contract still requires user_id
     * so the same query works on every tenant DB.
     *
     * The metadata param goes through the auto-encryption layer like
     * any other write to ENCRYPTED_FIELDS.messages.
     *
     * @param {string} id
     * @param {string} userId
     * @param {object|null} metadata
     */
    async updateMetadata(id, userId, metadata) {
      const json = metadata == null
        ? null
        : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
      await d1Query(
        `UPDATE messages SET metadata = ? WHERE id = ? AND user_id = ?`,
        [json, id, userId],
      );
    },

    /**
     * Mark a message enriched: write its embedding envelope + advance the
     * nlp_processed state machine. The D7 enrichment service is the only
     * caller. States: 0 pending → 2 embedded, or -1 on a per-row failure
     * (nlp_error records why). nlp_processed_at stamps the transition.
     *
     * embedding_768 is deliberately NOT in ENCRYPTED_FIELDS — the caller
     * passes a ready wrapped-DEK vector envelope (encryptVector), so it
     * stores raw, exactly the value the mind-search ANN read path expects.
     * userId is REQUIRED in the WHERE clause (same unfiltered-UPDATE guard
     * as updateMetadata).
     *
     * @param {string} id
     * @param {string} userId
     * @param {{embedding768?: string, nlpProcessed: number, nlpError?: string|null}} fields
     */
    async updateEnrichment(id, userId, { embedding768, nlpProcessed, nlpError = null } = {}) {
      if (typeof nlpProcessed !== 'number') {
        throw new TypeError('updateEnrichment: nlpProcessed (number) required');
      }
      const sets = [];
      const params = [];
      if (embedding768 !== undefined) {
        sets.push('embedding_768 = ?');
        params.push(embedding768);
      }
      sets.push('nlp_processed = ?');
      params.push(nlpProcessed);
      sets.push('nlp_error = ?');
      params.push(nlpError);
      sets.push("nlp_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    /**
     * Drain query for the enrichment service: messages awaiting embedding.
     * nlp_processed = 0 (or NULL legacy) AND non-empty content. content
     * auto-decrypts to plaintext on read, so the worker embeds plaintext.
     * Oldest-first so a backlog drains in arrival order. The state predicate
     * runs on the (unencrypted) nlp_processed column at SQL level.
     *
     * @param {string} userId
     * @param {{limit?: number}} opts
     */
    async selectPendingEnrichment(userId, { limit = 50 } = {}) {
      const result = await d1Query(
        `SELECT id, content, scope FROM messages
           WHERE user_id = ?
             AND forgotten_at IS NULL
             AND (nlp_processed = 0 OR nlp_processed IS NULL)
             AND content IS NOT NULL AND content != ''
           ORDER BY created_at ASC
           LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    /**
     * Embedding backlog snapshot for the activity/status surfaces. The single
     * source of truth for "embedded vs total vs pending" — `total` counts only
     * EMBEDDABLE messages (`content IS NOT NULL AND content != ''`), the SAME
     * predicate selectPendingEnrichment uses, so `pending` reflects work the
     * drainer can actually do and reaches 0 (a content-NULL row can never embed,
     * so counting it in `total` made the old `total − embedded` stick forever —
     * the "19 remaining" bug). PIPELINE-INTEGRITY design §P1.2.
     * @returns {Promise<{ embedded:number, total:number, pending:number }>}
     */
    async embedBacklog(userId) {
      const r = await d1Query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN embedding_768 IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded
         FROM messages
         WHERE user_id = ?
           AND forgotten_at IS NULL
           AND content IS NOT NULL AND content != ''`,
        [userId],
      );
      const row = (r.results || [])[0] || {};
      const total = Number(row.total || 0);
      const embedded = Number(row.embedded || 0);
      return { embedded, total, pending: Math.max(0, total - embedded) };
    },

    /**
     * Drain query for the NLP rules pass (enrichment stage 2). Selects rows
     * that are embedded but not yet enriched — nlp_processed = 2 — per the
     * canonical state machine (0 unprocessed → 2 embedded → 1 enriched).
     * content auto-decrypts on read so the extractor sees plaintext.
     *
     * @param {string} userId
     * @param {{limit?: number}} opts
     */
    async selectPendingNlp(userId, { limit = 50 } = {}) {
      const result = await d1Query(
        `SELECT id, content, scope FROM messages
           WHERE user_id = ?
             AND forgotten_at IS NULL
             AND nlp_processed = 2
             AND content IS NOT NULL AND content != ''
           ORDER BY created_at ASC
           LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    /**
     * Write NLP extraction results + advance the state machine to enriched (1).
     * entities/tags/entity_summary are ENCRYPTED_FIELDS — the caller passes
     * plaintext (JSON strings for entities/tags, a line for entity_summary) and
     * the adapter encrypts on write. userId REQUIRED in WHERE (unfiltered-UPDATE
     * guard). On failure the caller passes nlpProcessed=-1 + nlpError.
     *
     * @param {string} id
     * @param {string} userId
     * @param {{entities?: string, tags?: string, entitySummary?: string, nlpProcessed: number, nlpError?: string|null}} fields
     */
    async updateNlp(id, userId, { entities, tags, entitySummary, nlpProcessed, nlpError = null } = {}) {
      if (typeof nlpProcessed !== 'number') {
        throw new TypeError('updateNlp: nlpProcessed (number) required');
      }
      const sets = [];
      const params = [];
      if (entities !== undefined) { sets.push('entities = ?'); params.push(entities); }
      if (tags !== undefined) { sets.push('tags = ?'); params.push(tags); }
      if (entitySummary !== undefined) { sets.push('entity_summary = ?'); params.push(entitySummary); }
      sets.push('nlp_processed = ?');
      params.push(nlpProcessed);
      sets.push('nlp_error = ?');
      params.push(nlpError);
      sets.push("nlp_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    /**
     * Soft-redact (forget): destroy a message's sensitive payload but keep an
     * empty tombstone row (id + timestamps) for audit + anti-resurrection. Nulls
     * every ENCRYPTED_FIELDS column + the embedding (both fingerprints), deletes
     * the derived clustering_points row, and stamps forgotten_at. Returns the
     * pre-redaction content hash + length for the audit ledger — NEVER the
     * plaintext. Local SQLite; literal NULLs so the encrypt layer is a no-op.
     *
     * @param {string} id
     * @param {string} userId
     * @returns {Promise<{found:boolean, alreadyForgotten?:boolean, contentHash:string|null, length:number}>}
     */
    async redact(id, userId) {
      const cur = await d1Query(
        `SELECT content, forgotten_at FROM messages WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const row = firstRow(cur);
      if (!row) return { found: false, contentHash: null, length: 0 };
      if (row.forgotten_at) return { found: true, alreadyForgotten: true, contentHash: null, length: 0 };
      const content = row.content ?? '';
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      await d1Batch([
        {
          sql: `UPDATE messages SET
                  content = NULL, content_hash = NULL, thinking = NULL, tags = NULL, entities = NULL,
                  entity_summary = NULL, relations = NULL, metadata = NULL,
                  suggested_new_tag = NULL, nlp_error = NULL, embedding_768 = NULL,
                  forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND user_id = ?`,
          params: [id, userId],
        },
        {
          sql: `DELETE FROM clustering_points WHERE user_id = ? AND source_type = 'message' AND source_id = ?`,
          params: [userId, id],
        },
      ]);
      return { found: true, contentHash, length: content.length };
    },

    /**
     * Set user-asserted salience flags on a message. Forgotten rows are
     * immutable (excluded by the WHERE). RETURNING detects a live match.
     *
     * @param {string} id
     * @param {string} userId
     * @param {{pinned?:boolean, sensitive?:boolean}} flags
     */
    async setSalience(id, userId, { pinned, sensitive } = {}) {
      const sets = [];
      const params = [];
      if (pinned !== undefined) { sets.push('pinned = ?'); params.push(pinned ? 1 : 0); }
      if (sensitive !== undefined) { sets.push('sensitive = ?'); params.push(sensitive ? 1 : 0); }
      if (!sets.length) return { found: true, changed: false };
      params.push(id, userId);
      const res = await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
        params,
      );
      const hit = firstRow(res);
      return { found: !!hit, changed: !!hit };
    },

    /** INSERT OR IGNORE — skips duplicate IDs. Splits into D1's ~100 param limit. */
    async insertIgnore(rows) {
      const arr = Array.isArray(rows) ? rows : [rows];
      if (arr.length === 0) return [];
      const cols = assertSafeColumns(Object.keys(arr[0]), 'messages');
      const colNames = cols.join(', ');
      const allInserted = [];
      // ROWS_PER_STMT keeps each statement under D1's ~100-param ceiling.
      const ROWS_PER_STMT = Math.max(1, Math.floor(95 / cols.length));
      const statements = [];
      for (let i = 0; i < arr.length; i += ROWS_PER_STMT) {
        const batch = arr.slice(i, i + ROWS_PER_STMT);
        const placeholders = batch.map(() =>
          `(${cols.map(() => '?').join(', ')})`,
        ).join(', ');
        const params = batch.flatMap((r) => cols.map((c) => r[c]));
        statements.push({
          sql: `INSERT OR IGNORE INTO messages (${colNames}) VALUES ${placeholders}`,
          params,
        });
      }
      // d1Batch sends multiple statements in one HTTP round-trip.
      const BATCH_SIZE = 50;
      for (let i = 0; i < statements.length; i += BATCH_SIZE) {
        const stmtBatch = statements.slice(i, i + BATCH_SIZE);
        try {
          const results = await d1Batch(stmtBatch);
          for (const r of results) {
            allInserted.push(...(r.results || []));
          }
        } catch {
          // Fallback: execute one-by-one if the batch request itself fails.
          for (const stmt of stmtBatch) {
            try {
              const r = await d1Query(stmt.sql, stmt.params);
              allInserted.push(...(r.results || []));
            } catch { /* skip duplicates */ }
          }
        }
      }
      return allInserted;
    },

    async getExistingIds(userId, ids) {
      const existing = new Set();
      // D1 param cap: 1 for userId + up to 90 IDs per batch.
      for (let i = 0; i < ids.length; i += 90) {
        const batch = ids.slice(i, i + 90);
        const placeholders = batch.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
          [userId, ...batch],
        );
        for (const row of result.results || []) existing.add(row.id);
      }
      return existing;
    },

    /**
     * Change-detection metadata for one message id — drives captureMessage's
     * insert / no-op / update branch. content_hash is PLAINTEXT (0007) so it
     * compares without decrypting; content is decrypted by the adapter on read
     * so a legacy NULL hash can still be derived. `forgotten` is surfaced so the
     * caller never resurrects a redacted message.
     */
    async getContentMeta(userId, id) {
      const res = await d1Query(
        `SELECT content_hash, content, forgotten_at FROM messages WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const row = firstRow(res);
      if (!row) return { exists: false, contentHash: null, content: null, forgotten: false };
      return {
        exists: true,
        contentHash: row.content_hash ?? null,
        content: row.content ?? null,
        forgotten: Boolean(row.forgotten_at),
      };
    },

    /**
     * Content changed upstream — overwrite body + hash and RE-ENRICH: reset
     * nlp_processed=0 (the drainer re-embeds), null the embedding + every
     * AI-derived column, and drop the stale mindscape point so the cluster sync
     * re-adds it with the new embedding. Mirrors redact()'s reset minus the
     * tombstone, and is gated `forgotten_at IS NULL` so a redacted message is
     * never resurrected. content + metadata auto-encrypt on write; content_hash
     * stays plaintext (crypto-local.js parseWriteSQL UPDATE branch). Returns
     * { changed } — false if no live row matched (forgotten / missing).
     */
    async updateContent(userId, id, { content, contentHash, metadata }) {
      // metadata is written ONLY when the caller provides it (mirrors
      // document-store): an update that omits metadata must not wipe the prior
      // value. content + (optional) metadata auto-encrypt; content_hash stays
      // plaintext. parseWriteSQL maps the encrypted params by SET position, so
      // a dynamic SET clause stays correct.
      const sets = ['content = ?', 'content_hash = ?'];
      const params = [content, contentHash];
      if (metadata !== undefined) { sets.push('metadata = ?'); params.push(metadata); }
      // Re-enrich: clear AI-derived columns so the drainer re-embeds + re-clusters.
      sets.push(
        'nlp_processed = 0', 'nlp_processed_at = NULL', 'nlp_error = NULL',
        'thinking = NULL', 'tags = NULL', 'entities = NULL', 'entity_summary = NULL',
        'relations = NULL', 'suggested_new_tag = NULL', 'embedding_768 = NULL',
      );
      params.push(id, userId);
      const res = await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
        params,
      );
      const changed = Boolean(firstRow(res));
      if (changed) {
        await d1Query(
          `DELETE FROM clustering_points WHERE user_id = ? AND source_type = 'message' AND source_id = ?`,
          [userId, id],
        );
      }
      return { changed };
    },

    /** Backfill content_hash on a legacy (pre-0007) row whose content is unchanged — no re-enrich. */
    async backfillContentHash(userId, id, contentHash) {
      await d1Query(
        `UPDATE messages SET content_hash = ? WHERE id = ? AND user_id = ? AND content_hash IS NULL`,
        [contentHash, id, userId],
      );
    },

    async getExistingConversationIds(userId, source) {
      const result = await d1Query(
        `SELECT DISTINCT conversation_id FROM messages WHERE user_id = ? AND source = ? AND conversation_id IS NOT NULL`,
        [userId, source],
      );
      return new Set((result.results || []).map((r) => r.conversation_id));
    },

    /**
     * Cursor-paginated forward iteration for mind-search rehydrate.
     *
     * Returns one batch at a time, ordered by id ASC so a stable cursor
     * is just `lastId > ?`. Caller drives the loop. Always pulls
     * embedding_768 — this method exists specifically for rehydrate.
     *
     * Differs from selectRecent in two ways: (1) ASC order with a
     * cursor instead of a fixed-size most-recent slice, (2) no
     * agentId filter — rehydrate populates everything the agent's
     * scope can see.
     *
     * @param {string} userId  tenant id
     * @param {{ batchSize?: number, cursor?: string, scope?: string }} opts
     * @returns {Promise<Array<{ id, content, scope, created_at, embedding_768 }>>}
     */
    async streamForRehydrate(userId, { batchSize = 200, cursor = '', scope } = {}) {
      let sql = `SELECT id, content, scope, created_at, embedding_768
                 FROM messages
                 WHERE user_id = ? AND id > ? AND embedding_768 IS NOT NULL AND forgotten_at IS NULL`;
      const params = [userId, cursor];
      if (scope) {
        // Same scope-fan rule as selectRecent: 'personal' sees personal+org,
        // 'wealth' sees wealth+org, 'all' sees everything.
        if (scope === 'personal') {
          sql += ` AND scope IN ('personal', 'org')`;
        } else if (scope === 'wealth') {
          sql += ` AND scope IN ('wealth', 'org')`;
        } else if (scope !== 'all') {
          sql += ` AND scope = ?`;
          params.push(scope);
        }
      }
      sql += ` ORDER BY id ASC LIMIT ?`;
      params.push(batchSize);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async selectRecent(userId, { limit = 10, agentId, since, scope, includeEmbedding768 = false } = {}) {
      limit = clampLimit(limit, 10);
      const cols = `id, content, role, source, agent_id, attachment_id, tags, entities, scope, created_at, pinned${
        includeEmbedding768 ? ', embedding_768' : ''
      }`;
      let sql = `SELECT ${cols} FROM messages WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      // Alias-aware filter: personal-agent expands to (personal-agent, mya-personal).
      // Single source of truth in @mycelium/core/agent-id-aliases.js.
      const agentFilter = buildAgentIdFilter(agentId);
      if (agentFilter.sql) {
        sql += ` AND ${agentFilter.sql}`;
        params.push(...agentFilter.params);
      }
      if (scope) {
        // Scope filtering: 'personal' sees personal+org, 'wealth' sees
        // wealth+org, 'all' sees everything, else specific scope only.
        if (scope === 'personal') {
          sql += ` AND scope IN ('personal', 'org')`;
        } else if (scope === 'wealth') {
          sql += ` AND scope IN ('wealth', 'org')`;
        } else if (scope !== 'all') {
          sql += ` AND scope = ?`;
          params.push(scope);
        }
      } else {
        // No explicit scope — default to this agent's AGENT_SCOPES so we
        // never fetch a row the scope-guardian will then deny. Without
        // this the row arrives as ciphertext and reaches the portal.
        const allowed = _envAllowedScopes();
        if (allowed) {
          const placeholders = allowed.map(() => '?').join(', ');
          sql += ` AND scope IN (${placeholders})`;
          params.push(...allowed);
        }
      }
      if (since) {
        sql += ` AND created_at >= ?`;
        params.push(since);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async selectPaginated(userId, { since, until, offset = 0, limit = 30, channel, agentId, excludeAgentId } = {}) {
      limit = clampLimit(limit, 30);
      let where = `WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (since)   { where += ` AND created_at >= ?`; params.push(since); }
      if (until)   { where += ` AND created_at < ?`;  params.push(until); }
      if (channel) { where += ` AND source LIKE ?`;   params.push(`${channel}%`); }
      // Alias-aware include filter (personal-agent → both canonical + mya-personal).
      const agentFilter = buildAgentIdFilter(agentId);
      if (agentFilter.sql) {
        where += ` AND ${agentFilter.sql}`;
        params.push(...agentFilter.params);
      }
      if (excludeAgentId) {
        // Each entry in excludeAgentId expands through aliases too — excluding
        // 'personal-agent' must also exclude 'mya-personal' or company-scope
        // recall would leak personal data.
        const requested = Array.isArray(excludeAgentId) ? excludeAgentId : [excludeAgentId];
        const expanded = requested.flatMap((id) => resolveAgentIds(id) || []);
        if (expanded.length) {
          const placeholders = expanded.map(() => '?').join(', ');
          where += ` AND (agent_id NOT IN (${placeholders}) OR agent_id IS NULL)`;
          params.push(...expanded);
        }
      }

      const countResult = await d1Query(`SELECT COUNT(*) as count FROM messages ${where}`, params);
      const total = countResult.results?.[0]?.count || 0;

      const dataResult = await d1Query(
        `SELECT content, role, source, agent_id, created_at FROM messages ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      return {
        messages: dataResult.results || [],
        total, offset, limit,
        hasMore: offset + limit < total,
      };
    },

    async selectByAgent(agentId, { offset = 0, limit = 50 } = {}) {
      const userId = process.env.MYA_USER_ID;
      // Alias-aware: 'personal-agent' includes 'mya-personal' rows so the
      // portal "messages by agent" view shows the full historical roster
      // (~38k pre-monorepo imports otherwise hidden).
      const agentFilter = buildAgentIdFilter(agentId);
      const where = agentFilter.sql
        ? `WHERE ${agentFilter.sql} AND user_id = ? AND forgotten_at IS NULL`
        : `WHERE user_id = ? AND forgotten_at IS NULL`;
      const filterParams = [...agentFilter.params, userId];

      const countResult = await d1Query(
        `SELECT COUNT(*) as count FROM messages ${where}`,
        filterParams,
      );
      const count = countResult.results?.[0]?.count || 0;

      const result = await d1Query(
        `SELECT id, role, content, created_at, metadata FROM messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...filterParams, limit, offset],
      );
      return { data: result.results || [], count };
    },

    async selectTimeline(userId, { limit = 50, before, since, afterId, scope } = {}) {
      // metadata is encrypted at rest; the auto-decrypt layer returns a
      // JSON string here. Routes parse it before projecting to the UI so
      // we never leak triage decisions / dedupe nonces / delivery state
      // beyond the read path.
      let sql = `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id, metadata FROM messages WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (before) { sql += ` AND created_at < ?`; params.push(before); }
      // `since` is the unified-river time-scope floor (Today/7d/All) — pushed into
      // SQL so cursor pagination stays correct across the cross-table merge.
      if (since) { sql += ` AND created_at >= ?`; params.push(since); }
      if (afterId) {
        sql += ` AND rowid < (SELECT rowid FROM messages WHERE id = ?)`;
        params.push(afterId);
      }
      if (scope && scope !== 'all') {
        const list = Array.isArray(scope) ? scope : [scope];
        const placeholders = list.map(() => '?').join(', ');
        sql += ` AND scope IN (${placeholders})`;
        params.push(...list);
      } else if (!scope) {
        const allowed = _envAllowedScopes();
        if (allowed) {
          const placeholders = allowed.map(() => '?').join(', ');
          sql += ` AND scope IN (${placeholders})`;
          params.push(...allowed);
        }
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    // Conversation-scoped history (Phase 5, Step 6) — the rows for ONE conversation,
    // for a channel/scheduled turn's history hydration. Modeled on selectTimeline but
    // filtered by conversation_id (which selectTimeline ignores). user_id + conversation_id
    // together scope it: a channel turn can only ever see ITS conversation, never the
    // owner's chat or another channel. content auto-decrypts via the d1Query wrapper.
    // Newest-first (like selectTimeline); the caller reverses for chronological order.
    async selectByConversation(userId, conversationId, { limit = 30, before } = {}) {
      if (!conversationId) return [];
      let sql = `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ? AND conversation_id = ? AND forgotten_at IS NULL`;
      const params = [userId, conversationId];
      if (before) { sql += ` AND created_at < ?`; params.push(before); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(Number(limit) || 30);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async countByUser(userId) {
      const result = await d1Query(`SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND forgotten_at IS NULL`, [userId]);
      return firstRow(result)?.count || 0;
    },

    async selectAll(userId, { limit = 500, offset = 0 } = {}) {
      limit = clampLimit(limit, 500, 5000);
      const result = await d1Query(
        `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ? AND forgotten_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [userId, limit, offset],
      );
      return result.results || [];
    },

    async listAgentIds() {
      const userId = process.env.MYA_USER_ID;
      const result = await d1Query(
        `SELECT DISTINCT agent_id FROM messages WHERE agent_id IS NOT NULL AND user_id = ?`,
        [userId],
      );
      return (result.results || []).map((r) => r.agent_id);
    },

    /**
     * Aggregate of every (source, agent_id) pair the user has ingested,
     * with row count + date range + embedding coverage. Used by the
     * `listDataSources` MCP tool so agents can introspect "what's
     * actually in the vault" before claiming data is missing.
     *
     * source + agent_id + created_at + embedding_768 are NOT encrypted
     * (per crypto-local.js plaintext field list), so the aggregate runs
     * SQL-side with no decrypt cost.
     *
     * Returns rows pre-sorted by total count descending.
     */
    async listDataSources(userId) {
      const result = await d1Query(
        `SELECT
           COALESCE(source, '(no source)')      AS source,
           COALESCE(agent_id, '(no agent)')     AS agent_id,
           COUNT(*)                             AS row_count,
           MIN(created_at)                      AS oldest,
           MAX(created_at)                      AS newest,
           SUM(CASE WHEN embedding_768 IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM messages
         WHERE user_id = ? AND forgotten_at IS NULL
         GROUP BY source, agent_id
         ORDER BY row_count DESC`,
        [userId],
      );
      return result.results || [];
    },

    async matchMessages(embedding, userId, count = 5) {
      // Mind-search is the only path. Vectorize fallback removed
      // (Wave 4b 2026-05-04) — that path was 1024D-vs-768D broken
      // since the BGE shutdown and we don't keep deprecated paths
      // alive as silent fallbacks. If mind-search is unregistered
      // or fails, return empty and let the caller surface the
      // condition (the /internal/v1/search/mindscape endpoint
      // already returns 503 + Retry-After when subsystems aren't
      // ready, so the user-visible signal is preserved).
      const { getMindSearch } = await import('../mind-search/registry.js');
      const mindSearch = getMindSearch();
      if (!mindSearch) return [];

      let matches = [];
      try {
        const result = await mindSearch.query({
          embedding,
          topK: count,
          recency: 'mixed',
        });
        matches = (result.hits || []).map((h) => ({ id: h.id, score: h.score }));
      } catch {
        return [];
      }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, content, role, source, agent_id, created_at, entity_summary FROM messages WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL`,
        [userId, ...ids],
      );
      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },

    async matchDocuments(embedding, userId, count = 5, includeInternal = false) {
      // Scan-matcher only. Vectorize fallback removed (Wave 4b).
      const { getScanMatcher } = await import('../mind-search/scan-matcher-registry.js');
      const sm = getScanMatcher('documents');
      if (!sm) return [];

      let matches = [];
      try { matches = await sm.search(embedding, count); }
      catch { return []; }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      let sql = `SELECT id, path, title, summary, content FROM documents WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL`;
      if (!includeInternal) sql += ` AND is_internal = 0`;
      const result = await d1Query(sql, [userId, ...ids]);

      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },
  };
}
