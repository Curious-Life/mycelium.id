// src/crypto/space-content.js — E2E shared-spaces content encryption (the SpaceCrypto
// content layer of the "Space Key Lockbox", docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md).
//
// A space item (document body / knowledge note / oplog payload) is encrypted under the
// per-space Content Encryption Key (CEK_g), so ONLY members holding CEK_g can read it —
// the owner box / relay / Cloudflare Tunnel see only ciphertext. This is keyed by the
// SPACE CEK, NOT USER_MASTER, so it lives OUTSIDE crypto-local.js's scope-keyed path.
//
// Two non-negotiable properties (from the adversarial crypto review, E5/E6):
//   • PER-ITEM KEY: key = HKDF(CEK_g, "mycelium-space-item:"+item_id). A leaked
//     per-item key exposes one item, not the whole space.
//   • HEADER BOUND AS AAD: {space_id, gen, item_id, op_type, author_did} is plaintext
//     (the relay needs it for ordering/dedup) but bound as GCM AAD, so the untrusted
//     owner/relay cannot silently RELABEL a ciphertext's generation/item — any header
//     tamper breaks the tag → hard decrypt failure (fail closed).

import crypto from 'node:crypto';

const IV_BYTES = 12; // 96-bit GCM nonce (standard)

/** Canonical, stable serialization of the bound header (fixed key order). MUST be
 *  byte-identical at encrypt and decrypt or the AAD won't match. */
function canonicalHeader(h) {
  return JSON.stringify({
    space_id: String(h.space_id),
    gen: Number(h.gen),
    item_id: String(h.item_id),
    op_type: h.op_type ?? null,
    author_did: h.author_did ?? null,
  });
}

/** Reject an envelope whose stored header fields are not already in CANONICAL form.
 *  The AAD binds the COERCED value (Number(gen), String(space_id)…), so without this
 *  a relay could rewrite the STORED `gen` from the number 3 to the string "3.0"/"03"
 *  and the tag would still verify (both sides re-coerce to 3) — leaving a value whose
 *  type/representation differs from what was authenticated (review F1). Requiring the
 *  stored form to already be canonical closes that: a representation rewrite changes
 *  the type and is rejected here, before the key/AAD are even computed. */
function assertCanonical(e) {
  if (typeof e.gen !== 'number' || !Number.isInteger(e.gen)) throw new Error('space envelope: gen must be a canonical integer');
  if (typeof e.space_id !== 'string' || typeof e.item_id !== 'string') throw new Error('space envelope: space_id/item_id must be strings');
  if (e.op_type !== null && typeof e.op_type !== 'string') throw new Error('space envelope: op_type must be a string or null');
  if (e.author_did !== null && typeof e.author_did !== 'string') throw new Error('space envelope: author_did must be a string or null');
}

/** Per-item key from the space CEK (domain-separated by item_id). */
function itemKey(cek, itemId) {
  return Buffer.from(crypto.hkdfSync('sha256', cek, Buffer.alloc(0), Buffer.from('mycelium-space-item:' + String(itemId)), 32));
}

function assertCek(cek) {
  if (!Buffer.isBuffer(cek) || cek.length !== 32) throw new Error('space CEK must be a 32-byte Buffer');
}

/**
 * Encrypt a space item body under CEK_g, binding the header as GCM AAD.
 * @param {Buffer} cek  the 32-byte space Content Encryption Key (generation `header.gen`)
 * @param {{space_id,gen,item_id,op_type?,author_did?}} header  plaintext header (bound as AAD)
 * @param {string} plaintext  the item body
 * @returns {object} a v4 'space' envelope (header fields plaintext, body ciphertext)
 */
export function encryptSpaceItem(cek, header, plaintext) {
  assertCek(cek);
  if (header == null || header.item_id == null || header.space_id == null || header.gen == null) {
    throw new Error('space item header requires space_id, gen, item_id');
  }
  // Fail closed on a non-string body (review F3: String(null) would silently persist
  // the literal "null") and a non-integer generation (keeps the envelope canonical).
  if (typeof plaintext !== 'string') throw new Error('space item body must be a string');
  if (!Number.isInteger(header.gen)) throw new Error('space item gen must be an integer');
  const key = itemKey(cek, header.item_id);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonicalHeader(header), 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 4, kf: 'space',
    space_id: String(header.space_id), gen: Number(header.gen), item_id: String(header.item_id),
    op_type: header.op_type ?? null, author_did: header.author_did ?? null,
    iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'),
  };
}

/**
 * Decrypt a v4 'space' envelope. The header is taken FROM THE ENVELOPE and bound as
 * AAD, so any relabel of space_id/gen/item_id/op_type/author_did breaks the GCM tag →
 * throws. The owner/relay cannot make a gen-g ciphertext decrypt as gen-(g+1), or swap
 * which item a body belongs to. Fails closed on a wrong CEK, tamper, or bad envelope.
 */
export function decryptSpaceItem(cek, envelope) {
  assertCek(cek);
  if (envelope == null || envelope.v !== 4 || envelope.kf !== 'space') throw new Error('not a v4 space envelope');
  assertCanonical(envelope); // F1: reject a representation-relabel the AAD would otherwise miss
  const key = itemKey(cek, envelope.item_id);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv), 'base64'));
  decipher.setAAD(Buffer.from(canonicalHeader(envelope), 'utf8'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
  // .final() throws if the tag/AAD don't verify — the fail-closed integrity check.
  const pt = Buffer.concat([decipher.update(Buffer.from(String(envelope.ct), 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

export const _internal = { canonicalHeader, itemKey, IV_BYTES };
