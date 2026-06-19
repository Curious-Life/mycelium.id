# Portal Content-Load Performance — Design (measured, sweep-first)

**Date:** 2026-06-19
**Branch:** `perf/portal-content-load` (worktree `mycelium-id-worktrees/content-perf`), off `origin/main` @ `1b2824a`
**Skill:** authored under `/sweep-first-design` (empirical sweep on the LIVE vault + 3 parallel code sweeps + own-eyes verification)
**Status:** design locked; implementation pending user go-ahead
**Companion to:** [`PORTAL-PERF-CONSOLIDATED-PLAN-2026-06-19.md`](PORTAL-PERF-CONSOLIDATED-PLAN-2026-06-19.md) (serving layer — MERGED #279) and [`PORTAL-LOAD-PERF-DESIGN-2026-06-19.md`](PORTAL-LOAD-PERF-DESIGN-2026-06-19.md) (Mindscape/Library Phase 1 — MERGED #274)

---

## 0. Problem & method

After the serving fix shipped (#279, brotli + immutable cache + skeletons), **navigation feels fast but loading each section's *content* is still slow** (user report, 2026-06-19). So this pass targets the data layer, and — because the packaged app is running on `:8787` against the real ~2.6 GB vault — every root cause below is **measured**, not reasoned.

### Measured latency (live vault, cold then warm)

| Endpoint | Cold | Warm | Payload | Verdict |
|---|---|---|---|---|
| `GET /portal/streams/spectrum` | **6.97s** | **12.3s** | 5 KB | 🔴 #1 — Streams killer; uncached; *worse* warm |
| `GET /portal/mindscape` | 4.60s | 0.13s | **17.4 MB** | 🔴 #2 — cold scan + giant payload (SWR-cached) |
| `GET /portal/documents` (no limit) | 1.49s | 1.18s | 1.35 MB | 🟠 #3 — full set; `?limit=60` = **0.11s / 18 KB** |
| `GET /portal/streams?limit=40` | 0.07s | 0.01s | 29 KB | ✅ already fast (the #279 metadata-drop worked) |
| `/messages`, `/attachments`, `/mindscape/realms`, `/mindscape/territories` | <0.11s | — | — | ✅ fine |

Three bottlenecks own essentially all the pain: **spectrum**, **mindscape payload size**, **library full-set load**.

---

## 1. Root causes (verified by own reading)

### 🔴 R1 — Streams `/spectrum`: 7–12s, uncached, unindexed full scans
`db.streams.spectrum()` runs **8 queries** (an aggregate + a sparkline-bucket per table, ×4 tables) ([src/db/streams.js:133-152](../src/db/streams.js)).
- The aggregate ([streams.js:64-72](../src/db/streams.js)) is `SELECT source, MAX(created_at), COUNT(*) AS total_all, SUM(CASE created_at>=? …) … WHERE user_id=? GROUP BY source` with **no `created_at` bound** → a **full scan of every table** to compute `MAX` + the windowed `SUM`s. On a ~70k-row `messages` table inside a **whole-file SQLCipher** DB, the scan decrypts every page → the 7–12s.
- **`total_all` (COUNT(*)) is computed but never read** — the accumulator at [streams.js:139-143](../src/db/streams.js) only uses `window_total` / `today_total` / `last_activity`. Dead work.
- **No covering index.** Only `idx_messages_source(source)` ([0001_init.sql:1845](../migrations/0001_init.sql)) and `idx_messages_user_created(user_id, created_at)` ([0026](../migrations/0026_messages_user_created_index.sql)) exist — neither serves `WHERE user_id GROUP BY source + MAX(created_at)` as an index-only scan. `documents`/`tasks` have `(user_id, created_at DESC)` ([0018](../migrations/0018_streams_feed_indexes.sql)); none has `(user_id, source, created_at)`.
- **No cache** ([portal-compat.js:164-170](../src/portal-compat.js)) — recomputed on every Streams open (and the Streams view fires it on mount).

### 🔴 R2 — Mindscape: 17.4 MB payload (98% is the points array)
`GET /portal/mindscape` maps every one of ~70k `clustering_points` into a **nested 8-field object** `{id, type, data:{type, clusterId, cluster3d, themeId, atomId, position3d:{x,y,z}, timestamp}}` ([portal-mindscape.js:73-85](../src/portal-mindscape.js)) → ~280 bytes/point × 70k ≈ 17 MB. The other aggregates (themes/territories/realms) are <0.5 MB combined. The WKWebView parses 17 MB of JSON on every open even though the server result is SWR-cached ([src/mindscape-cache.js](../src/mindscape-cache.js); warm = 0.13s server, but the *client parse* of 17 MB is the felt cost).
- The frontend only reads **`position3d.{x,y,z}`, `data.cluster3d` (territory), `data.clusterId` (realm)**, and optionally `data.timestamp` ([Mindscape3D.svelte:1505-1525](../portal-app/src/lib/components/mindscape/Mindscape3D.svelte), [stores/mindscape.ts:443-470](../portal-app/src/lib/stores/mindscape.ts)). `id`, `type`, `data.type`, `themeId`, `atomId` are dead weight on the wire.
- The 4.6s cold is the SQLCipher page-scan of `clustering_points` + the JS aggregate build (getPoints selects **no encrypted column** — [mindscape.js:21-31](../src/db/mindscape.js)), not field decryption.

### 🟠 R3 — Library: full-set load, re-fetched every visit
`LibraryView.loadDocuments()` fetches `GET /portal/documents` **with no `limit`** ([LibraryView.svelte:305-330](../portal-app/src/lib/views/LibraryView.svelte)) because client-side search filters the full set in memory ([LibraryView.svelte:356-366](../portal-app/src/lib/views/LibraryView.svelte) `filteredDocs`). `db.documents.list()` decrypts `title`+`summary`+`metadata` per doc ([documents.js:135-152](../src/db/documents.js)) → 1.35 MB / 1.2s. It re-fetches **on every mount, folder switch, and SSE resync** ([LibraryView.svelte:151-189](../portal-app/src/lib/views/LibraryView.svelte)) — there is **no client cache**. Server pagination works (`?limit=60` = 0.11s) but the client can't use it without moving search server-side. A BM25 doc search exists ([src/search/index.js:170-176](../src/search/index.js)) but has **no portal HTTP endpoint**.

---

## 2. Revision history (pivots from the sweep)

- **v1 (pre-measurement guess):** "content slow = the known P2d Mindscape payload + P3 scoped decrypt." → **Refuted by measurement:** the dominant cost is **`/spectrum` at 7–12s**, which NO prior sweep prioritized (the streams sweep called it "no cache, medium"). Measuring first changed the #1 target.
- **v2 — spectrum fix is index+cache, not just cache.** First instinct was "SWR cache it like mindscape." But the bust point is **message ingest** ([capture.js](../src/ingest/capture.js)), which fires during active chat/channels — so a cache that busts per-insert still pays 7–12s repeatedly. → Pivot: **add the covering index so the *cold* compute is sub-second too**, and **coalesce** the bust (one recompute per burst, not per row).
- **v3 — spectrum index, NOT window-bounding the aggregate.** Tempting fix: add `created_at >= floor` to `aggregateSql`. But that changes `last_activity = MAX(created_at)` to window-only (a source quiet longer than the window would lose its "last seen"). → Pivot: keep semantics; make it fast with a `(user_id, source, created_at)` covering index that serves the GROUP BY + MAX as an index-only scan. Also **drop the unused `total_all`**.

---

## 3. Design (three independent fixes, ranked by measured impact)

### F1 — Spectrum: covering index + SWR cache + coalesced bust  *(backend-only, headless-verifiable)*
1. **Migration `00NN_spectrum_source_indexes.sql`** — composite covering indexes:
   - `messages(user_id, source, created_at)`, `documents(user_id, source_type, created_at)`, `health_daily(user_id, source, date)`. (`tasks.source` is the constant `'task'` — no index needed.) These let the `GROUP BY source` + `MAX(created_at)` + windowed `SUM`/bucket run as **index-only scans** (far fewer SQLCipher pages decrypted) with **zero behavior change**.
2. **SWR cache** in `src/db/streams.js` (mirror `src/mindscape-cache.js`): `getSpectrumCached(userId, windowDays, computeFn)` keyed by `userId:windowDays`, single-flight, TTL 60s, serve-stale-while-revalidate. Export `bustSpectrum(userId)`.
3. **Coalesced bust:** `bustSpectrum` marks the userId stale (clears the entry); a burst of inserts = at most one recompute on the next read. Wire a bust at the message-ingest site ([capture.js insert](../src/ingest/capture.js)) and document upsert ([documents.js upsert](../src/db/documents.js)). (Health/task inserts are rare; the 60s TTL covers them — no explicit bust needed.)
4. **Drop the dead `total_all`** column from `aggregateSql` (it's never read).
- **Expected:** cold 7–12s → <0.8s (index-only) → <20ms warm (cache). Even under active ingest, one ≤0.8s recompute per burst.

### F2 — Mindscape: slim the 17 MB payload  *(two steps)*
- **F2a (zero-risk, ~15%, no frontend change):** drop the unused per-point fields (`id`, `type`, `data.type`, `themeId`, `atomId`) from the projection ([portal-mindscape.js:73-85](../src/portal-mindscape.js)). 17 MB → ~14.7 MB; cold ~4.6s → ~3.2s. ~5 LOC.
- **F2b (the real win, ~93%, frontend loop refactor):** return **flat parallel typed arrays** — `Float32` positions (70k×3), `Int16` realmIds, `Int16` territoryIds, `Int32` timestamps — instead of nested objects. 17 MB → ~1.2 MB; client parse near-instant. Backend builds the buffers; the store ([mindscape.ts](../portal-app/src/lib/stores/mindscape.ts)) exposes them; the render loop ([Mindscape3D.svelte:1505-1525](../portal-app/src/lib/components/mindscape/Mindscape3D.svelte)) indexes arrays instead of object fields. Keeps visual parity (same data, denser encoding). ~80 backend + ~60 frontend LOC. **Requires live WKWebView visual verification.**

### F3 — Library: client-side session cache  *(frontend-first, low risk)*
- A module-level Svelte store caches the document list **once per session**; Library mounts/folder-switches read from the store instead of re-fetching; the existing SSE list listener ([LibraryView.svelte:177-183](../portal-app/src/lib/views/LibraryView.svelte)) patches it live. First visit still 1.2s; every subsequent visit/folder-switch becomes instant. ~60 LOC frontend. (Folder filtering can stay client-side over the cached set.)
- **Deferred (F3-next):** a `GET /portal/documents/search?q=` endpoint backed by the existing BM25 index ([search/index.js:170](../src/search/index.js)) + true pagination, so the first load also shrinks. Larger change; not needed to kill the revisit cost.

---

## 4. Threat model
- **Spectrum cache (F1):** in-memory, `userId`-keyed, never persisted (mirrors `mindscape-cache.js`). The spectrum is a **plaintext aggregate** by design (§7 fail-safe — no ciphertext-derived data; [streams.js:3-8](../src/db/streams.js)); caching it adds no new exposure.
- **Spectrum indexes (F1):** on `source`/`source_type`/`created_at` — all **plaintext** columns (source is a tag like `telegram`; not encrypted). Indexing them adds **no decryption surface** and changes no query semantics. Migration is `CREATE INDEX IF NOT EXISTS` (idempotent, re-run safe).
- **Mindscape slim (F2):** removes/recodes fields already sent in plaintext; no new data leaves the boundary. Typed arrays carry the same coordinates + cluster ids. No encryption-boundary change.
- **Library cache (F3):** holds decrypted `title`/`summary` in browser memory — **identical** to what the current response already puts there; SSE keeps it fresh. No persistence, no new surface.
- **No plaintext at rest / in logs** (CLAUDE.md §1): all caches are memory/response-only; no new logging of vault content.

---

## 5. Module shapes & LOC budget
- **F1** `migrations/00NN_spectrum_source_indexes.sql` (~8 LOC) · `src/db/streams.js` SWR cache + `bustSpectrum` + drop `total_all` (~55) · bust wiring in `src/ingest/capture.js` + `src/db/documents.js` (~10) · `scripts/verify-streams-spectrum-perf.mjs` (~90). **≈ 165 LOC.**
- **F2a** `src/portal-mindscape.js` projection trim (~5). **F2b** backend typed-array build (~80) + `mindscape.ts` (~30) + `Mindscape3D.svelte` loop (~30). **≈ 145 LOC.**
- **F3** `portal-app/src/lib/stores/libraryDocs.ts` (~45) + `LibraryView.svelte` wire (~20). **≈ 65 LOC.**
- **Total ≈ 375 LOC** across three independently shippable fixes (±20%).

---

## 6. Test strategy (verify gates)
- **`verify:streams-spectrum-perf`** (new): on a seeded vault, (a) `spectrum()` second call is served from cache (1 compute, not N); (b) `bustSpectrum` forces a recompute; (c) the new indexes exist and `EXPLAIN QUERY PLAN` for the aggregate uses an index (not `SCAN TABLE`); (d) result is byte-identical to the pre-change output (semantics preserved — `total_all` removal doesn't change any surfaced field). Extend the existing `verify:streams-spectrum` (24/24) so the §7 plaintext-only + vector-free assertions still hold.
- **`verify:mindscape-payload`** (new, F2): aggregate returns the typed-array shape; positions/cluster-ids round-trip; payload byte-size is ≥80% smaller for an N-point fixture; no encrypted column appears.
- **F3**: svelte-check 0/0 + build; live smoke (revisit Library → served from store, SSE patch lands).
- **Full `npm run verify` green + `npm audit` 0** before merge (no subset/flaky merges — project memory).
- **Live re-measure on `:8787`** before/after each fix: spectrum cold+warm, mindscape payload bytes + client parse, library revisit. Confirm no `[DECRYPT ERROR]`, no ciphertext.

---

## 7. Implementation order (each independently shippable + smoked)
1. **F1 spectrum** — biggest measured win (7–12s → <0.8s/<20ms), backend-only, headless-verifiable. **Ship first.** Smoke: re-time `/spectrum` cold+warm on `:8787`.
2. **F2a mindscape field-drop** — zero-risk 15%, ~5 LOC. Ship with F1.
3. **F3 library cache** — kills the revisit cost; frontend, low risk.
4. **F2b mindscape typed arrays** — the 93% payload win, but needs the frontend refactor + live WKWebView visual verification. Ship last, on its own, with a real-app smoke.

Each merges independently behind auto-merge-on-green; F2b additionally requires a live visual pass (WKWebView, per project discipline).

---

## 8. Risks & mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Index doesn't change the plan (SQLite ignores it) | Low | High (no speedup) | Gate asserts `EXPLAIN QUERY PLAN` uses the index; re-measure on live vault before claiming the win |
| Spectrum cache serves stale after an untracked ingest | Low | Low (5 KB recency view) | 60s TTL safety net + bust at the message/doc write sites |
| Dropping `total_all` changes a displayed number | V. low | Med | Verified unused at [streams.js:139-143](../src/db/streams.js); gate asserts byte-identical surfaced output |
| F2b typed-array refactor regresses the 3D view | Med | Med | Keep F2a as the shipped baseline; F2b behind live WKWebView visual diff; revert = restore object shape |
| Library cache shows stale docs | Low | Low | SSE list listener already patches in-place; store invalidates on write |
| Index build time on the 2.6 GB vault | Low | Med | `CREATE INDEX` on plaintext columns over ~70k rows is seconds, one-time; runs in the boot migration like 0026 did |

---

## 9. Verification table (every load-bearing claim, read by me)
| Assumption | Verified at |
|---|---|
| `/spectrum` measured 7–12s for a 5 KB response; `/mindscape` 17.4 MB; `/documents` 1.35 MB/1.2s; `?limit=60` 0.11s | live `curl` timing on `:8787` (own run) |
| Spectrum aggregate has NO `created_at` bound → full scan; `total_all` computed but unused | [src/db/streams.js:64-72, 133-152](../src/db/streams.js) (own read) |
| No `(user_id, source, created_at)` composite index on any spectrum table | `grep migrations/` — only `idx_messages_source`, `idx_*_user_created` (own read) |
| Spectrum is uncached at the route | [src/portal-compat.js:164-170](../src/portal-compat.js) |
| SWR cache pattern to mirror | [src/mindscape-cache.js](../src/mindscape-cache.js) |
| Mindscape node = nested 8-field object × ~70k; frontend reads only pos+cluster ids+ts | [src/portal-mindscape.js:73-85](../src/portal-mindscape.js), [Mindscape3D.svelte:1505-1525](../portal-app/src/lib/components/mindscape/Mindscape3D.svelte) (own read) |
| getPoints selects no encrypted column (4.6s = scan+build, not decrypt) | [src/db/mindscape.js:21-31](../src/db/mindscape.js) |
| Library loads full set (no limit) for client-side `filteredDocs`; re-fetches every visit/folder/SSE; no client cache | [LibraryView.svelte:305-330, 356-366, 151-189](../portal-app/src/lib/views/LibraryView.svelte) |
| A BM25 doc search exists but has no portal HTTP endpoint | [src/search/index.js:170-176](../src/search/index.js) |

---

## 10. Open questions
- **Resolved during sweep:** the felt slowness is **spectrum**, not the previously-assumed Mindscape/decrypt-scope work — measuring first re-ranked everything. Spectrum needs index **and** cache (bust point fires during active chat). Window-bounding the aggregate would break `last_activity` → use a covering index instead.
- **Deferred:** server-side document search endpoint + true Library pagination (F3-next) — only if the first-load 1.2s still bothers after the revisit cache. P3 scoped-decryption (from the consolidated plan) remains a separate, security-sensitive workstream.
- **For the user:** F2b (Mindscape typed arrays, the 93% win) needs a live WKWebView visual pass and a small 3D-loop refactor — confirm you want the full payload slim, or whether F2a's 15% + the SWR cache is enough for the Mindscape feel.
