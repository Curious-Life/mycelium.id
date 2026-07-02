// src/crypto/space-cek.js — E2E shared-spaces Content Encryption Key management (the
// integration layer of the "Space Key Lockbox", docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md).
//
// Ties the two primitives together:
//   • space-content.js — encrypt/decrypt a space item under a per-space CEK.
//   • space-seal.js     — seal a CEK to a member's X25519 keyAgreement key.
//
// A space has a CURRENT generation `g` with a random CEK_g, distributed to each member
// as a sealed key-grant. On every membership change the owner mints a fresh CEK_{g+1}
// (BU-REKEY). Members keep a HISTORY of the CEKs they were granted, so they can still
// read content authored under older generations they were a member for, while a removed
// member never receives the new generation's CEK → cannot read post-removal content.
//
// Key discipline (review-locked):
//   E7 — CEK generations are INDEPENDENT CSPRNG keys, NEVER derived/chained from each
//        other (a removed member holding CEK_g must not be able to compute CEK_{g+1}).
//   recipient_did is a CONTEXT LABEL — read authorization comes from the KEY/membership,
//        and the caller seals with recipient_did matching the member's key owner.

import crypto from 'node:crypto';
import { sealToX25519, openSealed } from './space-seal.js';
import { encryptSpaceItem, decryptSpaceItem } from './space-content.js';

/** Mint a fresh, independent 32-byte CEK for a new generation (E7: CSPRNG, never
 *  derived from a prior generation). */
export function generateCek() {
  return crypto.randomBytes(32);
}

/**
 * Seal a CEK to a member for a {space, generation} → a key-grant record.
 * @param {Buffer} cek  the 32-byte CEK for `gen`
 * @param {number} gen
 * @param {string} spaceId
 * @param {{did:string, keyAgreementPublicKeyB64:string}} member  recipient (resolved X25519 key)
 * @returns {{recipient_did, gen, blob}} a key-grant (blob from sealToX25519)
 */
export function sealCekToMember(cek, gen, spaceId, member) {
  if (!member || !member.did || !member.keyAgreementPublicKeyB64) {
    throw new Error('sealCekToMember: member requires did + keyAgreementPublicKeyB64');
  }
  return {
    recipient_did: member.did,
    gen,
    blob: sealToX25519(cek, member.keyAgreementPublicKeyB64, { space_id: spaceId, gen, recipient_did: member.did }),
  };
}

/**
 * Open a key-grant that a peer sealed TO ME → the CEK. The context must match what the
 * sealer used (space, gen, my did); a wrong context / not-the-recipient fails closed.
 * @param {{gen:number, blob:object}} grant
 * @param {object} identity  my createIdentity() (provides keyAgreementSharedSecret)
 * @param {string} spaceId
 * @param {string} myDid  my own did (the recipient_did the sealer bound)
 * @returns {Buffer} the 32-byte CEK
 */
export function openCekGrant(grant, identity, spaceId, myDid) {
  if (!grant || grant.gen == null || !grant.blob) throw new Error('openCekGrant: malformed grant');
  return openSealed(grant.blob, identity, { space_id: spaceId, gen: grant.gen, recipient_did: myDid });
}

/**
 * A per-space key ring: the CEKs (by generation) a box holds for one space, plus the
 * current generation. Reads use the CEK of the ITEM's generation (so a member keeps
 * reading old-gen content); writes use the CURRENT generation.
 */
export class SpaceKeyRing {
  constructor(spaceId) {
    if (!spaceId) throw new Error('SpaceKeyRing requires a spaceId');
    this.spaceId = String(spaceId);
    this.byGen = new Map(); // gen -> CEK (Buffer)
    this.currentGen = -1;
  }

  /** Add a CEK for a generation (from generateCek on the owner, or openCekGrant on a
   *  member). Advancing currentGen is how a member adopts a new generation. */
  setCek(gen, cek) {
    if (!Number.isInteger(gen) || gen < 0) throw new Error('gen must be a non-negative integer');
    if (!Buffer.isBuffer(cek) || cek.length !== 32) throw new Error('cek must be a 32-byte Buffer');
    this.byGen.set(gen, cek);
    if (gen > this.currentGen) this.currentGen = gen;
    return this;
  }

  hasGen(gen) { return this.byGen.has(gen); }

  cek(gen) {
    const c = this.byGen.get(gen);
    if (!c) throw new Error(`SpaceKeyRing: no CEK for generation ${gen} (not a member at that generation?)`);
    return c;
  }

  current() {
    if (this.currentGen < 0) throw new Error('SpaceKeyRing: no CEK yet');
    return { gen: this.currentGen, cek: this.cek(this.currentGen) };
  }

  /** Encrypt a new item body under the CURRENT generation → a v4 space envelope. */
  encryptItem(itemId, plaintext, { op_type = null, author_did = null } = {}) {
    const { gen, cek } = this.current();
    return encryptSpaceItem(cek, { space_id: this.spaceId, gen, item_id: itemId, op_type, author_did }, plaintext);
  }

  /** Decrypt an item envelope using the CEK for the item's OWN generation. Fails closed
   *  if this box never held that generation's CEK (e.g. a removed member + a post-removal
   *  generation) or if the envelope is for another space. */
  decryptItem(envelope) {
    if (!envelope || envelope.space_id !== this.spaceId) throw new Error('SpaceKeyRing: envelope is for a different space');
    // L2 (review): require an integer gen BEFORE the slot lookup — never Number()-coerce
    // a null/[] gen to slot 0 (space-content's assertCanonical also catches it; this is
    // the belt-and-suspenders second layer).
    if (!Number.isInteger(envelope.gen)) throw new Error('SpaceKeyRing: envelope gen must be an integer');
    return decryptSpaceItem(this.cek(envelope.gen), envelope);
  }
}
