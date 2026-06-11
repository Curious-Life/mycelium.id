// src/db/history.js — append-only entity change-log (ENTITY-HISTORY-DESIGN-2026-06-11).
//
// One namespace over `entity_snapshots`: records a new version of a territory/realm's
// narrative or dynamics ONLY when the content actually changed since the last
// snapshot (dedup-vs-latest), and reads the version series back. Append-only —
// nothing is overwritten or deleted, so the full evolution survives even after the
// live entity dissolves or is pruned.
//
// ENCRYPTION: the single `payload` column is encrypted (ENCRYPTED_FIELDS) and holds
// BOTH the content (prose/scalars) AND all soft metadata (stage, model, version,
// cluster era, capture timestamp) — nothing about the user's life or its timing is
// stored plaintext. The adapter encrypts the JSON string on write and auto-decrypts
// on read, exactly like territory_profiles.raw_response. Dedup compares the DECRYPTED
// latest content (one row) to the incoming content, so no plaintext hash of content
// is stored either. Only the row-addressing skeleton (entity_kind/id, snapshot_kind,
// seq) is plaintext — non-content keys SQLite needs to find/order/dedup rows.

/** Stable-key JSON so semantically-equal payloads compare equal regardless of key
 * order. Arrays keep their order (meaningful); object keys are sorted recursively. */
export function canonicalize(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = norm(v[k]); return acc; }, {});
    }
    return v;
  };
  return JSON.stringify(norm(value ?? null));
}

export function createHistoryNamespace({ d1Query, parseJson, now }) {
  if (typeof d1Query !== 'function') throw new TypeError('createHistoryNamespace: d1Query required');
  const parse = typeof parseJson === 'function' ? parseJson : (s) => { try { return JSON.parse(s); } catch { return null; } };
  const stamp = typeof now === 'function' ? now : () => new Date().toISOString();

  /** Latest snapshot row (decrypted payload) for an entity+kind, or null. */
  async function latest(userId, entityKind, entityId, snapshotKind) {
    const res = await d1Query(
      `SELECT seq, payload FROM entity_snapshots
       WHERE user_id = ? AND entity_kind = ? AND entity_id = ? AND snapshot_kind = ?
       ORDER BY seq DESC LIMIT 1`,
      [userId, entityKind, entityId, snapshotKind],
    );
    return (res.results || [])[0] || null;
  }

  return {
    /**
     * Append a new version IFF the CONTENT changed since the latest snapshot.
     * Metadata (incl. the capture timestamp) is stored but excluded from the dedup
     * compare, so a re-narration with identical prose adds no row.
     * @returns {Promise<{seq:number}|{skipped:true}>}
     */
    async recordSnapshot(userId, {
      entityKind, entityId, snapshotKind, content, meta = {},
    } = {}) {
      if (!userId || !entityKind || entityId == null || !snapshotKind) {
        throw new TypeError('recordSnapshot: userId, entityKind, entityId, snapshotKind required');
      }
      const canon = canonicalize(content);
      const prev = await latest(userId, entityKind, entityId, snapshotKind);
      if (prev) {
        const prevContent = parse(prev.payload)?.content;
        if (canonicalize(prevContent) === canon) return { skipped: true };
      }
      const seq = (Number(prev?.seq) || 0) + 1;
      // Everything sensitive — content + metadata + timestamp — lives in the one
      // encrypted blob. The adapter encrypts it because `payload` is in ENCRYPTED_FIELDS.
      const payload = JSON.stringify({ content: content ?? null, meta: { ...meta, capturedAt: stamp() } });
      await d1Query(
        `INSERT INTO entity_snapshots
           (user_id, entity_kind, entity_id, snapshot_kind, seq, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, entityKind, entityId, snapshotKind, seq, payload],
      );
      return { seq };
    },

    /**
     * Version series for one entity, oldest→newest. payload decrypted + unwrapped
     * to { content, ...meta }. (Read surface — portal/MCP — is deferred; this
     * powers tests + the future reader.)
     */
    async readHistory(userId, entityKind, entityId, { snapshotKind = null, limit = 500 } = {}) {
      const where = ['user_id = ?', 'entity_kind = ?', 'entity_id = ?'];
      const params = [userId, entityKind, entityId];
      if (snapshotKind) { where.push('snapshot_kind = ?'); params.push(snapshotKind); }
      params.push(limit);
      const res = await d1Query(
        `SELECT snapshot_kind, seq, payload FROM entity_snapshots
         WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
        params,
      );
      return (res.results || []).map((r) => {
        const blob = parse(r.payload) || {};
        const meta = blob.meta || {};
        return {
          snapshotKind: r.snapshot_kind, seq: Number(r.seq),
          content: blob.content ?? null,
          stage: meta.stage ?? null, model: meta.model ?? null,
          entityVersion: meta.entityVersion ?? null, clusterVersion: meta.clusterVersion ?? null,
          capturedAt: meta.capturedAt ?? null,
        };
      });
    },
  };
}

export default createHistoryNamespace;
