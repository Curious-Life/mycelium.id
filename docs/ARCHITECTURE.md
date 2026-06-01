# Mycelium V1 — System Architecture (as built)

> **As-built**, not as-designed. This doc describes what the code *currently is*.
> The *plan* (what we're building + order) lives in [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md);
> the running build journal lives in the `V1-BUILD-HANDOFF-*.md` files. Kept
> current via the `living-docs` skill. Status markers: ✅ built+verified ·
> ◑ partial · ⚠️ Tier-2/gated · ⬜ planned.

## 1. What it is

A self-hosted, **single-user** MCP server — a private "cognitive vault." It
ingests a person's messages/documents, encrypts everything at rest, embeds +
enriches it locally, and serves it back to an MCP client (Claude Desktop/CLI/
mobile) through tools. No multi-tenancy, no autonomous agent loop — it's a pure
tool server (decision D5).

## 2. Process model & run modes

One Node entry point, `src/index.js`, selects a mode:

| Mode | Command | Surface |
|---|---|---|
| MCP stdio (default) | `npm start` | MCP over stdio for a local client |
| MCP Streamable HTTP | `npm run start:http` (`--http` / `MYCELIUM_HTTP=1`) | remote MCP + OAuth |
| REST | `npm run rest` | REST over the shared handler map |
| Enrichment service | `npm run start:enrich` (`--enrich`) | the `:8095` background enricher |

Two **sidecar services** run as their own processes:
- **`:8091` embed-service** — Nomic v1.5 ONNX embeddings (`pipeline/embed-service.py`), ⚠️ Tier-2 (needs onnxruntime/model installed).
- **`:8095` enrichment** — embed-on-write + NLP drain (`src/enrich/server.js`). ✅

## 3. Components

| Component | Path | Status |
|---|---|---|
| Entry point / mode switch | `src/index.js` | ✅ |
| MCP server (tool registration) | `src/mcp.js` | ✅ |
| Streamable HTTP transport | `src/server-http.js` | ✅ |
| REST surface | `src/server-rest.js`, `src/api.js` | ✅ |
| OAuth 2.1 + PKCE (better-auth) | `src/auth.js` | ✅ |
| D1/SQLite storage adapter | `src/adapter/d1.js` | ✅ |
| DB namespaces (per table) | `src/db/*.js` | ✅ |
| Migration runner | `src/db/migrate.js` + `migrations/000*.sql` | ✅ |
| Scope-partitioned crypto (two-key vault) | `src/crypto/crypto-local.js`, `src/crypto/keys.js`, `src/crypto/guardians/*` | ✅ |
| Master-key source (env / macOS Keychain / 1Password) | `src/crypto/key-source.js`, `scripts/set-keys.mjs` | ✅ |
| Embeddings client + search adapter | `src/embed/client.js` (→ `:8091`), `src/search/embedder.js` (`createServiceEmbedder`) | ✅ (real vectors ⚠️ Tier-2) |
| Search (BM25 + vector + RRF fusion) | `src/search/**` | ✅ |
| Topology / AnalysisEngine pipeline | `src/topology.js`, `src/topology/helpers.js`, `pipeline/` | ✅ (real run ⚠️) |
| Ingestion choke-point + uploads | `src/ingest/{capture,upload,blob-store,enqueue}.js` | ✅ |
| Enrichment service (embed + NLP) | `src/enrich/{service,server,extract}.js` | ✅ |
| MCP tools (36 across 17 domains) | `src/tools/*.js` | ✅ |
| Mind-files subsystem | `src/mindfiles/mind-files.js` | ✅ |

## 4. Data flow — capture → searchable

```
client/connector
   │  captureMessage / /ingest  (the single ingestion choke-point)
   ▼
src/ingest/capture.js ──► messages row (content encrypted at rest)
   │  fire-and-forget nudge (src/ingest/enqueue.js)
   ▼
:8095 enrichment service (src/enrich/server.js)
   ├─ Stage 1  drainOnce      nlp_processed 0 → 2   embed via :8091, store vector envelope
   └─ Stage 2  enrichNlpOnce  nlp_processed 2 → 1   extract entities/tags/summary (rules)
   ▼
search (BM25 + vector, RRF fusion)  +  getContext preamble (D5)
   ▼
back to the client as tool results
```

**Query embedder wiring:** `boot()` (`src/index.js`) auto-wires the query-time
embedder via `resolveDefaultEmbedder()` → `createServiceEmbedder()` (an adapter
that bridges the embed client's positional-task signature to the search
embedder's `{task}` contract, and reports `unit:true` since the embed-service
L2-normalizes). The backend fail-softs to BM25 per query when `:8091` is down.
Opt out with `MYCELIUM_DISABLE_EMBED=1`; redirect with `MYCELIUM_EMBED_URL`.

Enrichment state machine (faithful to the canonical model): **`0 unprocessed →
2 embedded → 1 enriched → -1 failed`**. The NLP pass (`src/enrich/extract.js`)
is a pure deterministic rules extractor (url/email/money/date/proper-noun/
hashtag + keyword tags) behind a seam a model-backed pass can replace.

## 5. Storage & schema

- **Engine:** better-sqlite3 with a D1-compatible adapter (`src/adapter/d1.js`),
  so the same code runs on Cloudflare D1 later.
- **Schema:** all V1 tables ported in `migrations/0001_init.sql`; `0002` adds
  `attachments.local_path` for the local blob store. Applied by `src/db/migrate.js`.
- **Blobs:** uploaded files encrypted to a local blob store (`src/ingest/blob-store.js`).

## 6. Security model

- **Two 64-char hex keys** (decisions D4 + D6): `USER_MASTER` + `SYSTEM_KEY`
  (32 bytes each), no BIP-39. Per-key KCV guards typos.
- **Key source** (`src/crypto/key-source.js`, `MYCELIUM_KEY_SOURCE`): the two hex
  keys are read at boot from `env` (default), the **macOS Keychain**, or
  **1Password** (`op`). Keychain/1Password keep keys out of shell history and
  config files (and out of the process env until unlock). Shell-injection-safe
  (`execFile` arg arrays), fail-closed, never logged. `npm run set-keys` provisions.
  KCV (above) stays as the integrity interlock regardless of source.
- **Envelope encryption:** AES-256-GCM wrapped-DEK (`src/crypto/crypto-local.js`).
  `ENCRYPTED_FIELDS` are encrypted/decrypted transparently by the adapter on
  write/read — callers handle plaintext, storage holds ciphertext.
- **Keys are memory-only** after unlock; never in env/DB/logs/HTTP.
- **Fail closed:** missing key → refuse to write; missing auth → reject.
- **Embeddings are sensitive** — stored as ciphertext envelopes, treated like plaintext.
- Full principles in [`../CLAUDE.md`](../CLAUDE.md) §"Security first".

## 7. Transports & auth

- **stdio** (local client), **Streamable HTTP** (`src/server-http.js`), and a
  **REST** surface (`src/server-rest.js`) all dispatch through one shared handler
  map, so a tool is written once.
- **OAuth 2.1 + PKCE** via better-auth (`src/auth.js`) guards the HTTP surfaces.

## 8. Ports

| Port | Service | Status |
|---|---|---|
| `:8091` | Nomic embed-service (Python) | ⚠️ Tier-2 |
| `:8095` | enrichment service (Node) | ✅ |
| HTTP/REST | configurable (MCP HTTP + REST) | ✅ |

## 9. Verification

`npm run verify` runs **15 GO-gated suites** (`scripts/verify-*.mjs`), each with
a PASS/FAIL ledger + VERDICT line: foundation, mcp, mindfiles, metrics, rest,
search, topology, embed, oauth, context, ingest, blob, enqueue, enrich, keysource. CI
(`.github/workflows/verify.yml`) runs them on every PR. **Tier-1** suites pass
without the ML stack; **Tier-2** parity (real embeddings/clustering) is verified
on a host with onnxruntime/Ollama installed.

## 10. Built vs planned (vs the spec)

✅ **Built + verified:** D1 adapter, MCP server (stdio), HTTP + REST transports,
OAuth 2.1, two-key vault encryption, search, topology pipeline, getContext (D5),
ingestion + encrypted uploads, full enrichment pipeline (embed + NLP rules),
query embedder wiring, master-key source (env/Keychain/1Password + `set-keys`),
36 tools.

⚠️ **Built, Tier-2-gated:** real Nomic embeddings + clustering (need onnxruntime/
Ollama on the host).

⬜ **Planned / not yet built:** inference router (Ollama + BYOK — open as PR #12),
agent templates, Cloudflare Tunnel deploy, real-data import. See
[`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md) §"What's left".
