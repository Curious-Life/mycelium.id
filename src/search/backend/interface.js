/**
 * MindBackend — the storage/retrieval contract.
 *
 * Every implementation (`local.js`, `vectorize.js`) provides exactly these
 * methods with these signatures. The agent-tools surface and `db-d1/search.js`
 * see only this interface — they don't know which backend is wired.
 *
 * Shape borrowed from MemPalace's `BaseCollection` (mempalace/backends/base.py)
 * — the *interface*, not the code. Verbatim text storage, score-tagged
 * results, opaque filters.
 *
 * ─── Result shape ───────────────────────────────────────────────────────
 *
 * Every `query()` resolves to:
 *   {
 *     hits:     Array<{ id, score, ts }>,    // can be empty in tier 4
 *     degraded: boolean,                      // true iff tier > 0
 *     tier:     0 | 1 | 2 | 3 | 4,
 *     reason?:  string,                       // present iff degraded
 *     takenMs:  number,
 *   }
 *
 * Empty hits with `degraded: false` is permitted ONLY when the corpus
 * is genuinely empty for the given filter. Every other empty must carry
 * a tier > 0 and a reason. (Per MIND-SEARCH-IMPLEMENTATION.md §4.2.)
 *
 * ─── Logging ────────────────────────────────────────────────────────────
 *
 * Implementations MUST NOT log:
 *   • query text         (use redactText() if you must reference length)
 *   • result content     (only ids/scores/timestamps)
 *   • vector values      (only counts and dimensions)
 *   • decrypted tokens   (only token-count summaries)
 *
 * Per CLAUDE.md §1.
 *
 * @typedef {object} MindBackendDeps
 * @property {object} db                          @mycelium/core db backend (for vector/D1 access)
 * @property {object} embedder                    embed-service client (POST /embed)
 * @property {CryptoKey} masterKey                loaded master key (tmpfs source)
 * @property {string[]} scopes                    allowed scopes for this caller (e.g. ['personal'])
 * @property {string} userId                      tenant id; every query MUST be filtered by this
 * @property {object} [logger]                    logger.child({ mod: 'mind-search', ... })
 * @property {string} [persistPath]               optional path for encrypted index snapshot
 *
 * @typedef {object} MindAddRequest
 * @property {string} id                          stable message id (UUID)
 * @property {string} [text]                      plaintext to tokenize for BM25
 * @property {Float32Array|number[]} [embedding]  precomputed vector; if absent, embedder is called
 * @property {number} ts                          unix-seconds timestamp (used for temporal boost)
 * @property {object} [metadata]                  arbitrary tags (no content)
 *
 * @typedef {object} MindQueryRequest
 * @property {string} [text]                      query string — embedded internally if no `embedding`
 * @property {Float32Array|number[]} [embedding]  precomputed query vector (skips embed call)
 * @property {number} [topK=20]                   max hits to return after rerank/fusion
 * @property {'recent'|'mixed'|'reflective'} [recency='mixed']  temporal-boost τ selector
 * @property {'normal'|'high'} [precision='normal']             'high' enables Haiku rerank (Tier 0)
 * @property {object} [filter]                    plaintext-safe filter clause (agent_id, type, …)
 *
 * @typedef {object} MindQueryHit
 * @property {string} id
 * @property {number} score
 * @property {number} ts
 *
 * @typedef {object} MindQueryResult
 * @property {MindQueryHit[]} hits
 * @property {boolean} degraded
 * @property {0|1|2|3|4} tier
 * @property {string} [reason]
 * @property {number} takenMs
 *
 * @typedef {object} MindHealthReport
 * @property {'ok'|'degraded'|'down'} status
 * @property {boolean} embedServiceUp
 * @property {boolean} indexLoaded
 * @property {number} indexSize           token count, not byte count
 * @property {number|null} lastQueryAt    unix-seconds of most recent query
 *
 * @typedef {object} MindBackend
 * @property {(req: MindAddRequest) => Promise<void>}                 add
 * @property {(req: MindAddRequest) => Promise<void>}                 upsert
 * @property {(req: MindQueryRequest) => Promise<MindQueryResult>}    query
 * @property {(filter: object) => Promise<Array<{id:string, ts:number, metadata?:object}>>}  get
 * @property {(filter: object) => Promise<{deleted: number}>}         delete
 * @property {(filter?: object) => Promise<number>}                   count
 * @property {() => Promise<MindHealthReport>}                        health
 */

// Pure-types module. No runtime exports.
// (JSDoc typedefs are consumed by editors, by `tsc --noEmit --allowJs --checkJs`,
//  and by readers — there is no value in adding a runtime artifact.)
export const __interface_marker = Symbol.for('@mycelium/core/mind-search/backend/interface');
