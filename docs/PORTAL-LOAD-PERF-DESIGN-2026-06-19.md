# Portal Load Performance — Mindscape & Library — Design

**Date:** 2026-06-19
**Branch:** `feat/portal-load-perf` (worktree `mycelium-id-worktrees/portal-perf`), off `main` @ `89e3325`
**Skill:** authored under `/sweep-first-design` (3 sweep cycles + own-eyes verification)
**Status:** design locked; implementation pending (Phases 1–3)

---

## 0. Problem

On the live vault the **Mindscape** takes many seconds to open and the **Library** is sluggish, especially on iOS (the app is a WKWebView onto the portal served from the user's Mac over Tailscale/LAN, so server response time + payload size + webview render all stack up). We are about to go live; this needs a robust fix, not a band-aid.

Two independent investigation sweeps (cycle 1) + three targeted sweeps (cycle 2) + own-eyes verification established the root causes below. Every load-bearing claim is in the verification table (§9).

---

## 1. Root causes (verified)

### Mindscape
- **M1 — Full decrypting scan of the whole point corpus on every open, uncached.** `GET /portal/mindscape` runs `getPoints(userId, 100000)` — `SELECT … FROM clustering_points … ORDER BY created_at DESC LIMIT 100000` ([src/db/mindscape.js:21](../src/db/mindscape.js)) plus 4 more table reads, with **no caching** ([src/portal-mindscape.js](../src/portal-mindscape.js) GET `/mindscape`). On a ~70k-point, 2.6 GB SQLCipher vault this forces a multi-second page-decrypt every single open.
- **M2 — 100% wasted decryption probing.** `getPoints` selects 11 columns, **none of which is encrypted** (the only encrypted `clustering_points` column is `content`, not selected — [crypto-local.js:209 registry](../src/crypto/crypto-local.js)). Yet `autoDecryptResults` probes *every* string column of *every* row via `isEncrypted()` (base64-decode + JSON.parse) ([crypto-local.js:1723](../src/crypto/crypto-local.js), [d1.js:78](../src/adapter/d1.js)) — hundreds of thousands of synchronous parse attempts that find nothing.
- **M3 — Bloated payload + redundant work.** The aggregate maps every point into a nested `{id,type,data:{position3d…}}` object and re-loops the full set several times to build activity/centroid maps, fresh per request; the frontend then re-iterates all ~70k nodes multiple times. Plus a duplicate territory-profiles read and two empty stub round-trips.

### Library
- **L1 — N+1 full-document fetches for grid thumbnails (dominant cost).** Grid is the default view; each `DocThumbnail` lazily `GET /portal/documents/<path>` to render a preview, which server-side `SELECT *` + decrypts the full `content` (+ every encrypted column) per card ([DocThumbnail.svelte:73](../portal-app/src/lib/components/library/DocThumbnail.svelte)). Scrolling = a request storm of full-content decrypts.
- **L2 — Unbounded list query.** `db.documents.list` has no LIMIT and decrypts `title`+`summary`+`metadata` for every doc ([src/db/documents.js:134](../src/db/documents.js), comment self-flags "revisit if list-view perf degrades").
- **L3 — Attachments always scans 2000 rows.** `GET /portal/attachments` reads the client `limit` (≤200) but then calls `listByUser(userId,{limit:2000,offset:0})` and decrypts up to 2000 rows every open, filtering/slicing in JS ([portal-attachments.js:58,61](../src/portal-attachments.js)).
- **L4 — No virtualization.** Every doc+media renders a DOM node; in grid every card mounts a `DocThumbnail` → feeds L1.

---

## 2. Revision history (pivots from the sweeps)

- **v1 (cycle-1 sketch).** Cache `/mindscape`; Library → list-view default + use `summary` as the card preview; scope `autoDecryptResults` to the table's encrypted columns.
- **v2 (cycle-2 pivots — what the code actually says):**
  - **Pivot A — cache invalidation is broader than Generate/Measure.** `clustering_points` is also **DELETE**d outside those jobs by document-delete, message-forget, and message-edit ([documents.js:259](../src/db/documents.js), [messages.js:325](../src/db/messages.js), [messages.js:468](../src/db/messages.js)). A cache busted only on job completion would serve stale points after a delete. → Cache must bust on **job completion AND those three mutation paths**, with a TTL safety net.
  - **Pivot B — `summary` is NOT a drop-in grid preview.** List-view renders **no** `DocThumbnail`; grid deliberately renders decrypted **content** as markdown. `summary` is short/auto-truncated/sometimes blank ([documents.js:140](../src/db/documents.js), [tools/documents.js:382](../src/tools/documents.js)). Replacing rich previews with `summary` degrades the "nice" the user explicitly asked to preserve. → Keep the grid; make it cheap via **virtualization + a batched, snippet-only preview endpoint**, not full-doc-per-card.
  - **Pivot C — decryption-scoping is unsafe *naively*, safe *guarded*.** The only decrypt call site passes **no table** ([d1.js:78](../src/adapter/d1.js)) — but `query(sql,…)` *does* have the SQL, so a single-table `FROM` can be parsed and threaded. Joins/CTEs/subqueries make "the table" ambiguous (could drop a joined table's encrypted column → return ciphertext). → Scope **only** for unambiguous single-table SELECTs; **fall back to today's full-probe** for everything else. Registry is authoritative (read + write share `getEncryptedFields` — [crypto-local.js:729,1478](../src/crypto/crypto-local.js)).

---

## 3. Design

### Phase 1 — the big, safe wins
**P1a — Mindscape aggregate cache (mirror `embedBacklogCached`).**
New per-process, **userId-keyed**, single-flight cache wrapping the whole `/mindscape` aggregate result.
- Serve cached value instantly; single-flight revalidate (`_inFlight` latch) so concurrent opens never queue behind separate scans.
- **TTL safety net:** 5 min (the aggregate is otherwise static between jobs).
- **Explicit bust** `bustMindscape(userId)` exported and called from: clustering/measure **job completion** ([jobs.js](../src/jobs.js) completion hook), and the three `clustering_points` mutation paths (doc delete, msg forget, msg edit).
- Fail-closed: cache holds plaintext aggregate in memory only (same as `embedBacklogCached`), never persisted, never cross-user (keyed by userId; V1 is single-user but keyed defensively).

**P1b — Library grid made cheap (virtualize + batched snippet preview).**
- **Virtualize** the Library grid/list so only on-screen items mount (bounds DOM + thumbnail work to a viewport, not the corpus).
- New endpoint **`POST /portal/documents/previews { paths: string[] }`** → `{ [path]: snippet }`, snippet = first ~600 chars of decrypted content (decrypt once server-side, slice, return). `DocThumbnail` switches from per-card `GET …/<path>` (full doc) to a **batched** call for the visible page → N requests collapse to 1/page, payload shrinks from full content to a snippet.
- **Defer media:** skip `loadMedia()` on initial Library mount; load when the media/combined facet is actually viewed, and skip entirely when a folder is active (media hidden there).

### Phase 2 — structural
**P2a — Paginate `/portal/documents`.** Add `limit`/`offset` (default page ~60, keyset on `updated_at` preferred) to `db.documents.list` + `GET /portal/documents`; frontend loads first page, more on scroll. Caller audit (§9) shows MCP `listDocuments`, LibraryView, SSE patching all tolerate pagination; no full-set consumer exists.
**P2b — Index** `documents(user_id, updated_at DESC)` (new migration) to back the list `ORDER BY` (today it filesorts).
**P2c — Honor attachments limit.** Pass the real `limit`/`offset` to `listByUser` for the common no-filter open (skip the 2000-row decrypt); keep a capped scan only when a search/type filter is present (encrypted fields can't be SQL-filtered).
**P2d — Slim the Mindscape payload.** Send flat parallel typed arrays (Float32 positions + Int32 cluster ids) instead of nested per-point objects; precompute timestamps as numbers server-side; drop the duplicate territory read + the two empty stubs. Optional point **decimation** for the overview when count ≫ visually distinguishable.

### Phase 3 — scoped decryption (security-sensitive, independently shippable + revertible)
Thread a parsed **single-table name** from `d1.js query()` into `autoDecryptResults`; when present, only attempt decrypt on `getEncryptedFields(table)` columns. When the SQL is not an unambiguous single-table SELECT (JOIN/CTE/subquery/UNION/unparseable), pass `null` → **unchanged full-probe behavior**. Kills the wasted probing on hot single-table reads (`getPoints`, `documents.list`, `attachments`, `messages`) with zero risk to join queries. Revert = stop passing the table name.

---

## 4. Threat model
- **Encryption boundary (Phase 3).** Risk: scoping skips a genuinely-encrypted column → ciphertext leaks to the client/UI. Mitigations: (1) scope **only** for single-table SELECTs where the encrypted-column set is unambiguous; (2) the registry is the *same* source of truth the write path uses to encrypt ([crypto-local.js:1478](../src/crypto/crypto-local.js)), so a registered-decrypt set exactly matches the registered-encrypt set; (3) a verify gate asserting single-table scoping decrypts **all** registered columns AND a join query still decrypts **both** tables' columns (fallback path); (4) mirror `reference/tests/encryption-coverage.test.js` registry-completeness assertion. Fail-closed: unknown/ambiguous table → probe everything (today's behavior).
- **Cache isolation (Phase 1a).** Risk: cross-user aggregate leak. Mitigation: cache keyed by `userId`, returned only for the matching userId (mirrors `embedBacklogCached` — [messages.js:225](../src/db/messages.js)). In-memory only; never persisted.
- **Preview endpoint (Phase 1b).** Risk: snippet endpoint becomes an unscoped content read. Mitigation: same auth as `GET /portal/documents/<path>`; returns only a length-capped snippet of the user's own docs; no new scope surface.
- **No plaintext at rest / in logs** (CLAUDE.md §1): caches and snippets are memory/response only; no new logging of decrypted content.

---

## 5. Module shapes & LOC budget
- **P1a** `src/db/mindscape.js` (or a small `src/portal-mindscape-cache.js`): `getMindscapeCached(userId, computeFn)` + `bustMindscape(userId)`; wire bust into `jobs.js` completion + 3 delete/edit sites. ~60 LOC.
- **P1b** `src/portal-compat.js` (or portal docs router): `POST /portal/documents/previews` handler ~30 LOC; `DocThumbnail.svelte` + a small grid virtualization in `LibraryView.svelte` ~120 LOC; defer-media ~15 LOC.
- **P2a/b/c** `db.documents.list` + endpoint pagination ~40 LOC; migration `migrations/00NN_documents_updated_at_index.sql` ~5 LOC; attachments limit ~15 LOC.
- **P2d** payload typed-arrays server + frontend buffer build ~150 LOC.
- **P3** `d1.js` table parse + thread ~25 LOC; `autoDecryptResults` signature + scope ~20 LOC; verify gate ~120 LOC.
**Total ≈ 700 LOC across 3 phases** (±20%).

---

## 6. Test strategy (verify gates)
- **`verify:mindscape-cache`** — repeat `/mindscape` calls hit the cache (1 scan, not N); a simulated job-complete and each of the 3 delete/edit paths bust it; cache is per-userId.
- **`verify:library-perf`** — `/portal/documents` honors `limit`/`offset`; previews endpoint returns snippets for a batch of paths and never the full content; attachments no-filter open pages at the DB.
- **`verify:decrypt-scope`** (Phase 3, security) — single-table SELECT decrypts ALL registered columns for `documents`/`messages`/`attachments`; a JOIN query decrypts BOTH tables' encrypted columns (fallback); registry completeness assertion; `clustering_points` no-encrypted-column SELECT does **zero** decrypt attempts.
- Full `npm run verify` green before merge (no subset/flaky-CI merges — per project memory).
- **Live smoke** on the real vault (:8787): time Mindscape open (cold + warm) and Library open before/after; confirm no `[DECRYPT ERROR]` and no ciphertext in responses.

---

## 7. Implementation order (each independently shippable + smoke)
1. **P1a Mindscape cache** — smoke: open Mindscape twice, 2nd is instant; run Measure, confirm refresh.
2. **P1b Library grid** — smoke: scroll Library, one preview request/page, media not fetched until viewed.
3. **P2a–c pagination/index/attachments** — smoke: large library pages on scroll; attachments open fast.
4. **P2d payload slim** — smoke: Mindscape payload size + parse time down; visual parity.
5. **P3 decryption scope** — smoke + `verify:decrypt-scope`; adversarial review before merge.

Phases merge independently behind the auto-merge-on-green gate; Phase 3 additionally requires a human security approval (CLAUDE.md — security-sensitive diff).

---

## 8. Risks & mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 3 drops a joined table's encrypted column | Low | High (ciphertext leak) | Single-table-only scoping + full-probe fallback + verify gate asserting join decrypts both |
| Mindscape cache serves stale after an untracked mutation | Low | Med (stale map) | Bust on all 3 known mutation paths + 5-min TTL safety net |
| Pagination breaks a hidden full-set consumer | Low | Med | Caller audit (§9) found none; keep an `all=1` escape for MCP/export if needed |
| Virtualization regresses scroll/keyboard UX | Med | Low | Use a proven svelte virtual-list; keep list-view unchanged |
| Snippet preview less rich than full render | Med | Low | 600-char markdown snippet is enough for a card; full content still on open |

---

## 9. Verification table (every load-bearing assumption, read by me)
| Assumption | Verified at |
|---|---|
| `/mindscape` aggregate is uncached; reads 5 tables incl. getPoints | [src/portal-mindscape.js](../src/portal-mindscape.js) GET `/mindscape` (own read) |
| `getPoints` LIMIT 100000, selects **no** encrypted column | [src/db/mindscape.js:21-32](../src/db/mindscape.js) |
| `autoDecryptResults` probes every string column, no table param | [src/crypto/crypto-local.js:1723-1748](../src/crypto/crypto-local.js) |
| Only decrypt call site; `query()` HAS the SQL (table parseable) | [src/adapter/d1.js:63-80](../src/adapter/d1.js) |
| Encrypted-column registry; read+write both use `getEncryptedFields` | [src/crypto/crypto-local.js:209,729,1478](../src/crypto/crypto-local.js) |
| `clustering_points` deleted outside Generate/Measure (3 sites) | [documents.js:259](../src/db/documents.js), [messages.js:325](../src/db/messages.js), [messages.js:468](../src/db/messages.js) |
| `embedBacklogCached` = userId-keyed single-flight SWR pattern | [src/db/messages.js:224-235](../src/db/messages.js) |
| `db.documents.list` unbounded, decrypts title/summary/metadata | [src/db/documents.js:134-148](../src/db/documents.js) |
| Grid card fetches full doc; list-view mounts no DocThumbnail | [DocThumbnail.svelte:73-87](../portal-app/src/lib/components/library/DocThumbnail.svelte), LibraryView default view |
| `summary` auto-derived/can be blank → not a rich preview | [src/tools/documents.js:382](../src/tools/documents.js) |
| Attachments scans 2000 rows regardless of requested limit | [src/portal-attachments.js:58,61](../src/portal-attachments.js) |
| Pagination callers (MCP listDocuments, LibraryView, SSE) tolerate paging | [tools/documents.js:459](../src/tools/documents.js), LibraryView load/filter/SSE |

---

## 10. Open questions
- **Resolved during sweep:** decryption-scoping is feasible after all (table parseable in `query()`), but only safe single-table — pivoted accordingly. Cache invalidation needs the 3 delete/edit hooks, not just job completion.
- **Deferred:** Mindscape point **decimation** strategy (spatial vs temporal) — Phase 2d, only if payload-slim alone isn't enough. Server-side full-text search over encrypted attachment fields stays a scan (can't SQL-filter ciphertext) — out of scope.
- **For the user (UX call):** Library grid keeps rich previews via batched snippets (chosen). If you'd prefer *instant* cards showing the existing `summary` (faster, occasionally blank) over snippet richness, say so and P1b simplifies.
