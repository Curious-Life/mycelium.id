<p align="center">
  <img src="docs/mycelium-logo.svg" alt="Mycelium — Sovereign Intelligence" width="100%">
</p>

A self-sovereign personal intelligence system. Multi-agent AI network with encrypted memory, autonomous scheduling, and full web portal. Runs persistent AI agents powered by Claude, with Discord, Telegram, WhatsApp, and a SvelteKit dashboard.

---

## What It Does

Your data — conversations, documents, files, health metrics, location, browsing activity — flows into one encrypted system. AI agents process, organize, connect, and surface what matters. You own everything.

### Agents

| Agent | Role | Channels |
|-------|------|----------|
| **Mya** | Personal thinking partner | Telegram, Discord, Portal |
| **Com** | Company operations, coordination | Discord |
| **Ada** | Deep research | Discord |
| **Rex** | Commercial intelligence | Discord |
| **Noa** | Publishing, content creation | Discord |
| **Rob** | Wealth management, portfolio tracking | Discord |
| **Apollo** | Geopolitical intelligence, war room | Discord |
| **LevOps** | Operations admin, document filing | Discord, Email |
| **QA** | Automated bug detection and fixing | Headless |

### Modules

| Module | What it does |
|--------|-------------|
| **Mindscape** | 3D topological map of your thinking — territories, realms, co-firing connections |
| **Library** | Document vault with imports from Claude, ChatGPT, Obsidian, LinkedIn |
| **Intel** | Geopolitical war room — strategic map, Polymarket signals, narrative threading |
| **Wealth** | Portfolio tracker — positions, transactions, performance, allocations |
| **Activity** | Screen time, message volume, desktop tracking across all channels |
| **Calendar** | Google Calendar integration — schedule from any agent |
| **Search** | Hybrid semantic + keyword search across all messages and documents |
| **Enrichment** | Auto-tagging and embedding every message for semantic retrieval |
| **Clustering** | Nightly UMAP + HDBSCAN to discover emerging thought patterns |

---

## Architecture

```
                         ┌─────────────────────────────────┐
                         │        CLOUDFLARE EDGE           │
                         │                                  │
                         │  Worker → D1 (encrypted)         │
                         │         → Vectorize (embeddings)  │
                         │         → R2 (files)             │
                         │         → KV (cache)             │
                         │         → AI (Llama, BGE-M3)     │
                         └──────────────┬───────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                    │
                    ▼                   ▼                    ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │   TELEGRAM   │   │   DISCORD    │   │   PORTAL     │
            │   WhatsApp   │   │  (per agent) │   │  (SvelteKit) │
            └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                   │                  │                    │
                   └──────────────────┼────────────────────┘
                                      │
                              ┌───────┴────────┐
                              │  AGENT SERVER   │
                              │                 │
                              │  Claude Code    │
                              │  MCP Tools      │
                              │  Context Asm.   │
                              │  Schedulers     │
                              │  Task Queues    │
                              └───────┬─────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                  │
                    ▼                 ▼                  ▼
             ┌────────────┐   ┌────────────┐    ┌────────────┐
             │  MINDSCAPE  │   │   INTEL    │    │  WEALTH    │
             │  Clustering │   │  War Room  │    │  Portfolio │
             │  Topology   │   │  Polymarket│    │  CDP/Poly  │
             └────────────┘   └────────────┘    └────────────┘
```

### Port Allocation

| Service | Port |
|---------|------|
| Orchestrator | 3000-3001 |
| Company Agent (Com) | 3002 |
| Telegram Bot | 3003 |
| Personal Agent (Mya) + Portal | 3004 |
| Research Agent (Ada) | 5002-5003 |
| Commercial Intel (Rex) | 5004-5005 |
| Publishing (Noa) | 5006-5007 |
| QA Agent | 5008 |
| Mya Discord Bot | 5009 |
| Wealth Agent (Rob) | 5010-5011 |
| Intel Agent (Apollo) | 5012-5013 |
| Moms Agent | 5014-5015 |
| Ops Agent (LevOps) | 5018-5019 |
| OwnTracks Location | 5020 |

---

## Security

All data encrypted at rest with AES-256-GCM. Encryption keys never leave Cloudflare's edge.

```
   .env (disk)              D1 Secrets API            process.env (memory)
   ┌──────────┐             ┌──────────────┐          ┌──────────────────┐
   │ NO       │   bootstrap │ 65+ secrets  │  inject  │ All secrets      │
   │ SECRETS  │ ──────────→ │ encrypted    │ ───────→ │ available at     │
   │          │   (per-agent│ AES-256-GCM  │          │ runtime only     │
   │ Only:    │    tokens)  │              │          │                  │
   │ tokens   │             │              │          │ /proc/PID/environ│
   │ config   │             │              │          │ = clean          │
   └──────────┘             └──────────────┘          └──────────────────┘
```

- **3 encryption scopes**: personal, org, wealth (+ moms, ops)
- **Per-agent tokens**: each agent can only access its scoped secrets
- **Supply chain defense**: npm dependency exfiltrating `process.env` only gets scoped bootstrap tokens

---

## Companion Apps

### [Mycelium Desktop](https://github.com/Curious-Life/mycelium-transcriber) (macOS)

Native menu bar app — activity tracking, call transcription, voice notes.

- Dual-stream audio capture (mic + system audio via Core Audio)
- Local transcription with WhisperKit (no audio leaves device)
- Activity tracking: apps, windows, browser URLs, idle detection
- Syncs to Mycelium via API

### [Mycelium Mobile](https://github.com/Curious-Life/mycelium-ios) (iOS)

Native SwiftUI app — agent chat, intel war room, library, health sync.

- Chat with any agent
- Intel map with theaters, events, Polymarket
- HealthKit integration (sleep, HRV, steps, workouts)
- On-device transcription

---

## Quick Start

```bash
git clone https://github.com/Curious-Life/mycelium.git
cd mycelium && npm install
cd portal && npm install && cd ..
cd worker && npm install && cd ..

cp .env.example .env
# Fill in: CLAUDE_BIN, AGENT_ID, PORT

# Single agent:
node agent-server.js

# Full system:
pm2 start ecosystem.config.cjs
```

---

## License

Apache 2.0
