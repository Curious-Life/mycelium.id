# Search Index — On-Disk Architecture (Phase 1) — Design Direction (2026-06-16)

**Status:** DIRECTION / SCOPING — research done, decisions framed. **Needs its own full sweep-first pass before implementation** (it's a storage-engine migration on a 1.7 GB encrypted vault — the highest-blast-radius change in the codebase). Companion to [PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16](PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16.md) (Phase 0, shipped).

## 0. Why
Phase 0 made the in-memory index *cooperative* (no event-loop freeze) — but the architecture is still: decrypt the **entire corpus** into the heap and rebuild a JS inverted index + vector Map on first search. At 58k messages that's ~2 GB resident and seconds of CPU per build; it does not scale, and the index goes stale between Generates. The durable fix is to stop holding the corpus in app memory at all.

## 1. What the ecosystem does (research 2026-06-16)
The local-first memory/RAG consensus is an **on-disk, SQLite-native index**: **FTS5** (built-in BM25) for keyword + **sqlite-vec** for vectors, fused with **RRF**. The index lives on disk, is maintained *incrementally* (FTS5 triggers / sqlite-vec inserts on write), and queries run in C. Brute-force vectors are fine below ~100k rows (≈50k×384-d < 1 s/query), so no ANN is needed at our scale. **Mycelium already does BM25 + vector + RRF** — but in JS, in RAM, rebuilt from the whole corpus. The fix is to move that exact pipeline onto SQLite's on-disk primitives.
- MemPalace (best-benchmarked OSS memory system): persistent on-disk ChromaDB + SQLite KG — persistent, not rebuilt-in-RAM.
- sqlite-vec + FTS5 + RRF is the documented standard for SQLite-backed RAG.

Sources: [sqlite-vec hybrid FTS5+vector](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) · [Hybrid FTS5+Vector+RRF](https://ceaksan.com/en/hybrid-search-fts5-vector-rrf) · [Local-First RAG with SQLite](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/) · [MemPalace analysis](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-mempalace.md) · [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers).

## 2. The Mycelium-specific constraint — and the unlock
The in-memory index exists **because content + embeddings are encrypted per-column at rest** ([d1-loader.js:117-119](../src/search/d1-loader.js) decrypts each vector; the adapter auto-decrypts content). FTS5/sqlite-vec can't index ciphertext, and writing a plaintext index to disk would break encryption-at-rest (§1/§7). That's why everything is decrypted into RAM.

**The unlock — this merges with [[at-rest-blindness]].** That design already recommends **whole-file encryption** (`better-sqlite3-multiple-ciphers`, DB key HKDF from USER_MASTER, ChaCha20-Poly1305 or SQLCipher/AES). If the whole DB file is encrypted, then:
- content/embeddings can live as plaintext *within the encrypted file* (decrypted only in the page cache),
- **on-disk FTS5 + sqlite-vec indexes are themselves encrypted at rest** (they're pages in the same file),
- search runs in C on disk, incrementally maintained — **no JS rebuild, no resident corpus, no event-loop work**.

So **one migration solves both** the search-scaling problem *and* the at-rest-blindness gap (structural skeleton / timestamps / counts become encrypted too). This is the recommended target.

## 3. Target architecture (to be sweep-verified)
- **Storage:** swap `better-sqlite3` → `better-sqlite3-multiple-ciphers`; open with the DB key (HKDF from USER_MASTER); per-column AES envelopes become redundant for at-rest (whole-file covers it) — *decide* whether to keep per-column for defense-in-depth or simplify (a real decision for the sweep).
- **Keyword:** FTS5 virtual table over `messages.content` (+ profiles), maintained by triggers on insert/update/forget. BM25 via FTS5's `bm25()`.
- **Vector:** `sqlite-vec` virtual table holding the 768-d embeddings; brute-force KNN in C (fine < 100k). Insert on embed; delete on forget.
- **Fusion:** keep the existing RRF merge, now over two SQL result sets instead of two in-RAM backends.
- **Net effect:** `loadFromDb` / the in-memory inverted index + vector Map are **deleted**; search becomes two SQL queries + RRF. Memory drops from ~2 GB to the page cache; no build step; always-fresh.

## 4. Load-bearing questions the sweep MUST answer (do not implement before these)
1. **Does `sqlite-vec` load + run inside a `better-sqlite3-multiple-ciphers` (encrypted) DB?** Extension loading on an encrypted connection — verify with a spike (the one public unknown; treat as a hard gate).
2. **Migration of a live 1.7 GB vault**: re-encrypt whole-file + build FTS5 + populate sqlite-vec from existing encrypted embeddings. Time, disk, atomicity, rollback. (The at-rest-blindness memory already flags a "driver swap + vault migration" — reconcile.)
3. **Bundle/native-build**: `better-sqlite3-multiple-ciphers` + `sqlite-vec` are native modules — do they build for the Tauri sidecar on all target platforms? (macOS arm64 first.)
4. **Encryption-boundary semantics**: with whole-file encryption, what happens to the per-column `ENCRYPTED_FIELDS` + the scope guardian? Keep, simplify, or layer? (Security-critical decision.)
5. **Key lifecycle**: DB key derivation, where it's held, unlock flow, recovery — must compose with the existing keystore (USER_MASTER / SYSTEM_KEY).
6. **WAL + cipher**: `better-sqlite3-multiple-ciphers` requires care with WAL pragmas — verify performance + correctness.

## 5. Fallback (if Phase 1b can't land near-term)
**Persist the built index encrypted** (Phase 1a): serialize the inverted index + vectors → one AES-GCM blob under USER_MASTER → load+decrypt on boot instead of rebuilding from 58k rows. Kills the rebuild cost but stays ~2 GB resident (doesn't fix memory). A stopgap, not the destination — only if 1b slips.

## 6. Recommendation
Pursue **Phase 1b** (whole-file SQLCipher + FTS5 + sqlite-vec) as the target — it's how the ecosystem does it, it scales well past 58k, and it merges the performance fix with the at-rest-blindness security upgrade. Gate it behind the §4 sweep (especially Q1 — the sqlite-vec-on-encrypted-DB spike). Phase 0 already restored responsiveness, so there is **no emergency pressure** to rush 1b — design it right.

## 7. Open questions deferred
- ANN (HNSW) — not needed < 100k; revisit only if the vault crosses ~200k rows.
- Clustering's content-NULL `clustering_points` inclusion (noted in Phase 0 sweep) — fold into a source-sync hardening pass.
- Cross-machine / federation search — out of scope.
