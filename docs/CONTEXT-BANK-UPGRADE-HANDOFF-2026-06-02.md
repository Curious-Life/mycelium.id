# Context Bank Upgrade — Handoff Doc

**Date:** 2026-06-02
**Companions:** [`CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md`](CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md) (the spec — read §3, §5.1, §11) · [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md) (live tool surface, now 34) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
**Audience:** the next Claude Code instance picking up this work.

A 5-phase upgrade to the V1 MCP "context bank": add forget/correct, facts, proactive recall, entities, honest cold-start, user salience — **while shrinking the tool surface** (31 → ~27 after Phase 5). **Phases 1–2 are built + verified; Phases 3–5 pending.** Everything is **local SQLite on the home server — no Cloudflare D1.**

---

## TL;DR — current state

| Phase | Commit(s) | Status | What |
|---|---|---|---|
| 0 — schema | `a200ed0` | ✅ built+verified | migration runner hardened (guards *every* ADD COLUMN) + `0004` (messages.{pinned,sensitive,forgotten_at}, documents.{sensitive,forgotten_at}) |
| 1 — forget + salience | `9cde646` (db) · `22c1a75` (tools+gate) · `7832951` (docs) | ✅ built+verified | `forget(type,id)` soft-redact + `mark(type,id,{pinned,sensitive})`; 31 → **33 tools**; `verify:forget` 13/13 |
| 2 — facts + relatedContext | `2789f72` (db) · `e8d1d83` (tools+gates) | ✅ built+verified | `remember` (typed facts) + `getContext` FACTS section + `relatedTo` + `scope:'facts'` on `searchMindscape`; forget/mark gain `type:'fact'`; 33 → **34 tools**; `verify:facts` 17/17 + `verify:related` 7/7 |
| 3 — entities | — | ⬜ **NEXT** | `entities`+`entity_links`; write via `remember`(kind:'entity')/`link`; read via search |
| 4 — cold-start gating | — | ⬜ planned | async readiness probe → Tier-2 tools return "not ready" instead of empty |
| 5 — consolidate readers | — | ⬜ planned | 11 cognitive/topology readers → 3 (`cognitiveState`/`cognitiveHistory`/`mindscape`) — **behind `/pre-deletion-caller-audit`** |

- **Branch:** `claude/zealous-euler-kSPpI` · **PR:** #42 (draft) · **HEAD:** `e8d1d83` (+docs commit)
- **Gate:** full `npm run verify` → **34× GO, EXIT 0** (incl. `verify:forget`/`verify:facts`/`verify:related`). Clean tree.
- **Rebased onto `origin/main` (#43, `1a8f525`)** at the start of the Phase-2 session — #43 ("rehydrate stored `embedding_768`") collided with Phase 1 on `d1-loader.js:47`/`mcp.js`/`package.json`; resolved so the loader SELECT carries **both** `embedding_768` **and** `AND forgotten_at IS NULL` (a security win — a forgotten row's embedding can never be rehydrated). Force-pushed (lease-guarded).
- Earlier this session (separate, already **merged to main**): PR #39 (skills reconciled to V1) + PR #41 (`MCP-OVERVIEW.md`).

---

## 2026-06-02 session summary — start here when picking up

### What shipped
| Commit | Scope | Description |
|---|---|---|
| `a200ed0` | Phase 0 | `src/db/migrate.js` hardened to guard every `ALTER…ADD COLUMN` (was first-match-only → silently skipped cols 2..n on re-run); `migrations/0004_context_bank.sql` adds 5 columns. Verified idempotent on a temp db. |
| `9cde646` | Phase 1 Stage B (db) | `messages.redact`/`documents.redact` (null all encrypted cols + embedding, delete clustering point, stamp `forgotten_at`, return content-hash); `setSalience`; `forgotten_at IS NULL` on every read path + the in-RAM loader (`d1-loader.js:47`). |
| `22c1a75` | Phase 1 Stage C+D (tools) | `src/tools/curate.js` (`forget`+`mark`), wired into `buildDomains` (31→33); `boot()` now returns `searchHelpers` for index eviction; `getContext` 📌 for pinned; `scripts/verify-forget.mjs` (13 assertions) + chain entry. |
| `7832951` | Phase 1 docs | `MCP-OVERVIEW.md` 31→33 + curate section; spec + MEMORY status. |

### What was learned (most valuable — these die if not written)
- **`forget` is NOT greenfield.** Built on existing `documents.delete`+`afterDeleteHooks`, the `revoked_at` tombstone precedent, and `searchHelpers.backend.delete({ids})`. The gap was a *unified, audited, cascading* soft-delete — not new plumbing.
- **The cascade is shallow.** Only `clustering_points` (`source_id`→message, no FK) and the row's own `embedding_768` reference a message; the metric/fisher/topology tables key off `clustering_run_id` and **self-heal** on the next pipeline run. Forget does NOT rewrite 10 tables.
- **⚠️ Resurrection guard is FLAG-based, not content-based.** The in-RAM search loader is `SELECT id, content AS text, created_at FROM messages WHERE user_id = ?` (`d1-loader.js:47`) — **no `content IS NOT NULL`** (a sweep agent mis-claimed there was one; caught by reading the line myself). So nulling content does NOT keep a forgotten row out of a *rebuilt* index — the loader now filters `AND forgotten_at IS NULL`. This was a real build-breaker caught by the pre-build sweep.
- **Multi-column `ADD COLUMN` was unsafe** under the old runner (first-match-only guard). Hardened to guard all (a ~15-LOC `splitStatements` loop), fixing a latent footgun repo-wide.
- **`relatedContext` is ~30 LOC of reuse** — `backend.query({text})` already takes raw text; facts is genuinely greenfield (`user_profiles` is a display/fingerprint profile, not a KV store).
- **Audit reuses `audit_log`** (not a new `forget_audit` table — leaner): `db.audit.log({action:'forget', resourceType:type, resourceId:id, details:{content_hash,length,mode}})` — hash + length only, **never plaintext** (verified by `verify:forget` F9).

### Operator's directional calls (locked — spec §11)
1. **forget = soft-redact only** (no hard `purge`; tombstone husk persists for audit).
2. **facts = typed `category/key/value`**.
3. **Tier-2 gating = present-but-"not ready" message** (keep tools listed).
4. **New-tool shape = lean verbs** (`remember`/`forget`/`mark`/`link`); reads fold into `searchMindscape`+`getContext`.
5. **Slim the existing surface** — 11 readers → 3 (Phase 5).
6. **Build all phases**, Phase 1 first.
7. **Local SQLite only** — operator flagged twice that this is *not* Cloudflare D1; the `d1Query`/`src/adapter/d1.js` names are a legacy API-compat shim over better-sqlite3 (zero network).

### Pickup protocol for the next session
1. Read this handoff cold, then the spec §3.4 (entities), §3.8 (consolidation), §5 (phases). Read the **Phase 2 session summary** below first.
2. `git fetch origin main && git rebase origin/main` on `claude/zealous-euler-kSPpI`. **Always rebase before building** — main moved mid-session twice already (#44 `b622914`, then #43 `1a8f525`). #43 touched the search path (`d1-loader.js`/`mcp.js`/`package.json`); a future search PR may collide again — check those three files.
3. Verify current state: `npm run verify` → **34× GO, EXIT 0** (or at minimum `verify:facts`+`verify:related`+`verify:mcp` → "34 tools registered").
4. Build **Phase 3 (entities)** — additive, mirrors the Phase-2 fact pattern exactly:
   - `migrations/0006_entities.sql`: `entities` + `entity_links` per spec §3.4. ⚠️ Same as facts: make `name`/`summary` **nullable** (redact nulls them); add `forgotten_at`, `pinned`, `sensitive`. `ENCRYPTED_FIELDS.entities = ['name','aliases','summary']`, `entity_links` has no encrypted cols. `UNIQUE(user_id, type, name)`.
   - `src/db/entities.js` (`createEntitiesNamespace`): `upsert`/`list`/`redact`/`setSalience` (copy `db/facts.js`) + `link(entityId, refType, refId)` / `linksFor(entityId)`. **Reuse the verified upsert shape** (`ON CONFLICT … DO UPDATE SET x = excluded.x`, never a fresh `?`).
   - `remember`: add the `'entity'` branch (extend the `kind` enum to `['fact','entity']`, drop the fail-closed throw for entity) in `src/tools/curate.js`. Add the **`link`** verb (the 4th lean verb) to the curate domain.
   - `forget`/`mark`: extend the `REF` enum to include `'entity'` + add the dispatch branch (one line each — the pattern is in place).
   - `searchMindscape`: add `scope:'entities'` (the "dossier" = entity + its `entity_links`, via `db.entities`). `getContext` gains a compact **PEOPLE/PROJECTS** section (pinned only) — mirror the FACTS block in `src/tools/context.js`.
   - **Decide the open sub-decision first** (below): promote NLP-extracted `messages.entities` + curate, vs user-curated only.
   - Add `verify:entities` (model on `scripts/verify-facts.mjs`) + chain entry; bump `verify:forget`/`verify:facts` tool-count asserts (34 → 35+ once `link`/entity tools land — check `verify:mcp` for the exact number).
5. Run `/sweep-first-design` lightly on the enrichment-promote seam if you take the "promote NLP" path (it reads `messages.entities`, which the pipeline writes).
6. Before "done": full `npm run verify` GO; update `MCP-OVERVIEW.md` count + this handoff + spec status. Then Phase 4 (gating), then Phase 5 (consolidation — **behind `/pre-deletion-caller-audit`**).

### Open decisions for the operator
- **Entities (Phase 3) — DECIDE BEFORE BUILDING:** promote NLP-extracted (`messages.entities`, written by enrichment) into the registry **+ curate** *(working default, spec §11.3)* vs **user-curated only** (simpler; no dependency on the Tier-2 enrichment pipeline). Recommendation: **user-curated only for the first Phase-3 cut** (entities via `remember`/`link`), add NLP-promotion as a follow-up — it keeps Phase 3 free of the unbuilt-pipeline dependency and shippable in this env.
- **Pinned search-ranking boost — RESOLVED (deferred, evidence-based):** *not* folded into Phase 2. `pinned` isn't carried in the in-RAM index, so a ranking boost needs threading loader→`backend.add`→scorer (well beyond ~30 LOC, own gate); `getContext` already surfaces pinned (📌). Revisit only if explicit-search relevance proves insufficient.
- **The `d1` legacy naming:** leave the shim as-is (it works; renaming is a repo-wide refactor) — new code uses plain `db`/"local vault". Recommendation: leave.

---

## 2026-06-02 PM session summary — Phase 2 (facts + relatedContext)

### What shipped
| Commit | Scope | Description |
|---|---|---|
| _(rebase)_ | sync | Rebased onto `origin/main` #43 (`1a8f525`, "rehydrate stored `embedding_768`"). Resolved the 3-file collision (`d1-loader.js:47`, `mcp.js`, `package.json`) so the loader carries both #43's `embedding_768` SELECT and Phase-1's `AND forgotten_at IS NULL`. `verify:search-rehydrate` GO post-rebase. |
| `2789f72` | Phase 2 Stage A (db) | `migrations/0005_facts.sql` (facts table + 2 partial live-row indexes); `ENCRYPTED_FIELDS.facts = ['value']`; `src/db/facts.js` (`upsert`/`forContext`/`list`/`redact`/`setSalience`); wired `db.facts`. |
| `e8d1d83` | Phase 2 Stage B (tools+search+gates) | `remember` verb + `forget`/`mark` extended to `type:'fact'` (`src/tools/curate.js`, 33→34); `getContext` FACTS section + `'facts'` include (`context.js`); `searchMindscape` `relatedTo` + `scope:'facts'` (`mindscape.js`) + `db` threaded (`mcp.js`); `bulkSearch` `excludeSensitive` + `hydrateMessages` forgotten/sensitive filter (`search/index.js`); `verify:facts` (17) + `verify:related` (7) + chain; `verify:forget` count 33→34. |

### What was learned (most valuable — these die if not written)
- **The upsert encryption footgun (verified, build-critical).** `autoEncryptParams` (`crypto-local.js:1342`) only encrypts params in the **first VALUES group** and **never inspects the `ON CONFLICT` clause** (`parseWriteSQL` INSERT branch reads the column list, not the upsert tail). So `ON CONFLICT … DO UPDATE SET value = ?` would write `facts.value` **PLAINTEXT** *and* break the `paramsPerRow` row-count math. The safe shape (used everywhere) is `DO UPDATE SET value = excluded.value` — reuses the already-encrypted inserted value, adds no param. **Phase 3 entities must follow the same rule.**
- **`value TEXT NOT NULL` (draft spec) is incompatible with soft-redact.** redact nulls `value`; a `NOT NULL` constraint makes that impossible. Facts (and Phase-3 entities) use **nullable** sensitive columns; the `remember` tool validates non-empty for live rows, so only forgotten husks hold NULL.
- **`getContext` is the always-on proactive preamble → sensitive facts are excluded from it** (`forContext` filters `sensitive = 0`); they surface only via the explicit `searchMindscape({scope:'facts'})` listing. This sharpens spec §3.6 ("sensitive excluded from relatedTo/publish/egress") to also cover getContext-facts, the privacy-first default for a cognitive vault.
- **`hydrateMessages` was a second, unfiltered read path.** Phase 1 evicts forgotten rows from the index, but `bulkSearch`→`hydrateMessages` re-reads them from the db by id with **no `forgotten_at` filter**. Hardened to filter `forgotten_at IS NULL` **unconditionally** (defense-in-depth) + `sensitive = 0` in proactive mode. This closes a latent Phase-1 gap.
- **`relatedTo` is genuinely ~thin reuse** — it's `bulkSearch` with the turn text as the query + `excludeSensitive`. The only real work was the sensitive-exclusion seam (hydration filter) and relaxing `required:['query']`.
- **The pinned search-ranking boost was deferred on evidence** (not the paper recommendation to fold it in): `pinned` isn't in the in-RAM index, so it needs loader→`backend.add`→scorer threading + its own gate. getContext already honors pinned. Documented as RESOLVED-deferred.

### Operator's directional calls (this session)
- None new — Phase 2 executed the locked §11 decisions. The one open call surfaced for **Phase 3**: entities **user-curated-only first** vs **NLP-promote + curate** (see Open decisions; recommendation = user-curated-only first cut).

### Pickup protocol → see the updated "Pickup protocol for the next session" above (now Phase 3).

---

## Phase 2 — file-by-file

| File | Change |
|---|---|
| `migrations/0005_facts.sql` (new) | `facts` table (value NULLABLE; pinned/sensitive/forgotten_at/superseded_by) + 2 partial indexes on live rows. |
| `src/crypto/crypto-local.js` | `ENCRYPTED_FIELDS.facts = ['value']`. |
| `src/db/facts.js` (new) | `upsert` (ON CONFLICT excluded.* — encryption-safe), `forContext` (sensitive-excluded), `list` (sensitive-included), `redact` (literal-NULL + tombstone, hash-only), `setSalience` (RETURNING). |
| `src/db/index.js` | wire `db.facts`. |
| `src/tools/curate.js` | +`remember` verb (kind:'fact'; salience as follow-up setSalience); `forget`+`mark` REF enum + dispatch gain `'fact'`. |
| `src/tools/context.js` | getContext FACTS section (pinned-first, sensitive-excluded) + `'facts'` in include enum. |
| `src/tools/mindscape.js` | `relatedTo` proactive mode + `scope:'facts'` listing + `db`/`userId` deps; `query` no longer strictly required. |
| `src/search/index.js` | `bulkSearch` `excludeSensitive`; `hydrateMessages` always-`forgotten_at IS NULL` + conditional `sensitive=0`. |
| `src/mcp.js` | thread `db` into `createMindscapeDomain`. |
| `scripts/verify-facts.mjs` (new) | 17 assertions: encrypted-at-rest, surfaced, superseded, sensitive-gated, forgotten/audit-hash-only, fail-closed. |
| `scripts/verify-related.mjs` (new) | 7 assertions: proactive recall, sensitive-excluded, explicit-includes-sensitive, forgotten-guarded, BM25-only. |
| `package.json` | +`verify:facts` +`verify:related` (entries + chain). |

---

## Phase 1 — file-by-file

| File | Change |
|---|---|
| `src/db/migrate.js` | `applyMigrations` guards every ADD COLUMN (`splitStatements` helper); whole-file exec preserved for non-ADD files (0001). |
| `migrations/0004_context_bank.sql` | +`messages.{pinned,sensitive,forgotten_at}` +`documents.{sensitive,forgotten_at}`. |
| `src/db/messages.js` | +`redact` (literal-NULL UPDATE + `clustering_points` delete via `d1Batch`; returns content hash, idempotent) +`setSalience`; `forgotten_at IS NULL` on selectRecent/Paginated/Timeline/ByAgent/All/streamForRehydrate/pending*/matchMessages/matchDocuments; `pinned` added to `selectRecent` cols. |
| `src/db/documents.js` | +`redact` (+embedding null, fires afterDeleteHooks) +`setSalience` (is_pinned + sensitive); `forgotten_at IS NULL` on get/list/getBySlug. |
| `src/search/d1-loader.js` | messages `SOURCES` query +`AND forgotten_at IS NULL` (the resurrection guard). |
| `src/tools/curate.js` (new) | `forget` + `mark`; forget evicts the index (`searchHelpers.backend.delete`) + audits via `db.audit.log` (hash-only). |
| `src/mcp.js` | import + `createCurateDomain({db,userId,searchHelpers})` in `buildDomains`; `buildDomains` now returns `searchHelpers`. |
| `src/index.js` | `boot()` returns `searchHelpers` (for the gate + reuse). |
| `src/tools/context.js` | 📌 prefix on pinned recent messages. |
| `scripts/verify-forget.mjs` (new) | 13-assertion gate; added to `package.json` `verify` chain after `verify:mcp`. |

---

## Verification state (V1 is local self-host; the gate is the verify chain)

```bash
npm run verify:forget      # → VERDICT: GO EXIT=0   (13/13: redact, evict, tombstone, audit-no-plaintext, idempotent, mark)
npm run verify:facts       # → VERDICT: GO EXIT=0   (17/17: encrypted-at-rest, surfaced, superseded, sensitive-gated, forgotten, fail-closed)
npm run verify:related     # → VERDICT: GO EXIT=0   (7/7: proactive recall, sensitive-excluded, forgotten-guarded, BM25-only)
npm run verify:mcp         # → "34 tools registered, 2 deferred"  + GO
npm run verify             # → 34× GO, EXIT 0   (run before declaring any phase done)
```
No fleet/deploy — "shipping" = the verify gate is green + committed + pushed (see the rewritten `/deploy-and-verify`). PR #42 carries the spec + Phases 1–2; CI runs the same chain.

---

## Gotchas + lessons (2026-06-02)

- **Local SQLite only — no Cloudflare D1 (2026-06-02).** `d1Query`/`src/adapter/d1.js`/`d1Batch` are a **legacy API-compat shim** over better-sqlite3 with zero network. The vault is one `mycelium.db` on the home server. Never build toward D1/`wrangler`.
- **The search loader has no content filter (`d1-loader.js:47`, 2026-06-02).** Forget's resurrection guard is the `forgotten_at` flag on the loader query — nulling content alone is insufficient (a rebuilt index would still add the row).
- **Migration runner is now multi-ADD-COLUMN-safe (2026-06-02).** `applyMigrations` guards *every* ADD COLUMN. Still: prefer `CREATE TABLE IF NOT EXISTS`; the splitter is line-based (no procedural bodies / inner `;` in migration files).
- **`redact` UPDATEs use literal `NULL`** (not bound params) so the auto-encrypt layer is a no-op on the nulled columns; only `forgotten_at` is a param.
- **`boot()` now returns `searchHelpers`** — additive to the return object; existing destructures unaffected.
- **main moved mid-session** (`f614d4a` → `b622914`/#44 → `1a8f525`/#43). The branch was rebased each time; rebase again next session before building.
- **⚠️ Upsert encryption footgun (`2026-06-02 PM`).** `autoEncryptParams` encrypts only the first `VALUES` group and never the `ON CONFLICT … DO UPDATE` clause. Any encrypted-column upsert MUST use `DO UPDATE SET col = excluded.col` (never a fresh `?`) or it writes **plaintext** + breaks the row-count math. Applies to facts now and **entities in Phase 3**.
- **Sensitive columns must be NULLABLE (`2026-06-02 PM`).** Soft-redact nulls them; a `NOT NULL` constraint blocks redact. `facts.value` (and Phase-3 `entities.name`/`summary`) are nullable; the write verb validates non-empty for live rows.
- **`sensitive` ⇒ excluded from ALL proactive surfaces (`2026-06-02 PM`).** getContext FACTS (`forContext` filters `sensitive=0`) AND `relatedTo` (hydration filters). Sensitive items surface only via explicit `scope:'facts'` / explicit `query`. Defense-in-depth: `hydrateMessages` filters `forgotten_at IS NULL` unconditionally now.

---

## Glossary
- **`ref`** — the lean addressing handle `{ type: 'message'|'document'|'fact'|'entity', id }`. `forget`/`mark`/`link` take a flat `type`+`id`.
- **redact** — soft-forget: null the encrypted payload + both embedding fingerprints, delete the clustering point, evict the index, stamp `forgotten_at`. No hard delete.
- **tombstone / husk** — the row that persists after redact: id + timestamps + non-sensitive enums + `forgotten_at`. Carries no plaintext, no fingerprint.
- **the `d1` shim** — `src/adapter/d1.js`: a local better-sqlite3 wrapper that mimics the Cloudflare D1 API shape (transparent AES-256-GCM at the query boundary). Not Cloudflare.

---

## Skills that fired this session
`/sweep-first-design` (×3 — the spec, the Phase-1 pre-build sweep, and the Phase-2 seam sweep that caught the upsert-encryption + NOT-NULL + second-read-path footguns *before* coding) · `/deploy-and-verify` (the V1 verify-gate ship discipline, each phase) · `/handoff-discipline` (this doc). Phase 5 will require `/pre-deletion-caller-audit` (it removes 11 tools).
