/**
 * Space oplog namespace — the append-only, owner-signed CIPHERTEXT log + sealed CEKs
 * that back E2E shared spaces (docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md, BU-OPLOG-E2E).
 *
 * The owner box is the single home-of-record: it assigns the total order (`seq`) and
 * Ed25519-signs each entry header over the ciphertext payload. A grantee pulls the log
 * into a read-replica and decrypts locally with the CEK it was sealed. The DB layer is
 * content-agnostic — `payload` is opaque ciphertext, `blob` is an opaque sealed CEK.
 *
 * @typedef {object} SpaceOplogNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createSpaceOplogNamespace(deps) {
  if (!deps) throw new TypeError('createSpaceOplogNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createSpaceOplogNamespace: d1Query required');

  const headSeq = async (spaceId) => {
    const r = await d1Query(`SELECT COALESCE(MAX(seq), -1) AS h FROM space_oplog WHERE space_id = ?`, [spaceId]);
    return r.results?.[0]?.h ?? -1;
  };

  return {
    /**
     * Append a signed entry at the next seq (owner authority). IDEMPOTENT on op_id: a
     * duplicate returns the existing seq without inserting (so a retried/replayed push
     * never double-applies). Caller signs the header first and passes header_sig.
     * @returns {{seq:number, deduped:boolean}}
     */
    async append(spaceId, entry) {
      if (!spaceId || !entry || !entry.op_id || !entry.author_did || !entry.kind || !entry.header_sig) {
        throw new Error('space_oplog.append: spaceId + {op_id, author_did, kind, header_sig} required');
      }
      // Idempotency fast-path: already applied?
      const existing = await d1Query(`SELECT seq FROM space_oplog WHERE space_id = ? AND op_id = ? LIMIT 1`, [spaceId, entry.op_id]);
      if (existing.results?.[0]) return { seq: existing.results[0].seq, deduped: true };
      // ATOMIC seq assignment (review F1): compute MAX(seq)+1 INSIDE the INSERT — a single
      // statement — so two concurrent appends can't read the same head and collide on seq.
      // SQLite serializes writers, so each INSERT…SELECT computes a distinct next seq; no
      // read-then-insert race across the async adapter's awaits.
      const cols = [spaceId, spaceId, entry.op_id, entry.author_did, entry.kind, entry.action ?? null,
        entry.item_ref ?? null, entry.gen ?? null, entry.item_lamport ?? null, entry.payload ?? null, entry.header_sig];
      try {
        await d1Query(
          `INSERT INTO space_oplog (space_id, seq, op_id, author_did, kind, action, item_ref, gen, item_lamport, payload, header_sig)
           SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM space_oplog WHERE space_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?`,
          cols,
        );
      } catch (e) {
        // A CONCURRENT duplicate op_id (a retry/replay racing the original) loses the
        // UNIQUE(space_id,op_id) race → return the winner's seq as deduped, preserving the
        // idempotency contract under concurrency. Re-read keyed on op_id, so a genuine
        // (different-op_id) PK collision finds nothing and rethrows — fail closed.
        if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
          const ex = await d1Query(`SELECT seq FROM space_oplog WHERE space_id = ? AND op_id = ? LIMIT 1`, [spaceId, entry.op_id]);
          if (ex.results?.[0]) return { seq: ex.results[0].seq, deduped: true };
        }
        throw e;
      }
      const after = await d1Query(`SELECT seq FROM space_oplog WHERE space_id = ? AND op_id = ? LIMIT 1`, [spaceId, entry.op_id]);
      return { seq: after.results?.[0]?.seq, deduped: false };
    },

    /** The current total-order head (highest seq), or -1 when empty. */
    head: headSeq,

    /** List entries after `sinceSeq` in order (for the grantee pull / replica hydrate). */
    async listSince(spaceId, sinceSeq = -1, limit = 256) {
      const r = await d1Query(
        `SELECT * FROM space_oplog WHERE space_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [spaceId, sinceSeq, limit],
      );
      return r.results || [];
    },

    /** The highest item_lamport seen for an item (for LWW write ordering). -1 if none. */
    async itemLamport(spaceId, itemRef) {
      const r = await d1Query(
        `SELECT COALESCE(MAX(item_lamport), -1) AS l FROM space_oplog WHERE space_id = ? AND item_ref = ?`,
        [spaceId, itemRef],
      );
      return r.results?.[0]?.l ?? -1;
    },

    /** Store (or replace) a sealed CEK for a (space, gen, recipient). Idempotent. */
    async putCekGrant(spaceId, gen, recipientDid, blob, seq = null) {
      await d1Query(
        `INSERT INTO space_cek_grants (space_id, gen, recipient_did, blob, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(space_id, gen, recipient_did) DO UPDATE SET blob = excluded.blob, seq = excluded.seq`,
        [spaceId, gen, recipientDid, JSON.stringify(blob), seq],
      );
    },

    /** The sealed CEK grants for a recipient, generations > sinceGen, ascending. */
    async getCekGrants(spaceId, recipientDid, sinceGen = -1) {
      const r = await d1Query(
        `SELECT gen, blob, seq FROM space_cek_grants WHERE space_id = ? AND recipient_did = ? AND gen > ? ORDER BY gen ASC`,
        [spaceId, recipientDid, sinceGen],
      );
      return (r.results || []).map((g) => ({ gen: g.gen, blob: JSON.parse(g.blob), seq: g.seq }));
    },

    /** Ensure an owner-authority row exists for a space (idempotent). */
    async ensureOrigin(spaceId, { isHome = 1, currentGen = 0, originDid = null } = {}) {
      await d1Query(
        `INSERT INTO space_origin (space_id, is_home, current_gen, origin_did) VALUES (?, ?, ?, ?)
         ON CONFLICT(space_id) DO NOTHING`,
        [spaceId, isHome ? 1 : 0, currentGen, originDid],
      );
    },

    async getOrigin(spaceId) {
      const r = await d1Query(`SELECT * FROM space_origin WHERE space_id = ? LIMIT 1`, [spaceId]);
      return r.results?.[0] || null;
    },

    /** Advance the current generation (BU-REKEY calls this on a membership change). */
    async setCurrentGen(spaceId, gen) {
      await d1Query(`UPDATE space_origin SET current_gen = ? WHERE space_id = ?`, [gen, spaceId]);
    },
  };
}
