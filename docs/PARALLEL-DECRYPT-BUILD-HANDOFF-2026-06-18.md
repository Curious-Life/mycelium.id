# Handoff — Parallel worker-thread corpus decrypt (the "5.2× build" candidate)

**Status:** PROVEN lever, *not built*. Parked as a **next isolated build** — NOT
release-blocking (the cooperative one-time build already ships and is responsive). Pick up
when new-user first-build latency on large imports becomes worth the worker-pool complexity.

Author: at-rest perf session, 2026-06-18. Shipped sibling work on branch
`fix/at-rest-migration-lock` (PR #256): batched build (`e6043cc`), cooperative paginated read
(`7c95244`). Spikes: `scripts/spike-parallel-decrypt.mjs` (`0431210`),
`scripts/spike-parallel-build.mjs`. See [[at-rest-search-build-perf]].

---

## TL;DR

The one-time index build's dominant cost is the single-threaded SQLCipher page-decrypt scan of
the corpus (measured **312.9s** for 69,447 msgs on the real 2GB vault; the insert is only
~49s). That scan is CPU-bound and embarrassingly parallel. **Proven: K worker threads, each
with their OWN read-only keyed SQLCipher connection over a disjoint rowid range, scan+decrypt
in parallel → 5.2× at 8 threads** (`spike-parallel-decrypt.mjs`). End-to-end (workers →
IPC → single-writer index insert) the win is bounded by the **~49s insert floor** (the index
is one DB, one writer): real-vault projection `max(313/8, 49) + IPC ≈ ~50-90s vs 362s` →
**~4-6× on the one-time build**. Bounded value (one-time/rebuild only; steady state is
incremental index-on-write), which is why it's parked, not shipped.

## Evidence (read carefully — one spike is unfaithful)

- `spike-parallel-decrypt.mjs` (SCAN only): 469MB encrypted DB, 1T 3.74s → 4T 1.03s (3.6×) →
  8T 0.71s (**5.2×**). Proves the page-decrypt scan parallelizes near-linearly.
- `spike-parallel-build.mjs` (END-TO-END, workers→IPC→insert): showed only **1.3×**. **This
  spike is UNFAITHFUL** — it stored plain text + raw blobs, so its scan was artificially cheap
  (~3.7s) and the build was *insert-bound* (insert ~22s). The REAL vault has the INVERTED
  ratio (scan 313s ≫ insert 49s), so the real end-to-end win is ~4-6×, not 1.3×. Lesson: a
  faithful end-to-end spike must encrypt content+embedding as real envelopes (so workers pay
  the real SQLCipher page-decrypt + envelope decrypt) — see "Open question" below.
- The IPC works: workers transfer decrypted vectors as zero-copy ArrayBuffers; text is copied
  (~1.1GB on the real vault → ~2-3s). Main inserts as batches stream in (overlaps the scan).

## Recommended design (when picked up)

- **Worker pool** of `K = min(cores-1, 8)`. Each worker: `new Database(dbPath,{readonly:true})`
  + `cipher='sqlcipher'` + `key=x'<dbKeyHex>'`; scan `WHERE rowid >= ? AND rowid < ?` over its
  slice; for each row decrypt `content` (crypto-local `decrypt`) + `embedding_768`
  (`decryptVector`); post batches `{id, text, vec:ArrayBuffer}` with the vec ArrayBuffers in the
  transfer list.
- **Main = single writer.** Receives batches and inserts via the existing `backend.bulkAdd`
  (FTS5 + vec0). Streaming insert overlaps worker scan → wall ≈ max(scan/K, insert).
- **Key passing:** pass `dbKeyHex` (cipher) + the master key as RAW bytes via `workerData`;
  re-import the HKDF CryptoKey inside the worker. Same trust boundary as the main process
  (key already in `process.env`); never log key material (CLAUDE.md §1/§4).
- **Opt-in + fail-safe:** gate behind a flag/threshold (only worthwhile for large corpora,
  e.g. > 10k rows). ANY worker error → fall back to the proven cooperative serial path for the
  remaining ranges. The serial path (shipped) stays the default/fallback.
- Only the `messages` source needs this (the one large table). Profiles/documents stay serial.

## Open question to resolve first

Run a FAITHFUL end-to-end spike (real content+embedding envelopes; workers decrypt via
crypto-local with the master key passed as raw bytes) to confirm the real-vault ~4-6× before
committing the worker pool. The current `spike-parallel-build.mjs` understates it (wrong
scan/insert ratio). If the faithful number is < ~2.5×, the worker-pool complexity isn't worth
it — keep the cooperative serial build.

## Why parked / not release-blocking

- The user-facing problem (frozen app for days) is ALREADY fixed by the cooperative one-time
  build (responsive, persisted, skipped on every later boot).
- This only speeds the ONE-TIME first build / rare full rebuilds; steady state is incremental.
- The win (~4-6×) is real but trades reliability (worker pool, IPC, keys-in-workers) for speed
  on a one-time event. For a one-time build, simple+reliable was judged > fast+complex.

## Pickup protocol

1. Faithful end-to-end spike (above) → confirm ≥ ~2.5×.
2. `/sweep-first-design`: the loader's messages source (`src/search/d1-loader.js`, paginated
   path) is the integration point; `backend.bulkAdd` is the single-writer sink.
3. Build the pool behind a flag + serial fallback; gate (`verify:search-parallel-build`:
   correctness parity vs serial + speedup assertion on an encrypted fixture).
4. Live-smoke on a vault COPY first.
