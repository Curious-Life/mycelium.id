/**
 * Result-shape contract for the /internal/v1/search/mindscape endpoint.
 *
 * Single source of truth: the router populates these shapes, the HTTP
 * client returns them, the formatter (mindscape.js) consumes them. All
 * three sides import from here so a field rename fails at JSDoc check
 * before it can drift across processes.
 *
 * Field-name discipline: snake_case throughout, matching the underlying
 * D1 column names. No translation layer — callers learned the shapes
 * from db-d1/{messages,search}.js, and reusing those names keeps the
 * mental model intact when migrating from in-process callers.
 *
 * Versioning: when this shape changes incompatibly, ship `/v2` of the
 * endpoint and a parallel `result-types-v2.js`. Never break v1 in place.
 *
 * Per CLAUDE.md §1: similarity scores are returned but content fields
 * are intentionally hydrated and decrypted server-side. The HTTP hop
 * is loopback-only on the same VPS where the master key already lives —
 * the boundary is RAM-deduplication (avoid double-loading the index
 * into the MCP subprocess), not a new isolation layer.
 */

/**
 * @typedef {'messages'|'documents'|'territories'|'realms'|'themes'} Corpus
 *   Allowlisted corpus names. Adding a new corpus requires both a
 *   server-side scan-matcher registration AND adding the literal here.
 */

/**
 * @typedef {object} MessageHit
 * @property {string} id
 * @property {string} content              decrypted content
 * @property {string} role                 'user' | 'assistant' | etc.
 * @property {string} source               channel/source label
 * @property {string} agent_id             originating agent id
 * @property {string} created_at           ISO timestamp
 * @property {string|null} entity_summary  short summary line (decrypted)
 * @property {number} similarity           cosine score [0,1], descending sort
 */

/**
 * @typedef {object} DocumentHit
 * @property {string} id
 * @property {string} path
 * @property {string} title
 * @property {string|null} summary
 * @property {string} content              decrypted full content
 * @property {number} similarity
 */

/**
 * @typedef {object} TopologyNeighbor
 *   Co-firing neighbor returned when expandTopology=true. Populated only
 *   for entries in `results.territories`. weight ∈ [0,1] is the
 *   normalized co-fire strength.
 * @property {string} territory_id
 * @property {string} name
 * @property {number} weight
 */

/**
 * @typedef {object} TerritoryHit
 * @property {string} id
 * @property {string} territory_id
 * @property {string} name
 * @property {string|null} essence
 * @property {number} message_count
 * @property {Array<string>|null} top_entities   parsed JSON array
 * @property {number} similarity
 * @property {Array<TopologyNeighbor>} [topology]  present iff expandTopology
 */

/**
 * @typedef {object} RealmHit
 * @property {string} id
 * @property {string} realm_id
 * @property {string} name
 * @property {string|null} essence
 * @property {number} territory_count
 * @property {number} message_count
 * @property {number} similarity
 */

/**
 * @typedef {object} ThemeHit
 * @property {string} id
 * @property {string} semantic_theme_id
 * @property {string} name
 * @property {string|null} essence
 * @property {number} territory_count
 * @property {number} message_count
 * @property {number} similarity
 */

/**
 * @typedef {object} SearchMindscapeRequest
 * @property {string} query                          ≤2000 chars; never logged
 * @property {Array<Corpus>} [corpora]               default: all five
 * @property {number} [topK]                         default 5, max 50
 * @property {string|null} [agent]                   filter messages by source-agent
 * @property {'all'|'documents'|'messages'} [documentScope]  default 'all'
 * @property {boolean} [expandTopology]              default false; adds .topology to TerritoryHit entries
 * @property {string|null} [tenantId]                reserved for cross-tenant fan-out (bonds Phase 1+); null in v1
 */

/**
 * @typedef {object} SearchMindscapeResults
 * @property {Array<MessageHit>}    [messages]
 * @property {Array<DocumentHit>}   [documents]
 * @property {Array<TerritoryHit>}  [territories]
 * @property {Array<RealmHit>}      [realms]
 * @property {Array<ThemeHit>}      [themes]
 */

/**
 * @typedef {object} SearchMindscapeResponse
 * @property {true} ok
 * @property {number} elapsedMs
 * @property {'ok'|'degraded'} embedStatus
 * @property {Array<Corpus>} degraded                 corpora that errored mid-fanout; partial results returned for the rest
 * @property {SearchMindscapeResults} results
 */

/**
 * @typedef {object} SearchMindscapeError
 * @property {false} ok
 * @property {'auth'|'bad_request'|'warming'|'embed_unavailable'|'internal'} reason
 * @property {string} [detail]                        for bad_request only; never echoes user input verbatim
 * @property {Array<string>} [components]             for warming; which subsystems aren't ready
 * @property {string} [request_id]                    for internal; cross-references log line
 */

/**
 * @typedef {object} ReadyResponse
 * @property {boolean} ok
 * @property {{ mindSearch: boolean, scanMatchers: boolean, embedder: boolean }} components
 */

/** Allowlist enforced by the router — duplicate of the union literal above for runtime use. */
export const VALID_CORPORA = Object.freeze(['messages', 'documents', 'territories', 'realms', 'themes']);

/** Hard caps. Keep these in sync with the JSDoc above. */
export const LIMITS = Object.freeze({
  QUERY_MAX_CHARS: 2000,
  TOPK_MAX: 50,
  TOPK_DEFAULT: 5,
  BODY_BYTES_MAX: 4096,
});
