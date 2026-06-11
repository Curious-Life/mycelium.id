// src/db/history.js — append-only entity change-log (ENTITY-HISTORY-DESIGN-2026-06-11).
//
// One namespace over `entity_snapshots`: records a new version of a territory/realm's
// narrative or dynamics ONLY when it actually changed since the last snapshot
// (dedup-vs-latest), and reads the version series back. Append-only — nothing is ever
// overwritten or deleted, so the full evolution is preserved even after the live
// entity dissolves or is pruned.
//
// payload is the single ENCRYPTED column (ENCRYPTED_FIELDS.entity_snapshots) — the
// adapter encrypts the JSON string on write and auto-decrypts on read, exactly like
// territory_profiles.raw_response. Dedup compares the DECRYPTED latest payload (one
// row) to the incoming one, so no plaintext hash of content is ever stored.

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

export function createHistoryNamespace({ d1Query, parseJson }) {
  if (typeof d1Query !== 'function') throw new TypeError('createHistoryNamespace: d1Query required');
  const parse = typeof parseJson === 'function' ? parseJson : (s) => { try { return JSON.parse(s); } catch { return null; } };

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
     * Append a new version IFF the payload changed since the latest snapshot.
     * @returns {Promise<{seq:number}|{skipped:true}>}
     */
    async recordSnapshot(userId, {
      entityKind, entityId, snapshotKind, stage = null,
      payload, entityVersion = null, clusterVersion = null, model = null,
    } = {}) {
      if (!userId || !entityKind || entityId == null || !snapshotKind) {
        throw new TypeError('recordSnapshot: userId, entityKind, entityId, snapshotKind required');
      }
      const canon = canonicalize(payload);
      const prev = await latest(userId, entityKind, entityId, snapshotKind);
      // prev.payload is the decrypted JSON string; re-canonicalize for a stable compare.
      if (prev && canonicalize(parse(prev.payload)) === canon) return { skipped: true };
      const seq = (Number(prev?.seq) || 0) + 1;
      await d1Query(
        `INSERT INTO entity_snapshots
           (user_id, entity_kind, entity_id, snapshot_kind, stage, seq, payload,
            entity_version, cluster_version, generation_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, entityKind, entityId, snapshotKind, stage, seq, canon,
         entityVersion, clusterVersion, model],
      );
      return { seq };
    },

    /**
     * Version series for one entity, oldest→newest. payload parsed back to an object.
     * (Read surface — portal/MCP — is deferred; this powers tests + the future reader.)
     */
    async readHistory(userId, entityKind, entityId, { snapshotKind = null, limit = 500 } = {}) {
      const where = ['user_id = ?', 'entity_kind = ?', 'entity_id = ?'];
      const params = [userId, entityKind, entityId];
      if (snapshotKind) { where.push('snapshot_kind = ?'); params.push(snapshotKind); }
      params.push(limit);
      const res = await d1Query(
        `SELECT snapshot_kind, stage, seq, payload, entity_version, cluster_version,
                generation_model, created_at
         FROM entity_snapshots WHERE ${where.join(' AND ')}
         ORDER BY seq ASC LIMIT ?`,
        params,
      );
      return (res.results || []).map((r) => ({
        snapshotKind: r.snapshot_kind, stage: r.stage, seq: Number(r.seq),
        payload: parse(r.payload), entityVersion: r.entity_version,
        clusterVersion: r.cluster_version, model: r.generation_model, createdAt: r.created_at,
      }));
    },
  };
}

export default createHistoryNamespace;
