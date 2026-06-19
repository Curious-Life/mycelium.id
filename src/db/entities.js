import { createHash } from 'node:crypto';
import { clampLimit } from './column-guard.js';

// Keep-last-N bound on entity version rows per (user,entity) — bound growth (red-team HIGH-1).
const ENTITY_VERSION_KEEP = 50;

/**
 * Entities namespace — people/projects/places/orgs as first-class nodes, plus
 * their links to messages/documents/facts.
 *
 * Written via remember(kind:'entity') + the `link` verb; surfaced in getContext
 * (PEOPLE/PROJECTS, pinned-only) + searchMindscape({scope:'entities'}); curated
 * via forget/mark. NLP-extracted proper nouns (messages.entities, enrichment-
 * written) are promoted in via promoteFromMessages and merged with curation.
 *
 * Encryption boundary (verified src/adapter/d1.js + crypto-local.js):
 *   - name/aliases/summary are in ENCRYPTED_FIELDS.entities — the adapter
 *     auto-encrypts bound params on INSERT and the UPDATE-SET path, and
 *     auto-decrypts on read (so scanned names come back plaintext).
 *   - DEDUP IS APP-LAYER. `name` is encrypted with a random IV (non-
 *     deterministic), so a UNIQUE/ON CONFLICT(name) can never match. upsert
 *     scans this user's entities of a type, matches the decrypted name
 *     case-insensitively, and updates by id (or inserts). Single-user scale
 *     (dozens–hundreds of entities) makes the scan cheap.
 *   - redact() nulls name/aliases/summary with LITERAL NULLs (encrypt-layer
 *     no-op) and drops the entity's links (they carry no plaintext).
 *
 * Local SQLite vault. @see migrations/0006_entities.sql
 */
export function createEntitiesNamespace(deps) {
  if (!deps) throw new TypeError('createEntitiesNamespace: deps required');
  const { d1Query, firstRow, randomUUID } = deps;
  if (typeof d1Query !== 'function')    throw new TypeError('createEntitiesNamespace: d1Query required');
  if (typeof firstRow !== 'function')   throw new TypeError('createEntitiesNamespace: firstRow required');
  if (typeof randomUUID !== 'function') throw new TypeError('createEntitiesNamespace: randomUUID required');

  const LIVE_COLS = 'id, type, name, aliases, summary, source, mention_count, pinned, sensitive, updated_at';
  const norm = (s) => (s ?? '').toString().trim().toLowerCase();

  // Scan one user's entities of a type (names decrypted) — backs app-layer dedup.
  async function scanByType(userId, type, { includeForgotten = false } = {}) {
    const where = includeForgotten
      ? 'user_id = ? AND type = ?'
      : 'user_id = ? AND type = ? AND forgotten_at IS NULL';
    const res = await d1Query(
      `SELECT ${LIVE_COLS}, forgotten_at FROM entities WHERE ${where} ORDER BY mention_count DESC, updated_at DESC`,
      [userId, type],
    );
    return res?.results || [];
  }

  /**
   * Find-or-update an entity by (type, name). Never downgrades a user/assistant
   * entity to 'nlp'; keeps the richer (longer) summary/aliases; bumps
   * mention_count; restores a forgotten husk (clears forgotten_at) on re-assert.
   * @returns {Promise<{id:string, status:'created'|'updated'|'restored'}>}
   */
  async function upsert({ userId, type, name, aliases = null, summary = null, source = 'user', mentionCount = 0, trigger, reason }) {
    const rows = await scanByType(userId, type, { includeForgotten: true });
    const match = rows.find((e) => norm(e.name) === norm(name));
    if (match) {
      const keepSource = (match.source === 'user' || match.source === 'assistant') ? match.source : source;
      const newSummary = summary != null && summary !== '' ? summary : (match.summary ?? null);
      const newAliases = aliases != null && aliases !== '' ? aliases : (match.aliases ?? null);
      const newCount = Math.max(match.mention_count || 0, mentionCount || 0);
      // RT2-H1 (0034): snapshot the prior entity content before an overwrite changes
      // summary/aliases, so a poisoned remember(entity) is recoverable. A forgotten-husk
      // restore and a no-op (e.g. an NLP mention-count bump) capture nothing. Non-fatal +
      // isolated — never deny the write; no plaintext logged.
      if (!match.forgotten_at && (newSummary !== (match.summary ?? null) || newAliases !== (match.aliases ?? null))) {
        try {
          await d1Query(
            `INSERT INTO entity_versions (user_id, entity_id, type, name, aliases, summary, trigger, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, match.id, type, match.name ?? null, match.aliases ?? null, match.summary ?? null, trigger || 'overwrite', reason ?? null],
          );
          await d1Query(
            `DELETE FROM entity_versions WHERE user_id = ? AND entity_id = ? AND id NOT IN (
               SELECT id FROM entity_versions WHERE user_id = ? AND entity_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
            [userId, match.id, userId, match.id, ENTITY_VERSION_KEEP],
          );
        } catch (e) { console.warn(`[entity-version] prior-snapshot capture failed: ${e?.code || e?.name || 'error'}`); }
      }
      // `name` is deliberately NOT updated: the match is BY normalized name, so
      // the canonical display casing set on creation persists — a casual case
      // variant or an NLP-promoted proper noun must not downcase/overwrite a
      // curated name. aliases/summary are re-encrypted by the UPDATE-SET path.
      await d1Query(
        `UPDATE entities SET aliases = ?, summary = ?, source = ?, mention_count = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), forgotten_at = NULL
         WHERE id = ? AND user_id = ?`,
        [newAliases, newSummary, keepSource, newCount, match.id, userId],
      );
      return { id: match.id, status: match.forgotten_at ? 'restored' : 'updated' };
    }
    const id = randomUUID();
    await d1Query(
      `INSERT INTO entities (id, user_id, type, name, aliases, summary, source, mention_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, type, name, aliases, summary, source, mentionCount],
    );
    return { id, status: 'created' };
  }

  // Pinned, non-sensitive entities for getContext PEOPLE/PROJECTS (capped).
  async function forContext({ userId, limit = 20 }) {
    const res = await d1Query(
      `SELECT ${LIVE_COLS} FROM entities
       WHERE user_id = ? AND forgotten_at IS NULL AND sensitive = 0 AND pinned = 1
       ORDER BY type ASC, mention_count DESC LIMIT ?`,
      [userId, limit],
    );
    return res?.results || [];
  }

  // List live entities (optionally by type) — the searchMindscape({scope:'entities'})
  // surface. Includes sensitive (explicit request).
  async function list({ userId, type = null, limit = 200 }) {
    const params = [userId];
    let where = 'user_id = ? AND forgotten_at IS NULL';
    if (type) { where += ' AND type = ?'; params.push(type); }
    params.push(limit);
    const res = await d1Query(
      `SELECT ${LIVE_COLS} FROM entities WHERE ${where}
       ORDER BY pinned DESC, mention_count DESC, updated_at DESC LIMIT ?`,
      params,
    );
    return res?.results || [];
  }

  // Link an entity to an item (message|document|fact). Dedup via INSERT OR IGNORE
  // (entity_links is all-plaintext, UNIQUE(user_id,entity_id,ref_type,ref_id)).
  async function link({ userId, entityId, refType, refId }) {
    const res = await d1Query(
      `INSERT OR IGNORE INTO entity_links (id, user_id, entity_id, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), userId, entityId, refType, refId],
    );
    return { created: (res?.meta?.changes ?? 0) > 0 };
  }

  async function linksFor({ userId, entityId }) {
    const res = await d1Query(
      `SELECT ref_type, ref_id, created_at FROM entity_links WHERE user_id = ? AND entity_id = ? ORDER BY created_at DESC`,
      [userId, entityId],
    );
    return res?.results || [];
  }

  /**
   * Soft-redact (forget) an entity: null name/aliases/summary, stamp
   * forgotten_at, drop its links (no plaintext lost). Returns the pre-redaction
   * name hash + length — NEVER plaintext. Idempotent.
   */
  async function redact(id, userId) {
    const row = firstRow(await d1Query(
      `SELECT name, forgotten_at FROM entities WHERE id = ? AND user_id = ?`,
      [id, userId],
    ));
    if (!row) return { found: false, contentHash: null, length: 0 };
    if (row.forgotten_at) return { found: true, alreadyForgotten: true, contentHash: null, length: 0 };
    const name = row.name ?? '';
    const contentHash = createHash('sha256').update(name, 'utf8').digest('hex');
    await d1Query(
      `UPDATE entities SET name = NULL, aliases = NULL, summary = NULL,
         forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND user_id = ?`,
      [id, userId],
    );
    await d1Query(`DELETE FROM entity_links WHERE user_id = ? AND entity_id = ?`, [userId, id]);
    return { found: true, contentHash, length: name.length };
  }

  // Salience flags (plaintext integers; forgotten husks immutable via WHERE).
  async function setSalience(id, userId, { pinned, sensitive } = {}) {
    const sets = [];
    const params = [];
    if (pinned !== undefined)    { sets.push('pinned = ?');    params.push(pinned ? 1 : 0); }
    if (sensitive !== undefined) { sets.push('sensitive = ?'); params.push(sensitive ? 1 : 0); }
    if (!sets.length) return { found: true, changed: false };
    params.push(id, userId);
    const res = await d1Query(
      `UPDATE entities SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
      params,
    );
    return { found: !!firstRow(res), changed: !!firstRow(res) };
  }

  /**
   * Promote NLP-extracted proper nouns / @mentions (messages.entities, written
   * by enrichment as JSON {category:[values]}) into the registry. Aggregates by
   * normalized name across messages, promotes only those mentioned >= minMentions
   * (filters one-off capitalized noise), upserts source='nlp' (never clobbering a
   * user/assistant entity). Verifiable by seeding messages.entities.
   *
   * @returns {Promise<{scanned:number, candidates:number, promoted:number, skipped:number}>}
   */
  async function promoteFromMessages({ userId, minMentions = 3, limit = 5000 }) {
    const res = await d1Query(
      `SELECT entities FROM messages WHERE user_id = ? AND entities IS NOT NULL AND forgotten_at IS NULL LIMIT ?`,
      [userId, limit],
    );
    const rows = res?.results || [];
    const CAT_TO_TYPE = { proper: 'proper', mention: 'person' };
    const agg = new Map(); // `${type} ${normName}` -> { type, name, count }
    for (const r of rows) {
      let obj;
      try { obj = JSON.parse(r.entities); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      for (const [cat, type] of Object.entries(CAT_TO_TYPE)) {
        const vals = Array.isArray(obj[cat]) ? obj[cat] : [];
        for (const v of vals) {
          const name = (v ?? '').toString().trim();
          if (!name) continue;
          const key = `${type} ${norm(name)}`;
          const cur = agg.get(key) || { type, name, count: 0 };
          cur.count++;
          agg.set(key, cur);
        }
      }
    }
    let promoted = 0, skipped = 0;
    for (const { type, name, count } of agg.values()) {
      if (count < minMentions) { skipped++; continue; }
      await upsert({ userId, type, name, source: 'nlp', mentionCount: count });
      promoted++;
    }
    return { scanned: rows.length, candidates: agg.size, promoted, skipped };
  }

  // ── RT2-H1 recovery (migration 0034) ────────────────────────────────

  // Prior versions of an entity (by entity_id), newest first; name/aliases/summary
  // auto-decrypt. The recovery half for poisoned remember(entity) overwrites.
  async function listVersions({ userId, entityId, limit = 20 }) {
    const res = await d1Query(
      `SELECT id, name, aliases, summary, trigger, reason, created_at FROM entity_versions
       WHERE user_id = ? AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [userId, entityId, clampLimit(limit, 20, 200)],
    );
    return res?.results || [];
  }

  // Restore a prior version's summary/aliases. Routes through upsert() (matches by name,
  // updates in place) so the CURRENT value is itself versioned first — reversible.
  async function restoreVersion(userId, versionId) {
    const v = firstRow(await d1Query(
      `SELECT entity_id, type, name, aliases, summary FROM entity_versions WHERE id = ? AND user_id = ?`,
      [versionId, userId],
    ));
    if (!v) return null;
    return upsert({ userId, type: v.type, name: v.name, summary: v.summary, aliases: v.aliases, source: 'user', trigger: 'restore', reason: `restore ${versionId}` });
  }

  return { upsert, forContext, list, link, linksFor, redact, setSalience, promoteFromMessages, listVersions, restoreVersion };
}
