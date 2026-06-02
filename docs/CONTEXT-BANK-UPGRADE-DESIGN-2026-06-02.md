# Context Bank Upgrade — Design Spec (v2 — decisions locked, iterating)

**Date:** 2026-06-02 · **Status:** DRAFT — 4 decisions LOCKED (§11), iterating before build · **Author:** sweep-first-design pass
**Scope:** V1 self-hosted MCP server (`src/tools`, `src/db`, `migrations/`). Single-user, encrypted SQLite vault.
**Companions:** [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md) (current 31-tool surface) · [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md).

This spec closes the gaps from the context-bank design review. It is grounded in a two-cycle sweep against live code (file:line throughout). **We iterate this spec, then build.** Nothing here is built yet.

---

## 0. The gaps we're closing (from the review)

| # | Gap | One-line fix |
|---|---|---|
| G1 | **No forget/correct anywhere on the tool surface** (message stream + internal model append-only) | A **soft-redact** primitive (tombstone; no hard-delete) that cascades correctly + is audited |
| G2 | **No high-precision facts/preferences surface** | A small encrypted `facts` store + tools + a `getContext` section |
| G3 | **Retrieval is query-only** (no "relevant to *now*") | `relatedContext(text)` — thin reuse of the existing embed+ANN+RRF backend |
| G4 | **Entities are convention-over-documents** | A first-class `entities` registry (promote NLP-extracted + curate) |
| G5 | **Cold-start: ~10 Tier-2 tools return empty, training the model to stop calling them** | A readiness probe + honest "not ready, do X" responses (or gating) |
| G6 | **5 overlapping ontologies, no common handle** | A unified `ref` addressing scheme (`{type,id}`) for pin/forget/link/relate |
| G7 | **Salience is computed, not user-assertable** (no pin on messages) | Extend the existing document pin to messages/facts/entities + a `sensitive` flag |

---

## 1. Revision history

- **v0 (design review, in-chat):** claimed "no delete anywhere; forget is greenfield"; "relatedContext needs a new pipeline"; "gate Tier-2 by hiding tools."
- **v1 (this doc, post-sweep) — three pivots:**
  1. **Forget is NOT greenfield at the storage layer.** ~20 hardcoded `DELETE FROM` exist; `documents.delete` fires `afterDeleteHooks` (`db/documents.js:206`); the search backend has `delete({ids})` (`search/backend/local.js:125`); and there's a soft-delete precedent — `identity_channels.revoked_at` (`0001_init.sql:879-926`). Forget *composes* these; the gap is a *unified, audited, cascading* forget + missing orphan cleanup + index eviction + a `forgotten` flag.
  2. **The forget cascade is shallow, not 10-table-deep.** Only `clustering_points` and the row's own `embedding_768` reference a message directly; the metric/fisher/topology tables are recomputed per `clustering_run_id` and self-heal. (`Sweep A`)
  3. **`relatedContext` is trivial reuse**, not new infra — `backend.query({text})` already accepts raw text or a vector (`search/backend/local.js:58-88`).
- **v2 (operator decisions locked, 2026-06-02):** forget = **soft-redact only** (no hard `purge`); facts = **typed `category/key/value`**; Tier-2 = **present-but-"not ready"**; scope = **build all four phases** sequentially. Consequences folded in: redact now nulls **all** sensitive columns (not just `content`) and **every read path filters `forgotten_at IS NULL`**; §3.2/§5/§6/§7/§11 updated.

---

## 2. Sweep findings (consolidated, file:line)

**Data model / forget cascade (Sweep A):**
- `messages` row: PK `id`, encrypted `content`, and `embedding_768 TEXT` (768D Nomic envelope) — `0001_init.sql:950`.
- `clustering_points` holds the 256D `nomic_embedding` + `territory_id`/`theme_id`/`realm_id`, linked to a message by `source_type='message' AND source_id=<id>`, **no FK** — `0001_init.sql:254`.
- Derived tables (`territory_cofire`, `cognitive_metrics_harmonic|window|per_territory`, `fisher_trajectory|milestones`, `territory_vitality`, `topology_metrics`, …) key off `clustering_run_id` + counts/distributions, **not message ids** — they go stale, not dangling, and regenerate next pipeline run. **No `ON DELETE CASCADE` anywhere.**

**Delete / encryption / audit precedent (Sweep B):**
- Hard deletes exist per-namespace (`documents.delete` + `afterDeleteHooks` — `db/documents.js:206-212`); no unified/account-level delete.
- `ENCRYPTED_FIELDS` (`crypto/crypto-local.js:209`) maps table→columns; `messages` encrypts `content/thinking/tags/entities/...`; `clustering_points:['content']`. New tables opt sensitive columns in here; add `scope`-bearing tables to `SCOPE_AWARE_TABLES`.
- Embeddings/centroids are **intentionally NOT encrypted** (accepted trade-off — `crypto-local.js:204-206`) — but they ARE inversion-sensitive, so forget must *remove* them.
- Audit: `audit_log` (plaintext, fire-and-forget, `db/audit.js:105`); `egress_audit` stores **`content_hash`+length, never plaintext** (`db/egress-audit.js:121`) — the model for a forget audit.
- Soft-delete precedent: `identity_channels.revoked_at` — "NEVER hard-deleted; rows persist for audit; filter `revoked_at IS NULL`" (`0001_init.sql:919-920`).

**Tool/namespace/getContext/gating/profiles (Sweep C):**
- Domain factory: `createXDomain(deps) → { tools:[{name,description,inputSchema}], handlers:{name: async(args)=>string} }` (`tools/tasks.js:18-96`); added to the `domains` array in `buildDomains` (`mcp.js:79-112`).
- `db` namespaces wired in `db/index.js:34-72` (documents, messages, health, tasks, metrics, topology, fisher, mindscape, …). **`db.profiles`/`db.users` exist but are NOT wired into the MCP `db`.** New namespace = create `db/<ns>.js` → import → wire.
- `getContext` composes `sections[]` with `if (want(include,'x') && db?.ns) { try{}catch{} }`, joined `\n\n`; `include` enum = `['mind','messages','phase','health']` (`tools/context.js:45`); messages truncated to 500 chars; **no overall output budget.**
- Tool registration is **static at boot**; readiness probe available: `db.mindscape.getNoiseStats(userId)` counts `clustering_points` (`db/mindscape.js:34`).
- `user_profiles` (`0001_init.sql:1565`) = display/fingerprint profile (handle, display_name, computed scores), **not a facts KV store**; REST-only (`portal-compat.js:161`).

**Search reuse + lifecycle (Sweep D + Cycle 2):**
- `backend.query({ text | embedding, topK })` runs ANN+BM25+RRF; takes raw text (embeds with `task:'query'`) or a precomputed `Float32Array` (`search/backend/local.js:58-88`). `searchHelpers` exposes `bulkSearch` + the backend (`search/index.js`).
- In-RAM index is built **once per process** (`ensureBuilt`, `built` flag, no TTL — `search/index.js:46-52`); a DB delete is **not** reflected until `backend.delete({ids})` (`search/backend/local.js:125-133`) or a `rebuild()`.
- Enrichment selects `nlp_processed=0 AND content!=''` (`db/messages.js:148`); sync selects `embedding_768 IS NOT NULL` (`pipeline/sync-clustering-points.js`) and **never removes orphans**. ⇒ a redact that blanks `content` + nulls `embedding_768` + sets `forgotten` is safe from both re-embedding and re-sync.
- `messages` namespace has **no delete method** (`db/messages.js`); `selectRecent` has no `forgotten` predicate (we add one).
- Salience: `documents` have `pin/unpin` (`portal-compat.js:71`); **messages have none.**

---

## 3. The design

### 3.1 A unified reference handle (G6)
Introduce one addressing scheme used by forget/pin/link/relate so the model holds **one** handle across the 5 ontologies (it reduces conceptual surface without merging stores):
```
ref := { type: 'message'|'document'|'fact'|'entity', id: string }
```
(`territory`/`realm`/`theme` are computed, read-only — not forgettable, so excluded from `ref`.)

### 3.2 Memory hygiene — forget / correct (G1) · DECISION: soft-redact only
A single **soft** primitive — **no hard-delete tool** (locked #1). `forget` destroys the *meaning* (the sensitive payload + both embedding fingerprints) and keeps an empty **tombstone husk** for audit + anti-resurrection.

- **`forget(ref)`** — for the target row, in one logical op:
  - **Null every sensitive/derived column** — all `ENCRYPTED_FIELDS` columns for that table (messages: `content, thinking, tags, entities, entity_summary, relations, metadata, suggested_new_tag, nlp_error`; documents: `content, summary, title, …`). No plaintext remains.
  - **Null `embedding_768`** (768D fingerprint) and **delete the `clustering_points` row(s)** (256D fingerprint) for that `source_id`.
  - **`backend.delete({ids:[id]})`** — evict the live in-RAM index (process-cached, no auto-refresh).
  - **Set `forgotten_at`**; **every read path filters `forgotten_at IS NULL`** (`selectRecent`, search hydrate, `getDailyMessages`, `relatedContext`, `getContext`).
  - Mark topology stale (regenerates next pipeline run). DB mutation is one SQLite txn; fail-closed + report on any partial (don't half-forget).
  - **Audited** via `forget_audit` (ref_type, ref_id, content_hash, length, at) — hash + length only, never plaintext (mirrors `egress_audit`).
  - The persisting husk = `id` + timestamps + non-sensitive enums (`role`/`source`/`scope`) + `forgotten_at`. **No hard `DELETE`.**
- **`correct(ref, newContent)`** — supersede: `forget` the old item, capture a replacement linked by `supersedes`; for the internal model, the existing `editMindFile`/`writeMindFileWhole` already overwrite in place.

> **Right-to-forget note:** the content + both embedding fingerprints are destroyed; only a metadata husk remains (audit + re-ingestion block). True hard-erasure (drop the husks) stays a separate, deferred concern (§12).

Reuses: `backend.delete` (exists), `afterDeleteHooks` (exists), new `messages.redact` + `clustering_points` cleanup (new), `ENCRYPTED_FIELDS` (unchanged).

### 3.3 Facts / preferences (G2)
New encrypted `facts` table + namespace + a small, always-on `getContext` section.
```sql
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,          -- preference|dietary|relationship|biographical|logistical|...
  key TEXT NOT NULL,               -- short stable handle, e.g. 'diet', 'partner_name'
  value TEXT NOT NULL,             -- ENCRYPTED
  confidence TEXT DEFAULT 'stated',-- stated|inferred
  source TEXT DEFAULT 'user',      -- user|assistant
  pinned INTEGER DEFAULT 0,
  sensitive INTEGER DEFAULT 0,
  superseded_by TEXT,
  forgotten_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, category, key)
);
```
- `ENCRYPTED_FIELDS.facts = ['value']` (key/category stay plaintext for query/dedup).
- Tools: `rememberFact({category,key,value,confidence?,sensitive?})` (upsert, dedup on category+key, supersede prior), `listFacts({category?})` (high-precision read), `forgetFact(id)` (→ `forget`).
- `getContext` gains a small **FACTS** section (pinned + recent, capped) — the highest-frequency need, always front-loaded.

### 3.4 Entities (G4) — heaviest piece, Phase 3
New `entities` + `entity_links`. Promote the NLP-extracted `messages.entities` (already populated by enrichment) into a registry, plus user/assistant curation.
```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL, type TEXT NOT NULL,         -- person|project|place|org
  name TEXT NOT NULL, aliases TEXT, summary TEXT,    -- name/aliases/summary ENCRYPTED
  pinned INTEGER DEFAULT 0, sensitive INTEGER DEFAULT 0, forgotten_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, type, name)
);
CREATE TABLE IF NOT EXISTS entity_links (
  entity_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  user_id TEXT NOT NULL, created_at TEXT DEFAULT (...),
  UNIQUE(entity_id, ref_type, ref_id)
);
```
- Tools: `upsertEntity`, `getEntity(name|id)` (summary + linked messages/docs/facts, reuses search), `listEntities({type?})`, `linkEntity(entity, ref)`, `forgetEntity(id)`.
- `getContext` may gain a compact **PEOPLE/PROJECTS** section (pinned entities only).

### 3.5 Proactive retrieval (G3)
- **`relatedContext({ text, limit?, scope? })`** — embeds `text`, runs the existing ANN+BM25+RRF, returns ranked neighbors; **excludes `forgotten_at IS NOT NULL` and `sensitive=1`** unless explicitly asked. ~30 LOC over `searchHelpers`/`backend.query`. The model passes the current conversation turn; no query craft needed.

### 3.6 Salience (G7)
- Add `pinned INTEGER DEFAULT 0` + `sensitive INTEGER DEFAULT 0` to `messages` (docs already have pin; facts/entities include them above).
- Tools: `pin(ref)` / `unpin(ref)` / `markSensitive(ref)` (ref-typed, one tool family across stores).
- Effect: pinned boosted in `getContext` + search; `sensitive` excluded from `relatedContext`/publish/egress by default.

### 3.7 Cold-start gating (G5)
- Thread an **async readiness probe** into boot: `boot()` awaits `db.mindscape.getNoiseStats()` (or a `territory_profiles` count) and passes a `ready` flag to `buildDomains({..., topologyReady})`.
- **DECISION (locked #4):** keep Tier-2 tools registered, but when `!ready` their handlers return a uniform structured message — *"Topology isn't computed yet. Import data and run clustering (see docs/SETUP.md)."* — instead of an empty result. `getContext` already omits empty sections. Preserves discoverability while being honest.

---

## 4. Threat model (new surface)

- **Forget must remove the *fingerprint*, not just the text.** A redact that leaves `embedding_768` or a `clustering_points` 256D vector is an **inversion risk** (CLAUDE.md §7). Therefore redact **nulls every `ENCRYPTED_FIELDS` column on the row** (not just `content`) **+ nulls `embedding_768` + deletes `clustering_points` + evicts the in-RAM vector** (`backend.delete` drops `_vectors`, `search/backend/local.js:129`). The husk that remains carries no plaintext and no fingerprint.
- **Facts/entities are maximally sensitive** → `value`/`name`/`summary`/`aliases` go in `ENCRYPTED_FIELDS`; `sensitive=1` items are excluded from `relatedContext`, never published, never in egress.
- **Audit without plaintext** — `forget_audit` stores `content_hash`+length+ref only (egress_audit pattern). Never log the forgotten content (CLAUDE.md §1).
- **Fail-closed:** an unknown `ref.type`, a missing id, or a forget that can't evict the index → refuse + report, don't partially-forget silently. Forget is **all-or-nothing per item** (row + embedding + clustering_point + index in one logical op; SQLite txn for the DB part).
- **No new network surface.** All additions are local tools over the existing vault.

---

## 5. Module shapes & LOC budget

| Unit | Files touched | New tools | LOC (±20%) |
|---|---|---|---|
| Phase 0 — schema | `migrations/0004_context_bank.sql`, `crypto-local.js` (ENCRYPTED_FIELDS), `db/index.js` | — | ~120 |
| Phase 1 — forget + salience | `db/messages.js` (+`redact`), `db/forget.js` (new ns), `tools/forget.js` (new domain), read-path `forgotten_at` filters, `search` wiring, `forget_audit` | `forget`, `correct`, `pin`, `unpin`, `markSensitive` | ~360 |
| Phase 2 — facts + relatedContext | `db/facts.js`, `tools/facts.js`, `tools/mindscape.js` (relatedContext), `tools/context.js` (FACTS section) | `rememberFact`, `listFacts`, `forgetFact`, `relatedContext` | ~340 |
| Phase 3 — entities | `db/entities.js`, `tools/entities.js`, enrichment promote step, `tools/context.js` | `upsertEntity`, `getEntity`, `listEntities`, `linkEntity`, `forgetEntity` | ~480 |
| Phase 4 — gating + ref | `index.js` (readiness), `mcp.js` (`buildDomains` flag), Tier-2 handlers | — | ~160 |

Handlers follow the verified contract: JSON-Schema `inputSchema`, `async (args) => string`, fail-closed throws wrapped by `mcp.js`.

## 6. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Redact leaves searchable index | **Must** call `backend.delete({ids})` (index is process-cached, no auto-refresh — `index.js:46-52`). |
| Redacted row re-embedded by enrichment | Prevented: blank `content` fails `content!=''` (`messages.js:148`); also set `forgotten`/null embedding. |
| Orphan `clustering_points` after forget | Forget **explicitly deletes** them — sync never does (`sync-clustering-points.js`). |
| Topology now stale | Acceptable: aggregates regenerate per `clustering_run_id`; mark stale, don't rewrite. |
| `forget` on already-forgotten | Idempotent no-op. |
| `rememberFact` duplicate | Upsert on `(category,key)`; old value `superseded_by` new. |
| `getContext` grows unbounded | Add an overall budget guard + per-section caps (facts/entities pinned-first, capped). |
| `relatedContext` surfaces forgotten/sensitive | Filtered out by default. |
| forget reversibility | `forget` destroys content + both embeddings (not recoverable) and keeps a metadata husk; there is **no hard-delete**. Not an "undo." |
| Husk still holds sensitive metadata | `forget` nulls **all** `ENCRYPTED_FIELDS` columns for the row + the embedding — not just `content`. |
| Reads still surface forgotten rows | add `AND forgotten_at IS NULL` to every read path (`selectRecent`, search hydrate, `getDailyMessages`, `relatedContext`). |

## 7. Test strategy (verify:* gates, one per phase)

- **`verify:forget`** — capture → `forget(ref)` → assert: absent from `selectRecent`/`searchMindscape` (index evicted), **all sensitive columns null** + `embedding_768` null, `clustering_points` row gone, `forgotten_at` set (**husk persists — no hard delete**), `forget_audit` written (hash only, no plaintext), enrichment won't re-pick. Wrong ref → fail-closed.
- **`verify:facts`** — `rememberFact` → `listFacts` → present in `getContext` FACTS → supersede on re-remember → `forgetFact`.
- **`verify:related`** — `relatedContext(text)` returns ranked hits; excludes forgotten + sensitive; BM25-only when embedder down.
- **`verify:entities`** — upsert/get/link/forget; NLP-promote backfill dedups.
- **`verify:gating`** — fresh vault: Tier-2 tool returns the "not ready" message; with seeded topology: returns real data.

## 8. Implementation order (design all now; build in shippable slices)

Phase 0 (schema) → **Phase 1 (forget + salience — highest value, smallest blast radius)** → Phase 2 (facts + relatedContext) → Phase 3 (entities) → Phase 4 (gating + ref unification). Each phase: its migration is `CREATE TABLE IF NOT EXISTS` only (runner is "idempotent-ish" — `migrate.js:31`), ships with its `verify:*` gate, and updates the living docs (`MCP-OVERVIEW.md` tool count, `ARCHITECTURE.md`).

## 9. Decision criteria to proceed phase→phase
A phase is "done" when its `verify:*` gate is `VERDICT: GO`, the changed surface smokes against the running server, the new tool count in `MCP-OVERVIEW.md` matches `verify:mcp`, and no plaintext appears in any audit/log path.

## 10. Risks + mitigations

| Risk | L | I | Mitigation |
|---|---|---|---|
| Redact misses an embedding copy → inversion | M | High | Forget nulls `embedding_768` + deletes `clustering_points` + `backend.delete`; `verify:forget` asserts all three. |
| Tool-count creep re-bloats the surface | M | Med | Net new ~16 tools across 4 phases; fold via `ref` family (one `forget`/`pin`, not per-type); revisit getContext as the primary surface. |
| Gating change to `buildDomains` breaks boot | L | High | Readiness probe is best-effort (defaults to "ready=false" on error → safe messages); covered by `verify:mcp` + `verify:gating`. |
| Facts/entities become a second mindscape | M | Med | Keep facts *small + high-precision*; entities link to existing refs, don't duplicate content. |
| Iteration scope balloons | M | Med | Phase 1 alone (forget+salience) closes the sharpest gap; ship it before committing to 3-4. |

## 11. Open decisions (resolve during iteration)

1. **Forget semantics:** ✅ **RESOLVED → soft-redact only** (no hard `purge`; husk persists for audit).
2. **Facts model:** ✅ **RESOLVED → typed `category/key/value`**.
3. **Entities:** working default **promote NLP-extracted + curate** — confirm the curate-vs-user-only sub-call when we reach Phase 3.
4. **Tier-2 gating:** ✅ **RESOLVED → present-but-"not ready" message** (keep tools listed).
5. **Scope/sequencing:** ✅ **RESOLVED → build all four phases, sequentially** (Phase 1 → Phase 4).

## 12. Open questions deferred (out of scope)
- Account-level "delete everything" (a `DELETION_CATALOG`) — related but separate from per-item forget; V2/portal concern.
- Multi-tenant interactions (V2 only).
- A re-clustering trigger after a large forget batch (relies on the Tier-2 pipeline; today topology self-heals on the next manual run).

---

## 13. Verification table (assumption → file:line I read myself)

| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | Tool domain factory shape `{tools,handlers}`, handler `async(args)=>string` | `src/tools/tasks.js:18-96`; wrap at `src/mcp.js:148-179` |
| 2 | New domains added to `domains[]` in `buildDomains` (static at boot) | `src/mcp.js:79-117` |
| 3 | `messages` row has `embedding_768`; encrypted `content`; PK `id` | `migrations/0001_init.sql:950`; `crypto-local.js:214-218` |
| 4 | `clustering_points` links to message by `source_id`, **no FK**, holds 256D vector | `migrations/0001_init.sql:254` (Sweep A) |
| 5 | Derived metric/fisher/topology tables key off `clustering_run_id`, not message id | Sweep A (migrations/0001_init.sql cofire/harmonic/fisher blocks) |
| 6 | `documents.delete` exists + fires `afterDeleteHooks` (delete+hook seam) | `src/db/documents.js:206-212` |
| 7 | Search backend `delete({ids})` evicts `_index`+`_vectors`; index built once/process | `src/search/backend/local.js:125-133`; `src/search/index.js:46-52` (Cycle 2) |
| 8 | `ENCRYPTED_FIELDS` is the table→columns allowlist; embeddings intentionally plaintext | `src/crypto/crypto-local.js:209,204-206,214-218` |
| 9 | Audit-without-plaintext precedent (`content_hash`+length) | `src/db/egress-audit.js:121` |
| 10 | Soft-delete/tombstone precedent (`revoked_at`, filter `IS NULL`) | `migrations/0001_init.sql:919-920` |
| 11 | `getContext` section seam + `include` enum + no output budget | `src/tools/context.js:32-61` |
| 12 | Readiness probe exists (`clustering_points` count) | `src/db/mindscape.js:34` (Sweep C) |
| 13 | `user_profiles` is display/fingerprint, not a facts store; `db.profiles` unwired | `migrations/0001_init.sql:1565`; `src/db/index.js:34-72` (Sweep C) |
| 14 | `backend.query({text|embedding,topK})` reuse for `relatedContext` | `src/search/backend/local.js:58-88` |
| 15 | Enrichment skips `content=''`; sync skips null embedding (anti-resurrection) | `src/db/messages.js:148`; `pipeline/sync-clustering-points.js` (Cycle 2) |
| 16 | `messages` has no delete method + no salience column; docs have pin | `src/db/messages.js` (grep); `src/portal-compat.js:71` (Cycle 2) |
| 17 | Migration runner is "idempotent-ish" → new migrations must be `CREATE TABLE IF NOT EXISTS` | `src/db/migrate.js:26-39,31` |
