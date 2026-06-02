# Context Bank Upgrade — Handoff Doc

**Date:** 2026-06-02
**Companions:** [`CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md`](CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md) (the spec — read §3, §5.1, §11) · [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md) (live tool surface, now 27) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
**Audience:** the next Claude Code instance picking up this work.

A 5-phase upgrade to the V1 MCP "context bank": add forget/correct, facts, proactive recall, entities, honest cold-start, user salience — **while shrinking the tool surface** (31 → **27**). **✅ ALL 5 PHASES BUILT + VERIFIED.** The remaining work is follow-ups (NLP-promote auto-trigger) + flipping PR #42 out of draft for a human security review. Everything is **local SQLite on the home server — no Cloudflare D1.**

---

## TL;DR — current state

| Phase | Commit(s) | Status | What |
|---|---|---|---|
| 0 — schema | `a200ed0` | ✅ built+verified | migration runner hardened (guards *every* ADD COLUMN) + `0004` (messages.{pinned,sensitive,forgotten_at}, documents.{sensitive,forgotten_at}) |
| 1 — forget + salience | `9cde646` (db) · `22c1a75` (tools+gate) · `7832951` (docs) | ✅ built+verified | `forget(type,id)` soft-redact + `mark(type,id,{pinned,sensitive})`; 31 → **33 tools**; `verify:forget` 13/13 |
| 2 — facts + relatedContext | `2789f72` (db) · `e8d1d83` (tools+gates) | ✅ built+verified | `remember` (typed facts) + `getContext` FACTS section + `relatedTo` + `scope:'facts'` on `searchMindscape`; forget/mark gain `type:'fact'`; 33 → **34 tools**; `verify:facts` 17/17 + `verify:related` 7/7 |
| 3 — entities | `4aa5f4c` (db) · `13c96ce` (tools+gate) | ✅ built+verified | `entities`+`entity_links` + NLP-promote; `remember`(kind:'entity') + **`link`** verb; forget/mark gain `type:'entity'`; `getContext` PEOPLE + `searchMindscape` `scope:'entities'`; 34 → **35 tools**; `verify:entities` 19/19 |
| 4 — cold-start gating | `1022a92` | ✅ built+verified | 11 Tier-2 readers return a uniform "not ready" message until clustering runs (mid-session flip); Tier-1 untouched; **no new tools (35)**; `verify:gating` 8/8 |
| 5 — consolidate readers | `f0c673a` (tools) · `73e448a` (gates) | ✅ built+verified | 11 cognitive/topology readers → 3 (`cognitiveState`/`cognitiveHistory`/`mindscape`); 35 → **27 tools**; behind a full `/pre-deletion-caller-audit`; `verify:cognition` 7/7 + `verify:mindscape` 8/8 |

- **Branch:** `claude/zealous-euler-kSPpI` · **PR:** #42 (draft) · **HEAD:** `73e448a` (+docs commit)
- **Gate:** full `npm run verify` → **37× GO, EXIT 0** (incl. `verify:forget`/`facts`/`related`/`entities`/`gating`/`cognition`/`mindscape`). Clean tree.
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

### Pickup protocol for the next session — UPGRADE IS COMPLETE; only follow-ups remain
1. Read this handoff cold (the **Phase 5 session summary** below is newest). The 5-phase upgrade is built + verified; there is **no Phase 6**.
2. `git fetch origin main && git rebase origin/main` on `claude/zealous-euler-kSPpI` before any new work. Main moved twice mid-session (#44 `b622914`, #43 `1a8f525`); #43 touched the search path — a future search PR may collide on `d1-loader.js`/`mcp.js`/`package.json`.
3. Verify current state: `npm run verify` → **37× GO, EXIT 0** (`verify:mcp` → "27 tools registered").
4. **Follow-ups (optional, not blocking):**
   - **Flip PR #42 out of draft** for a human security review (the diff touches the crypto boundary, forget/audit, encrypted-entity dedup) — do NOT auto-merge; security-sensitive diffs need a human approval (CLAUDE.md, `/auto-merge-on-green`).
   - **NLP-entity promotion auto-trigger:** `db.entities.promoteFromMessages` is built + verified but nothing calls it yet. Add an enrichment-service hook (call it after a drain batch) once the pipeline runs on a real host (it's Tier-2). Not blocking — user curation (`remember`/`link`) works today.
   - **Real-vault smoke (Tier-2):** the consolidated `cognitiveState`/`cognitiveHistory`/`mindscape` were verified on seeded + empty vaults here; smoke them against a clustered vault on a capable host (`:8091` + Python pipeline) to confirm the real-data rendering.
5. If you DO change the tool surface again: `TIER2_TOOLS` (`src/mcp.js`) now lists the **3 consolidated** names; the count floor lives in `verify:portal` P3 (`>= 25`) and exact-count asserts in `verify:forget`/`facts`/`entities` (`=== 27`) + `verify:mcp` (dynamic). Update all of them.

### Open decisions for the operator
- **None blocking.** The upgrade's 7 locked decisions (§11) are all built. Remaining items are the follow-ups in the pickup protocol (PR review, NLP-promote trigger, real-vault smoke).
- **Pinned search-ranking boost — RESOLVED (deferred, evidence-based):** *not* folded in. `pinned` isn't carried in the in-RAM index, so a ranking boost needs threading loader→`backend.add`→scorer (well beyond ~30 LOC, own gate); `getContext` already surfaces pinned (📌). Revisit only if explicit-search relevance proves insufficient.
- **NLP-promote trigger — follow-up:** `db.entities.promoteFromMessages` exists + is verified, but **nothing calls it automatically yet**. Options: a `promoteEntities` tool, an enrichment hook (call it after a drain batch), or a portal/cron action. Recommendation: an enrichment-service hook once the pipeline runs on a real host (it's Tier-2). Not blocking — user curation (`remember`/`link`) works today.
- **The `d1` legacy naming:** leave the shim as-is (it works; renaming is a repo-wide refactor) — new code uses plain `db`/"local vault". Recommendation: leave.

---

## 2026-06-02 PM session summary — Phase 5 (consolidation) — START HERE · UPGRADE COMPLETE

### What shipped
| Commit | Scope | Description |
|---|---|---|
| `f0c673a` | Phase 5 (consolidation) | `src/tools/cognition.js` (new) — cognitiveState / cognitiveHistory / mindscape, reusing the fisher-tools/metrics/topology-tools handler logic verbatim. `src/mcp.js`: register the cognition domain in place of the 3 old domains; `TIER2_TOOLS` → the 3 new names. The 3 folded factories marked INTERNAL. 35 → **27 tools**. |
| `73e448a` | Phase 5 (gates + caller migrations) | `verify:cognition` (7) + `verify:mindscape` (8) parity gates; removed `verify:metrics` + `verify:topology`; `verify:gating` retargeted to the renamed tools; `verify:forget`/`facts`/`entities` counts 35→27; `verify:portal` P3 floor 30→25; `verify:facts` FA17 fixed (entity is a valid kind now). |

### What was learned (most valuable — these die if not written)
- **Reuse beats rewrite for capability parity.** The 3 consolidated tools instantiate the existing `createFisherToolsDomain`/`createMetricsDomain`/`createTopologyToolsDomain` factories and call their `.handlers` verbatim — so the consolidation is parity-by-construction (same db methods, same formatters, same output). Zero handler logic was rewritten. The old factory files stay as internal implementations; only their `.tools` arrays go unregistered.
- **The caller audit's "grep one more time" caught a real miss.** My inventory found the obvious callers (verify:metrics/topology, TIER2_TOOLS, REST, portal). The full-chain run then surfaced a caller I missed: **`verify:portal` P3 asserted `tools.length >= 30`** — the consolidation dropped the surface to 27, failing it. Tool-count *threshold* assertions don't match a tool-name grep. Fixed the floor to `>= 25`. (Exactly the skill's canonical lesson — the third caller is in a sibling file with a different signature.)
- **REST is generic — renames are free there.** `src/api.js` routes `POST /api/v1/:toolName → handlers[toolName]` (no hardcoded per-tool routes), so the REST surface auto-follows the handler map. `portal-app` calls none of the 11 (it uses `/api/v1/portal/*`). The blast radius was just the verify gates + TIER2_TOOLS + docs.
- **`verify:metrics`/`verify:topology` coverage was preserved, not dropped.** Their tool-level assertions moved into the two parity gates; the metric-domain CONTRACTS refusal copy is still asserted (now reached via `cognitiveState`/`cognitiveHistory` on a seeded-ready vault). verify:topology's python-deps SKIP was pipeline-probe coverage already duplicated by verify:embed/enrich.

### Caller-audit ledger (Step 5 pre-flight — falsifiable V1 criteria, all PASS)
- `grep` for the 11 old names in `src/mcp.js` → **0** (registration + TIER2_TOOLS clean).
- `grep "name: '<old>'"` outside the 3 internal factories → **0** (no old tool is registered).
- `verify:mcp` → **27 tools**, the 11 old names absent, the 3 new present.
- `verify:cognition` (7/7) + `verify:mindscape` (8/8) → each old capability is covered by a new tool.
- Full `npm run verify` → **37× GO, EXIT 0**.

### Operator's directional calls (this session)
- **Build Phase 5 (finish it)** (chose via AskUserQuestion). The whole 5-phase upgrade is now shipped.

### Pickup protocol → see "Pickup protocol for the next session" above (the upgrade is COMPLETE; only follow-ups: PR review, NLP-promote trigger, real-vault smoke).

---

## Phase 5 — file-by-file

| File | Change |
|---|---|
| `src/tools/cognition.js` (new) | The 3 consolidated tools; reuses the 3 folded factories' `.handlers` verbatim (parity by construction). |
| `src/mcp.js` | Register `createCognitionDomain` in place of fisher-tools/metrics/topology-tools; `TIER2_TOOLS` → `cognitiveState`/`cognitiveHistory`/`mindscape`. |
| `src/tools/fisher-tools.js` · `metrics.js` · `topology-tools.js` | Header note: now INTERNAL (handlers reused; `.tools` arrays unregistered). |
| `scripts/verify-cognition.mjs` · `verify-mindscape.mjs` (new) | Parity gates (capability preserved). |
| `scripts/verify-metrics.mjs` · `verify-topology.mjs` (deleted) | Their tools no longer exist; coverage moved to the parity gates. |
| `scripts/verify-gating.mjs` · `verify-forget/facts/entities.mjs` · `verify-portal.mjs` | Caller migrations: renamed tools, counts 35→27, portal floor 30→25. |
| `package.json` | −verify:metrics −verify:topology +verify:cognition +verify:mindscape. |

---

## 2026-06-02 PM session summary — Phase 4 (cold-start gating)

### What shipped
| Commit | Scope | Description |
|---|---|---|
| `1022a92` | Phase 4 (gating) | `src/mcp.js`: `TIER2_TOOLS` (the 11 readers), `TOPOLOGY_NOT_READY_MESSAGE`, `makeTopologyReadiness({db,userId})`, `collectTools(domains, gate)` wrap. `src/index.js`: `boot()` threads the gate + returns `isTopologyReady`. `scripts/verify-gating.mjs` (8 assertions). `scripts/verify-metrics.mjs`: seed a clustered point (caller-audit fix). |

### What was learned (most valuable — these die if not written)
- **Readiness must be a getter, not a boot-time boolean.** `buildDomains` runs once at boot, but a user imports + clusters mid-session. A static flag would be stale forever. The fix: `makeTopologyReadiness` returns an async `isReady()` that **caches `true` once seen but re-queries while `false`** — so it flips the moment clustering lands (verified by `verify:gating` G7, same booted server, no restart) with zero queries once ready. No TTL needed (clustering doesn't un-compute).
- **`collectTools(domains, gate)` is the right chokepoint.** Gating one place (wrap the handler iff `name ∈ TIER2_TOOLS`) beats touching 3 domain factories. The wrap short-circuits BEFORE the inner handler, so gated tools need no args when not-ready.
- **Caller-audit catch (the `/pre-deletion-caller-audit` instinct paid off again).** Before gating, I swept *who calls the 11 tools*: only `verify:metrics` + `verify:topology`. `verify:metrics` M4/M5 assert the metric-domain refusal copy on an empty vault — gating would have replaced it with the not-ready message and broken them. Fix: `verify:metrics` seeds one `clustering_points` row (readiness=true), so M4/M5 now test the refusal copy on the correct "ready vault, empty metric window" path. `verify:topology` T3 only checks non-crash text → the not-ready message satisfies it, no change. **Changing shared behavior (here, ~10 tools' empty-state output) demands a caller sweep first.**
- **⚠️ Phase-4 → Phase-5 coupling.** `TIER2_TOOLS` lists the 11 OLD tool names. Phase 5 renames them to 3 — it MUST update `TIER2_TOOLS` to the 3 new names (and gate the new tools) or gating silently stops applying. Flagged in the Phase 5 pickup.

### Operator's directional calls (this session)
- **Build Phase 4 only** (chose "Build Phase 4 (gating)" via AskUserQuestion — not Phase 4+5). Phase 5 (the breaking consolidation) is the explicit checkpoint.

### Pickup protocol → see "Pickup protocol for the next session" above (now Phase 5 — consolidate 11 readers → 3, behind `/pre-deletion-caller-audit`).

---

## Phase 4 — file-by-file

| File | Change |
|---|---|
| `src/mcp.js` | `TIER2_TOOLS` set (11 readers) + `TOPOLOGY_NOT_READY_MESSAGE` + `makeTopologyReadiness` (probe: `getNoiseStats().total > 0`, cache-once-ready, fail-closed) + `collectTools(domains, gate)` wraps only gated tools; `buildDomains` returns `isTopologyReady`. |
| `src/index.js` | `boot()` threads the gate into `collectTools`; returns `isTopologyReady`. |
| `scripts/verify-gating.mjs` (new) | 8 assertions: all 11 gated on fresh vault, message actionable, Tier-1 untouched (getContext/searchMindscape/remember), mid-session flip on clustering, sticky readiness. |
| `scripts/verify-metrics.mjs` | seed one `clustering_points` row so readiness=true (caller-audit fix: M4/M5 keep testing the refusal copy on the ready-vault path). |
| `package.json` | +`verify:gating` (entry + chain). Tool count unchanged (35). |

---

## 2026-06-02 PM session summary — Phase 3 (entities)

### What shipped
| Commit | Scope | Description |
|---|---|---|
| `4aa5f4c` | Phase 3 Stage A (db) | `migrations/0006_entities.sql` (`entities` + `entity_links`); `ENCRYPTED_FIELDS.entities = ['name','aliases','summary']`; `src/db/entities.js` (`upsert`/`forContext`/`list`/`link`/`linksFor`/`redact`/`setSalience`/`promoteFromMessages`); wired `db.entities`. |
| `13c96ce` | Phase 3 Stage B (tools+gate) | `remember` kind:'entity' + the `link` verb (`tools/curate.js`, 34→35); forget/mark gain `type:'entity'`; `getContext` PEOPLE section (`context.js`); `searchMindscape` `scope:'entities'` + dossier (`mindscape.js`); `verify:entities` (19) + chain; forget/facts count asserts 34→35. |

### What was learned (most valuable — these die if not written)
- **You cannot `UNIQUE`/`ON CONFLICT` on an encrypted column.** `entities.name` is encrypted with a random IV → the same name encrypts to different ciphertext each write → a `UNIQUE(user_id,type,name)` (spec §3.4) can never match, and `ON CONFLICT(name)` would never fire. **Dedup is app-layer:** scan this user's entities of the type, match the *decrypted* name case-insensitively, upsert by id. (Facts avoided this by keeping category/key plaintext; entity names can't be plaintext — they're the sensitive part.) Single-user scale makes the scan free.
- **A dedup match must preserve the canonical display-name casing.** `verify:entities` EN6 caught this: re-remembering "alice rivera" (lowercase) was overwriting the curated "Alice Rivera". Fix: the upsert UPDATE **omits `name`** — the match is by *normalized* name, so the first-set casing persists; a casual case variant or an NLP-promoted proper noun must not downcase a curated name. (A real bug the gate caught before it shipped.)
- **NLP-promotion is verifiable without the live pipeline.** `promoteFromMessages` reads the `messages.entities` column (enrichment writes `JSON.stringify({category:[values]})` — verified `enrich/extract.js:73-92`; the registry-relevant categories are `proper` → type 'proper' and `mention` → type 'person'). `verify:entities` seeds that column directly and asserts threshold-gating + no-clobber. No embedder/numpy needed.
- **Promote merges, never downgrades.** An NLP hit on an existing user/assistant entity keeps `source` (no downgrade to 'nlp'), keeps the richer summary, and bumps `mention_count` (EN17).
- **`link` find-or-creates** the entity by name+type (ergonomic — the model needn't juggle entity ids), then `INSERT OR IGNORE` the link (idempotent; `entity_links` is all-plaintext so UNIQUE works there). It does NOT validate the target item exists (records the ref; dossier rendering filters forgotten).

### Operator's directional calls (this session)
- **Entities = NLP-promote + curate** (confirmed via AskUserQuestion; locks spec §11.3). I flagged the verifiability concern (live pipeline absent) and resolved it by seeding `messages.entities` in the gate.

### Pickup protocol → see "Pickup protocol for the next session" above (now Phase 4 — cold-start gating).

---

## Phase 3 — file-by-file

| File | Change |
|---|---|
| `migrations/0006_entities.sql` (new) | `entities` (name/aliases/summary NULLABLE + encrypted; type/source/counts plaintext; **no UNIQUE on name**) + `entity_links` (all-plaintext, `UNIQUE(user_id,entity_id,ref_type,ref_id)`) + indexes. |
| `src/crypto/crypto-local.js` | `ENCRYPTED_FIELDS.entities = ['name','aliases','summary']`. |
| `src/db/entities.js` (new) | App-layer-dedup `upsert` (preserves display-name casing; no user→nlp downgrade), `forContext` (pinned-only + sensitive-excluded), `list`, `link`/`linksFor`, `redact` (literal-NULL + drop links + hash), `setSalience`, `promoteFromMessages` (proper/@mention aggregation, threshold-gated). |
| `src/db/index.js` | wire `db.entities`. |
| `src/tools/curate.js` | `remember` kind:'entity'; the **`link`** verb (find-or-create + link); forget/mark REF enum + dispatch gain `'entity'`. |
| `src/tools/context.js` | getContext PEOPLE & PROJECTS section (pinned-only) + `'people'` in include enum. |
| `src/tools/mindscape.js` | `scope:'entities'` listing + dossier (links shown for ≤3 matches). |
| `scripts/verify-entities.mjs` (new) | 19 assertions. `verify:forget`/`verify:facts` count asserts 34→35. |
| `package.json` | +`verify:entities` (entry + chain). |

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
npm run verify:entities    # → VERDICT: GO EXIT=0   (19/19: encrypted-at-rest, app-dedup, pinned-gated, link/dossier, forgotten, NLP-promote no-clobber)
npm run verify:gating      # → VERDICT: GO EXIT=0   (8/8: Tier-2 gated on fresh vault, Tier-1 untouched, mid-session flip)
npm run verify:leak        # → VERDICT: GO EXIT=0   (encryption-at-rest: raw-byte scan, every encrypted col, INSERT + multi-line UPDATE)
npm run verify:cognition   # → VERDICT: GO EXIT=0   (7/7: 6 Fisher/metric readers folded into cognitiveState + cognitiveHistory)
npm run verify:mindscape   # → VERDICT: GO EXIT=0   (8/8: 5 topology readers folded into mindscape({view}))
npm run verify:mcp         # → "27 tools registered, 2 deferred"  + GO
npm run verify             # → 37× GO, EXIT 0   (the gate before declaring done)
```
No fleet/deploy — "shipping" = the verify gate is green + committed + pushed (see the rewritten `/deploy-and-verify`). PR #42 carries the spec + Phases 1–3; CI runs the same chain.

---

## Gotchas + lessons (2026-06-02)

- **🔴 CRITICAL (pre-merge review, fixed `c93ecd0`): a multi-line UPDATE `SET` clause silently wrote PLAINTEXT at rest.** `parseWriteSQL`'s UPDATE matcher (`crypto-local.js`) lacked `/s` (dotall), so `.+?` stopped at the first newline → a multi-line `SET` never reached `WHERE` → `setMatch` null → `parseWriteSQL` null → `autoEncryptParams` no-op'd the WHOLE statement → encrypted-column params bound as plaintext. Hit `entities.upsert` (multi-line dedup UPDATE — `summary`/`aliases`, fires on 2nd mention / every `link()` / NLP-promote) AND the dormant `people.upsert` (multi-line COALESCE UPDATE — email/phone/company PII). **Fix:** `/s` + paren-aware `splitValueExprs` (so `strftime(',')` / `COALESCE(NULLIF(?,''),col)` aren't split mid-function). **Two lessons:** (1) NEVER rely on SQL formatting for a crypto property — the parser must be formatting-independent; (2) a STATIC read of `parseWriteSQL` declared the path sound — only a **runtime raw-DB-bytes plaintext scan** (`verify:leak`, now a permanent gate) caught it. Test it, don't reason about it.
- **`verify:leak` is the encryption-at-rest regression gate.** Plants tokens in every encrypted column across facts/entities/messages/people (INSERT + multi-line UPDATE) and scans raw db/WAL/shm bytes for any plaintext. Run it after ANY change to `crypto-local.js`, the adapter, or a `db/*.js` write path.

- **Local SQLite only — no Cloudflare D1 (2026-06-02).** `d1Query`/`src/adapter/d1.js`/`d1Batch` are a **legacy API-compat shim** over better-sqlite3 with zero network. The vault is one `mycelium.db` on the home server. Never build toward D1/`wrangler`.
- **The search loader has no content filter (`d1-loader.js:47`, 2026-06-02).** Forget's resurrection guard is the `forgotten_at` flag on the loader query — nulling content alone is insufficient (a rebuilt index would still add the row).
- **Migration runner is now multi-ADD-COLUMN-safe (2026-06-02).** `applyMigrations` guards *every* ADD COLUMN. Still: prefer `CREATE TABLE IF NOT EXISTS`; the splitter is line-based (no procedural bodies / inner `;` in migration files).
- **`redact` UPDATEs use literal `NULL`** (not bound params) so the auto-encrypt layer is a no-op on the nulled columns; only `forgotten_at` is a param.
- **`boot()` now returns `searchHelpers`** — additive to the return object; existing destructures unaffected.
- **main moved mid-session** (`f614d4a` → `b622914`/#44 → `1a8f525`/#43). The branch was rebased each time; rebase again next session before building.
- **⚠️ Upsert encryption footgun (`2026-06-02 PM`).** `autoEncryptParams` encrypts only the first `VALUES` group and never the `ON CONFLICT … DO UPDATE` clause. Any encrypted-column upsert MUST use `DO UPDATE SET col = excluded.col` (never a fresh `?`) or it writes **plaintext** + breaks the row-count math. Applies to facts now and **entities in Phase 3**.
- **Sensitive columns must be NULLABLE (`2026-06-02 PM`).** Soft-redact nulls them; a `NOT NULL` constraint blocks redact. `facts.value` + `entities.name`/`summary`/`aliases` are nullable; the write verb validates non-empty for live rows.
- **⚠️ No `UNIQUE`/`ON CONFLICT` on an encrypted column (`2026-06-02 PM`).** `entities.name` is encrypted with a random IV (non-deterministic) → a UNIQUE/`ON CONFLICT(name)` can never match. Dedup that key in the **app layer** (scan + match the decrypted value). Plaintext keys (facts' category/key, entity_links' ids) keep DB-level UNIQUE. Applies to any future encrypted-name table.
- **Dedup-match preserves the display-name casing (`2026-06-02 PM`).** `db.entities.upsert` matches by *normalized* name and does NOT overwrite the stored `name` — a case variant or NLP proper-noun must not downcase a curated name. (`verify:entities` EN6 caught the overwrite bug.)
- **NLP-entity promotion is built but not auto-triggered (`2026-06-02 PM`).** `db.entities.promoteFromMessages` works + is verified (seed `messages.entities`), but nothing calls it yet — needs an enrichment hook / tool / cron (see Open decisions). User curation via `remember`/`link` works today.
- **Cold-start readiness is a cache-once getter, not a boot flag (`2026-06-02 PM`).** `makeTopologyReadiness` re-queries `getNoiseStats().total` while not-ready and caches `true` once seen → flips mid-session on import+cluster, no restart. `TIER2_TOOLS` (`src/mcp.js`) is the gated set; gating is injected at the `collectTools(domains, gate)` chokepoint.
- **⚠️ Phase-4→5 coupling — RESOLVED (`2026-06-02 PM`).** `TIER2_TOOLS` now lists the 3 consolidated names (`cognitiveState`/`cognitiveHistory`/`mindscape`); gating applies to them. Any future surface change must keep `TIER2_TOOLS` in sync.
- **Consolidation = reuse, not rewrite (`2026-06-02 PM`).** `src/tools/cognition.js` instantiates the 3 folded factories and calls their `.handlers` verbatim — parity by construction. The factories (`fisher-tools.js`/`metrics.js`/`topology-tools.js`) are now internal; their `.tools` arrays are intentionally unregistered (grep for the old tool names finds them only there + in historical docs).
- **Tool-count assertions live in 4 places (`2026-06-02 PM`).** `verify:mcp` (dynamic), `verify:forget`/`facts`/`entities` (`=== 27`), and a FLOOR in `verify:portal` P3 (`>= 25`). The portal floor was the caller the inventory missed — the full-chain run caught it. Update all four on any surface change.
- **`sensitive` ⇒ excluded from ALL proactive surfaces (`2026-06-02 PM`).** getContext FACTS (`forContext` filters `sensitive=0`) AND `relatedTo` (hydration filters). Sensitive items surface only via explicit `scope:'facts'` / explicit `query`. Defense-in-depth: `hydrateMessages` filters `forgotten_at IS NULL` unconditionally now.

---

## Glossary
- **`ref`** — the lean addressing handle `{ type: 'message'|'document'|'fact'|'entity', id }`. `forget`/`mark`/`link` take a flat `type`+`id`.
- **redact** — soft-forget: null the encrypted payload + both embedding fingerprints, delete the clustering point, evict the index, stamp `forgotten_at`. No hard delete.
- **tombstone / husk** — the row that persists after redact: id + timestamps + non-sensitive enums + `forgotten_at`. Carries no plaintext, no fingerprint.
- **the `d1` shim** — `src/adapter/d1.js`: a local better-sqlite3 wrapper that mimics the Cloudflare D1 API shape (transparent AES-256-GCM at the query boundary). Not Cloudflare.

---

## Skills that fired this session
`/sweep-first-design` (×5 — the spec, then a pre-build seam sweep each phase: P1 [loader + migration footguns], P2 [upsert-encryption + NOT-NULL + second-read-path], P3 [encrypted-name UNIQUE impossibility + `messages.entities` shape], P4 [readiness seam] — each caught build-breakers *before* coding) · `/pre-deletion-caller-audit` (×2 — Phase 4's gating changed shared empty-state behavior [caught `verify:metrics` M4/M5]; **Phase 5's full audit before removing the 11 tools** [REST/portal cleared, `verify:portal` count-floor caught by the full chain]) · `/deploy-and-verify` (the V1 verify-gate ship discipline, each phase) · `/handoff-discipline` (this doc). All 5 phases shipped; the upgrade is complete.
