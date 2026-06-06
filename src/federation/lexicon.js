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
  }
  for (const [f, t] of Object.entries(schema.optional)) {
    if (record[f] != null && !typeOk(record[f], t)) return { ok: false, error: `field ${f} must be ${t}` };
  }
  if (hasVectorKey(record)) return { ok: false, error: 'vector/embedding field refused (CLAUDE.md §7)' };
  return { ok: true };
}

export const LEXICON_TYPES = Object.freeze(Object.keys(SCHEMAS));
