# Embed-service (Nomic v1.5 ONNX, :8091) — notes

Local embedding service that turns text into **768-dim** vectors using
`nomic-ai/nomic-embed-text-v1.5` exported to ONNX (int8 quantized,
`onnx/model_quantized.onnx`), plus a thin JS client. CPU-only,
loopback-only, no external API calls at inference time.

Ported from `reference/pipeline/embed-service.py` — the model-loading,
mean-pooling, L2-normalization, and HTTP contract are preserved verbatim in
spirit (only the docstring/comments and the venv path in the usage line were
adapted for this repo's `pipeline/` layout).

## Files

| File | Role |
|---|---|
| `pipeline/embed-service.py` | HTTP service, binds `127.0.0.1:8091`. |
| `pipeline/requirements-embed.txt` | Pinned **embed-service** deps (numpy, onnxruntime, tokenizers, huggingface-hub). |
| `pipeline/requirements.txt` | Pinned **clustering/topology** deps for Generate (faiss, igraph, leidenalg, scikit-learn, umap, scipy, ripser, cryptography, python-dotenv…). |
| `pipeline/setup.sh` | Creates `pipeline/.venv` and installs **both** dep sets (embed = fatal, clustering = non-fatal), optionally warms the model cache. |
| `src/embed/client.js` | `createEmbedClient({ baseUrl })` → `embed(text, task)` / `embedBatch(texts, task)` / `health()`. |
| `scripts/verify-embed.mjs` | Tiered verification ledger (`npm run verify:embed`). |
| `tests/embed-client.test.js` | Client unit tests against a mock server (`npm test`). |

## Endpoints (service)

- `GET  /health` → `{ "status": "ok"|"loading"|"error", "model": "nomic-v1.5", "loaded": bool, "dim": 768 }`
- `POST /embed`  → body `{ "text": "...", "task": "query"|"document" }` → `{ "embedding": [...768...], "dim": 768, "model": "nomic-v1.5", "task": "..." }`
- `POST /batch`  → body `{ "texts": [...], "task": "query"|"document" }` → `{ "embeddings": [[...], ...], "count": N, "dim": 768, "model": "nomic-v1.5", "task": "..." }`

### Mandatory Nomic v1.5 task prefixes

Callers pass the **task** name; the service prepends the on-wire prefix
before tokenization. These are the exact strings the model was trained with
— a mismatched prefix at index vs query time tanks recall.

| task | prefix |
|---|---|
| `query` | `search_query: ` |
| `document` | `search_document: ` |

> The reference service is the **search-side** entrypoint and intentionally
> exposes only `query`/`document`. The `clustering: ` prefix (256D matryoshka)
> lives in the separate `cluster.py` consumer, kept apart so the two evolve
> independently. An unknown task is rejected (HTTP 400 / client
> `EmbedServiceError`).

## Security

- Binds `127.0.0.1` only (loopback). Never expose port 8091 (CLAUDE.md §13).
- Embedding vectors are semantic fingerprints of plaintext — treat with the
  same paranoia as plaintext (CLAUDE.md §7). The service suppresses HTTP
  access logs (request paths could leak to journald), never logs request
  bodies, and never returns a stack trace over the wire (CLAUDE.md §1).

## Running where the model can download

The model + tokenizer auto-download from the HuggingFace Hub on first use
(`onnx/model_quantized.onnx`, `tokenizer.json`). This requires **network
access on the first run**; afterwards it is served from the HF cache
(set `HF_HOME` to pin the cache; `HF_HUB_OFFLINE=1` to force cache-only).

```bash
bash pipeline/setup.sh                          # venv + deps + warmup (downloads model)
EMBED_SKIP_WARMUP=1 bash pipeline/setup.sh      # deps only, no download
pipeline/.venv/bin/python3 pipeline/embed-service.py --serve --port 8091
```

Smoke test once running:

```bash
curl -s 127.0.0.1:8091/health
curl -s -X POST 127.0.0.1:8091/embed \
  -H 'content-type: application/json' \
  -d '{"text":"hello world","task":"query"}' | head -c 120
```

## Verification status (honest)

Run `npm run verify:embed`.

- **Tier 1 — VERIFIED (gates the VERDICT).**
  - `src/embed/client.js` drives a mock embed-service: correct path/body for
    `/embed` and `/batch`, 768-dim parsing, health parse, client-side task
    validation, 4xx surfacing (with `status`), and a clear "unreachable"
    error when the service is down.
  - `pipeline/embed-service.py` parses clean via `python3 ast.parse`.
- **Tier 2 — ATTEMPTED, SKIPPED in this container.** The real service start +
  live embed requires Python deps and a HuggingFace model download. In the
  build container the Python deps (numpy/onnxruntime/tokenizers/huggingface-hub)
  are not installed **and** outbound network to `huggingface.co` is blocked
  (verified: HTTP 403), so the ledger records a **SKIP** with reason — it does
  not fabricate a pass. On a host where `pipeline/setup.sh` has run and the
  first download can reach the Hub, this tier exercises
  `embed("hello world", "query")` and asserts a 768-dim vector.
- **Parity (R2) — DEFERRED.** True cosine ≥ 0.999 parity against the
  production embed-service needs a reference vector that is not available
  here. This is a deferred gate; it is intentionally not asserted and not
  faked.

## Repo-state note (for the coordinator)

This worktree did **not** contain a pre-existing Node project — no
`package.json`, no `scripts/verify.mjs`, no `src/client.js`, and the branch
had no commits. The task brief assumed an existing green base
(`npm run verify` → two `VERDICT: GO`); that scaffolding was absent, so there
was **no base ledger to confirm green** and none was fabricated. A minimal
`package.json` (`type: module`, `verify:embed`, `test`) was added so this unit
is self-verifiable and cleanly independent, as intended. `src/mcp.js` was not
created/edited (no MCP tool depends on embed-service).

## Wiring note

No MCP tool depends directly on the embed-service. Consumers
(`mind-search`, the enrichment service) inject a client via
`createEmbedClient(...)`.
