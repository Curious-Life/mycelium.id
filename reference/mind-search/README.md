# mind-search

On-VPS hybrid search: vector ANN + BM25 + temporal boost + optional rerank.
Replaces BGE-M3 + Cloudflare Vectorize. Runs in 4 GB RAM. Zero new dependencies.

For the *why* and the *whole plan*, see:

- [docs/MIND-SEARCH-UPGRADE-PLAN.md](../../../docs/MIND-SEARCH-UPGRADE-PLAN.md) — design
- [docs/MIND-SEARCH-IMPLEMENTATION.md](../../../docs/MIND-SEARCH-IMPLEMENTATION.md) — PR roadmap

## Public API

```js
import { createMindSearch } from '@mycelium/core/mind-search/index.js';

const mind = createMindSearch({
  db,                                // @mycelium/core db backend
  embedder,                          // POST /embed client
  masterKey,                         // loaded CryptoKey from tmpfs
  scopes: ['personal'],              // allowed scope tags for this caller
  userId,                            // tenant id
  logger,                            // optional, child of agent-server logger
  persistPath,                       // optional, path for encrypted snapshot
});

await mind.add({ id, text, ts });
const result = await mind.query({ text, topK: 10, recency: 'mixed' });
// → { hits, degraded, tier, reason?, takenMs }
```

The contract — `MindBackend` — is defined in [`backend/interface.js`](backend/interface.js)
as JSDoc typedefs. Implementations conform to those signatures exactly.

## Invariants (must always hold)

1. **No plaintext on disk.** The persisted index snapshot is AES-256-GCM
   encrypted using `crypto-local.js` envelope, same scope tags as DB columns.
2. **No content in logs.** Every log call routes content through
   [`log-redact.js`](../log-redact.js). A grep test in CI asserts this.
3. **No cross-scope reads.** `query()` rejects if any decrypted vector's
   envelope scope is not in `deps.scopes`. Throws `ScopeMismatchError`.
4. **No cross-tenant reads.** Every D1 query carries `WHERE user_id = ?`.
5. **No silent empty.** `hits: []` is returned only when the corpus is
   genuinely empty for the filter. Every other empty case carries
   `degraded: true` + a `tier` + a `reason`.
6. **Master key never logged, never returned, never persisted.** Used only
   to derive scope keys and pass to `crypto-local.js`.
7. **No new npm or system dependencies** beyond what's installed today.

## Degradation tiers

`query()` selects the highest-quality tier its dependencies allow:

| Tier | Mode                                          | Used when                          |
|------|-----------------------------------------------|------------------------------------|
| 0    | Embed + ANN + BM25 + temporal + Haiku rerank  | All up; `precision: 'high'`        |
| 1    | Embed + ANN + BM25 + temporal                 | Default, all up                    |
| 2    | BM25 + temporal (no semantic)                 | Embed service down/timed out       |
| 3    | BM25 on hot subset (last 30 d)                | Index not yet warm                 |
| 4    | SQL `LIKE` on last 1000 messages              | Index unavailable                  |

Every degraded response carries `{ degraded: true, tier, reason }`. Tier 4
is the floor — if it returns empty, the response is an error, not silent.

## Module layout

```
mind-search/
├── index.js              public factory
├── errors.js             typed error classes (tagged for log/Sentry)
├── README.md             you are here
├── PERFORMANCE-BUDGET.md committed numbers, enforced by CI
├── backend/
│   ├── interface.js      JSDoc contract (MindBackend)
│   ├── local.js          default impl                          (PR 8)
│   └── vectorize.js      transition impl, dropped Phase 7      (PR 8)
├── ann/
│   ├── decode.js         encrypted BLOB → Float32Array         (PR 4)
│   └── cosine.js         vectorized cosine over Float32Array   (PR 4)
├── index/
│   ├── tokenize.js       lowercase + word-break + stop-words   (PR 5)
│   ├── inverted.js       in-memory token→postings              (PR 5)
│   ├── bm25.js           standard scorer                       (PR 5)
│   └── persist.js        encrypted snapshot to disk            (PR 6)
├── fusion/
│   ├── rrf.js            reciprocal rank fusion (k=60)         (PR 7)
│   └── temporal.js       exp(-Δt/τ) boost                      (PR 7)
├── rerank/
│   └── haiku.js          opt-in batch rerank                   (PR 8)
├── degrade/
│   ├── probe.js          health checks (cached 1s)             (PR 9)
│   └── tiers.js          tier orchestrator                     (PR 9)
└── metrics.js            structured log emission               (PR 8)
```

## Status

PR 1 (this commit): factory shape, contract, error types, no behavior.
Stubs throw `NotImplementedError`. Interface tests pin the surface.

Subsequent PRs land behavior. See implementation plan for the schedule.
