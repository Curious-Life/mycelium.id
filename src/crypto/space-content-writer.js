// src/crypto/space-content-writer.js — the owner-side WRITE path for E2E shared spaces
// (BU-OPLOG-E2E O3-WRITE). Turns a plaintext space item into a signed CIPHERTEXT oplog
// entry under the space's CURRENT generation, so a grantee can pull + decrypt it. This
// is what populates space_oplog (unused until now); the serve path (O3-SERVE) ships
// those ciphertext entries + each grantee's sealed CEK, and the grantee decrypts locally.
//
// Composes SpaceKeyManager (current CEK) + SpaceKeyRing (encrypt) + SpaceCrypto
// (author-sign + append). It writes ONLY ciphertext to the replicated log — the owner's
// own plaintext copy lives in the local space_knowledge store, unchanged.

import crypto from 'node:crypto';

export function createSpaceContentWriter({ keyManager, spaceCrypto, oplog, selfDid }) {
  if (!keyManager || typeof keyManager.ring !== 'function') throw new TypeError('createSpaceContentWriter: keyManager required');
  if (!spaceCrypto || typeof spaceCrypto.appendEntry !== 'function') throw new TypeError('createSpaceContentWriter: spaceCrypto required');
  if (!oplog || typeof oplog.itemLamport !== 'function') throw new TypeError('createSpaceContentWriter: oplog required');
  if (!selfDid) throw new TypeError('createSpaceContentWriter: selfDid required');

  return {
    /** Encrypt + append a content item under the CURRENT generation (eager-on-next-write:
     *  a write after a rekey re-encrypts under the new gen automatically, since the ring's
     *  current() is the new CEK). item_lamport gives per-item LWW ordering for concurrent
     *  edits. op_id defaults to a fresh nonce so distinct edits are distinct entries; pass
     *  a stable opId to make a retried write idempotent. Returns { seq, gen, op_id }. */
    async putItem(spaceId, itemId, plaintext, { opId = null } = {}) {
      if (!spaceId || !itemId) throw new Error('putItem: spaceId + itemId required');
      if (typeof plaintext !== 'string') throw new Error('putItem: plaintext must be a string');
      await keyManager.ensureSpaceKey(spaceId);
      const ring = await keyManager.ring(spaceId);
      const env = ring.encryptItem(itemId, plaintext, { op_type: 'put', author_did: selfDid });
      const lamport = (await oplog.itemLamport(spaceId, itemId)) + 1;
      const op_id = opId || `put:${itemId}:${crypto.randomUUID()}`;
      const r = await spaceCrypto.appendEntry(spaceId, {
        op_id, author_did: selfDid, kind: 'content', action: 'put',
        item_ref: itemId, gen: env.gen, item_lamport: lamport, payload: JSON.stringify(env),
      });
      return { ...r, gen: env.gen, op_id };
    },

    /** Append a signed DELETE tombstone (no ciphertext) under the current generation. A
     *  later item_lamport than any prior put for the item → LWW resolves to deleted. */
    async deleteItem(spaceId, itemId, { opId = null } = {}) {
      if (!spaceId || !itemId) throw new Error('deleteItem: spaceId + itemId required');
      await keyManager.ensureSpaceKey(spaceId);
      const { gen } = await keyManager.currentCek(spaceId);
      const lamport = (await oplog.itemLamport(spaceId, itemId)) + 1;
      const op_id = opId || `del:${itemId}:${crypto.randomUUID()}`;
      const r = await spaceCrypto.appendEntry(spaceId, {
        op_id, author_did: selfDid, kind: 'content', action: 'delete',
        item_ref: itemId, gen, item_lamport: lamport, payload: null,
      });
      return { ...r, gen, op_id };
    },
  };
}
