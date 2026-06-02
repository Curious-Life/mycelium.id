# Context Bank Upgrade — Design Spec (v3 — lean surface, decisions locked)

**Date:** 2026-06-02 · **Status:** DRAFT — decisions locked (§11), iterating before build · **Author:** sweep-first-design pass
**Scope:** V1 self-hosted MCP server (`src/tools`, `src/db`, `migrations/`). Single-user, encrypted SQLite vault.
**Companions:** [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md) (current 31-tool surface) · [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md).

This spec closes the gaps from the context-bank design review **and slims the surface**: net **31 → ~27 tools** while adding forget, facts, entities, proactive recall, salience, and an honest cold-start. Grounded in a two-cycle sweep against live code (file:line throughout). **We iterate this spec, then build.** Nothing here is built yet.

---

## 0. The gaps we're closing (from the review)

| # | Gap | One-line fix |
|---|---|---|
| G1 | **No forget/correct on the tool surface** (message stream + internal model append-only) | A **soft-redact** `forget(ref)` (tombstone; no hard-delete) that cascades correctly + is audited |
| G2 | **No high-precision facts/preferences surface** | A small encrypted `facts` store, written via `remember`, surfaced in `getContext` + search |
| G3 | **Retrieval is query-only** (no "relevant to *now*") | A `relatedTo` mode on `searchMindscape` — reuse of the embed+ANN+RRF backend |
| G4 | **Entities are convention-over-documents** | A first-class `entities` registry (write via `remember`/`link`; read via search) |
| G5 | **Cold-start: ~10 Tier-2 tools return empty** | A readiness probe + honest "not ready, do X" responses |
| G6 | **5 overlapping ontologies + a bloated reader surface** | A unified `ref` handle **and** consolidate 11 readers → 3 cohesive tools |
| G7 | **Salience is computed, not user-assertable** | `mark(ref, {pinned?, sensitive?})` across messages/facts/entities |

---

## 1. Revision history

- **v0 (review):** "no delete anywhere"; "relatedContext needs new infra"; "gate Tier-2 by hiding tools."
- **v1 (post-sweep) — three pivots:** (1) forget is NOT greenfield (builds on `documents.delete`+`afterDeleteHooks`, `backend.delete({ids})`, `revoked_at`); (2) the cascade is shallow (only `clustering_points`+`embedding_768` ref a message); (3) `relatedContext` is trivial reuse of `backend.query({text})`.
- **v2 (decisions locked):** forget = **soft-redact only**; facts = **typed category/key/value**; Tier-2 = **present-but-"not ready"**; scope = **all four phases**.
- **v3 (lean surface):** **model intents, not storage ops.** New tools collapse to **4 lean verbs** (`remember`/`forget`/`mark`/`link`); all new *reads* fold into extended `searchMindscape` + `getContext`. **AND** the existing **11 cognitive/topology readers consolidate to 3** (`cognitiveState`/`cognitiveHistory`/`mindscape`). Net surface **31 → ~27**. Consolidation is delete/rename → gated by `/pre-deletion-caller-audit`.
- **v3.1 (pre-build implementation sweep):** verified the exact Phase-1 touch-points (§5.1). **Two build-level catches:** (a) the search loader selects messages by `user_id` only — **no content filter** (`d1-loader.js:47`) — so the forget resurrection-guard must be the new `forgotten_at` flag, *not* nulled content alone; (b) multi-column `ADD COLUMN` is unsafe under the runner (`migrate.js:31`) — one-per-file or harden the runner. Index-eviction API confirmed: `searchHelpers.backend.delete({ids})`.
- **Phase 1 BUILT + verified (2026-06-02):** migration runner hardened to guard *every* `ADD COLUMN` + `0004` (local SQLite); `forget`/`mark` tools (31→33); `forgotten_at` filters on all message/document reads + the in-RAM loader; index eviction; hash-only forget audit (`audit_log`); `getContext` 📌 for pinned. `verify:forget` GO (13/13); regression GO (`verify:mcp`/`foundation`/`context`/`ingest`/`search`/`rest`). Commits: `a200ed0` (Phase 0), `9cde646` (Stage B), `22c1a75` (Stage C+D). Next: Phase 2 (facts + relatedContext).

---

## 2. Sweep findings (consolidated, file:line)

**Data model / forget cascade (Sweep A):**
- `messages` row: PK `id`, encrypted `content`, `embedding_768 TEXT` (768D) — `0001_init.sql:950`.
- `clustering_points` holds the 256D `nomic_embedding` + `territory_id`, linked by `source_type='message' AND source_id=<id>`, **no FK** — `0001_init.sql:254`.
- Derived tables (`territory_cofire`, `cognitive_metrics_*`, `fisher_*`, `territory_vitality`, `topology_metrics`) key off `clustering_run_id` + counts, **not message ids** — they go stale, regenerate next run. **No `ON DELETE CASCADE`.**

**Delete / encryption / audit precedent (Sweep B):**
- Hard deletes exist per-namespace (`documents.delete` + `afterDeleteHooks` — `db/documents.js:206-212`); no unified/account delete.
- `ENCRYPTED_FIELDS` (`crypto/crypto-local.js:209`) maps table→columns; `messages` encrypts `content/thinking/tags/entities/...`. Embeddings/centroids **intentionally NOT encrypted** (`crypto-local.js:204-206`) — but inversion-sensitive, so forget must remove them.
- Audit: `audit_log` (plaintext, `db/audit.js:105`); `egress_audit` stores **`content_hash`+length, never plaintext** (`db/egress-audit.js:121`) — the forget-audit model.
- Soft-delete precedent: `identity_channels.revoked_at` — "NEVER hard-deleted; rows persist for audit; filter `revoked_at IS NULL`" (`0001_init.sql:919-920`).

**Tool/namespace/getContext/gating/profiles (Sweep C):**
- Domain factory: `createXDomain(deps) → { tools:[{name,description,inputSchema}], handlers:{name: async(args)=>string} }` (`tools/tasks.js:18-96`); domains array in `buildDomains` (`mcp.js:79-112`).
- `db` namespaces wired in `db/index.js:34-72` (incl. `fisher`, `metrics`, `topology`, `mindscape`) — **the consolidated readers route to these unchanged.** New namespace = create `db/<ns>.js` → import → wire.
- `getContext` composes `sections[]` with `if (want(include,'x') && db?.ns){try{}catch{}}`; `include` enum `['mind','messages','phase','health']` (`tools/context.js:45`); no overall budget.
- Tool registration is **static at boot**; readiness probe: `db.mindscape.getNoiseStats(userId)` counts `clustering_points` (`db/mindscape.js:34`).
- `user_profiles` (`0001_init.sql:1565`) = display/fingerprint, **not a facts store**; REST-only.

**Search reuse + lifecycle (Sweep D + Cycle 2):**
- `backend.query({ text | embedding, topK })` runs ANN+BM25+RRF; raw text or vector (`search/backend/local.js:58-88`). `searchHelpers` exposes `bulkSearch` + backend (`search/index.js`).
- In-RAM index built **once per process** (`ensureBuilt`, no TTL — `search/index.js:46-52`); a DB delete needs `backend.delete({ids})` (`search/backend/local.js:125-133`) to evict.
- Enrichment selects `nlp_processed=0 AND content!=''` (`db/messages.js:148`); sync selects `embedding_768 IS NOT NULL` and **never removes orphans** (`pipeline/sync-clustering-points.js`). ⇒ blank content + null embedding + `forgotten` flag = safe from re-embed + re-sync.
- `messages` has **no delete method**; `selectRecent` has no `forgotten` predicate. Salience: `documents` have `pin/unpin` (`portal-compat.js:71`); **messages have none.**

---

## 3. The design

### 3.0 The lean surface (the whole picture)

Organize around **intents**, not storage ops. Two read primitives + four write/curate verbs, plus a one-time consolidation of the existing readers.

**Reads — 2 primitives (extended, no new read tools):**
- `getContext` — the preamble; gains **FACTS** + **PEOPLE** sections (pinned-first, capped).
- `searchMindscape` — gains `scope: …|facts|entities` and a **`relatedTo: <text>`** mode → subsumes `relatedContext`, fact/entity listing, and entity-dossier lookup.

**Write / curate — 4 lean verbs (new):**
| Tool | Purpose | Replaces (vs the thin plan) |
|---|---|---|
| `remember({kind:'fact'\|'entity', ...})` | Typed durable write; can set `pinned`/`sensitive` inline | `rememberFact`, `upsertEntity` |
| `forget(ref)` | Soft-redact any item (§3.2) | `forgetMessage/Document/Fact/Entity` |
| `mark(ref, {pinned?, sensitive?})` | Salience on existing items | `pin`, `unpin`, `markSensitive` |
| `link(ref, ref)` | Relate two items (entity ↔ message/doc/fact) | `linkEntity` |

(`correct` is **not** a tool — it's the documented composition `forget(ref)` + `remember`/recapture; the internal model already has `editMindFile`/`writeMindFileWhole`.)

**Consolidate existing readers — 11 → 3 (§3.8).**

**Net: 31 − 11 + 3 + 4 = ~27 tools.**

### 3.1 The unified `ref` handle (G6)
```
ref := { type: 'message'|'document'|'fact'|'entity', id: string }
```
Used by `forget`/`mark`/`link` so the model holds **one** handle, not per-type variants. (`territory`/`realm`/`theme` are computed/read-only — excluded.)

### 3.2 Forget / correct (G1) · soft-redact only
A single **soft** primitive — **no hard-delete tool**. `forget(ref)` destroys the *meaning* and keeps a tombstone husk for audit + anti-resurrection, in one logical op:
- **Null every `ENCRYPTED_FIELDS` column** for that table (messages: `content, thinking, tags, entities, entity_summary, relations, metadata, suggested_new_tag, nlp_error`). No plaintext remains.
- **Null `embedding_768`** + **delete the `clustering_points` row(s)** for that `source_id` (both fingerprints gone).
- **`backend.delete({ids:[id]})`** — evict the live in-RAM index (process-cached, no auto-refresh).
- **Set `forgotten_at`**; **every read path filters `forgotten_at IS NULL`** (`selectRecent`, search hydrate, `getDailyMessages`, `searchMindscape`, `getContext`).
- Mark topology stale (regenerates next pipeline run). One SQLite txn; fail-closed + report on partial.
- **Audited** via `forget_audit` (ref_type, ref_id, content_hash, length, at) — hash + length only, never plaintext.

> Right-to-forget: content + both fingerprints destroyed; a metadata husk (`id`/timestamps/enums/`forgotten_at`) persists. True hard-erasure is deferred (§12).

### 3.3 Facts (G2) — typed; written via `remember`
New encrypted `facts` table; read via `getContext`/`searchMindscape`, not a dedicated reader.
```sql
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL, category TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL,                 -- ENCRYPTED
  confidence TEXT DEFAULT 'stated', source TEXT DEFAULT 'user',
  pinned INTEGER DEFAULT 0, sensitive INTEGER DEFAULT 0,
  superseded_by TEXT, forgotten_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, category, key)
);
```
- `ENCRYPTED_FIELDS.facts = ['value']` (key/category plaintext for query/dedup).
- Write: `remember({kind:'fact', category, key, value, confidence?, sensitive?})` — upsert on `(category,key)`, supersede prior.
- Read: a **FACTS** section in `getContext` (pinned + recent, capped) + `searchMindscape({scope:'facts'})`.

### 3.4 Entities (G4) — Phase 3
```sql
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL, type TEXT NOT NULL,            -- person|project|place|org
  name TEXT NOT NULL, aliases TEXT, summary TEXT,       -- name/aliases/summary ENCRYPTED
  pinned INTEGER DEFAULT 0, sensitive INTEGER DEFAULT 0, forgotten_at TEXT,
  created_at TEXT DEFAULT (...), UNIQUE(user_id, type, name)
);
CREATE TABLE IF NOT EXISTS entity_links (
  entity_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  user_id TEXT NOT NULL, created_at TEXT DEFAULT (...),
  UNIQUE(entity_id, ref_type, ref_id)
);
```
- Write: `remember({kind:'entity', type, name, summary?})`; relate: `link(entityRef, itemRef)`.
- Read: `searchMindscape({scope:'entities', relatedTo|query})` returns the entity + its linked items (the "dossier") — no `getEntity` tool. `getContext` gains a compact **PEOPLE/PROJECTS** section (pinned only).
- Promote the NLP-extracted `messages.entities` (enrichment-populated) into the registry + user/assistant curation. (Curate-vs-user-only sub-decision confirmed at Phase 3.)

### 3.5 Proactive retrieval (G3) — a mode, not a tool
`searchMindscape({ relatedTo: <text>, scope?, limit? })` embeds the text and runs the existing ANN+BM25+RRF; **excludes `forgotten_at IS NOT NULL` and `sensitive=1`** unless asked. The model passes the current turn; no query craft. ~30 LOC on the existing helper.

### 3.6 Salience (G7) — `mark`
- Add `pinned`/`sensitive` to `messages`, `facts`, `entities` (docs already have pin).
- `mark(ref, {pinned?, sensitive?})` — one tool across stores. Pinned → boosted in `getContext` + search; `sensitive` → excluded from `relatedTo`/publish/egress by default.

### 3.7 Cold-start gating (G5)
- Thread an **async readiness probe** into boot: `boot()` awaits `db.mindscape.getNoiseStats()` and passes `topologyReady` to `buildDomains`.
- **DECISION (locked):** keep Tier-2 tools registered; when `!ready` their handlers return a uniform *"Topology isn't computed yet — import data and run clustering (see docs/SETUP.md)."* `getContext` already omits empty sections.

### 3.8 Consolidate existing readers — 11 → 3 (G6) · DECISION: slim them too
Pure **tool-surface** reshape — handlers route to the **existing** `db.fisher`/`db.metrics`/`db.topology`/`db.mindscape` methods, **zero change to storage or computation**. Gated by `/pre-deletion-caller-audit` (callers = `verify:metrics`/`verify:topology`, REST `/api/v1/<name>` paths, `portal-app`, docs — **not** `getContext`, which uses `db.*` directly).

| New tool | Folds in | Shape |
|---|---|---|
| `cognitiveState({level?})` | `getCurrentPhase` + `getHarmonicState` + `getActiveMilestones` | the "now": movement + rhythm + alerts |
| `cognitiveHistory({level?, metric?, window?, range?})` | `getTrajectoryHistory` + `getMetricSeries` + `getTopMovers` | over-time series |
| `mindscape({view:'structure'\|'territories'\|'territory'\|'explore'\|'time', territory?, ...})` | `mindscapeStructure` + `listTerritories` + `territoryDetail` + `exploreTerritory` + `timeView` | topology, by view |

---

## 4. Threat model (new surface)

- **Forget removes the *fingerprint*, not just the text.** Redact **nulls every `ENCRYPTED_FIELDS` column** (not just `content`) + **nulls `embedding_768`** + **deletes `clustering_points`** + **evicts the in-RAM vector** (`backend.delete` drops `_vectors`, `search/backend/local.js:129`). The husk carries no plaintext, no fingerprint.
- **Facts/entities are maximally sensitive** → `value`/`name`/`summary`/`aliases` in `ENCRYPTED_FIELDS`; `sensitive=1` excluded from `relatedTo`, never published/egressed.
- **Audit without plaintext** — `forget_audit` = `content_hash`+length+ref only (egress_audit pattern). Never log forgotten content (CLAUDE.md §1).
- **Fail-closed:** unknown `ref.type`, missing id, or a forget that can't evict the index → refuse + report; forget is all-or-nothing per item.
- **Consolidation preserves behavior:** new readers call the same `db.*` methods; `/pre-deletion-caller-audit` proves every old tool's capability is covered before removal. No new network surface.

---

## 5. Phases, files, LOC budget

| Phase | Files | Tools (Δ) | LOC (±20%) |
|---|---|---|---|
| 0 — schema | `migrations/0004_context_bank.sql`, `crypto-local.js` (ENCRYPTED_FIELDS), `db/index.js` | — | ~120 |
| 1 — forget + salience | `db/messages.js` (+`redact`), `db/forget.js`, `tools/curate.js`, read-path `forgotten_at` filters, `search` wiring, `forget_audit` | +`forget`, +`mark`, +`link` | ~360 |
| 2 — facts + related | `db/facts.js`, `tools/facts.js` (`remember` fact-path), `tools/mindscape.js` (`relatedTo` + `facts` scope), `tools/context.js` (FACTS) | +`remember` | ~320 |
| 3 — entities | `db/entities.js`, `remember` entity-path, `searchMindscape` entities scope, enrichment promote, `getContext` PEOPLE | — (reuses `remember`/`link`) | ~440 |
| 4 — gating | `index.js` (readiness), `mcp.js` (`buildDomains` flag), Tier-2 handlers | — | ~140 |
| 5 — consolidate readers (**pre-deletion-caller-audit**) | `tools/cognition.js`, `tools/mindscape.js`, remove 11 old tools, rewrite `verify:metrics`/`verify:topology`, update `MCP-OVERVIEW.md` | +3, **−11** | ~300 |

Handlers follow the verified contract: JSON-Schema `inputSchema`, `async (args) => string`, fail-closed throws wrapped by `mcp.js`.

### 5.1 Phase 1 build map — exact touch-points (pre-build sweep, verified)

**New db methods:** `messages.redact(id,userId)` + `documents.redact(userId,path)` — null every `ENCRYPTED_FIELDS` column + `embedding_768`, set `forgotten_at` (model after `messages.updateNlp`; documents has only a *hard* `delete` at `documents.js:206`, no soft path). `forget_audit` via a new `db.forgetAudit.record(...)` (egress_audit pattern). Salience: add `messages.setSalience`; documents reuse existing `pin/unpin` (`documents.js:150-176`, already exposes `is_pinned`).

**Add `AND forgotten_at IS NULL` to (verified line list):** messages — `selectRecent:321`, `selectPaginated:366`, `selectTimeline:434`, `selectByAgent:411`, `selectAll:466`, `streamForRehydrate:299`, `selectPendingEnrichment:151`, `selectPendingNlp:173`, `matchMessages` hydration `:541`; documents — `get:87`, `list:122`, `getBySlug:224`.

**Index eviction (verified):** `searchHelpers.backend.delete({ids:[id]})` — `backend` exposed at `search/index.js:252`; `delete` evicts `_index`+`_vectors` at `search/backend/local.js:125-133`. Wire `searchHelpers` into the forget domain via `buildDomains`.

**Salience boost (verified):** search — add a `pinned` multiplier after temporal boost in backend `tier1` (`backend/local.js:82`; temporal is multiplicative at `fusion/temporal.js:58`); getContext — sort pinned-first after `selectRecent` (`context.js:86`, before reverse/render).

**⚠️ Two build-level catches found here (before coding):**
1. **Resurrection guard is NOT covered by nulling content.** The in-RAM loader selects `SELECT id, content AS text, created_at FROM messages WHERE user_id=?` — **no `content IS NOT NULL`** (verified `d1-loader.js:47`). A nulled-content row is still *added* to a rebuilt index (just non-matching). **Fix: add `AND forgotten_at IS NULL` to `d1-loader.js:47`** as the real guard. (Documents aren't in the loader yet — `search/index.js:162` — so only the messages line needs it now.)
2. **Multi-column `ADD COLUMN` in one migration is unsafe.** `messages` needs `pinned`+`sensitive`+`forgotten_at`, but the runner guards only the *first* `ALTER…ADD COLUMN` per file (`migrate.js:31`) — a re-run on a populated vault would skip columns 2-3. **Fix: one `ADD COLUMN` per migration file, OR harden `applyMigrations` to guard *all* ADD COLUMNs (~10-LOC loop — recommended; kills a latent footgun repo-wide).**

## 6. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Redact leaves searchable index | **Must** `backend.delete({ids})` (process-cached, no auto-refresh — `index.js:46-52`). |
| Redacted row re-embedded | Prevented: blank `content` fails `content!=''` (`messages.js:148`) + null embedding + `forgotten`. |
| Orphan `clustering_points` | Forget **explicitly deletes** them — sync never does (`sync-clustering-points.js`). |
| Topology stale after forget | Acceptable: regenerates per `clustering_run_id`. |
| `forget` on already-forgotten | Idempotent no-op. |
| Husk still holds sensitive metadata | Forget nulls **all** `ENCRYPTED_FIELDS` columns + embedding, not just `content`. |
| Reads still surface forgotten rows | `AND forgotten_at IS NULL` on every read path. |
| `remember` duplicate fact | Upsert on `(category,key)`; old `superseded_by` new. |
| Consolidated tool renames break a caller | `/pre-deletion-caller-audit` inventories + migrates verify scripts/REST/portal/docs before removal. |
| `getContext` unbounded | Overall budget guard + per-section caps. |

## 7. Test strategy (verify:* gates)

- **`verify:forget`** — capture → `forget(ref)` → assert: absent from `selectRecent`/`searchMindscape` (index evicted), all sensitive columns + `embedding_768` null, `clustering_points` gone, `forgotten_at` set (husk persists — no hard delete), `forget_audit` written (hash only), enrichment won't re-pick. Wrong ref → fail-closed.
- **`verify:salience`** — `mark`/`link` round-trip; pinned boosted; `sensitive` excluded from `relatedTo`.
- **`verify:facts`** — `remember(fact)` → in `getContext` FACTS + `searchMindscape({scope:'facts'})` → supersede → `forget`.
- **`verify:related`** — `searchMindscape({relatedTo})` ranks; excludes forgotten + sensitive; BM25-only when embedder down.
- **`verify:entities`** — `remember(entity)`/`link` → dossier via search; NLP-promote dedups.
- **`verify:gating`** — fresh vault: Tier-2 returns "not ready"; seeded: real data.
- **`verify:cognition` / `verify:mindscape`** — the 3 consolidated tools return what the 11 originals did (parity assertions), proving the consolidation preserved capability.

## 8. Implementation order

Phase 0 (schema) → 1 (forget + salience) → 2 (facts + related) → 3 (entities) → 4 (gating) → **5 (consolidate readers — last, behind `/pre-deletion-caller-audit`, since it's the only breaking change)**. Each phase ships with its `verify:*` gate + updates `MCP-OVERVIEW.md` (tool count must match `verify:mcp`) + `ARCHITECTURE.md`. Phases 1–4 are additive; Phase 5 lands the rename once the new lean convention is established.

## 9. Decision criteria phase→phase
A phase is done when its `verify:*` is `VERDICT: GO`, the changed surface smokes against the running server, `MCP-OVERVIEW.md`'s tool count matches `verify:mcp`, and no plaintext appears in any audit/log path. Phase 5 additionally requires the `/pre-deletion-caller-audit` ledger (every caller migrated, parity proven) before any old tool is removed.

## 10. Risks + mitigations

| Risk | L | I | Mitigation |
|---|---|---|---|
| Redact misses an embedding copy → inversion | M | High | Null embedding + delete clustering_point + `backend.delete`; `verify:forget` asserts all three. |
| Consolidation breaks a hidden caller | M | Med | `/pre-deletion-caller-audit`; readers route to unchanged `db.*` methods; parity tests (`verify:cognition`/`mindscape`). |
| `remember`/`searchMindscape` schemas get overloaded | M | Med | Keep `kind`/`scope`/`view` discriminators shallow + well-described; don't add a 5th mode without review. |
| Gating change breaks boot | L | High | Readiness probe best-effort (defaults `ready=false` → safe messages); `verify:mcp`+`verify:gating`. |
| Model trained on old tool names (post-Phase-5) | L | Low | Single-user; new tools' descriptions guide; transition note in `MCP-OVERVIEW.md`. |

## 11. Decisions (locked)

1. **Forget:** ✅ soft-redact only (no hard purge; husk persists for audit).
2. **Facts:** ✅ typed `category/key/value`.
3. **Entities:** working default = promote NLP + curate — confirm curate-vs-user-only at Phase 3.
4. **Tier-2 gating:** ✅ present-but-"not ready" (keep listed).
5. **Scope:** ✅ build all phases (now incl. Phase 5 consolidation).
6. **New-tool shape:** ✅ **lean verbs** (`remember`/`forget`/`mark`/`link`); reads fold into `searchMindscape`+`getContext`.
7. **Existing surface:** ✅ **slim it** — 11 cognitive/topology readers → 3 (`cognitiveState`/`cognitiveHistory`/`mindscape`).

## 12. Deferred (out of scope)
- Account-level hard-erasure (drop the husks; a `DELETION_CATALOG`) — V2/portal concern.
- Multi-tenant interactions (V2).
- Re-clustering trigger after a large forget batch (topology self-heals next manual run).

---

## 13. Verification table (assumption → file:line I read myself)

| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | Tool factory `{tools,handlers}`, handler `async(args)=>string` | `src/tools/tasks.js:18-96`; wrap `src/mcp.js:148-179` |
| 2 | Domains added to `domains[]` in `buildDomains` (static at boot) | `src/mcp.js:79-117` |
| 3 | `messages` has `embedding_768`, encrypted `content`, PK `id` | `migrations/0001_init.sql:950`; `crypto-local.js:214-218` |
| 4 | `clustering_points` links by `source_id`, no FK, holds 256D vector | `migrations/0001_init.sql:254` |
| 5 | Metric/fisher/topology tables key off `clustering_run_id`, not message id | Sweep A (0001_init.sql) |
| 6 | `documents.delete` + `afterDeleteHooks` (delete+hook seam) | `src/db/documents.js:206-212` |
| 7 | `backend.delete({ids})` evicts index; built once/process | `src/search/backend/local.js:125-133`; `src/search/index.js:46-52` |
| 8 | `ENCRYPTED_FIELDS` allowlist; embeddings intentionally plaintext | `src/crypto/crypto-local.js:209,204-206,214-218` |
| 9 | Audit-without-plaintext precedent (`content_hash`+length) | `src/db/egress-audit.js:121` |
| 10 | Soft-delete/tombstone precedent (`revoked_at`) | `migrations/0001_init.sql:919-920` |
| 11 | `getContext` section seam + `include` enum + no budget | `src/tools/context.js:32-61` |
| 12 | Readiness probe (`clustering_points` count) | `src/db/mindscape.js:34` |
| 13 | `user_profiles` is display/fingerprint, not facts | `migrations/0001_init.sql:1565`; `src/db/index.js:34-72` |
| 14 | `backend.query({text|embedding,topK})` reuse for `relatedTo` | `src/search/backend/local.js:58-88` |
| 15 | Enrichment skips `content=''`; sync skips null embedding | `src/db/messages.js:148`; `pipeline/sync-clustering-points.js` |
| 16 | `messages` no delete method / no salience col; docs have pin | `src/db/messages.js`; `src/portal-compat.js:71` |
| 17 | Migration runner "idempotent-ish" → `CREATE TABLE IF NOT EXISTS` | `src/db/migrate.js:26-39,31` |
| 18 | Consolidated readers route to existing `db.fisher/metrics/topology/mindscape` | `src/db/index.js:34-72` (Sweep C) |
| 19 | Search loader `SOURCES` selects messages by `user_id` only (no content/embedding filter) → forget needs a `forgotten_at` loader filter | `src/search/d1-loader.js:47` |
| 20 | `searchHelpers` exposes raw `backend`; `backend.delete({ids})` evicts `_index`+`_vectors` | `src/search/index.js:252`; `src/search/backend/local.js:125-133` |
| 21 | Full message/document read-path line list to filter `forgotten_at` | `src/db/messages.js` 299/321/366/411/434/466/541 + 151/173; `src/db/documents.js` 87/122/224 |
