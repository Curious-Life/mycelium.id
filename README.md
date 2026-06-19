<p align="center">
  <img src="assets/mushroom.svg" alt="Mycelium" width="88">
</p>

<h1 align="center">Mycelium</h1>

<p align="center"><strong>Personal intelligence that belongs to you.</strong><br>Own your data · Think in private · Connect meaningfully · Know the truth</p>

<p align="center">
  <a href="docs/guide/"><strong>Docs</strong></a> ·
  <a href="docs/guide/handbook/">Handbook</a> ·
  <a href="docs/guide/reference/">Reference</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="https://mycelium.id">Website</a>
</p>

---

## What This Is

Your AI gets more useful the more it knows about you — and with Mycelium, that knowledge stays yours. It lives on your own machine, not on someone else's server tied to whichever model you happen to use this month.

Mycelium is a self-hosted memory layer for AI. A local server ingests your conversations, notes, and reflections, encrypts them at rest on your own machine, and serves that context to **any** AI model through the Model Context Protocol (MCP). Your memory compounds across every tool you use, you switch models freely, and nobody else holds the keys.

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

Mycelium is an environment for curiosity about your own mind. Beneath the storage and search, a measurement layer turns your accumulated thinking into something you can actually see — the shape of your attention, how your ideas move, what's shifting over time. Patterns no single conversation can show you.

We cultivate it in the open because of what we care about: people owning their inner life, having room to think in private, and being free to leave any platform without leaving their data behind. That's why [Curious Life](https://curiouslife.is) builds Mycelium — and why it's free, open source, and community-driven.

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

A tool that holds your inner life is easier to trust when you can read it, run it, and fork it — no black box, no faith required. So everything is yours to take:

```
  MCP interface spec                      → copy it
  Vault structure (local-first SQLite)    → copy it
  Federation protocol                     → copy it
  Topology algorithms (Leiden, co-firing) → copy it
```

The more people who run their own, the more of us there are who **own our data** instead of renting it back, **think in private** without lock-in, **hold the keys** to our own memory, and **connect on terms we set ourselves**.

A healthy forest needs a free and open mycelial network connecting its trees. If you care about open source — about people owning their own minds — come build it with us.

## Build Status

**Under active development.** The core is built and continuously verified; remaining pieces are environment-gated — they need a networked host for ML models, deploy, and platform tokens.

**Verification:** `npm install --legacy-peer-deps && npm run verify` runs the full suite (every `verify:*` gate prints `VERDICT: GO`). For a fast sanity check use `npm run verify:core` (boot · crypto · MCP tools · portal · search). A real MCP client completes OAuth and lists the live tools over HTTPS; messages and file uploads round-trip through the encrypting vault.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the as-built system and [`docs/SETUP.md`](docs/SETUP.md) to run it.

## Install

> **Status:** the `@mycelium/mcp` npm package is a roadmap deliverable. Today the server runs from source.

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

## Support development

Mycelium is free and open source — clone it, run it, fork it, own your data. That's the point.

If it's useful to you, support its development. Mycelium is **value-for-value**: the software is free, and the people who find it useful fund the work that keeps it growing and independent. Use the **Sponsor** button at the top of this repo, or [mycelium.id](https://mycelium.id).

No ads, no data sold, no strings. Just people funding the infrastructure they rely on.

## License

[AGPL-3.0](LICENSE) — Mycelium's core is free and open source.

---

<p align="center"><sub>Built by <a href="https://curiouslife.is">Curious Life</a></sub></p>
