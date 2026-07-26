// src/core/item-ref.js — the single wire shape for a curate-able item reference.
//
// WHY THIS EXISTS (D-040 ↻1): `forget` / `mark` / `link` all address an item by
// {type, id}, but NOT ONE agent-facing read surface rendered that id. `formatMessage`
// SELECTed it and threw it away (src/search/index.js), facts printed `category/key`,
// entities printed `type: name`, getDailyMessages printed nothing. So the agent had no
// valid handle to pass, guessed, and got a success-shaped miss back. See
// the forget-reachability design.
//
// The contract, in one place so a renderer and the resolver can never drift:
//
//   renderRef('message', '3f9a1c2b8d4e5f…')      → '[msg:3f9a1c2b8d4e]'
//   renderRef('fact',    'f47ac10b-58cc-…')    → '[fact:f47ac10b-58c]'
//   renderRef('entity',  …)                    → '[ent:…]'
//   renderRef('document','people/anna.md')     → '[doc:people/anna.md]'
//
// Messages/facts/entities render a SHORT PREFIX (token budget: a 32-hex id or a uuid is
// ~16-20 tokens, the 10-char form ~9 — and getContext renders up to 60 rows on EVERY
// turn). Documents render the FULL path, because the path IS the id `forget` takes and it
// is human-meaningful — and because a path PREFIX would match a whole folder.
//
// SECURITY:
//   • The short form is expanded by SQL prefix match, so the prefix is validated against a
//     strict hex/dash charset FIRST — a `%` or `_` can never enter the LIKE pattern
//     (no wildcard-widening, no LIKE injection). Anything else → not-found, never a scan.
//   • >1 match is AMBIGUOUS and fails closed. A destructive verb never picks one of two.
//   • Resolution spans forgotten husks too, so an already-forgotten item reports
//     "already forgotten" instead of the indistinguishable "no such item".
//   • Every query is scoped `user_id = ?`.

/** type → the short tag rendered to the agent. */
export const REF_TAGS = Object.freeze({
  message: 'msg',
  document: 'doc',
  fact: 'fact',
  entity: 'ent',
});

const TAG_TO_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(REF_TAGS).map(([type, tag]) => [tag, type])),
);

// How many leading characters of an opaque id the short form carries.
//
// 12 was chosen against the COLLISION math, not by feel. A message id is 32 hex chars, so a
// 12-char prefix is 16^12 ≈ 2.8e14; the birthday estimate n²/2N puts the chance of ANY
// colliding pair at ~2e-3 even in a million-message vault (at 10 chars it was ~2e-2 at
// 200k — small, but not small enough for a surface whose only recovery was a full id that
// NO read surface renders). A uuid prefix is `xxxxxxxx-xxx` = 11 hex ≈ 1.8e13, likewise
// negligible at fact/entity counts. Collisions still fail closed (never a coin flip), and
// the ambiguity message now carries the full candidate ids so the path is not a dead end.
export const SHORT_REF_LEN = 12;

// Ids in this vault are hex (messages: lower(hex(randomblob(16)))) or uuid v4
// (facts/entities: randomUUID()). Both are covered by [0-9a-f-]. Anything outside this
// charset is not an id we ever minted → it can never reach the LIKE pattern.
//
// The MINIMUM is SHORT_REF_LEN, not something shorter, and that is a security bound rather
// than tidiness: prefix resolution answers found / ambiguous / not-found, which is an
// ENUMERATION ORACLE. At a 6-char minimum an agent could sweep 16^6 ≈ 1.7e7 prefixes and
// discover rows it was never allowed to READ (scope-filtered `wealth`/`health` rows never
// appear in selectRecent/search) and then forget them — an injection could drive exactly
// that loop. At 12 the sweep is 2.8e14 and the oracle is dead. Nothing legitimate is lost:
// no surface ever renders a shorter prefix, and a full id still matches exactly (that check
// runs first), including short non-hex ids like 'm-123'.
const SAFE_ID = new RegExp(`^[0-9a-f-]{${SHORT_REF_LEN},64}$`);

// A rendered token, e.g. `[msg:3f9a1c2b8d4e]` or `[doc:people/anna.md]`. The value group is
// GREEDY and the pattern is anchored, so it runs to the LAST `]` — a document path may
// legitimately contain one (`validatePath`, src/core/document-store.js, permits it) and
// `[doc:notes/todo [draft].md]` must round-trip rather than truncate at the first bracket.
const REF_TOKEN = /^\[(msg|doc|fact|ent):(.+)\]$/i;

/** The table + id column each forgettable type resolves against. */
const TABLES = Object.freeze({
  message: 'messages',
  fact: 'facts',
  entity: 'entities',
});

// SCOPE, for the one table that has it. src/db/messages.js:29 + :1176-1183 bind an agent's
// reads to AGENT_SCOPES "so we never fetch a row the scope-guardian will then deny" — but
// prefix RESOLUTION is a read too, and without this it would resolve (and hand back as an
// ambiguity candidate) a `wealth`/`health` row the same agent is forbidden to see. Same
// predicate, same source of truth (independent security review, 2026-07-26).
function scopeClause() {
  const raw = process.env.AGENT_SCOPES;
  if (!raw) return { sql: '', params: [] };
  let allowed;
  try { allowed = JSON.parse(raw); } catch { return { sql: '', params: [] }; }
  if (!Array.isArray(allowed) || !allowed.length) return { sql: '', params: [] };
  return { sql: ` AND scope IN (${allowed.map(() => '?').join(', ')})`, params: allowed };
}

/**
 * The compact reference the agent sees next to an item — and can hand straight back to
 * forget/mark/link. Returns '' for a missing id so a renderer never prints `[msg:]`.
 * @param {'message'|'document'|'fact'|'entity'} type
 * @param {string} id  full id (or, for a document, its path)
 */
export function renderRef(type, id) {
  const tag = REF_TAGS[type];
  const raw = id == null ? '' : String(id);
  if (!tag || !raw) return '';
  // SHORTEN ONLY WHAT THE RESOLVER CAN EXPAND. Message ids are NOT always hex — the Obsidian
  // importer mints `obsidian:<vault>/<path>` (src/ingest/obsidian-import.js) and importMessages
  // takes a caller-supplied id (src/tools/ingest.js). Truncating one of those produced a ref
  // that resolveItemRef's prefix path (gated on SAFE_ID) can never expand and that no exact
  // match can find — i.e. D-040 reproduced verbatim, on the very ref shipped to fix it: the
  // agent pastes back exactly what was rendered, is told to re-read and paste the ref, and
  // loops forever over data that survives. Found by independent review, 2026-07-26.
  // Anything not prefix-resolvable is therefore rendered IN FULL. Documents likewise — the
  // path IS the id, it is meaningful, and a path prefix would sweep a folder.
  const shown = (type === 'document' || !SAFE_ID.test(raw)) ? raw : raw.slice(0, SHORT_REF_LEN);
  return `[${tag}:${shown}]`;
}

/**
 * Accept whatever the model pasted back: a bare id, a short prefix, or the whole rendered
 * `[tag:…]` token. Returns the type the token declared (null when it was a bare id) plus
 * the id text.
 * @param {string} raw
 * @returns {{type: string|null, id: string}}
 */
export function parseRef(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  const m = REF_TOKEN.exec(s);
  if (!m) return { type: null, id: s };
  return { type: TAG_TO_TYPE[m[1].toLowerCase()] || null, id: m[2].trim() };
}

/**
 * Resolve an agent-supplied reference to the real row id, fail-closed.
 *
 * @param {object} db      the keyed vault (needs rawQuery)
 * @param {string} userId
 * @param {'message'|'document'|'fact'|'entity'} type
 * @param {string} raw     full id · short prefix · rendered `[tag:…]` token
 * @returns {Promise<{ok:true,id:string} | {ok:false,reason:'missing'|'type-mismatch'|'not-found'|'ambiguous',matches?:number}>}
 */
export async function resolveItemRef(db, userId, type, raw) {
  const { type: declared, id } = parseRef(raw);
  if (!id) return { ok: false, reason: 'missing' };
  // A `[fact:…]` token passed as type:'message' is the model contradicting itself —
  // refuse rather than guess which half it meant.
  if (declared && declared !== type) return { ok: false, reason: 'type-mismatch' };

  // A document is addressed BY PATH: exact match only. A prefix here could sweep a folder.
  if (type === 'document') return { ok: true, id };

  const table = TABLES[type];
  if (!table) return { ok: false, reason: 'not-found' };
  // Only `messages` carries a scope column; facts/entities are unscoped.
  const scope = type === 'message' ? scopeClause() : { sql: '', params: [] };

  // Exact hit first — the model may well have pasted the full id.
  const exact = await db.rawQuery(
    `SELECT id FROM ${table} WHERE id = ? AND user_id = ?${scope.sql} LIMIT 2`,
    [id, userId, ...scope.params],
  );
  if (exact?.results?.length === 1) return { ok: true, id: exact.results[0].id };

  // Short form → prefix expansion, but ONLY for an id-shaped string (see SAFE_ID).
  if (!SAFE_ID.test(id)) return { ok: false, reason: 'not-found' };
  const pre = await db.rawQuery(
    // Husks included on purpose: an already-forgotten item must report itself as such.
    `SELECT id FROM ${table} WHERE user_id = ? AND id LIKE ? || '%'${scope.sql} LIMIT 5`,
    [userId, id, ...scope.params],
  );
  const rows = pre?.results || [];
  if (rows.length === 0) return { ok: false, reason: 'not-found' };
  // NEVER A DEAD END: the caller's only way out of an ambiguity is a full id, and no read
  // surface renders one — so hand back the candidates. Ids carry no content (opaque random
  // hex/uuid), and they are this user's own rows, so this leaks nothing (§1).
  if (rows.length > 1) return { ok: false, reason: 'ambiguous', matches: rows.length, candidates: rows.map((r) => r.id) };
  return { ok: true, id: rows[0].id };
}

/** Is this string safe to record in an audit row as an attempted id? */
export const isSafeIdShape = (s) => SAFE_ID.test((s == null ? '' : String(s)).trim());

export default renderRef;
