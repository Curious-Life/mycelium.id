# Document-layer search — wiring `documents` into bulkSearch

**Status:** DESIGN LOCKED (sweep-first) — implemented Phase 1 on `feat/document-search-phase1`, 2026-06-17
**Context:** surfaced while cleaning up dead scan-matcher code (commits `511fc2e`, `e40f09a` on `spike/sqlite-vec-encrypted-gate`). Independent of that cleanup; branched off `main`.
**Author trail:** sweep-first-design protocol (3 Explore sweeps + first-party reads).

## TL;DR

`bulkSearch` (the live `searchMindscape` / `relatedTo` path) declares a `documents`
scope and a `documents: string[]` return field, but the field was **hardcoded empty**
([src/search/index.js:169](../src/search/index.js#L169)). The premise "the backend
already indexes documents" is **false in a running vault** — the boot loader's
`SOURCES` list ([src/search/d1-loader.js:49-57](../src/search/d1-loader.js#L49))
contained only `messages`, `territory_profiles`, `realms`, `semantic_themes`. The
`backend.add(task='document')` path only runs through `indexDocument()`, a test-only
helper with **zero `src/` callers**.

Phase 1 wires documents into the index **BM25-only**, because the enrichment pipeline
never writes `documents.embedding_768` and auto-embedding every document at cold start
would re-introduce the ~81s event-loop freeze PIPELINE-INTEGRITY fought. Semantic (ANN)
document ranking is deferred to Phase 2 (enrich-pipeline document embeddings).

## The two load-bearing surprises (caught by sweep, not in the premise)

1. **No incremental indexing exists for *anything*.** `captureMessage` does not touch
   the index; `indexDocument()` has zero `src/` callers; `rebuild()` is triggered in
   exactly one place — `refreshSearchIndex()` inside Generate
   ([src/jobs.js:201,365](../src/jobs.js#L201) → [:319](../src/jobs.js#L319)). The index
   reflects **boot state + last-Generate state**. New rows (messages *or* documents) are
   invisible to search until the next Generate or process restart. → Documents inherit
   this exact lifecycle; making them fresher would be inconsistent, so Phase 1 relies on
   `rebuild()` like everything else. (Incremental indexing = separate, cross-cutting work.)

2. **Documents are never embedded.** `documents.embedding_768` exists but the enrich
   service embeds **messages only** ([src/enrich/service.js](../src/enrich/service.js));
   the only writer of `documents.embedding_768` sets it `NULL` on forget
   ([src/db/documents.js:253](../src/db/documents.js#L253)). And `backend.add` auto-embeds
   when `embedding` is absent and an embedder is wired
   ([src/search/backend/local.js:108-110](../src/search/backend/local.js#L108)). → Adding
   documents to the loader as-is = one live `:8091` call **per document** at cold start.
   Phase 1 suppresses that with `skipEmbed` → BM25-only.

## ID-namespace decision

`documents.id` and `messages.id` are both bare UUID TEXT (`lower(hex(randomblob(16)))`).
Profiles use INTEGER pks and are kind-prefixed. **Decision: prefix document index ids
with `document:`** so the bare-id space stays message-only — `hydrateMessages` selects
candidates by `!id.includes(':')`, and a `document:` prefix keeps documents cleanly out
of that filter and makes partitioning self-describing. Mirrors the profile pattern.

## Module shape (as built)

1. **`src/search/backend/local.js`** — `add()` honors a `skipEmbed` flag: the auto-embed
   branch becomes `else if (!req.skipEmbed && embedder && …)`. skipEmbed docs are BM25-only.
2. **`src/search/d1-loader.js`** — `ID_PREFIX.document = 'document:'`; a `documents` entry
   in `SOURCES` (`is_internal = 0 AND forgotten_at IS NULL`, content/title non-empty,
   `skipEmbed: true`); `backend.add` call passes `skipEmbed: src.skipEmbed === true`.
3. **`src/search/index.js`** — `hydrateDocuments(ids, {excludeSensitive})` (unconditional
   `forgotten_at IS NULL` + `is_internal = 0`; `sensitive = 0` when excludeSensitive);
   `docMap` in the hydrate `Promise.all`; a `docMap` partition branch; `formatDocument`;
   documents added to the early-break condition.
4. **Tests** — `verify-search.mjs` seeds 2 documents (one `is_internal=1`) and asserts
   scope=all + scope=documents return the doc, internal excluded, and the BM25-only
   (no-vector-at-load) cold-start guarantee. `verify-related.mjs` (Phase 1.1) covers
   sensitive-doc exclusion on proactive recall.

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Document has no embedding | BM25-only via `skipEmbed`. No cold-start embed storm. |
| Internal-model docs (`is_internal=1`) | Excluded at load (SOURCE sql) AND hydrate (defense in depth). |
| Forgotten docs (`forgotten_at`) | Excluded at load + unconditional hydrate filter. |
| Sensitive docs + proactive recall | `excludeSensitive` adds `sensitive = 0` in hydrate; matches messages. |
| Empty title+summary+content | Filtered at load; zero-token docs never become BM25 hits anyway. |
| id collision message↔document | `document:` prefix → disjoint namespaces. |
| Doc created/edited/forgotten after boot | Visible/evicted only after next `rebuild()` (Generate) — same as messages. Hydrate filter still guarantees forgotten/internal never surface. |

## Threat model

- **Plaintext leakage (§1):** loader logs counts only; `formatDocument` bounds snippets
  to 240 chars; no bodies/ids logged.
- **Sensitive/internal exposure (§3 fail-closed):** internal + forgotten excluded at two
  layers; sensitive excluded on the proactive path. Tests assert each.
- **Embedding-inversion (§7):** Phase 1 stores **no** document vectors → zero new vector
  surface. Phase 2 (stored doc embeddings) must reuse the encrypted message envelope.

## Decision criteria → Phase 2 (semantic document embeddings)

Proceed when BM25-only doc recall demonstrably misses semantically-relevant docs (seed a
paraphrase doc with no shared keywords; if `scope:'documents'` misses it, that's the gap)
or a document-heavy real vault reports recall misses. Phase 2 = drain `documents` in the
enrich pipeline → `encryptVector` → `documents.embedding_768` → loader reuses stored
vectors (drop `skipEmbed`) → ANN parity with messages, zero cold-start cost.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cold-start embed storm if `skipEmbed` mis-wired | Med | High | Guard in `add()`; test asserts no doc vector cached at load |
| Sensitive/internal doc leaks via search | Low | High | Two-layer filter; explicit tests |
| Freshness over-promise (docs not live) | High (expectation) | Low | Documented; same as messages |
| id collision message↔document | Negligible | Low | `document:` prefix |

## Deferred (named so they don't ambush a later phase)

- **Incremental indexing** (messages + documents): cross-cutting; separate design.
- **Phase 2 document embeddings**: see decision criteria.
- **Forget-time eviction for documents**: optional; the unconditional hydrate filter is
  the correctness guarantee.

## Verification table

| Assumption | Verified at (read first-party) |
|---|---|
| `bulkSearch` returned `documents: []` hardcoded | [src/search/index.js:169](../src/search/index.js#L169) |
| Boot loader SOURCES had no `documents` | [src/search/d1-loader.js:49-57](../src/search/d1-loader.js#L49) |
| `indexDocument()` is the only doc-add path (test-only, 0 callers) | [src/search/index.js:56-64](../src/search/index.js#L56); grep |
| `backend.add` auto-embeds when no embedding + embedder wired | [src/search/backend/local.js:108-110](../src/search/backend/local.js#L108) |
| `add` is upsert; `delete({ids})` evicts index+vectors | [src/search/backend/local.js:123,125-133](../src/search/backend/local.js#L123) |
| `documents.id` is bare UUID TEXT (same as messages) | migrations/0001_init.sql (documents/messages CREATE) |
| `documents` has `is_internal`, `sensitive`, `forgotten_at`, `embedding_768` | migrations 0001/0004 |
| enrich embeds messages only; never writes doc embedding_768 | src/enrich/service.js; [src/db/documents.js:253](../src/db/documents.js#L253) |
| `rebuild()` fires only inside Generate | [src/jobs.js:201,365](../src/jobs.js#L201) → [:319](../src/jobs.js#L319) |
| mindscape renders `result.documents` as `## Documents`, plain strings | [src/tools/mindscape.js:147](../src/tools/mindscape.js#L147) |
| `'documents'` is a declared scope (was a no-op) | [src/tools/mindscape.js:76](../src/tools/mindscape.js#L76) |
| verify harness seeds via raw SQL post-migration | [scripts/verify-search.mjs](../scripts/verify-search.mjs) |
