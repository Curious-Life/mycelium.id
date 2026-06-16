# Search Index — On-Disk Architecture (Phase 1) — Design (2026-06-16)

**Status:** SWEPT + SPIKED — gate passed, one load-bearing pivot found. Ready for operator decisions (§9) before implementation. Companion to [PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16](PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16.md) (Phase 0, shipped `221ab0d`) and the security thread [AT-REST-BLINDNESS-DESIGN-2026-06-11](AT-REST-BLINDNESS-DESIGN-2026-06-11.md). Handoff: [SEARCH-INDEX-PHASE1-HANDOFF-2026-06-16](SEARCH-INDEX-PHASE1-HANDOFF-2026-06-16.md).

## Revision history
- **v1 (direction, 2026-06-16 AM)** — "on-disk FTS5 + sqlite-vec + RRF; brute-force vectors fine < 100k, no ANN needed; whole-file encryption merges with at-rest-blindness." Framed the target, flagged the sqlite-vec-on-encrypted-DB spike as the gate.
- **v2 (this doc, post-spike + 4 sweeps)** — gate **passed** (sqlite-vec loads + runs on an encrypted `better-sqlite3-multiple-ciphers` connection). **PIVOT:** the "brute-force fine < 100k" assumption is **refuted at 768-d** — measured **1.2 s** per query @ 58 k. The architecture now requires a **two-stage retrieve-then-rescore** (cheap candidate generation on the full corpus → re-rank a few hundred candidates at full 768-d precision). Sweep-verified module shape + caller audit added.

---

## 0. Why
Phase 0 made the in-memory index *cooperative* (no event-loop freeze) — but the architecture is still: decrypt the **entire corpus** into the JS heap and rebuild an inverted index + vector Map on first search. At 58 k messages that is ~2 GB resident and seconds of CPU per build ([d1-loader.js loadFromDb](../src/search/d1-loader.js)), and the index goes stale between Generates. The durable fix is to stop holding the corpus in app memory at all — move the index on-disk, maintained incrementally, queried in C.

## 1. What the ecosystem does (research 2026-06-16)
The local-first memory/RAG consensus is an **on-disk, SQLite-native index**: **FTS5** (built-in BM25) for keyword + **sqlite-vec** for vectors, fused with **RRF**. Mycelium *already* does BM25 + vector + RRF ([src/search/fusion/rrf.js:15-67](../src/search/fusion/rrf.js)) — but in JS, in RAM, rebuilt from the whole corpus. The fix is to move that exact pipeline onto SQLite's on-disk primitives.
- MemPalace (best-benchmarked OSS memory system): persistent on-disk ChromaDB + SQLite KG — persistent, not rebuilt-in-RAM.
- sqlite-vec + FTS5 + RRF is the documented standard for SQLite-backed RAG.

Sources: [sqlite-vec hybrid FTS5+vector](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) · [Hybrid FTS5+Vector+RRF](https://ceaksan.com/en/hybrid-search-fts5-vector-rrf) · [Local-First RAG with SQLite](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/) · [MemPalace analysis](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md) · [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers).

## 2. The Mycelium-specific constraint — and the unlock
The in-memory index exists **because content + embeddings are encrypted per-column at rest**. The DB file itself is **plaintext SQLite** today ([src/adapter/d1.js:32-34](../src/adapter/d1.js) — WAL + foreign_keys only, no cipher); sensitive columns are AES-256-GCM wrapped-DEK envelopes ([crypto-local.js encrypt() 1137-1203](../src/crypto/crypto-local.js); `ENCRYPTED_FIELDS.messages` = content, thinking, tags, … [235-239]). `embedding_768` is deliberately *not* auto-decrypted ([NEVER_AUTO_DECRYPT_COLUMNS 1685-1696](../src/crypto/crypto-local.js)); the search loader decrypts each vector itself via `decryptVector` ([d1-loader.js:131](../src/search/d1-loader.js), [ann/decode.js:65-85](../src/search/ann/decode.js)). FTS5/sqlite-vec cannot index ciphertext, and writing a plaintext index to disk would break encryption-at-rest — that is *why* everything is decrypted into RAM.

**The unlock — this merges with [[at-rest-blindness]].** That design recommends **whole-file encryption** (`better-sqlite3-multiple-ciphers`, DB key HKDF-derived from USER_MASTER). If the whole DB file is encrypted, then content/embeddings can live as plaintext *within the encrypted file* (decrypted only in the page cache), **on-disk FTS5 + sqlite-vec indexes are themselves encrypted at rest** (they are pages in the same file), and search runs in C on disk, incrementally maintained — **no JS rebuild, no resident corpus, no event-loop work**. One migration solves both the scaling problem *and* the at-rest-blindness gap (structural skeleton / timestamps / counts become encrypted too).

## 3. Spike results — the gate (running code, not assumption)
Spike at [spike/sqlite-vec-encrypted/](../spike/sqlite-vec-encrypted/) (macOS arm64, node v22, prebuilt binaries). Full ledger in its [README](../spike/sqlite-vec-encrypted/README.md).

| # | Question | Verdict |
|---|---|---|
| S5 | **sqlite-vec (v0.1.9) loads + runs inside an encrypted `better-sqlite3-multiple-ciphers` connection** | **GO ✅** (the one public unknown — answered) |
| S2 | On-disk file is ciphertext (no `SQLite format 3` header) | GO ✅ |
| S3 | Wrong key cannot read (fail-closed) | GO ✅ |
| S7 | FTS5 + `bm25()` in the same build | GO ✅ (22 ms @ 58 k) |
| S8 | WAL + cipher correctness; `-wal` also ciphertext | GO ✅ |
| S6/S9 | vec0 insert / KNN / persist-reopen / incremental DELETE (forget) | GO ✅ |
| install | `better-sqlite3-multiple-ciphers` + `sqlite-vec` prebuilt arm64-darwin | GO ✅ (~8 s, no node-gyp) |

**Gotchas the spike found (now load-bearing for implementation):**
- vec0 rowid **must be bound as `BigInt`** — a plain JS number throws `"Only integers are allowed for primary key values"` (vec0 checks `SQLITE_INTEGER`).
- bit columns: `vec0(embedding bit[768])` — the inline `distance_metric=hamming` clause does **not** parse in v0.1.9; bit columns default to hamming.
- cipher pragmas must be set **before any I/O** on the connection (`cipher='sqlcipher'` then `key='…'`), then `journal_mode=WAL`.

## 4. THE PIVOT — brute-force 768-d does not meet the latency bar
The v1 claim ("brute-force fine < 100 k, no ANN needed") came from a **384-d** benchmark. At Mycelium's **768-d** it is refuted by measurement ([bench.mjs](../spike/sqlite-vec-encrypted/bench.mjs), [bench2.mjs](../spike/sqlite-vec-encrypted/bench2.mjs), 58 k rows, encrypted DB):

| Method | p50 | p95 | recall@10 vs full-768 |
|---|---|---|---|
| **full 768 brute (baseline)** | 1187 ms | 1213 ms | 100 % |
| 256-d matryoshka only | 412 ms | 495 ms | 64 % |
| **256-d top-200 → rescore 768** | **458 ms** | **550 ms** | **100 %** |
| binary hamming top-400 → rescore 768 | 18 ms | 30 ms | 25 % *(synthetic — untrustworthy)* |
| FTS5 bm25 keyword | 22 ms | 51 ms | n/a |

**Conclusion:** a single full-precision brute-force scan is too slow (~1.2 s/query) for interactive search. The fix is **two-stage retrieve-then-rescore**: generate a few hundred candidates cheaply over the full corpus, then re-rank them at full 768-d precision. **256-d matryoshka candidate generation → 768 rescore gives 100 % recall@10 at 550 ms p95 even on adversarial synthetic vectors**, and it *reuses the 256-d projection the codebase already computes* (`nomic_embedding`, today used only for clustering — [crypto-local.js:1688](../src/crypto/crypto-local.js), decoupled from `embedding_768`). Binary quantization is ~18× faster but its recall must be validated on **real** embeddings before it can be chosen (the 25 % is almost certainly a synthetic-data artifact — binary quantization needs sign-informative real vectors).

> Caveat: all recall numbers are on synthetic sin/cos vectors. The candidate-generation method (256-d vs binary vs both) is an **open decision gated on a real-embedding recall test** — re-run `bench2` against a decrypted sample of the live vault (§9 D-1).

## 5. Target architecture (sweep-verified shapes)
Storage tables (in the encrypted DB), maintained incrementally:
- **`fts_messages`** — FTS5 virtual table over `messages.content` (and document/profile text), `content=''` external-content or contentless mode keyed by message rowid. BM25 via `bm25()`. Maintained by triggers / on the existing write path (capture, import, forget).
- **`vec_messages_cand`** — sqlite-vec vec0 candidate index. **Decision D-1:** either `float[256]` (matryoshka) or `bit[768]` (binary) — chosen by the real-embedding recall test.
- **`vec_messages_full`** (or a plain `BLOB` column) — the full 768-d float vectors for the rescore stage, fetched by rowid for the ~200–400 candidates only.
- **Fusion:** reuse [rrf.js:15-67](../src/search/fusion/rrf.js) verbatim over the two SQL result sets (BM25 list + rescored vector list).

Query path (replaces the in-RAM `backend.query`):
1. FTS5 `MATCH` → top-K keyword hits + bm25 scores (~22 ms).
2. vec candidate scan (256-d or binary) → top-200..400 rowids (~400 ms / ~30 ms).
3. Fetch those candidates' full 768-d vectors, cosine-rerank in JS (or `vec_distance_cosine`) → top-K (cheap, bounded by candidate count).
4. RRF-merge (1) and (3) → final hits.

**Net effect:** `loadFromDb`, the inverted index ([index/inverted.js](../src/search/index/inverted.js)), and the in-RAM vector Map are **deleted**; memory drops from ~2 GB to the SQLite page cache; no build step; always-fresh. The public contract is preserved (see §6).

## 6. Contract to preserve (pre-deletion caller audit — done)
`backend.query(req)` returns `{ hits: [{id, score}], degraded, tier, takenMs }`; `bulkSearch(args)` returns the 5-layer `{ messages, documents, territories, realms, themes }`. Callers that must keep working unchanged:
- [src/search/index.js:49,77,152](../src/search/index.js) — `ensureBuilt` / `search` / `bulkSearch`.
- [src/tools/mindscape.js:135](../src/tools/mindscape.js) — `searchMindscape` MCP tool.
- [src/server-http.js:515](../src/server-http.js) — `POST /context`.
- [src/portal-chat.js:189](../src/portal-chat.js) — portal mid-turn search.
- [src/tools/documents.js:324](../src/tools/documents.js) — `findDocuments`.
- [src/jobs.js:201,365](../src/jobs.js) — `refreshSearchIndex` after clustering/enrichment (becomes a **no-op / cheap reconcile** once the index is incremental).
- [src/tools/curate.js:190](../src/tools/curate.js) — `forget` → `backend.delete` (maps to `DELETE FROM vec_* / fts_*`).
No dangling callers found. RRF logic is reusable verbatim.

## 7. Migration of the live 1.7 GB vault
- **Atomicity primitive exists:** [src/account/backup.js snapshotDb() 44-52](../src/account/backup.js) wraps better-sqlite3's online-backup API (WAL-folded single consistent file). Migration plan: snapshot → build new encrypted DB with FTS5 + vec tables populated from existing (decrypted) embeddings → atomic swap → keep snapshot as rollback.
- **Driver swap:** `better-sqlite3` → `better-sqlite3-multiple-ciphers` ([d1.js:32](../src/adapter/d1.js) is the single open site). Cipher key set before first I/O.
- **Migration framework:** [migrate.js:29-51](../src/db/migrate.js) re-execs every `migrations/*.sql` each boot, idempotent (column-presence guard for ADD COLUMN; CREATE TABLE IF NOT EXISTS otherwise). New `0015_*` files auto-run. **Caveat (from [[measurement-deadweight-audit]]): never use a migration for a one-time data prune** — the FTS5/vec backfill is a one-time *script*, not a migration.
- **Native build:** [scripts/build-app-bundle.sh:141](../scripts/build-app-bundle.sh) `rsync`s `node_modules` verbatim into the bundle — the new native modules must be present + built for the bundle's arch (prebuilt arm64 worked in the spike; **verify the Tauri bundle picks them up**, and add x86_64 if targeted).

## 8. Key lifecycle (sweep-verified)
The DB key composes with the existing keystore without changing it:
- USER_MASTER (64-hex) → SYSTEM_KEY via `crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32)` ([keystore.js:48-56](../src/account/keystore.js)). Add a **DB key** the same way: `info='mycelium:db-key:v1'`, all-zero salt, matching the existing domain-separated convention ([crypto-local.js:984-1055](../src/crypto/crypto-local.js)).
- Keys are held in session memory ([session-keys.js](../src/account/session-keys.js)) + Keychain + tmpfs; unlock is the hex paste at `/restore` ([account/router.js:101-115](../src/account/router.js)) → `setSessionKeys`.
- **Chicken-and-egg to resolve in design D-3:** boot opens the DB and runs `applyMigrations` *before* the user unlocks (KCV verify reads the DB). With whole-file encryption the DB key must be available **before the first read**. Options: (a) derive the DB key from USER_MASTER in the Keychain/tmpfs path at boot (key present before DB open, as today for the master key); (b) keep a small unencrypted bootstrap DB for KCV + gate the main encrypted DB behind unlock. **Recommendation: (a)** — the key material is already resolved pre-open today ([getMasterKey tmpfs/env 1778-1833](../src/crypto/crypto-local.js)); derive the DB key in the same step.

## 9. Open decisions for the operator
- **D-1 — candidate-generation method.** 256-d matryoshka (proven 100 % recall@10 / 550 ms on synthetic; reuses existing 256-d projection) vs binary quantization (30 ms but recall unproven on synthetic). **Gate — run the dedicated real-data harness [scripts/bench-search-recall.mjs](../scripts/bench-search-recall.mjs)** (read-only; decrypts only `embedding_768`; pure JS, no native modules):
  ```
  MYCELIUM_DB="$HOME/Library/Application Support/id.mycelium.app/mycelium.db" \
    node scripts/bench-search-recall.mjs --sample 6000 --queries 120
  ```
  Recommendation: **256-d as the safe default; adopt binary only if real-embedding recall@10 ≥ 95 %** (it would cut query latency ~18×). Hybrid (binary candidate → 256 mid → 768 rescore) is a later optimization, not v1.
- **D-2 — per-column encryption fate.** Once whole-file encryption lands, the per-column AES-GCM envelopes are redundant *for at-rest*. Keep them for **defense-in-depth** (two independent layers — CLAUDE.md §2) or simplify to reduce complexity? Security-critical; **recommendation: keep per-column for `content`/`embedding_768` in v1** (no security regression), revisit simplification as a separate audited step. *But note:* FTS5/vec must index **plaintext**, so the indexed copy is necessarily decrypted-within-the-encrypted-file — the threat model (§10) must accept that.
- **D-3 — boot/unlock key ordering** (see §8). Recommendation: (a) derive DB key pre-open.
- **D-4 — migration cadence.** In-place re-encrypt vs export→reimport into a fresh encrypted DB. Recommendation: **build-new + atomic swap** via `snapshotDb` (cleanest rollback), accept transient 2× disk (~3.4 GB) during migration.

## 10. Threat model delta
- **New at-rest posture:** whole-file encryption *adds* protection (skeleton/timestamps/counts now encrypted — closes [[at-rest-blindness]]). The indexed FTS5/vec content is plaintext *inside* the encrypted file — same exposure as today's decrypted-in-RAM corpus, now decrypted-in-page-cache. No regression; an improvement.
- **Key handling unchanged:** DB key is HKDF-derived from USER_MASTER, memory/Keychain/tmpfs only, never logged (CLAUDE.md §4). A lost key remains unrecoverable by design.
- **Fail-closed:** wrong key → DB unreadable (spike S3). Missing key → refuse to open (no plaintext fallback).
- **Embedding sensitivity (CLAUDE.md §7):** vectors are semantic fingerprints; they now live on-disk but inside the encrypted file. The candidate index (256-d or binary) is a *lossy* fingerprint — still sensitive, still inside the cipher boundary.

## 11. Test strategy
- `verify:search-ondisk` gate (new): build a small encrypted DB, insert N messages via the real write path, assert (a) ciphertext at rest, (b) FTS5 BM25 hit, (c) vec KNN hit, (d) RRF merge matches the in-RAM baseline's top-K on a fixture corpus, (e) forget removes from both indexes, (f) wrong key fails closed.
- **Recall regression:** a fixture of real (decrypted, anonymized) embeddings asserting candidate→rescore recall@10 ≥ threshold — guards D-1.
- Reuse the Phase 0 `verify:pipeline-integrity` harness pattern (boot a real DB, deterministic assertions).
- Parity test: same query through old in-RAM path and new on-disk path returns the same top-K on a seeded corpus (proves the contract §6 is preserved before deleting the old path).

## 12. Implementation order (each independently shippable)
1. Add `better-sqlite3-multiple-ciphers` + `sqlite-vec` deps; wire the native build into `build-app-bundle.sh`; `verify` they load in the bundle. *(no behavior change yet)*
2. DB key derivation (§8) + driver swap behind a flag; boot opens encrypted DB; KCV passes. *(at-rest-blindness lands here)*
3. Create FTS5 + vec tables (`0015_*`); backfill **script** from existing embeddings; maintain on the write path (capture/import/forget).
4. New on-disk `backend.query` (two-stage retrieve-rescore) behind a flag; parity test vs in-RAM.
5. Flip the flag; delete `loadFromDb` + inverted index + vector Map (pre-deletion caller audit §6 already done); `refreshSearchIndex` → cheap reconcile.
6. Live 1.7 GB migration runbook (snapshot → build-new → swap), operator-run with keys.

## 13. Decision criteria to proceed past the design
- D-1 resolved by the real-embedding recall test (falsifiable: recall@10 ≥ 95 % at < 600 ms p95).
- Native modules confirmed loading **inside the Tauri bundle** (not just `npm` on this machine).
- Parity test green (old vs new top-K) before any deletion.

## 14. Open questions deferred
- ANN (HNSW) — sqlite-vec v0.1.9 is brute-force only; not needed with two-stage retrieve-rescore < ~200 k rows. Revisit if the vault crosses ~200 k.
- Clustering's content-NULL `clustering_points` inclusion (noted in Phase 0) — fold into a source-sync hardening pass.
- Cross-machine / federation search — out of scope.

## 15. Verification table (load-bearing assumptions)
| Assumption | Status | Verified at |
|---|---|---|
| sqlite-vec loads + runs on an encrypted DB | **PROVEN** | spike S5 ([spike.mjs](../spike/sqlite-vec-encrypted/spike.mjs)) |
| Whole-file encryption yields ciphertext at rest, fail-closed | PROVEN | spike S2/S3/S8 |
| FTS5 BM25 available in same build | PROVEN | spike S7 |
| vec0 insert/KNN/persist/delete works (BigInt rowid) | PROVEN | spike S6/S9 ([spike6.mjs](../spike/sqlite-vec-encrypted/spike6.mjs)) |
| Brute-force 768-d is too slow @ 58 k (pivot) | PROVEN | [bench.mjs](../spike/sqlite-vec-encrypted/bench.mjs) 1.2 s |
| 256-d→rescore restores recall at acceptable latency | PROVEN (synthetic) | [bench2.mjs](../spike/sqlite-vec-encrypted/bench2.mjs) 100 % / 550 ms |
| Binary-quant recall | UNPROVEN — needs real data | D-1 gate |
| DB file open is a single site; WAL+FK only today | VERIFIED | [d1.js:32-34](../src/adapter/d1.js) |
| Per-column envelope, embedding_768 not auto-decrypted | VERIFIED | [crypto-local.js:235-239,1685-1696](../src/crypto/crypto-local.js) |
| RRF reusable over SQL result sets | VERIFIED | [rrf.js:15-67](../src/search/fusion/rrf.js) |
| Full caller list of the index (deletion audit) | VERIFIED | §6 citations |
| HKDF helper + convention for a DB key | VERIFIED | [keystore.js:48-56](../src/account/keystore.js) |
| Keys resolved pre-DB-open (enables D-3 option a) | VERIFIED | [crypto-local.js:1778-1833](../src/crypto/crypto-local.js) |
| Online-backup atomic-migration primitive exists | VERIFIED | [backup.js:44-52](../src/account/backup.js) |
| Migration framework re-execs idempotently each boot | VERIFIED | [migrate.js:29-51](../src/db/migrate.js) |
| Bundle rsyncs node_modules verbatim (native build risk) | VERIFIED | [build-app-bundle.sh:141](../scripts/build-app-bundle.sh) |
| Native modules build prebuilt on arm64-darwin | PROVEN (this machine) | spike install; **bundle-load still to verify (§13)** |
