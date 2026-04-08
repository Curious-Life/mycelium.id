# Mycelium Architecture

## The Idea

Mycelium is sovereign intelligence infrastructure. It gives a person (or organisation) a network of persistent AI agents that remember, reason, collaborate, and act on their behalf — across every channel they use.

The system is designed as an **open set**: it has a defined origin (the core infrastructure and its principles) but no defined boundary. It grows. Each user runs their own instance — their own **strain** — and it evolves in directions nobody planned, driven by the agents solving real problems for real people.

Three principles are non-negotiable and encoded infrastructurally:

1. **Sovereignty** — your data, your agents, your compute. No platform dependency.
2. **Persistence** — agents remember across conversations, survive crashes, resume where they left off.
3. **Growth** — the system must be able to extend itself. Agents should be able to create new capabilities without touching the core.

---

## The Biological Model

The naming is not cosmetic. The architecture maps directly to how mycelial networks function in nature.

### In a real forest

```
    🌲    🌲    🌲    🌲    🌲          the forest — alive, ephemeral, seasonal
   ─────────────────────────────        forest floor
     ╲  │  ╱    ╲  │  ╱    ╲
      ╲ │ ╱      ╲ │ ╱      ╲
       ╲│╱        ╲│╱        ╲
        ●──────────●──────────●         the mycelium — persistent, underground
   ═════════════════════════════        substrate — soil, minerals, water
        🌱    🌱    🌱                  spores — new life, dispersal, variation
```

**Mycelium** is the underground network of threadlike hyphae connecting every tree root to every other. It routes nutrients, water, and chemical signals. A tree under attack sends warnings through the mycelium. A dying tree dumps its carbon into the network for others. The mycelium was there before the forest grew and will be there after it burns.

**The forest** is what the mycelium enables. Trees, fruiting bodies (mushrooms), the canopy — all of it is ephemeral. Seasons change. Trees fall. New ones grow. The forest is alive precisely because it's impermanent.

**Spores** are the reproductive units. A fruiting body releases spores into the environment. Most don't germinate. But the ones that land in good substrate grow new mycelium, and new forests follow.

### In the system

| Biology | System | What it is |
|---------|--------|------------|
| **Mycelium** | The codebase | Persistent infrastructure — `lib/`, `agent-server.js`, `mcp/`, `worker/`. The information network that connects everything. This is the product. |
| **Hyphae** | Individual lib modules | Each module is a thread in the network: `delegation.js` carries signals between agents, `lanes.js` controls flow, `watchers.js` senses the environment, `runner.js` is the metabolic engine. |
| **Substrate** | Database + compute | D1, R2, Vectorize, the VPS. The soil the mycelium grows in. Provides nutrients (data) and structure (schema). |
| **Forest** | Runtime | Agents running, users chatting, knowledge accumulating, conversations happening. Ephemeral. Burn it down and the mycelium regrows it from stored state. |
| **Trees** | Persistent agents | Your agents — rooted, long-lived, connected to each other through the mycelium underground. Each one draws from and feeds back into the network. |
| **Fruiting bodies** | User interfaces | Portal, Discord bots, Telegram bots. The visible surface that users interact with. Pushed above ground by the mycelium when conditions are right. |
| **Spores** | Evolution-space | User-created extensions. New code that carries the mycelium's patterns but grows independently. When a spore proves itself, it can be absorbed back into the mycelium. |
| **Strain** | A user's deployment | Each person who runs mycelium has their own strain. Same genetic origin, different growth. Your strain evolves to serve you. |

---

## Three Layers

The architecture has three distinct layers. The boundary between them is the key design decision.

### Layer 1: The Mycelium (infrastructure)

The persistent, connective network. This is what you `git clone`. It encodes sovereignty, handles routing, manages lifecycle, and provides the information paths that everything else grows on.

```
mycelium/
│
│   # ── The Network (lib/) ─────────────────────────────────
│   #    The hyphae. 45+ modules that route signals,
│   #    share resources, and manage the lifecycle of
│   #    everything above.
│
│   lib/
│     runner.js              # metabolic engine — turns inputs into Claude responses
│     delegation.js          # hyphae between trees — agent-to-agent task routing
│     collab.js              # chemical signaling — inter-agent announcements
│     lanes.js               # flow control — one signal at a time per path
│     watchers.js            # sensory hyphae — detect environmental changes
│     scheduler.js           # circadian rhythm — morning, evening, dream cycles
│     coalesce.js            # signal debouncing — merge rapid inputs
│     spawner.js             # budding — create ephemeral sub-organisms
│     checkpoint.js          # resilience — survive disruption, resume growth
│     context-assembly.js    # nutrient assembly — gather what an agent needs to think
│     session-store.js       # memory persistence — conversation history
│     db.js, db-d1.js        # root system — interface to the substrate
│     attachments.js         # digestion — process any input type
│     error-classifier.js    # immune response — classify and handle failures
│     watchdog.js            # health monitor — detect dying processes, restart
│     model-fallback.js      # adaptation — fall back to different models under stress
│     ...
│
│   # ── The Trunk (shared server) ──────────────────────────
│   #    Every tree (agent) grows from the same trunk pattern.
│   #    The server handles HTTP, streaming, tasks, portal API.
│
│   agent-server.js          # the trunk — shared by all agents
│   orchestrator.js          # the elder tree — coordinates the canopy
│   registry.js              # root map — who is where
│
│   # ── Tool Interfaces (mcp/) ─────────────────────────────
│   #    Hyphal tips — where the mycelium touches the outside world.
│
│   mcp/
│     mya-tools.js           # 22 tools: documents, tasks, search, delegation
│     wealth-tools.js        # financial tools
│     linear-tools.js        # project management tools
│     ops-tools.js           # operations tools
│     polymarket-tools.js    # prediction market tools
│     setup.js               # MCP configuration writer
│
│   # ── Fruiting Surfaces ──────────────────────────────────
│   #    User-facing interfaces pushed above ground.
│
│   portal/                  # web UI — SvelteKit app
│   *-discord-bot.js         # Discord interfaces (one per agent)
│   telegram-bot.js          # Telegram interface
│   whatsapp-bot.js          # WhatsApp interface
│
│   # ── Substrate Interface ────────────────────────────────
│   #    Connection to the soil — database, storage, compute.
│
│   worker/                  # Cloudflare Worker — D1/R2/Vectorize proxy
│   migrations/              # schema evolution
│   ecosystem.config.cjs     # PM2 process topology
│
│   # ── Supporting Structure ───────────────────────────────
│
│   agents/                  # agent identity configs (JSON)
│   templates/               # prompt templates
│   scripts/                 # infrastructure scripts
│   tests/                   # test suite
│   docs/                    # documentation
```

### Layer 2: The Forest (runtime)

The forest is what emerges when you start the mycelium. It's not in the repo — it's what the repo produces.

```
Runtime (the forest floor)
│
├── Agent: Personal (port 3004)
│   ├── conversations happening right now
│   ├── active sessions, in-flight requests
│   ├── scheduled cycles running (morning check-in, evening reflection)
│   └── task queue being processed
│
├── Agent: Research (port 5002)
│   ├── deep research tasks delegated from Personal
│   └── web search sessions
│
├── Agent: Commercial (port 5004)
│   └── market intelligence gathering
│
├── Agent: Wealth (port 5010)
│   └── portfolio monitoring, financial reasoning
│
├── Orchestrator (port 3000)
│   ├── Discord message routing
│   ├── agent health polling (every 5 min)
│   └── system status aggregation
│
├── Portal (port 5173)
│   └── live user sessions, SSE streams, mindscape renders
│
├── Knowledge accumulating in D1
│   ├── messages, documents, embeddings
│   ├── territories, realms, themes
│   └── task history
│
└── Files on disk
    └── agents/*/memory/, sessions/, tasks/
```

The forest is ephemeral. You can stop all processes, wipe the runtime state, restart, and the mycelium regrows the forest from what's persisted in the substrate (D1, R2, local files). This is by design — the forest is a side effect of the mycelium being alive.

### Layer 3: Evolution-Space (spores/)

This is where variation happens. The user (or their agents) create new code here — bots, daemons, receivers, scripts — that run on top of the mycelium infrastructure. Evolution-space code:

- **Imports from the mycelium** (`../../lib/`) — uses the network's capabilities
- **Runs as its own PM2 process** — independent lifecycle, own port, own logs
- **Stores data in shared paths** (`agents/.shared/daemon/events/`) — visible to agents
- **Never modifies the mycelium** — the forest floor, not the underground network
- **Can be absorbed** — when something proves universally useful, it moves from spore to mycelium via PR

```
spores/                                 # evolution-space root
│
├── README.md                           # field guide (committed to mycelium)
├── _example/                           # germination template (committed)
│   ├── index.js                        #   minimal daemon showing the pattern
│   └── ecosystem.config.cjs            #   PM2 config template
│
my-telegram-bot/                        # ── example: custom bot ──────
│   ├── manifest.json                   # spore manifest
│   ├── index.js                        # bot logic
│   └── routes.js                       # optional portal routes
│
├── energy-monitor/                     # ── example: token tracking ──
│   ├── manifest.json
│   ├── lib/energy.js                   # energy ledger
│   └── routes.js                       # /portal/energy/* endpoints
│
└── my-daemon/                          # ── example: background job ──
    ├── manifest.json
    └── daemon.js                       # long-running process
```

**Auto-discovery**: the root `ecosystem.config.cjs` auto-loads spore PM2 configs via `spores/loader.cjs`. Drop a new directory with a `manifest.json` and your scripts, restart PM2, and it's alive.

**Git boundary**: `spores/*/` is gitignored in the main repo. The README and `_example/` are committed (they define the pattern). Your actual spores are your strain's growth — they live in your deployment, not in the shared codebase. When a spore is ready for the world, you extract it into a PR.

---

## Information Flow

How signals move through the system:

```
User input (Discord, Telegram, Portal, WhatsApp)
        │
        ▼
   Fruiting Body (bot / portal)
        │
        ▼  HTTP POST /chat or /chat/stream
   Agent Server (agent-server.js)
        │
        ├──▶ Context Assembly (lib/context-assembly.js)
        │       └── loads: mind files, pinned docs, recent messages, goals
        │
        ├──▶ Lane Serialization (lib/lanes.js)
        │       └── queues request, one at a time per agent
        │
        ├──▶ Runner (lib/runner.js)
        │       └── spawns Claude CLI session with assembled context
        │       └── model selection: opus (think), sonnet (chat), haiku (spawn)
        │
        ├──▶ MCP Tools (mcp/mya-tools.js)
        │       └── agent can: search, create docs, manage tasks, delegate
        │
        ├──▶ Delegation (lib/delegation.js)
        │       └── discover peers via PM2, health check, POST /chat
        │       └── announce in #agent-collab (lib/collab.js)
        │       └── wake sleeping agents (POST /think)
        │
        ├──▶ Spawner (lib/spawner.js)
        │       └── create ephemeral Tier 2 sub-tasks
        │
        ├──▶ Token Parser (lib/tokens.js)
        │       └── parse response for: NO_REPLY, DELEGATE, TASK, etc.
        │
        └──▶ Session Store (lib/session-store.js)
                └── persist conversation to JSONL + D1
```

### Autonomous cycles (the circadian rhythm)

Agents don't just respond — they think on their own:

```
Scheduler (lib/scheduler.js)
   │
   ├── 08:00  Morning check-in    → review tasks, plan the day
   ├── 12:00  Midday reflection   → process morning's events
   ├── 20:00  Evening reflection  → synthesize the day
   ├── 02:00  Dream cycle         → deep pattern recognition, insight generation
   └── Weekly  Weekly review      → strategic planning, goal reassessment
```

### Agent-to-agent collaboration

```
Personal Agent                      Research Agent
     │                                  │
     │  "Research the latest on X"      │
     ├──────── delegation ─────────────▶│
     │         POST /chat               │
     │                                  ├── deep web search
     │                                  ├── source synthesis
     │◀──────── callback ──────────────┤
     │         results + summary        │
     │                                  │
     ├── Announce in #agent-collab      │
     │   (lib/collab.js, bold labels)   │
```

---

## The Strain

Every user who deploys mycelium runs their own **strain**. A strain is:

- A clone of the mycelium repo (the shared genetic material)
- Their own agents with their own identities, goals, and memories
- Their own substrate (their D1 database, their R2 bucket, their VPS)
- Their own evolution-space (spores that solve their specific problems)

Two strains share the same mycelium but grow completely different forests. One user might have a research-heavy lattice with five specialized research agents. Another might have a single personal agent with a dozen spores handling life logistics.

When you `git pull` upstream mycelium updates, your strain absorbs the infrastructure improvements without disturbing your forest or your spores.

```
Curious-Life/mycelium.id (the shared genome)
        │
        ├── Strain A
        │   ├── agents: personal, research, commercial, wealth
        │   ├── spores: custom telegram bot, energy monitor
        │   └── substrate: D1 (their data), VPS (their compute)
        │
        ├── Strain B
        │   ├── agents: personal, ops
        │   ├── spores: (whatever they grow)
        │   └── substrate: D1 (their data), VPS (their compute)
        │
        └── Strain C (...)
```

---

## Absorption: Evolution-Space to Mycelium

The most important flow in the system. When a spore proves universally useful:

```
1. GERMINATION
   User creates spores/my-bot/ to solve a personal problem.
   It imports from ../../lib/ and runs as a PM2 process.

2. GROWTH
   The spore matures. It handles edge cases, gains features,
   becomes reliable. Other strain operators want it.

3. EXTRACTION
   The spore is extracted from spores/ into the mycelium proper:
   - Script moves to root (or lib/ if it's a module)
   - PM2 config moves to ecosystem.config.cjs
   - Tests are added
   - Docs are written

4. ABSORPTION (PR)
   Pull request to Curious-Life/mycelium.id.
   The spore becomes part of the shared genome.
   All strains can now grow this capability.

5. DECOMPOSITION
   The spore directory is deleted from the user's evolution-space.
   The code now lives in the mycelium. The cycle completes.
```

In biology, this is exactly what happens: mycelium reabsorbs nutrients from its own decaying fruiting bodies. Nothing is wasted. The organism evolves.

---

## Port Allocation

### Mycelium (reserved ranges)

| Range | Purpose |
|-------|---------|
| 3000 | Orchestrator |
| 3001 | Orchestrator Discord bot HTTP |
| 3002 | Company agent (legacy) |
| 3003 | Telegram bot |
| 3004 | Personal agent + portal API |
| 5000-5029 | Agent servers + Discord bot HTTP (formula: `5000 + index*2`) |
| 5173 | Portal (SvelteKit) |

### Evolution-space (user-allocated)

| Range | Purpose |
|-------|---------|
| 3015+ | Spore HTTP APIs |
| 5030+ | Additional spore services |

Spore authors choose their own ports in the unallocated ranges and declare them in their `ecosystem.config.cjs`.

---

## Key Design Decisions

### Why Claude Code as the engine (not API)

Agents run Claude Code CLI sessions, not raw API calls. This means:
- Agents can use tools (MCP), read files, run commands
- Conversation state is managed by the CLI
- Model selection and fallback are handled by the runner
- The agent *is* a Claude Code session with persistence bolted on

### Why PM2 (not containers)

PM2 gives us process management with zero overhead:
- Restart on crash, memory limits, log rotation
- `pm2 status` shows the entire forest at a glance
- No Docker networking complexity for agent-to-agent HTTP
- The `ecosystem.config.cjs` is a single source of truth for the topology

### Why Cloudflare D1 (not Postgres)

- Zero-config, serverless, globally distributed
- Worker proxy means agents never hold database connections
- Vectorize integration for semantic search
- R2 for attachment storage in the same ecosystem
- Free tier covers most personal deployments

### Why per-agent Discord bots

Each agent gets its own Discord bot identity. This means:
- Agents appear as separate users in Discord
- Users can @mention specific agents
- Each bot has its own rate limits (no shared throttling)
- Clear attribution in conversation threads

---

## What the Mycelium Guarantees

If your code is a spore (lives in evolution-space), the mycelium guarantees:

1. **`lib/` is stable** — shared modules maintain their interfaces. Your `import { delegation } from '../../lib/delegation.js'` will keep working across mycelium updates.

2. **PM2 auto-discovery works** — if your spore has a valid `ecosystem.config.cjs`, it will be loaded. No need to touch the root config.

3. **Substrate is accessible** — D1, R2, Vectorize are reachable through the same env vars and worker proxy that core agents use.

4. **Your data is yours** — spore data in `agents/.shared/daemon/events/` or wherever you store it is not touched by mycelium updates.

5. **The forest regrows** — if you pull a mycelium update that changes agent-server.js, your agents restart with the new code but retain their memories, sessions, and tasks. The forest is ephemeral; the substrate persists.