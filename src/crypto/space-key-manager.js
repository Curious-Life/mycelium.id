// src/crypto/space-key-manager.js — the per-space CEK lifecycle (E2E shared spaces,
// BU-OPLOG-E2E O3-KM). The linchpin between the crypto primitives and the wiring: it
// owns minting CEK_0, sealing it to members, unsealing the box's own CEK to read/write,
// and the forward-secret rotate-on-removal — all backed by the oplog grant store
// (space_cek_grants) + origin row (space_origin.current_gen) from migration 0044.
//
// Built once at boot over {identity, db, selfDid, spaceCrypto}. The owner box is a
// MEMBER of its own spaces (owner-as-member, locked decision): it seals every CEK to its
// OWN X25519 keyAgreement key so reads/writes go through the same unseal path as a peer.
//
// This is a CRYPTO seam, not an authz floor — it never decides WHO may join/leave (that
// is resolveSharedGrant + the portal at the serve/grant layer). It only manages keys.

import { generateCek, sealCekToMember, openCekGrant, SpaceKeyRing } from './space-cek.js';

// Normalize a did:web for EXCLUSION comparison only — did:web is case- and
// trailing-slash-aliasable, so a strict `!==` is bypassable. Belt-and-suspenders behind
// the authoritative KEY check in removeMember (decryption authority is the X25519 key).
const normDid = (d) => String(d || '').trim().toLowerCase().replace(/\/+$/, '');

export function createSpaceKeyManager({ identity, db, selfDid, spaceCrypto }) {
  if (!identity || !identity.keyAgreementPublicKeyB64 || typeof identity.sign !== 'function') {
    throw new TypeError('createSpaceKeyManager: identity with keyAgreement + sign required');
  }
  if (!db || !db.spaceOplog) throw new TypeError('createSpaceKeyManager: db.spaceOplog required');
  if (!selfDid) throw new TypeError('createSpaceKeyManager: selfDid required');
  if (!spaceCrypto || typeof spaceCrypto.appendEntry !== 'function') throw new TypeError('createSpaceKeyManager: spaceCrypto required');
  const oplog = db.spaceOplog;

  // This box, as a member: CEKs are sealed to its own keyAgreement key.
  const selfMember = () => ({ did: selfDid, keyAgreementPublicKeyB64: identity.keyAgreementPublicKeyB64 });

  const api = {
    /** Ensure a NEW home space has a CEK_0 sealed to self. Idempotent: a no-op once a
     *  self-grant at the current generation exists. Returns { gen }. */
    async ensureSpaceKey(spaceId) {
      await oplog.ensureOrigin(spaceId, { isHome: 1, originDid: selfDid });
      const origin = await oplog.getOrigin(spaceId);
      const gen = origin.current_gen;
      const mine = await oplog.getCekGrants(spaceId, selfDid);
      // "Already keyed" must mean "I hold an OPENABLE current-gen CEK", not merely that a
      // row exists. A foreign/poisoned grant at the current gen we cannot unseal must NOT
      // suppress minting — else ring().current() throws and the owner can't write. The
      // mint's putCekGrant ON CONFLICT overwrites the unopenable row, self-healing.
      const haveCurrent = mine.some((g) => {
        if (g.gen !== gen) return false;
        try { openCekGrant(g, identity, spaceId, selfDid); return true; } catch { return false; }
      });
      if (haveCurrent) return { gen };
      const cek = generateCek();
      const sealed = sealCekToMember(cek, gen, spaceId, selfMember());
      await oplog.putCekGrant(spaceId, gen, selfDid, sealed.blob);
      return { gen };
    },

    /** Build a SpaceKeyRing from EVERY generation this box can unseal (all self-grants).
     *  Reads decrypt under the item's own gen (a member keeps reading old-gen content);
     *  writes use the current gen. A grant we cannot open is skipped (fail-closed: the
     *  gen simply isn't in the ring, so reading it throws rather than leaking). */
    async ring(spaceId) {
      const ring = new SpaceKeyRing(spaceId);
      const grants = await oplog.getCekGrants(spaceId, selfDid);
      for (const g of grants) {
        try { ring.setCek(g.gen, openCekGrant(g, identity, spaceId, selfDid)); } catch { /* not openable by us → skip */ }
      }
      return ring;
    },

    /** Build a ring from a PROVIDED set of sealed grants (e.g. fetched from a peer over
     *  the wire) instead of the local oplog — the grantee decrypt path. Unseal every gen
     *  this box can open; skip the rest (fail-closed: an unopenable gen is absent, so
     *  reading it throws rather than leaking). Synchronous (no oplog). */
    ringFromGrants(spaceId, grants = []) {
      const ring = new SpaceKeyRing(spaceId);
      for (const g of grants) {
        try { ring.setCek(g.gen, openCekGrant(g, identity, spaceId, selfDid)); } catch { /* not ours / unopenable → skip */ }
      }
      return ring;
    },

    /** The CEK to ENCRYPT new content under (current generation). Throws if this box
     *  holds no CEK for the space (never a member / not yet keyed). */
    async currentCek(spaceId) {
      return (await api.ring(spaceId)).current(); // { gen, cek }
    },

    /** Add a member (grant): seal the CURRENT CEK to them + append a signed member-add
     *  and key-grant to the oplog (auditable membership log). The op_ids are
     *  deterministic so a replayed grant dedups. Returns { gen }. */
    async addMember(spaceId, member) {
      if (!member || !member.did || !member.keyAgreementPublicKeyB64) throw new Error('addMember: member {did, keyAgreementPublicKeyB64} required');
      const { gen, cek } = await api.currentCek(spaceId);
      const sealed = sealCekToMember(cek, gen, spaceId, member);
      await oplog.putCekGrant(spaceId, gen, member.did, sealed.blob);
      await spaceCrypto.appendEntry(spaceId, { op_id: `member-add:${member.did}:${gen}`, author_did: selfDid, kind: 'member-add', action: 'add', item_ref: member.did, gen });
      await spaceCrypto.appendEntry(spaceId, { op_id: `key-grant:${member.did}:${gen}`, author_did: selfDid, kind: 'key-grant', action: 'grant', item_ref: member.did, gen });
      return { gen };
    },

    /** Remove a member (forward-secret rekey, eager-on-next-write): mint a FRESH
     *  CEK_{g+1} (independent CSPRNG — E7), seal it to self + the surviving members ONLY,
     *  advance current_gen, and append signed member-remove + key-grant entries. The
     *  removed member never receives the gen+1 seal, so even with the full relay/oplog
     *  ciphertext they cannot decrypt content written under gen ≥ g+1. Existing gen-g
     *  entries stay readable until rewritten (they re-encrypt under gen+1 on next write).
     *  Returns { gen } (the new generation). */
    async removeMember(spaceId, removed, survivors = []) {
      // `removed` is the member to evict: { did, keyAgreementPublicKeyB64 }. Decryption
      // authority is the X25519 KEY (space-seal.js), NOT the DID — so removal MUST exclude
      // by key. A DID-string check alone is bypassable by a did:web variant (case /
      // trailing slash / a duplicate membership row) that carries the removed member's key
      // (review F1 — a real E9 forward-secrecy bypass). Require the key; fail closed.
      const removedDid = typeof removed === 'string' ? removed : removed?.did;
      const removedKey = typeof removed === 'object' ? removed?.keyAgreementPublicKeyB64 : null;
      if (!removedDid || !removedKey) throw new Error('removeMember: removed { did, keyAgreementPublicKeyB64 } required (the key is the authoritative exclusion guard)');
      const origin = await oplog.getOrigin(spaceId);
      if (!origin) throw new Error('removeMember: space has no origin (not keyed)');
      const newGen = origin.current_gen + 1;
      const cek = generateCek(); // fresh + independent of CEK_g (E7) — never chained
      const rmDid = normDid(removedDid);
      // EXCLUDE any survivor whose KEY equals the removed member's (authoritative) OR whose
      // normalized DID matches (belt). selfMember() is always retained — the owner is
      // home-of-record, so self-removal is a no-op for the owner's own access, by design.
      const recipients = [selfMember(), ...survivors.filter((s) =>
        s && s.did && s.keyAgreementPublicKeyB64 &&
        s.keyAgreementPublicKeyB64 !== removedKey &&
        normDid(s.did) !== rmDid,
      )];
      for (const m of recipients) {
        const sealed = sealCekToMember(cek, newGen, spaceId, m);
        await oplog.putCekGrant(spaceId, newGen, m.did, sealed.blob);
      }
      await oplog.setCurrentGen(spaceId, newGen);
      await spaceCrypto.appendEntry(spaceId, { op_id: `member-remove:${removedDid}:${newGen}`, author_did: selfDid, kind: 'member-remove', action: 'remove', item_ref: removedDid, gen: newGen });
      for (const m of recipients) {
        await spaceCrypto.appendEntry(spaceId, { op_id: `key-grant:${m.did}:${newGen}`, author_did: selfDid, kind: 'key-grant', action: 'grant', item_ref: m.did, gen: newGen });
      }
      return { gen: newGen };
    },

    /** ALLOWLIST rekey — mint a FRESH CEK_{g+1} and seal it to self + EXACTLY the given
     *  survivor set (nobody else). Anyone not in the allowlist (a removed member) receives
     *  no new grant → forward secrecy by construction, with NO dependence on resolving the
     *  removed member's key (so a revoke still rekeys when the evicted peer is offline /
     *  hasn't published #key-enc). This is the primitive the portal revoke path uses: it
     *  builds the survivor set from the remaining members, so an allowlist is both simpler
     *  and safer than the denylist removeMember. `removedDid` is recorded in the signed
     *  member-remove entry for the audit log. Returns { gen }. */
    async rekeyTo(spaceId, survivors = [], { removedDid = null, removedKey = null } = {}) {
      const origin = await oplog.getOrigin(spaceId);
      if (!origin) throw new Error('rekeyTo: space has no origin (not keyed)');
      const newGen = origin.current_gen + 1;
      const cek = generateCek(); // fresh + independent of CEK_g (E7)
      const rmDid = removedDid ? normDid(removedDid) : null;
      // Defense in depth (parity with removeMember's F1 fix): even though the caller builds
      // the survivor allowlist, exclude anyone whose normalized DID OR X25519 key matches
      // the evicted peer — a did:web variant (case / trailing slash) carrying the removed
      // identity must NEVER be re-sealed, or forward secrecy (E9) is bypassed.
      const recipients = [selfMember(), ...survivors.filter((s) =>
        s && s.did && s.keyAgreementPublicKeyB64 &&
        (!rmDid || normDid(s.did) !== rmDid) &&
        (!removedKey || s.keyAgreementPublicKeyB64 !== removedKey),
      )];
      for (const m of recipients) {
        const sealed = sealCekToMember(cek, newGen, spaceId, m);
        await oplog.putCekGrant(spaceId, newGen, m.did, sealed.blob);
      }
      await oplog.setCurrentGen(spaceId, newGen);
      if (removedDid) await spaceCrypto.appendEntry(spaceId, { op_id: `member-remove:${removedDid}:${newGen}`, author_did: selfDid, kind: 'member-remove', action: 'remove', item_ref: removedDid, gen: newGen });
      for (const m of recipients) {
        await spaceCrypto.appendEntry(spaceId, { op_id: `key-grant:${m.did}:${newGen}`, author_did: selfDid, kind: 'key-grant', action: 'grant', item_ref: m.did, gen: newGen });
      }
      return { gen: newGen };
    },
  };
  return api;
}
