# Context Bank Upgrade — Handoff Doc

**Date:** 2026-06-02
**Companions:** [`CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md`](CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md) (the spec — read §3, §5.1, §11) · [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md) (live tool surface, now 33) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
**Audience:** the next Claude Code instance picking up this work.

A 5-phase upgrade to the V1 MCP "context bank": add forget/correct, facts, proactive recall, entities, honest cold-start, user salience — **while shrinking the tool surface** (31 → ~27 after Phase 5). **Phase 1 is built + verified; Phases 2–5 pending.** Everything is **local SQLite on the home server — no Cloudflare D1.**

---

## TL;DR — current state

| Phase | Commit(s) | Status | What |
|---|---|---|---|
| 0 — schema | `a200ed0` | ✅ built+verified | migration runner hardened (guards *every* ADD COLUMN) + `0004` (messages.{pinned,sensitive,forgotten_at}, documents.{sensitive,forgotten_at}) |
| 1 — forget + salience | `9cde646` (db) · `22c1a75` (tools+gate) · `7832951` (docs) | ✅ built+verified | `forget(type,id)` soft-redact + `mark(type,id,{pinned,sensitive})`; 31 → **33 tools**; `verify:forget` 13/13 |
| 2 — facts + relatedContext | — | ⬜ **NEXT** | `remember` (typed facts) + `getContext` FACTS section + `relatedTo` mode on `searchMindscape` |
| 3 — entities | — | ⬜ planned | `entities`+`entity_links`; write via `remember`/`link`; read via search |
| 4 — cold-start gating | — | ⬜ planned | async readiness probe → Tier-2 tools return "not ready" instead of empty |
| 5 — consolidate readers | — | ⬜ planned | 11 cognitive/topology readers → 3 (`cognitiveState`/`cognitiveHistory`/`mindscape`) — **behind `/pre-deletion-caller-audit`** |

- **Branch:** `claude/zealous-euler-kSPpI` · **PR:** #42 (draft) · **HEAD:** `7832951`
- **Gate:** full `npm run verify` → **GO, EXIT 0** (all ~31 suites incl. `verify:forget`). Clean tree.
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
1. Read this handoff cold, then the spec §3.3 (facts), §3.5 (relatedContext), §5 (phases).
2. `git fetch origin main && git rebase origin/main` on `claude/zealous-euler-kSPpI` — **main moved mid-session** (it was `f614d4a` → `b622914`/#44; rebase kept the branch clean). Always rebase before building; the `d1`/migrate files were untouched by #44 but check.
3. Verify current state: `npm run verify:forget` → `VERDICT: GO EXIT=0`; `npm run verify:mcp` → "33 tools registered".
4. Build **Phase 2 (facts + relatedContext)** — additive, mirrors the Phase-1 pattern:
   - `migrations/0005_facts.sql`: `CREATE TABLE IF NOT EXISTS facts (...)` per spec §3.3; add `facts: ['value']` to `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js:209`); wire a `db.facts` namespace in `src/db/index.js`.
   - `remember({kind:'fact', category, key, value, …})` — new tool (extend `src/tools/curate.js` or a new `facts` domain); upsert on `(category,key)`.
   - `getContext` FACTS section (the seam is `src/tools/context.js`; add `'facts'` to the `include` enum at ~line 45).
   - `relatedContext` → add a `relatedTo` mode to `searchMindscape` (`src/tools/mindscape.js` → `searchHelpers.bulkSearch`/`backend.query({text})`); **exclude `forgotten_at IS NULL` and `sensitive=1`** by default.
   - Add `verify:facts` + `verify:related` gates (model on `scripts/verify-forget.mjs`); add to the chain.
5. Run `/sweep-first-design` lightly on the `searchMindscape` extension seam (it's a shared abstraction); the rest of Phase 2 is additive.
6. Before "done": full `npm run verify` GO; update `MCP-OVERVIEW.md` count + this handoff + spec status. Then continue Phase 3.

### Open decisions for the operator
- **Entities (Phase 3): promote NLP-extracted (`messages.entities`) + curate** *(working default)* vs user-curated only. Decide at Phase 3.
- **Pinned search-ranking boost:** Phase 1 surfaces pinned in `getContext` (📌); the *search-result* ranking boost (multiplier after temporal in `backend/local.js:82`) was deferred — fold into Phase 2 when touching search, or leave. Recommendation: fold into Phase 2.
- **The `d1` legacy naming:** leave the shim as-is (it works; renaming is a repo-wide refactor) — new code uses plain `db`/"local vault". Recommendation: leave.

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
npm run verify:mcp         # → "33 tools registered, 2 deferred"  + GO
npm run verify             # → all ~31 suites GO, EXIT 0   (run before declaring any phase done)
```
No fleet/deploy — "shipping" = the verify gate is green + committed + pushed (see the rewritten `/deploy-and-verify`). PR #42 carries the spec + Phase 1; CI runs the same chain.

---

## Gotchas + lessons (2026-06-02)

- **Local SQLite only — no Cloudflare D1 (2026-06-02).** `d1Query`/`src/adapter/d1.js`/`d1Batch` are a **legacy API-compat shim** over better-sqlite3 with zero network. The vault is one `mycelium.db` on the home server. Never build toward D1/`wrangler`.
- **The search loader has no content filter (`d1-loader.js:47`, 2026-06-02).** Forget's resurrection guard is the `forgotten_at` flag on the loader query — nulling content alone is insufficient (a rebuilt index would still add the row).
- **Migration runner is now multi-ADD-COLUMN-safe (2026-06-02).** `applyMigrations` guards *every* ADD COLUMN. Still: prefer `CREATE TABLE IF NOT EXISTS`; the splitter is line-based (no procedural bodies / inner `;` in migration files).
- **`redact` UPDATEs use literal `NULL`** (not bound params) so the auto-encrypt layer is a no-op on the nulled columns; only `forgotten_at` is a param.
- **`boot()` now returns `searchHelpers`** — additive to the return object; existing destructures unaffected.
- **main moved mid-session** (`f614d4a` → `b622914`/#44). The branch was rebased; rebase again next session before building.

---

## Glossary
- **`ref`** — the lean addressing handle `{ type: 'message'|'document'|'fact'|'entity', id }`. `forget`/`mark`/`link` take a flat `type`+`id`.
- **redact** — soft-forget: null the encrypted payload + both embedding fingerprints, delete the clustering point, evict the index, stamp `forgotten_at`. No hard delete.
- **tombstone / husk** — the row that persists after redact: id + timestamps + non-sensitive enums + `forgotten_at`. Carries no plaintext, no fingerprint.
- **the `d1` shim** — `src/adapter/d1.js`: a local better-sqlite3 wrapper that mimics the Cloudflare D1 API shape (transparent AES-256-GCM at the query boundary). Not Cloudflare.

---

## Skills that fired this session
`/sweep-first-design` (×2 — the spec + the pre-build implementation sweep that caught the loader + migration footguns) · `/handoff-discipline` (this doc). Phase 5 will require `/pre-deletion-caller-audit` (it removes 11 tools). Each shipped phase runs the `verify` gate per the V1 `/deploy-and-verify`.
