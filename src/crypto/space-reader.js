// src/crypto/space-reader.js — the GRANTEE decrypt path for E2E shared spaces
// (BU-OPLOG-E2E O3-SERVE-B). Turns the owner's served {entries (ciphertext), grants
// (sealed CEKs)} into plaintext items the grantee can render — LOCALLY, after unsealing
// its own CEK. The owner/relay/tunnel never had the plaintext; this is where it
// reappears, only on a box that holds a grant.
//
// Fail-closed at every step, because `entries` arrive over the wire from a peer (whose
// box, or the relay, could be hostile):
//   1. AUTHORSHIP — verifyEntry against the OWNER's Ed25519 key (the response was already
//      transport-signed by the owner; this additionally pins each entry's author so a
//      relay can't splice a forged op).
//   2. SHAPE/BOUNDS/§7 — validateInboundEntry (object/BigInt/oversized/vector rejected).
//   3. ANTI-RELABEL — the outer entry.gen MUST equal the inner envelope.gen, else a relay
//      relabel that points the grantee at the wrong CEK generation is refused.
//   4. DECRYPT — under the item's own generation; a gen this box never held (e.g. a
//      removed member + a post-removal gen) simply can't be opened → the item is skipped,
//      never substituted.
// LWW conflict resolution is by `seq` (the owner's authoritative total order), NOT
// item_lamport (which can tie on concurrent edits — see O3-WRITE review).

export function decodeSharedSpace({ ref, name = null, entries = [], grants = [], ownerSigningKeyB64, keyManager, spaceCrypto }) {
  if (!ref) throw new Error('decodeSharedSpace: ref required');
  if (!keyManager || typeof keyManager.ringFromGrants !== 'function') throw new Error('decodeSharedSpace: keyManager required');
  if (!spaceCrypto || typeof spaceCrypto.verifyEntry !== 'function') throw new Error('decodeSharedSpace: spaceCrypto required');
  if (typeof ownerSigningKeyB64 !== 'string') throw new Error('decodeSharedSpace: ownerSigningKeyB64 required');

  const ring = keyManager.ringFromGrants(ref, grants); // unseal every gen this box holds
  const byItem = new Map(); // item_ref -> { seq, deleted?, content? }

  for (const e of entries) {
    // (1) authorship — a forged/spliced entry that the owner did not sign is dropped.
    if (!spaceCrypto.verifyEntry(e, ownerSigningKeyB64)) continue;
    // (2) shape/bounds/§7 — never throws on hostile input (fail-closed contract).
    if (!spaceCrypto.validateInboundEntry(e).ok) continue;
    if (e.kind !== 'content') continue; // membership/key-grant entries aren't rendered content
    // (LWW) keep the highest-seq op per item; a lower-seq op never overwrites a higher one.
    const prev = byItem.get(e.item_ref);
    if (prev && prev.seq >= e.seq) continue;
    if (e.action === 'delete') { byItem.set(e.item_ref, { seq: e.seq, deleted: true }); continue; }
    let env;
    try { env = JSON.parse(e.payload); } catch { continue; }
    // (3) anti-relabel: the signed outer gen must match the AAD-bound inner gen.
    if (env == null || env.gen !== e.gen) continue;
    // (4) decrypt under the item's own gen; a gen we don't hold → skip (fail-closed).
    let plain;
    try { plain = ring.decryptItem(env).toString('utf8'); } catch { continue; }
    byItem.set(e.item_ref, { seq: e.seq, content: plain });
  }

  const knowledge = [...byItem.entries()]
    .filter(([, v]) => !v.deleted)
    .map(([item_id, v]) => ({ item_id, content: v.content }));
  return { kind: 'space', name, knowledge };
}
