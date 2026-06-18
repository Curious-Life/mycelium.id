// src/federation/lexicon.js — wire-contract validators for the inbound Matrix
// records Phase B mirrors into the vault. Validated on ingest BEFORE persist
// (mirroring how handlers.js gates $type before receiveRemote), so a malformed
// or hostile record from a peer never reaches the DB.
//
// These are schemas/validators — NOT a running atproto PDS. Strict by design:
// unknown $type, missing required field, or unexpected key → reject. And a
// recursive §7 tripwire refuses ANY embedding/vector/centroid field — a peer
// must never be able to push (or a regression mirror) a semantic fingerprint
// into our store.

const VECTOR_KEY_RE = /(embedding|vector|centroid|matryoshka|\bvec\b)/i;

/** Recursively detect a vector/embedding-shaped key (CLAUDE.md §7). */
export function hasVectorKey(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (VECTOR_KEY_RE.test(k)) return true;
    if (v && typeof v === 'object' && hasVectorKey(v, depth + 1)) return true;
  }
  return false;
}

// Each record: a $type + required/optional fields. `str` fields must be strings.
const SCHEMAS = {
  'social.mycelium.space.v1':     { required: { name: 'str' }, optional: { space_id: 'str', essence: 'str', handle: 'str' } },
  'social.mycelium.room.v1':      { required: { space_ref: 'str', name: 'str' }, optional: { room_id: 'str', parent_id: 'str', essence: 'str' } },
  'social.mycelium.knowledge.v1': { required: { space_ref: 'str', content: 'str' }, optional: { source_type: 'str', source_ref: 'str', knowledge_id: 'str', domain_tags: 'arr' } },
};

const typeOk = (v, t) => t === 'str' ? typeof v === 'string' : t === 'arr' ? Array.isArray(v) : true;

// Bounds on peer-supplied fields (DoS / storage-exhaustion defense). A malicious
// peer in a shared Megolm room could otherwise push arbitrarily large records into
// space_knowledge — each one decrypted and rendered in the portal. `content` is the
// one legitimately-large field (a shared note); everything else is an identifier or
// short label. The HTTP federation path caps the whole canonical envelope at 8 KB
// (handlers.js MAX_CANONICAL_BYTES), but Matrix timeline events bypass that gate, so
// the bound has to live here, at the ingest validator. Byte length (not char count)
// so a multibyte payload can't slip the cap. Fail closed.
const MAX_CONTENT_BYTES = 64 * 1024;  // knowledge body
const MAX_FIELD_BYTES = 8 * 1024;     // name, essence, refs, ids, source_*
const MAX_ARR_ITEMS = 64;             // domain_tags element count
const MAX_ARR_ITEM_BYTES = 256;       // a single tag

/** Bounds-check a present field. Returns an error string, or null when within bounds. */
function boundError(f, v) {
  if (typeof v === 'string') {
    const max = f === 'content' ? MAX_CONTENT_BYTES : MAX_FIELD_BYTES;
    if (Buffer.byteLength(v, 'utf8') > max) return `field ${f} exceeds ${max} bytes`;
    return null;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARR_ITEMS) return `field ${f} exceeds ${MAX_ARR_ITEMS} items`;
    for (const item of v) {
      if (typeof item !== 'string') return `field ${f} items must be strings`;
      if (Buffer.byteLength(item, 'utf8') > MAX_ARR_ITEM_BYTES) return `field ${f} item too long`;
    }
    return null;
  }
  return null;
}

/**
 * Validate an inbound lexicon record. Returns { ok:true } or { ok:false, error }.
 * Never throws. @param {object} record
 */
export function validateLexicon(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, error: 'record must be an object' };
  const schema = SCHEMAS[record.$type];
  if (!schema) return { ok: false, error: `unknown $type: ${String(record.$type)}` };
  const allowed = new Set(['$type', ...Object.keys(schema.required), ...Object.keys(schema.optional)]);
  for (const k of Object.keys(record)) {
    if (!allowed.has(k)) return { ok: false, error: `unexpected field: ${k}` };
  }
  for (const [f, t] of Object.entries(schema.required)) {
    if (record[f] == null || (t === 'str' && record[f] === '')) return { ok: false, error: `missing required field: ${f}` };
    if (!typeOk(record[f], t)) return { ok: false, error: `field ${f} must be ${t}` };
    const be = boundError(f, record[f]); if (be) return { ok: false, error: be };
  }
  for (const [f, t] of Object.entries(schema.optional)) {
    if (record[f] == null) continue;
    if (!typeOk(record[f], t)) return { ok: false, error: `field ${f} must be ${t}` };
    const be = boundError(f, record[f]); if (be) return { ok: false, error: be };
  }
  if (hasVectorKey(record)) return { ok: false, error: 'vector/embedding field refused (CLAUDE.md §7)' };
  return { ok: true };
}

export const LEXICON_TYPES = Object.freeze(Object.keys(SCHEMAS));
