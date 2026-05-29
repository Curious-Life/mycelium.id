# mind-search — Performance Budget

These numbers are **committed**. CI tests enforce them. A regression that
breaches the budget fails the build; it does not log a warning and continue.

Reference platform for budget verification: 4 GB RAM, 2 vCPU Linux VM —
the customer-VPS class. CI runs perf tests on a runner of equivalent
class, or skips them with an explicit env flag and runs them on the
owner VPS pre-merge.

## Latency

| Metric                              | Budget     | Test                                    |
|-------------------------------------|------------|-----------------------------------------|
| Search p50, warm, default precision | < 100 ms   | `tests/mind-search/perf/latency.test.js` |
| Search p99, warm, default precision | < 300 ms   | same                                    |
| Search p99, with Haiku rerank       | < 800 ms   | same                                    |
| Embedder cold start                 | < 5 s      | `tests/embed-service/cold-start.test.js`|
| Embedder p99 single-query           | < 80 ms    | `tests/embed-service/latency.test.js`   |
| Cold index rebuild, 100K msgs       | < 60 s     | `tests/mind-search/perf/index-rebuild.test.js` |
| Warm index load (encrypted snap)    | < 5 s      | `tests/mind-search/perf/index-warm-load.test.js` |
| Cosine over 5000 candidates         | < 30 ms    | `tests/mind-search/ann/perf.test.js`    |

Tolerance: ±10% on latency budgets (CI noise). Hard fail on memory budgets.

## Memory

| Metric                                     | Budget   | Test                                          |
|--------------------------------------------|----------|-----------------------------------------------|
| Agent process RSS at rest, 100 K corpus    | < 700 MB | `tests/mind-search/perf/memory-rest.test.js`  |
| Agent process RSS, 100 concurrent searches | < 900 MB | `tests/mind-search/perf/memory-load.test.js`  |
| Embedder service resident                  | < 350 MB | `tests/embed-service/memory.test.js`          |
| Inverted index (100 K msgs, ~50 tokens avg) | < 280 MB | `tests/mind-search/index/memory.test.js`      |
| Inverted index, STRICT (typed-array path)  | < 150 MB | same, set `MIND_SEARCH_PERF_STRICT=1`         |

### Inverted-index sizing — measured

Initial measurement (PR 5, 2026-04-27, Node 22, fresh V8 heap):

| Corpus                             | Heap delta | Lookup p99 | BM25 query (5 tokens) |
|------------------------------------|------------|------------|-----------------------|
| 100 K docs, avg 50 tokens, Zipf vocab=50 K | 240.8 MB   | < 0.01 ms  | 35.7 ms               |

The 240 MB cost is dominated by **4.8 M Posting objects** — V8 representation
of `{ id: string, tf: number }` is ~50 bytes each. Future optimization to
typed-array postings (Uint32Array of internal-id + Uint8Array of tf) is
projected at ~50–60% reduction; landed when a real customer hits the budget,
not preemptively.

**Trigger to revisit:** single-tenant corpus > 250 K messages (extrapolates
to ~600 MB and crowds the agent-process RSS budget).

## Storage on disk (encrypted)

| Metric                                  | Budget        |
|-----------------------------------------|---------------|
| Per-vector D1 BLOB (768 floats + envelope) | ≈ 3132 bytes |
| Vector storage at 100 K msgs (D1)       | ~350 MB       |
| Inverted index snapshot at 100 K msgs   | < 80 MB       |

## Capacity envelope

Brute-force ANN scales linearly. The budgets above are the operating
regime; the table below documents what happens beyond.

| Corpus      | Index RAM | D1 vectors | Cold rebuild | Warm load | ANN p99 |
|-------------|-----------|------------|--------------|-----------|---------|
| 21 K        | ~10 MB    | ~75 MB     | ~10 s        | < 1 s     | < 50 ms |
| 100 K       | ~50 MB    | ~350 MB    | ~60 s        | < 5 s     | ~100 ms |
| 500 K       | ~250 MB   | ~1.7 GB    | ~5 min       | ~15 s     | ~300 ms |
| 1 M         | ~500 MB   | ~3.5 GB    | ~10 min      | ~30 s     | ~600 ms |

**Triggers to revisit the architecture:**
- 500 K single-tenant: ANN p99 crosses 300 ms → consider IVF-Flat partitioning
- 1 M single-tenant: D1 storage cost dominant → consider archive policy
- Inverted index > 200 MB: enable age-based eviction

## How CI enforces this

1. Per-PR sample (subset) runs on the standard CI runner. Tolerates
   ±10% on latency.
2. Pre-merge full perf suite runs on the owner VPS via `bash scripts/verify-deploy.sh --perf`.
   Hard-fails on any breach.
3. Nightly bench harness records latency p50/p99 across the labeled
   query set (200 queries) and writes `tests/bench/results-<sha>.json`
   to a tracked log file.
4. Production alerts: Sentry fires when rolling p99 over 5 min crosses
   the budget on any production agent.

## Changelog (when budgets change)

| Date       | Metric                                | Old      | New      | Reason                                      |
|------------|---------------------------------------|----------|----------|---------------------------------------------|
| 2026-04-27 | (initial commit)                      | —        | —        | PR 1 — first commit of budget               |
| 2026-04-27 | Inverted index, 100 K msgs            | < 60 MB  | < 280 MB | PR 5 measured 240 MB; original was theoretical guess. Typed-array compactness deferred until a customer hits the new ceiling. |
| 2026-04-27 | Agent RSS at rest                     | < 500 MB | < 700 MB | Knock-on from inverted-index reality        |
| 2026-04-27 | Agent RSS, 100 concurrent searches    | < 700 MB | < 900 MB | Same                                        |
