<p align="center">
  <img src="assets/mushroom.svg" alt="Mycelium" width="88">
</p>

<h1 align="center">Mycelium</h1>

<p align="center"><strong>Self-sovereign memory infrastructure for AI.</strong><br>Own your keys. Own your data. Own the intelligence.</p>

<p align="center">
  <a href="docs/guide/"><strong>Docs</strong></a> ·
  <a href="docs/guide/handbook/">Handbook</a> ·
  <a href="docs/guide/reference/">Reference</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="https://mycelium.id">Website</a>
</p>

---

## What This Is

A self-hosted MCP server that gives **any AI model** complete context about your life through a standard protocol. Your data compounds across every service. You switch models freely. Your vault is encrypted on your machine, with keys only you hold.

```
┌─────────────────────────────────────────────────────────────┐
│                      ANY AI MODEL                            │
│       Claude · ChatGPT · Gemini · Llama · Mistral · any     │
└────────────────────────────┬────────────────────────────────┘
                             │
                      MCP Protocol
                  (model-agnostic tool surface)
                             │
┌────────────────────────────▼────────────────────────────────┐
│                                                              │
│                      YOUR MYCELIUM                           │
│                                                              │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│   │ Encrypted│  │ Semantic │  │ Topology │  │ Agent    │  │
│   │ Storage  │  │ Search   │  │ Engine   │  │ Context  │  │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                              │
│   Self-hosted · your hardware · your keys                   │
└────────────────────────────┬────────────────────────────────┘
                             │
          ┌──────────┬───────┴───────┬──────────┐
          │          │               │          │
       Telegram   Discord      WhatsApp     Files
       iOS app    Email        Voice        Imports
```

## Architecture

| Layer | What | Sovereignty |
|-------|------|-------------|
| **MCP Interface** | model-agnostic tools over stdio + Streamable HTTP | Full — runs on your machine |
| **Encryption** | AES-256-GCM, scope-partitioned, one hex recovery key | Full — keys never leave your hardware |
| **Search** | Nomic v1.5 ONNX embeddings, ANN + BM25 + RRF fusion | Full — local inference, no API calls |
| **Topology** | Leiden clustering, co-firing, information harmonics | Full — open source, runs locally |
| **REST + Ingest** | `/api/v1/*` + `/ingest/*` for non-MCP clients (bots, webhooks, scripts) | Full — same tools, HTTP interface |
| **Federation** | Node-to-node discovery via topology resonance | Open protocol — community-driven *(roadmap)* |

## The Measurement Layer

Storage is commodity. Everyone is building memory retrieval. We're building **measurement science** — and open-sourcing it deliberately.

```
Topology        Leiden clustering → 200-400 territories
                Hierarchical. Splits and merges as you change.

Co-firing       Which territories activate together.
                Reveals hidden connections across time windows.

Harmonics       H0 (entropy) · β (autocorrelation) · γ (momentum) · α (complexity)
                The signature of how your mind moves.

What it does    Detect cognitive regime shifts before conscious awareness.
                Measure attention dynamics — not just what, but when and how.
                7+ distinct cognitive modes from metric signatures alone.
```

## Why Open Source

```
Everything is copyable — by design.

  MCP interface spec                      → copy it
  Vault structure (local-first SQLite)    → copy it
  Federation protocol                     → copy it
  Topology algorithms (Leiden, co-firing) → copy it

More copies = more nodes in the federated network.
Open source GROWS the network. Proprietary would cap it.

  1 node     → personal vault (useful alone)
  10 nodes   → topology resonance discovery begins
  100 nodes  → cross-pollination, agent-to-agent context
  1000 nodes → protocol becomes standard
  10000+     → the memory layer for AI
```

The **Redis / Elasticsearch / Linux** model: commoditization of the infrastructure layer funds everything above it.

## What Accumulates

Even when the code is free, these can't be copied:

1. **Your computed topology** — months/years of personal data. Algorithm is free, your history isn't.
2. **Network position** — the reference implementation. Red Hat dynamic.
3. **Managed convenience** — calibration, federation routing, zero-config. Code is free, not running it isn't.
4. **Interpretation layer** — what your topology *means* and what to *do* about it. Requires lived practice.

## Technical Decisions (Locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Topology engine | Open, behind AnalysisEngine plugin interface |
| D2 | Embeddings | Nomic v1.5 ONNX + task prefixes (loopback :8091) |
| D3 | Encryption | Port `crypto-local.js` — wrapped-DEK envelope, AES-256-GCM |
| D4 | Master key | 64-char hex strings, no BIP-39 in V1 |
| D5 | Runtime | Pure MCP tool server — no autonomous loop |
| D6 | System key | One recovery key (USER_MASTER); SYSTEM_KEY HKDF-derived from it |
| D7 | Enrichment | Build-new NLP tagging + embed-on-write service |

## Build Status

**Under active development.** The core is built and continuously verified; remaining pieces are environment-gated — they need a networked host for ML models, deploy, and platform tokens.

```
Phase 1  Core Server + Data Layer       ✅ built   encrypting SQLite adapter, recovery-key vault
Phase 2  Embeddings + Search            ◑ built*   in-RAM ANN+BM25+RRF; real embeddings gated
Phase 3  Topology Pipeline              ◑ built*   ported pipeline + tools; clustering wheels gated
Phase 4  OAuth + Security               ✅ built   OAuth 2.1 + PKCE, stateful Streamable HTTP
Phase 5  Ingestion + Uploads            ✅ built   capture choke-point, encrypted blobs, /ingest/*
Phase 6  Enrichment + Connectors        ◷ next     D7 service skeleton, messaging bridges
```

<sub>✅ verified to `EXIT 0` · ◑ built, a Tier-2 path needs a networked host · ◷ designed, not yet built</sub>

**Verification:** `npm install --legacy-peer-deps && npm run verify` runs the full suite (every `verify:*` gate prints `VERDICT: GO`). For a fast sanity check use `npm run verify:core` (boot · crypto · MCP tools · portal · search). A real MCP client completes OAuth and lists the live tools over HTTPS; messages and file uploads round-trip through the encrypting vault.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the as-built system and [`docs/SETUP.md`](docs/SETUP.md) to run it.

## Install

> **Status:** the `@mycelium/mcp` npm package is a roadmap deliverable. Today the server runs from source on the development branch.

```bash
git clone https://github.com/Curious-Life/mycelium.id.git && cd mycelium.id
nvm use                 # Node 22 LTS (see .nvmrc) — Node 23+ breaks prebuilt native modules
npm install --legacy-peer-deps   # the --legacy-peer-deps flag is required
npm run verify:core     # fast sanity (or `npm run verify` for the full suite)
npm start               # stdio MCP server   (or: npm run start:http for OAuth)
```

Pure Node.js (**22 LTS** — pinned in `.nvmrc`). No Docker required. Connect Claude, ChatGPT, or any MCP-compatible client.

**Optional (Tier-2 features):** the embeddings + clustering pipeline needs **Python ≥3.10** and, on macOS, the Xcode Command Line Tools (`xcode-select --install`). Search, capture, and the MCP tools work without it; semantic clustering / Generate need it. Setup: [`docs/SETUP.md`](docs/SETUP.md).

### Troubleshooting

- **`better-sqlite3` fails to build (libtool / `clang` errors), conda active** — a conda environment puts its own `libtool`/compiler ahead of the system toolchain and collides with the native build. **`conda deactivate`** (so no env is active), then re-run `npm install --legacy-peer-deps`.
- **Native module errors / `NODE_MODULE_VERSION` mismatch** — you're on Node 23+. The prebuilt binaries target Node 22 LTS. **`nvm use`** (or install Node 22), delete `node_modules`, and reinstall.
- **`npm install` fails on peer-dependency conflicts** — use the **`--legacy-peer-deps`** flag (a committed `.npmrc` sets it by default; pass it explicitly if your npm ignores the file).

## Repo Structure

```
mycelium.id/
├── src/                           the V1 server (built)
│   ├── adapter/                   encrypting better-sqlite3 / D1 adapter
│   ├── crypto/                    crypto-local.js + guardians + two-key unlock
│   ├── db/                        43 namespaces + getDb() assembly + migration runner
│   ├── ingest/                    capture choke-point, blob store, uploads, enqueue
│   ├── search/                    in-RAM ANN + BM25 + RRF mind-search
│   ├── tools/                     MCP tool domains
│   ├── server-http.js             OAuth 2.1 + Streamable HTTP + /ingest/*
│   └── index.js                   stdio + --http entry
├── scripts/                       verify-*.mjs (one per subsystem) + init-db
├── migrations/                    0001 schema (111 tables) + 0002 local_path
├── pipeline/                      Python: embed-service, clustering, harmonics
├── portal-app/                    SvelteKit web UI (built + served at :8787)
├── src-tauri/                     Tauri desktop app shell (macOS)
├── packages/channel-daemon/       Telegram / Discord bridge
├── tools/memory-bridge/           harness adapters (Claude Code, opencode, …)
├── docs/                          guide (handbook + reference) + architecture
├── tests/ · assets/ · mobile/     test suites · brand · mobile scaffold
├── CLAUDE.md · LICENSE (AGPL-3.0)
```

## Competitive Position

| | Mem0 | Zep | Letta | Screenpipe | **Mycelium** |
|---|---|---|---|---|---|
| Self-hosted | ✗ | ✗ | ✓ | ✓ | **✓** |
| Topology | ✗ | ✗ | ✗ | ✗ | **✓** |
| Co-firing | ✗ | ✗ | ✗ | ✗ | **✓** |
| Harmonics | ✗ | ✗ | ✗ | ✗ | **✓** |
| Federation | ✗ | ✗ | ✗ | ✗ | **✓** *(roadmap)* |
| Model-agnostic | partial | partial | ✓ | ✓ | **✓** |
| Encrypted at rest (your keys) | ✗ | ✗ | ✗ | ✗ | **✓** |

Everyone else is building memory. We're building the **nervous system**.

## Support development

Mycelium is free and open source — clone it, run it, fork it, own your data. That's the point.

If it's useful to you, support its development. This is infrastructure built in the open, **value-for-value**: the practice is free, and the people who get value from it fund the work that keeps it growing. The Redis / Linux model — commoditize the layer, fund what's above it.

Sponsorship links will be available at launch — see [mycelium.id](https://mycelium.id).

No ads, no data sold, no strings. Just people funding the infrastructure they rely on.

## License

[AGPL-3.0](LICENSE) — Mycelium's core is free and open source.

---

<p align="center"><sub>Built by <a href="https://curious.life">Curious Life</a></sub></p>
