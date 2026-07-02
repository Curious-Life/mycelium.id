// src/federation/space-content-mirror.js — O3-HOOK: mirror the owner's LOCAL plaintext
// space-knowledge writes into the E2E ciphertext oplog, so real owner edits actually flow
// to grantees (who decrypt locally). The local space_knowledge store stays the owner's own
// fast plaintext copy; this keeps the replicated oplog a ciphertext mirror of it.
//
// The op_id is VERSION-keyed — `kn:<entryId>:v<version>` (the space_knowledge.version
// column). This gives both:
//   • idempotency — a retried mirror / a backfill of the SAME row+version dedups;
//   • edit-safety — an in-place edit bumps version → a NEW oplog entry (higher seq → LWW
//     shows the edit). A bare `kn:<entryId>` would hit the oplog idempotency fast-path and
//     silently drop the edit (review F3).
// We deliberately do NOT hash the content into the op_id: the op_id is PLAINTEXT oplog
// metadata the relay/tunnel sees, and a content hash would let it detect content-equality
// or confirm a low-entropy guess — exactly the leak E2E exists to prevent. The version is
// benign metadata (the oplog already reveals entry count + ordering).
// A revoke writes a deterministic `del:<entryId>` tombstone. All best-effort + fail-closed:
// a mirror failure NEVER leaks (worst case the grantee doesn't yet see the change) and is
// logged loudly, not swallowed.

const BACKFILL_LIMIT = 100000; // lift space-knowledge.list's default 100-row cap (review F2)
const knOpId = (entryId, version = 1) => `kn:${entryId}:v${version}`;
const delOpId = (entryId) => `del:${entryId}`;

/** Mirror one knowledge write into the oplog (ciphertext). No-op when E2E is off
 *  (db.spaceContent absent → remote not configured). */
export async function mirrorKnowledgeWrite(db, spaceId, entryId, content, { version = 1, log = () => {} } = {}) {
  if (!db?.spaceContent || !spaceId || !entryId || typeof content !== 'string') return { mirrored: false };
  try {
    await db.spaceContent.putItem(spaceId, entryId, content, { opId: knOpId(entryId, version) });
    return { mirrored: true };
  } catch (e) {
    log(`[spaces] oplog mirror FAILED for ${spaceId}/${entryId}: ${e?.message || e} — grantees won't see this edit until re-mirrored`);
    return { mirrored: false, error: true };
  }
}

/** Mirror a knowledge revoke as a signed delete tombstone (higher lamport → LWW deletes). */
export async function mirrorKnowledgeDelete(db, spaceId, entryId, { log = () => {} } = {}) {
  if (!db?.spaceContent || !spaceId || !entryId) return { mirrored: false };
  try {
    await db.spaceContent.deleteItem(spaceId, entryId, { opId: delOpId(entryId) });
    return { mirrored: true };
  } catch (e) {
    log(`[spaces] oplog tombstone FAILED for ${spaceId}/${entryId}: ${e?.message || e}`);
    return { mirrored: false, error: true };
  }
}

/** Backfill a space's local knowledge into the oplog (ciphertext) — run when a space is
 *  first shared, so content written BEFORE the space was keyed (or before remote was
 *  configured) reaches the new member. RECONCILES BOTH directions (review F1): re-emits a
 *  PUT for every active row AND a delete tombstone for every revoked row, so a transient
 *  mirror failure on either a write OR a revoke self-heals on the next grant. Idempotent
 *  via the content-addressed / deterministic op_ids. Returns counts. */
export async function backfillSpace(db, spaceId, { log = () => {} } = {}) {
  if (!db?.spaceContent || !db.spaceKnowledge?.list || !spaceId) return { backfilled: 0, tombstoned: 0 };
  let put = 0, del = 0;
  let active = [], revoked = [];
  try { active = await db.spaceKnowledge.list(spaceId, { status: 'active', limit: BACKFILL_LIMIT }); }
  catch (e) { log(`[spaces] backfill list(active) failed for ${spaceId}: ${e?.message || e}`); }
  for (const r of active || []) {
    if (!r?.id || typeof r.content !== 'string') continue;
    try { await db.spaceContent.putItem(spaceId, r.id, r.content, { opId: knOpId(r.id, r.version ?? 1) }); put++; }
    catch (e) { log(`[spaces] backfill put failed for ${spaceId}/${r.id}: ${e?.message || e}`); }
  }
  // Re-emit tombstones for revoked rows so a lost delete-mirror heals (a deterministic
  // del op_id no-ops where a tombstone already exists; restores it where it was lost).
  try { revoked = await db.spaceKnowledge.list(spaceId, { status: 'revoked', limit: BACKFILL_LIMIT }); }
  catch (e) { log(`[spaces] backfill list(revoked) failed for ${spaceId}: ${e?.message || e}`); }
  for (const r of revoked || []) {
    if (!r?.id) continue;
    try { await db.spaceContent.deleteItem(spaceId, r.id, { opId: delOpId(r.id) }); del++; }
    catch (e) { log(`[spaces] backfill tombstone failed for ${spaceId}/${r.id}: ${e?.message || e}`); }
  }
  return { backfilled: put, tombstoned: del };
}
