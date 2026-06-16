# Spike: sqlite-vec + FTS5 inside an encrypted better-sqlite3-multiple-ciphers DB

Throwaway evidence for the Phase 1 search-index design (2026-06-16). Proves (or
refutes) the load-bearing unknowns with running code, per the repo's
"hard evidence over paper reasoning" rule.

## Run

```
mkdir -p /tmp/myc-spike-sqlitevec && cd /tmp/myc-spike-sqlitevec
npm init -y && npm pkg set type=module
npm install better-sqlite3-multiple-ciphers sqlite-vec
cp <repo>/spike/sqlite-vec-encrypted/*.mjs .
node spike.mjs    # the GATE: vec-on-encrypted + fail-closed + FTS5 + WAL+cipher
node spike6.mjs   # vec0 insert/KNN/persist/delete lifecycle (BigInt rowid)
node bench.mjs    # brute-force latency @ 58k×768d (the PIVOT)
node bench2.mjs   # retrieve-then-rescore methods: 256-d matryoshka vs binary
```

## Verdicts (this machine: macOS arm64, node v22, prebuilt binaries)

| Spike | Result |
|---|---|
| GATE — sqlite-vec v0.1.9 loads + runs on an encrypted (SQLCipher cipher) connection | **GO ✅** |
| On-disk file is ciphertext (no `SQLite format 3` header); `-wal` also ciphertext | GO ✅ |
| Wrong key cannot read (fail-closed) | GO ✅ |
| FTS5 + `bm25()` in the same build | GO ✅ (22ms @ 58k) |
| WAL + cipher correctness (write→checkpoint→reopen) | GO ✅ |
| vec0 insert / KNN / persist-across-reopen / incremental DELETE | GO ✅ (**rowid must be `BigInt`**) |
| Brute-force 768-d KNN < 1s @ 58k | **NO-GO ❌ — 1.2s p50 / 1.4s p95** (refutes the paper claim) |
| 256-d matryoshka top-200 → rescore 768 | recall@10 **100%**, **550ms p95** |
| binary hamming top-400 → rescore 768 | **30ms** but recall@10 **25%** on synthetic — NEEDS real-embedding validation |

## Gotchas found

- `vec0` rowid bind **must be `BigInt`** — a plain JS number is rejected with
  `"Only integers are allowed for primary key values"` (vec0 checks `SQLITE_INTEGER`).
- bit columns: `vec0(embedding bit[768])` — the inline `distance_metric=hamming`
  clause does **not** parse in v0.1.9; bit columns default to hamming.
- Prebuilt arm64-darwin binaries installed in ~8s (no node-gyp compile needed here).

## Caveat

`bench2.mjs` uses **synthetic** sin/cos vectors. The 256-d 100% recall is on an
adversarial distribution and is encouraging; the binary 25% recall is almost
certainly a synthetic artifact (binary quantization needs real, sign-informative
embeddings). **Before choosing the candidate-generation method, re-run `bench2`
against a decrypted sample of the real vault's `embedding_768` vectors.**
