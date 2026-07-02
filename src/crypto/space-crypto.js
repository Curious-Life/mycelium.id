// src/crypto/space-crypto.js — the SpaceCrypto boundary (E2E shared spaces, BU-OPLOG-E2E
// O2). The one auditable seam that combines the box identity (signing) + the oplog
// (ordering/storage) + the crypto modules into signed, ordered, CIPHERTEXT entries.
// Constructed once at boot; OpenMLS could replace the seam at Phase 5.
//
// Trust split (resolves the seq/sign chicken-and-egg):
//   • header_sig is the AUTHOR's Ed25519 signature over the AUTHOR-ATTRIBUTABLE header
//     {op_id, author_did, kind, action, item_ref, gen, item_lamport, payload}. It proves
//     WHO authored the (ciphertext) content — closing the relay-controlled-attribution
//     gap — and is computable before the owner assigns an ordering seq.
//   • seq is the OWNER's total order, assigned at append; its authenticity rides the
//     existing transport signature on the whole shared-content response (handlers.js).
// So an entry never needs its own seq inside the author signature.

import { canonicalize, verifyDetached } from '../federation/sign.js';
import { hasVectorKey } from '../federation/lexicon.js';

const KINDS = new Set(['content', 'member-add', 'member-remove', 'key-grant']);
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MB, matches handlers.js MAX_SHARED_CONTENT_BYTES

/** The author-attributable header (everything except the owner-assigned seq/ts and the
 *  signature itself). Canonicalized → signed. Stable key order via canonicalize(). */
function signedHeader(e) {
  return {
    op_id: e.op_id, author_did: e.author_did, kind: e.kind,
    action: e.action ?? null, item_ref: e.item_ref ?? null,
    gen: e.gen ?? null, item_lamport: e.item_lamport ?? null, payload: e.payload ?? null,
  };
}

export function createSpaceCrypto({ identity, db }) {
  if (!identity || typeof identity.sign !== 'function' || !identity.publicKeyB64) {
    throw new TypeError('createSpaceCrypto: identity with sign() + publicKeyB64 required');
  }
  if (!db || !db.spaceOplog) throw new TypeError('createSpaceCrypto: db.spaceOplog required');
  const oplog = db.spaceOplog;

  return {
    /** Author-sign an entry over its content header, then append it to the owner oplog
     *  (which assigns the total-order seq). Returns {seq, deduped}. */
    async appendEntry(spaceId, fields) {
      if (!fields || !fields.op_id || !fields.author_did || !KINDS.has(fields.kind)) {
        throw new Error('appendEntry: {op_id, author_did, kind∈KINDS} required');
      }
      const header_sig = identity.sign(canonicalize(signedHeader(fields)));
      return oplog.append(spaceId, { ...fields, header_sig });
    },

    /** Verify an entry's AUTHOR signature against the author's Ed25519 public key
     *  (base64url). Fails closed (false) on any tamper to the signed header or payload,
     *  a wrong key, or a missing signature. Never throws. */
    verifyEntry(entry, authorSigningPubB64) {
      if (!entry || !entry.header_sig || typeof authorSigningPubB64 !== 'string') return false;
      // Self-defend: a hostile object/BigInt payload makes canonicalize() overflow the
      // stack or throw. This is the AUTHENTICITY gate — its contract is "never throws,
      // fail closed (false)", so a caller doing `if (!verifyEntry(...)) reject` can't be
      // turned into an unhandled exception by a crafted inbound entry.
      try {
        return verifyDetached(authorSigningPubB64, canonicalize(signedHeader(entry)), entry.header_sig);
      } catch { return false; }
    },

    /** Validate an inbound entry's SHAPE + BOUNDS before applying it (grantee-side
     *  defense: the author signature proves authenticity, this bounds the blast radius
     *  of a malformed/oversized/hostile entry). Returns {ok} | {ok:false,error}. */
    validateInboundEntry(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: 'entry must be an object' };
      if (!KINDS.has(entry.kind)) return { ok: false, error: `unknown kind: ${String(entry.kind)}` };
      if (typeof entry.op_id !== 'string' || typeof entry.author_did !== 'string') return { ok: false, error: 'op_id + author_did must be strings' };
      // The payload is the ciphertext TEXT column on the wire — reject any non-string
      // BEFORE measuring it, so a hostile object/BigInt payload can't make us throw
      // (JSON.stringify on a ~200k-deep object overflows the stack; a BigInt throws).
      // This function is a fail-closed BLAST BOUND: it must return {ok:false}, never throw.
      if (entry.payload != null && typeof entry.payload !== 'string') return { ok: false, error: 'payload must be a string' };
      if (entry.gen != null && !Number.isInteger(entry.gen)) return { ok: false, error: 'gen must be an integer' };
      if (entry.kind === 'content' && entry.action !== 'put' && entry.action !== 'delete') return { ok: false, error: 'content action must be put|delete' };
      if (Buffer.byteLength(entry.payload ?? '', 'utf8') > MAX_PAYLOAD_BYTES) return { ok: false, error: 'payload exceeds 1MB' };
      // Best-effort defense in depth (CLAUDE.md §7): refuse a vector/embedding key in the
      // entry. hasVectorKey caps recursion at depth 8 (matching the merged lexicon
      // validator), so this is a tripwire, NOT a hard guarantee — acceptable because the
      // payload is opaque ciphertext, never an embedding sink.
      if (hasVectorKey(entry)) return { ok: false, error: 'vector/embedding field refused (§7)' };
      return { ok: true };
    },

    /** Store a sealed CEK grant for a (space, gen, recipient) — thin pass-through to the
     *  oplog store (BU-REKEY / grant wiring calls this after sealCekToMember). */
    putKeyGrant(spaceId, gen, recipientDid, blob, seq = null) {
      return oplog.putCekGrant(spaceId, gen, recipientDid, blob, seq);
    },

    /** The owner's Ed25519 signing key (base64url) — what a grantee verifies entries
     *  against when the owner is the author (owner-as-member, V1 default). */
    signingPublicKeyB64: identity.publicKeyB64,
  };
}
