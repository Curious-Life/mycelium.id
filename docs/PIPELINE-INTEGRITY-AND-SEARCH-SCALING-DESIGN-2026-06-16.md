# Pipeline Integrity + Search-Index Scaling — Holistic Design (2026-06-16)

**Status:** DESIGN — sweep complete (3 Explore sweeps + live profiling + own-eyes verification), awaiting approval to implement.
**Trigger:** A user's app became "very very slow" — unresponsive clicks, slow handle-change, crawling chat — on a vault of **58,711 messages / 1.7 GB** (after the 1 GB import on 2026-06-15). User directive: *"if data null it should not enter the pipeline; needs a holistic, well-engineered, robust and reliable fix."*

---

## 0. Headline

Two distinct, independently-shippable problems — **not** the model, **not** PR #175 (not even deployed on the affected build):

1. **Pipeline integrity hole.** The full-export/vault importer (`restoreTable`) copies `messages` rows verbatim with **no content guard**, so content-NULL rows enter the vault as permanently-pending pipeline rows. They can never embed, and the backlog counter (`total − embedded`) counts them forever → a stuck "N remaining" (the user's 19). Live capture (`captureMessage`) is already fail-closed; the importer is the one hole.

2. **Search index blocks the event loop + doesn't scale.** The in-memory search index loads the **entire 58k-message corpus** (decrypted content + every 768-d embedding) in a **58k-iteration `await` loop on the main thread**. Because `await` over near-synchronous work yields only a *microtask* (which preempts I/O), that loop **starves the HTTP event loop** for the whole build — every request (clicks, handle-change, chat) freezes for seconds. Live profiling confirmed the hot path is `Builtins_StringEqual` (inverted-index token churn), **not** GC (the heap is already 4 GB; RSS ~2 GB).

The fix is two pillars. Pillar 1 enforces the user's principle (null never enters the pipeline) end-to-end. Pillar 2 makes the index cooperative now and bounded later.

---

## 1. Load-bearing assumptions (Step 1)

| # | Assumption | Category |
|---|---|---|
| A1 | Live capture rejects null/empty content. | Fail-closed |
| A2 | The full-export/vault importer can insert content-NULL message rows. | Boundary |
| A3 | The embed drainer already skips content-NULL rows. | Lifecycle |
| A4 | The backlog "remaining" counter includes content-NULL rows → sticks. | Shape |
| A5 | The search index loads the full corpus with no bound/pagination. | Concurrency/memory |
| A6 | The index build runs on the main thread and starves the event loop. | Concurrency |
| A7 | The Node heap is 4 GB (so heap size is NOT the lever). | Lifecycle |
| A8 | content-NULL rows are not referenced by clustering (no embedding ⇒ no cluster point). | Boundary |

Verdicts in §6.

## 2. Sweep findings (consolidated, file:line — verified myself unless noted)

### Pillar 1 — integrity
- **Capture is fail-closed** ✓: [capture.js:94-96](../src/ingest/capture.js) throws on empty content + no attachment. `importMessages` ([tools/ingest.js:110-127](../src/tools/ingest.js)) and obsidian-import (`if (memContent.trim())`) skip empties.
- **The hole** ✗: [vault-import.js:74-98](../src/ingest/vault-import.js) `restoreTable` does `INSERT OR IGNORE INTO messages (...) VALUES (...)` from export rows with **no content check**, forcing `embedding_768=null` (line 90). A content-NULL export row → a content-NULL, embedding-NULL, `nlp_processed=0` pending row. **This created the 19.** Used by `full-export-import.js` and `vault-import.js`.
- **Drainer correctly skips them** ✓: [messages.js:151-163](../src/db/messages.js) `selectPendingEnrichment` has `AND content IS NOT NULL AND content != ''`. So they never embed, never reach `-1`, the self-heal never resurrects them — they just sit at `nlp_processed=0` forever.
- **The stuck counter** ✗: `embedProjection` ([portal-activity.js:24-31](../src/portal-activity.js)) computes `pending = total − embedded` where `total = COUNT(*)` (includes content-NULL) and `embedded = COUNT(embedding_768 IS NOT NULL)`. Same pattern in [portal-compat.js:712](../src/portal-compat.js), [server-rest.js:320](../src/server-rest.js), [portal-mindscape.js:272,294](../src/portal-mindscape.js). → "remaining" can never reach 0.
- **Index indexes them too** ✗: [d1-loader.js:50](../src/search/d1-loader.js) message SQL filters only `forgotten_at IS NULL` (not content), and [d1-loader.js:127](../src/search/d1-loader.js) adds `text: row.text ?? ''` — content-NULL rows enter the index as empty docs.

### Pillar 2 — search scaling
- **Unbounded full-corpus load** ✗: [d1-loader.js:100-132](../src/search/d1-loader.js) — `db.rawQuery(src.sql, [userId])` with **no LIMIT**, then a `for (const row of rows) { await decryptVector(...); await backend.add(...) }` loop over all 58k. Decrypts every embedding + indexes every doc, resident in the heap.
- **Event-loop starvation** ✗ (verified): the per-row `await` yields a microtask, not a macrotask — 58k microtask hops run to completion before the event loop services any HTTP I/O. Live `sample` showed `Builtins_StringEqual` as the dominant JS leaf (inverted-index token comparison), Scavenger GC minor.
- **Built once, resident** : [index.js:44-52](../src/search/index.js) `ensureBuilt()` builds lazily on first query, `built=true` forever; `rebuild()` only after Generate ([jobs.js:201](../src/jobs.js)). No rebuild loop found (no `setInterval`).
- **Vectors brute-force** : all 58k×768 Float32Arrays in a Map; `topKCosine` is O(n) per query ([search/ann/cosine.js], [search/backend/local.js]).
- **Heap already 4 GB** ✓ (PIVOT): [main.rs:226-236](../src-tauri/src/main.rs) sets `NODE_OPTIONS=--max-old-space-size=4096`. RSS ~2 GB. So this is **event-loop blocking by synchronous CPU work, not heap exhaustion** — raising the heap is NOT the fix.

## 3. Design

### Pillar 1 — null content never enters the pipeline (fail-closed, end-to-end)
A single principle, enforced at every layer, with one shared predicate.

- **P1.1 Import guard (close the hole).** In `restoreTable`, when `table === 'messages'`, skip a row whose `content` is null/empty AND has no `attachment_id` — mirroring `captureMessage`'s rule. Count skips in the import summary (`out.skippedEmpty`). ~8 LOC in [vault-import.js](../src/ingest/vault-import.js). *This is the load-bearing integrity fix.*
- **P1.2 Backlog counter reflects reality.** Add `AND content IS NOT NULL AND content != ''` to the `total` count in all four sites (or a shared `db.messages.embedBacklog(userId)` helper returning `{embedded, total, pending}` with the predicate baked in). `pending` then excludes un-embeddable rows → never sticks. *Single helper preferred (one source of truth).*
- **P1.3 Index excludes content-NULL.** Add `AND content IS NOT NULL AND content != ''` to the d1-loader message SQL (also trims wasted index entries).
- **P1.4 One-time cleanup of existing dead rows.** A guarded maintenance script: for rows with `content IS NULL AND forgotten_at IS NULL AND attachment_id IS NULL AND embedding_768 IS NULL`, verify no `clustering_points` reference (A8), then **tombstone** them (`forgotten_at = now`, audit-logged) rather than hard-delete — reversible, audit-preserving, and excluded everywhere by the existing `forgotten_at IS NULL` filters. Reports counts; never touches content-bearing rows.

### Pillar 2 — the index must not freeze the event loop, and must scale
- **P2.1 Cooperative build (ship now — the immediate responsiveness fix).** In the d1-loader build loop, yield to the **macrotask** queue every N rows (`if (++i % 256 === 0) await new Promise(r => setImmediate(r))`). HTTP requests are then serviced *during* the build — clicks/handle-change/chat stay responsive even at 58k. ~5 LOC, surgical, low-risk. Directly resolves the reported symptom.
- **P2.4 Single-flight build latch + background warm (SHIPPED — PR #232, [index.js](../src/search/index.js)).** Two follow-on bugs to the "built once" model. (a) **Concurrent-build thrash:** `ensureBuilt()` flipped `built=true` only *after* `loadFromDb` finished, so on a 1.99GB / ~74k-row vault — where P2.1's cooperative yield keeps the app responsive but the build still runs minutes — every search arriving mid-build saw `built===false` and started *another* full-vault `loadFromDb` on the **same** shared backend/`_index`, N builds thrashing the one thread and mutating shared state. Fix: store the in-flight build promise; concurrent callers await the same build; `.finally` clears the latch so `rebuild()` still forces a fresh build. (b) **Cold-start on the critical path:** the *first* search after boot blocked ~10 min. Fix: `warm()` kicks the build fire-and-forget (through the same single-flight `ensureBuilt`) — `server-rest.js` calls it at boot in the real-app block, so the first user search joins an already-running warm instead of starting it. `isBuilt()`/`isWarming()` added for warming UIs (mirrors the mindscape `503`+`Retry-After` convention). Gate: `verify:search` single-flight section (5 concurrent + warm()+search ⇒ exactly one `loadFromDb`). *Remaining for Phase 1: hot-path profiling (vector decrypt vs tokenization) + the P2.3 persist/restore lever, which would cut the ~10 min itself.*
- **P2.2 Off-main-thread build (durable).** Move the decrypt + tokenize + postings + vector build into a `worker_thread`; the main loop never runs the heavy work. The worker owns the index and answers queries over a message port. Larger; Phase 1.
- **P2.3 Bounded / scalable algorithms (scaling).** Cap or shard the resident corpus; HNSW or 8-bit-quantized vectors for O(log n) query; persist the built index to disk so a restart re-loads instead of re-building. Phase 1, separate design.

**Phasing:** **Phase 0 = P1.1–P1.4 + P2.1** — robust, low-risk, fixes both the user's stated principle and the slowness symptom. **Phase 1 = P2.2 + P2.3** — the scaling investment, designed separately.

## 4. Module shape + LOC (Phase 0)
| Change | File | LOC |
|---|---|---|
| Import content guard (messages) | [vault-import.js](../src/ingest/vault-import.js) | ~10 |
| Shared `embedBacklog(userId)` helper + 4 call-site swaps | [messages.js](../src/db/messages.js) + portal-activity/compat/server-rest/mindscape | ~25 |
| Index SQL content filter | [d1-loader.js](../src/search/d1-loader.js) | ~2 |
| Cooperative-yield build loop | [d1-loader.js](../src/search/d1-loader.js) | ~5 |
| Dead-row cleanup script | `scripts/cleanup-null-content-messages.mjs` | ~70 |
| Verify gate | `scripts/verify-pipeline-integrity.mjs` | ~120 |
**Total ≈ 230 LOC ±20%.**

## 5. Test strategy
- `verify:pipeline-integrity` (temp vault): (a) `restoreTable` skips a content-NULL message row + keeps a content-bearing one; (b) `embedBacklog` excludes content-NULL from `pending` → a vault with 1 content-NULL row reports `pending=0`; (c) d1-loader does not index a content-NULL row; (d) the cooperative build yields (assert HTTP latency stays low during a large simulated build — or unit-assert a `setImmediate` is scheduled every 256 rows); (e) cleanup tombstones only the dead rows, never content-bearing/forgotten/clustered ones.
- Re-run `verify:ingest`, `verify:full-export-import`, `verify:vault-import`, `verify:search`, `verify:search-rehydrate`, `verify:chat` (no regression).
- **Live re-verify** on the user's vault after rebuild: `/healthz` < 50 ms during/after first search; backlog "remaining" → 0; CPU settles.

## 6. Verification table
| # | Assumption | Verdict | Verified at (read myself) |
|---|---|---|---|
| A1 | Capture rejects null content | TRUE | [capture.js:94-96](../src/ingest/capture.js) |
| A2 | Importer inserts content-NULL verbatim | TRUE | [vault-import.js:74-98](../src/ingest/vault-import.js) |
| A3 | Drainer skips content-NULL | TRUE | [messages.js:151-163](../src/db/messages.js) |
| A4 | Backlog counter includes content-NULL → sticks | TRUE | [portal-activity.js:24-31](../src/portal-activity.js) |
| A5 | Index loads full corpus, no bound | TRUE | [d1-loader.js:100-132](../src/search/d1-loader.js) |
| A6 | Build is a main-thread await loop → starves I/O | TRUE | [d1-loader.js:109-131](../src/search/d1-loader.js) + live `sample` (StringEqual hot) |
| A7 | Heap is 4 GB (not the lever) | TRUE | [main.rs:226-236](../src-tauri/src/main.rs) |
| A8 | content-NULL ⇒ no embedding ⇒ not in any cluster | TRUE (to verify on live vault before cleanup) | clustering needs embeddings — [d1-loader.js:117](../src/search/d1-loader.js) / cluster.py embed-gate |

## 7. Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| Import guard drops legitimate empty-but-attachment rows | Low | Med | Guard mirrors captureMessage exactly (`content empty AND no attachmentId`) — attachments pass |
| Cooperative yield slows total build slightly | High | Low | 256-row batches → negligible wall-clock cost; responsiveness >> a few extra ms |
| Cleanup tombstones a row that mattered | Low | High | Tombstone (reversible) not delete; guard on `content NULL AND forgotten_at NULL AND no attachment AND no clustering_points ref`; audit-logged; dry-run first |
| Counter helper changes a number a UI depends on | Low | Low | `pending` only drops to a truthful value; embedded/total semantics unchanged |

## 8. Revision history
- **v1** (initial live read): "heap at ceiling → GC death spiral; raise `--max-old-space-size`." **Refuted** — the sweep found the heap is already 4 GB ([main.rs:226](../src-tauri/src/main.rs)) and the live `sample` showed `StringEqual` (compute), not dominant GC. **Pivot:** the real cause is **event-loop starvation by a 58k-row main-thread `await` build loop**, so the fix is **cooperative/off-thread build**, not heap size.
- **v2** (this doc): two-pillar design — fail-closed null-content integrity (P1) + cooperative-then-bounded index (P2), Phase 0 vs Phase 1 split.

## 8b. How other repos do it (research, 2026-06-16) — and why Mycelium is different

**Ecosystem consensus for local-first memory/RAG search:** an **on-disk, SQLite-native index** — **FTS5** (built-in BM25) for keyword + **sqlite-vec** for vectors, fused with **RRF**. Queries run in C on disk; the index is maintained *incrementally* (triggers / inserts on write), never rebuilt in app code. Brute-force vectors are fine below ~100k (≈50k×384-d < 1 s/query), so no ANN needed at our scale. Mycelium *already* does BM25+vector+RRF — but **in JS, in RAM, rebuilt from the whole corpus**, which is the entire bug.
- **MemPalace** (best-benchmarked OSS memory system): persistent on-disk **ChromaDB** for vectors + a **SQLite** knowledge graph — i.e. a *persistent* index, not an in-memory rebuild. (Its own scaling gaps are O(n) metadata scans, not index rebuild — confirming the persistent-index direction.)
- **jeffpierce/memory-palace**, **sqlite-vec/FTS5 RAG guides**: same — persistent SQLite-native indexes, local Ollama embeddings.

**The constraint that makes Mycelium different — and the elegant unlock.** Our index is in-memory *on purpose*: content + embeddings are **encrypted per-column at rest** ([d1-loader.js:117-119](../src/search/d1-loader.js) decrypts each vector; the adapter auto-decrypts content), so FTS5/sqlite-vec can't run on the ciphertext columns, and writing a plaintext index to disk would break encryption-at-rest (§1/§7). That's why everything is decrypted into RAM and indexed there.

**This is the same problem as [[at-rest-blindness]].** That design already recommends **whole-file encryption** (`better-sqlite3-multiple-ciphers`, DB key HKDF from USER_MASTER, ChaCha20-Poly1305/SQLCipher). If the *whole file* is encrypted, then content/embeddings can live as plaintext-within-the-encrypted-file (decrypted only in the page cache), and **on-disk FTS5 + sqlite-vec indexes are themselves encrypted at rest** because they're pages in the same file. So **one migration solves both**: whole-file SQLCipher → native on-disk FTS5 + sqlite-vec → no JS rebuild, no 2 GB resident index, no event-loop block, queries in C — *and* it closes the at-rest-blindness gap (structural skeleton/timestamps/counts become encrypted too).

**Phase 1 architecture (recommended):**
- **1b (target):** adopt whole-file `better-sqlite3-multiple-ciphers` (the at-rest-blindness migration) → replace the in-memory index with **FTS5 (BM25) + sqlite-vec** maintained incrementally; keep RRF fusion. This is *how the ecosystem does it*, and it merges the scaling fix with the security upgrade. Big (driver swap + 1.7 GB migration) — its own design + sweep.
- **1a (fallback, smaller):** if 1b isn't near-term, **persist the built index encrypted** (serialize inverted index + vectors → AES-GCM blob under USER_MASTER → load+decrypt on boot instead of rebuilding from 58k rows). Kills the rebuild cost but stays ~2 GB resident — a stopgap, not the destination.

**Sources:** [sqlite-vec hybrid FTS5+vector (Alex Garcia)](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) · [Local-First RAG with SQLite (PingCAP)](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/) · [Hybrid FTS5+Vector+RRF](https://ceaksan.com/en/hybrid-search-fts5-vector-rrf) · [MemPalace](https://github.com/mempalace/mempalace) · [MemPalace architecture analysis](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md) · [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers).

## 9. Deferred (named so they don't ambush Phase 1)
- Off-thread (`worker_thread`) index build (P2.2).
- HNSW / vector quantization / disk-persisted index / bounded resident corpus (P2.3).
- Clustering's inclusion of content-NULL `clustering_points` (sweep 3 noted it inflates a per-run roster but doesn't embed them) — fold into Phase 1 source-sync hardening.
