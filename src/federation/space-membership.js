// src/federation/space-membership.js — BU-REKEY: the bridge between the portal's
// share/revoke actions and the SpaceKeyManager's E2E key lifecycle. When the owner shares
// a space with a connected peer, the peer's CEK must be sealed to THEIR X25519 key; when
// the owner revokes, the space must rekey so the evicted peer can't read new content.
//
// Confidentiality-first, fail-closed UX-soft: if a peer's keyAgreement key can't be
// resolved (offline / no #key-enc published), we DON'T leak — we simply don't seal a CEK
// to them (grant) or we rekey to the resolvable survivors (revoke). The peer then sees
// ciphertext it can't open until a later re-grant reseals. Plaintext never escapes.
//
// resolveKey(did) -> Promise<base64url X25519 key | null> is injected (the did:web
// #key-enc resolver), so this is unit-testable with a stub.

import { backfillSpace } from './space-content-mirror.js';

/** Seal the space's current CEK to a newly-granted member. Best-effort: returns a status
 *  object rather than throwing, so a share never fails just because a peer is unreachable
 *  (the access grant + announce still stand; the seal retries on a future grant). */
export async function applyShareGrant({ db, spaceId, memberDid, resolveKey, log = () => {} }) {
  if (!db?.spaceKeyManager) return { sealed: false, reason: 'e2e-off' };
  if (!memberDid) return { sealed: false, reason: 'no-did' };
  let key = null;
  try { key = await resolveKey(memberDid); } catch (e) { log(`[spaces] keyAgreement resolve failed for ${memberDid}: ${e?.message || e}`); }
  if (!key) { log(`[spaces] no keyAgreement key for ${memberDid} — member added but NOT sealed (will reseal on next grant)`); return { sealed: false, reason: 'key-unresolved' }; }
  await db.spaceKeyManager.ensureSpaceKey(spaceId);
  await db.spaceKeyManager.addMember(spaceId, { did: memberDid, keyAgreementPublicKeyB64: key });
  // Backfill existing local knowledge into the oplog (idempotent) so the new member sees
  // content written BEFORE the space was keyed (or before remote was configured), under the
  // current gen we just sealed to them. Best-effort — never blocks the grant.
  try { await backfillSpace(db, spaceId, { log }); } catch (e) { log(`[spaces] backfill on grant failed for ${spaceId}: ${e?.message || e}`); }
  return { sealed: true };
}

/** Rekey the space after a revoke: mint a fresh CEK sealed ONLY to self + the resolvable
 *  survivors (allowlist). The evicted peer is, by construction, not in the survivor set →
 *  forward secrecy, with no dependence on resolving the evicted peer's key. A survivor we
 *  can't resolve is skipped (they re-sync on their next grant) — never a leak. */
export async function applyShareRevoke({ db, spaceId, removedDid, survivorDids = [], resolveKey, log = () => {} }) {
  if (!db?.spaceKeyManager) return { rekeyed: false, reason: 'e2e-off' };
  const origin = await db.spaceOplog?.getOrigin?.(spaceId);
  if (!origin) return { rekeyed: false, reason: 'not-keyed' }; // never shared/keyed → nothing to rekey
  // did:web is case/slash-aliasable — normalize the exclusion compare (review F1).
  const norm = (d) => String(d || '').trim().toLowerCase().replace(/\/+$/, '');
  const rmNorm = norm(removedDid);
  // Resolve the evicted peer's X25519 key for the AUTHORITATIVE exclusion (best-effort;
  // when offline, the normalized-DID exclusion still applies).
  let removedKey = null;
  try { removedKey = await resolveKey(removedDid); } catch { /* offline → DID exclusion only */ }
  const survivors = [];
  for (const did of survivorDids) {
    if (!did || norm(did) === rmNorm) continue; // never seal the evicted peer (normalized)
    try {
      const k = await resolveKey(did);
      if (k && removedKey && k === removedKey) { log(`[spaces] survivor ${did} shares the evicted peer's key — excluded`); continue; }
      if (k) survivors.push({ did, keyAgreementPublicKeyB64: k });
      else log(`[spaces] survivor ${did} has no keyAgreement key — skipped (re-syncs on next grant)`);
    } catch (e) { log(`[spaces] survivor ${did} resolve failed: ${e?.message || e}`); }
  }
  // The rekey is the cryptographic forward-secrecy enforcement — if it FAILS, surface it
  // (don't swallow): the authz 403 still blocks the evicted peer's pull, but the crypto
  // guarantee is the floor, and a silent failure leaves new writes under the OLD gen the
  // evicted peer holds (review F2). Caller logs + can re-drive.
  try {
    await db.spaceKeyManager.rekeyTo(spaceId, survivors, { removedDid, removedKey });
    return { rekeyed: true, survivors: survivors.length };
  } catch (e) {
    log(`[spaces] REKEY FAILED for ${spaceId}: ${e?.message || e} — forward secrecy NOT cryptographically enforced until re-rekey (authz 403 still blocks the evicted peer)`);
    return { rekeyed: false, reason: 'rekey-failed' };
  }
}
