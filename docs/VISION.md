# mycelium.id — Vision & Strategy

> **Status of this document.** The pitch below is the **product vision / strategy artifact** (mycelium.id · May 2026), preserved **verbatim**. It describes the *destination* — the full multi-layer product, business model, and federated network — not the current build state. The **"V1 reality deltas"** section at the end reconciles specific claims against what is actually built and locked today (branch `claude/repo-overview-mC69M`). When the two disagree, the code + locked decisions (D1–D7, see `docs/V1-BUILD-SPEC.md`) are ground truth; the pitch is the aim.

---

## PITCH (verbatim)

mycelium.id
Self-sovereign memory infrastructure for AI agents.
Open source. Model-agnostic. Federated.

The Shape

┌─────────────────────────────────────────────────────────────────────┐
│                        ANY AI MODEL                                  │
│         Claude · ChatGPT · Gemini · Llama · Mistral · any           │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                          MCP Protocol
                     (37 tools, model-agnostic)
                                 │
┌────────────────────────────────▼────────────────────────────────────┐
│                                                                      │
│                         YOUR MYCELIUM                                 │
│                                                                      │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│   │ Encrypted│  │ Semantic │  │ Topology │  │ Agent            │   │
│   │ Storage  │  │ Search   │  │ Engine   │  │ Coordination     │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────────┘   │
│                                                                      │
│   Self-hosted (npm) or Managed (mycelium.id)                        │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
              ┌──────────┬───────┴───────┬──────────┐
              │          │               │          │
          Telegram    Discord        WhatsApp     Files
          iOS app     Email          Voice        Imports

One Sentence
A private vault you own — encrypted, self-hosted or managed — that gives any AI model complete context about your life through a standard protocol. Your data compounds across every service. You switch models freely. Nobody else can read it.

Why Now
AI memory is exploding
Every provider building memory. All of it locked in. Your ChatGPT memory ≠ your Claude memory ≠ your Gemini memory. Fragmentation by default.

Users will demand MCP write access
Right now ChatGPT Plus users can't write to external tools. But power users WILL demand it — "let me own my data." AI companies comply or lose them to those who do.

Privacy pressure mounting
People don't want Google and Meta reading their therapy conversations with AI. The Proton generation exists. They'll move to private-first infrastructure when it's available.

MCP is the standard
Anthropic's Model Context Protocol is becoming the universal interface. One protocol, any model. The infrastructure layer is now possible in a way it wasn't 12 months ago.

Deployment Model

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: MCP TOOL INTERFACE                                     │
│                                                                   │
│  npm install @mycelium/mcp                                       │
│                                                                   │
│  Pure Node.js. No Docker. Works immediately.                     │
│  37 tools: search, store, retrieve, territories, agents, etc.    │
│  Connects to Claude, ChatGPT, any MCP-compatible client.         │
│  Reads/writes to local SQLite or configured storage.             │
│                                                                   │
│  ► Ships first. One command. Zero friction.                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: TOPOLOGY COMPUTATION                                   │
│                                                                   │
│  Option A: docker run mycelium/topology                          │
│  Full sovereignty. Runs on your machine.                         │
│                                                                   │
│  Option B: --topology=cloud                                      │
│  Managed computation. Vectors sent encrypted.                    │
│  Results back to your vault. We never store raw data.            │
│                                                                   │
│  ► The measurement science layer. Where the moat lives.          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: FEDERATION NETWORK                                     │
│                                                                   │
│  Open protocol. Your mycelium talks to other myceliums.          │
│  Discovery through topology resonance, not social graphs.         │
│  Each node self-hosted = users pay their own storage.            │
│  Solves Mastodon's memory cost problem.                          │
│                                                                   │
│  ► The network. Open source. Community-driven.                   │
└─────────────────────────────────────────────────────────────────┘

The Measurement Layer (Differentiator)
The storage is commodity. The measurement is the moat.

Topology
Leiden clustering → 200-400 territories. Hierarchical. Splits and merges as you change.

HDBSCAN Leiden
Co-firing
Which territories activate together. Reveals hidden connections. Tracks over time windows.

differential temporal
Harmonics
H0 (entropy), β (autocorrelation), γ (momentum), α (complexity). The signature of how your mind moves.

Shannon Fisher
What this enables
Detect cognitive regime shifts before conscious awareness
Measure attention dynamics across time (not just what — when and how)
Phase transition detection using harmonic rate-of-change
7+ distinct cognitive modes identified from metric signatures alone
Practice effectiveness measured through β floor/ceiling delta

Model Agnosticism

  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │   Claude   │  │  ChatGPT   │  │   Gemini   │  │   Llama    │
  │  (Anthropic│  │  (OpenAI)  │  │  (Google)  │  │  (Meta/    │
  │   API)     │  │            │  │            │  │   local)   │
  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
         │               │               │               │
         └───────────────┴───────┬───────┴───────────────┘
                                 │
                          MCP Protocol
                                 │
                    ┌────────────▼────────────┐
                    │     YOUR MYCELIUM       │
                    │                         │
                    │  Same data. Same tools. │
                    │  Switch models freely.  │
                    │  No lock-in. Ever.      │
                    └─────────────────────────┘

Your mycelium works with any model. Use Claude for deep reasoning, GPT for quick tasks, Llama for privacy-critical work. The context layer is yours regardless of which intelligence sits on top.

Why AI Companies Comply
Users will demand MCP write access from their AI providers.

Power users already want data portability — "I'm paying $20/month, this is MY conversation"
Privacy-conscious users won't accept Google/Meta reading their inner thoughts
AI providers that support MCP tools gain users who care about sovereignty
Those who don't? They lose them to providers who do.
Many users will stay locked in — and that's fine. But enough people care about ownership to create a market. The Proton generation proved this with email. Same dynamic, higher stakes.

Competitive Landscape
Player	Approach	Missing
Mem0	Memory layer, 21 integrations	No topology. No measurement. Centralized.
Zep	Temporal knowledge graphs	No co-firing. No harmonics. Not self-hostable.
Letta	Self-editing memory	No measurement pipeline. Single-agent.
Screenpipe	Local-first, 19K stars	Screen capture only. No semantic topology.
Mycelium	Self-sovereign + topology + federation	—
Everyone else is building memory retrieval. We're building measurement science.

The Moat
What can be copied (and that's fine)
MCP interface spec (37 tools)
Vault structure (BYOS, local-first)
Federation protocol
Basic clustering approach
What can't be copied
1. Topology Science
Leiden + co-firing + harmonics + Fisher isn't just code — it's a measurement paradigm. Years of calibration, baseline ranges, regime signatures. The science compounds.

HIGH
2. Data Gravity
Once your topology is computed over months, that IS you. Switching = recomputing from scratch. The longer you're on it, the richer the temporal patterns.

HIGH
3. Network Position
Reference implementation + managed provider of the protocol standard. Copies validate the protocol, which validates us. Linux Foundation / Red Hat dynamic.

MEDIUM
4. Developmental Layer
Curious Life on top: "what your topology MEANS and what to DO about it." Requires lived practice + companion relationship + teaching. Service moat, not tech moat.

HIGHEST
More openness = more defensibility. Every fork validates the protocol. Copiers who can't match the topology science produce worse results, sending serious users back to the source.

Business Model

┌─────────────────────────────────────────────────────────────┐
│                                                              │
│  LAYER 3: Curious Life Programs                   $$$$      │
│  Transformation. Teaching. Community. Retreats.              │
│  Can't be copied — requires lived practice.                  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  LAYER 2: Topology-as-a-Service                   $$$       │
│  Managed computation. Calibration expertise.                 │
│  The Elastic Cloud equivalent.                               │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  LAYER 1: Managed Infrastructure                  $$        │
│  Hosting. Storage. Backups. Updates.                         │
│  The Proton / Vercel play. Recurring revenue floor.          │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  LAYER 0: Open Source                             free      │
│  Self-host everything. Full sovereignty.                     │
│  Validates the protocol. Grows the network.                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘

Federation: The Open Network

    ┌─────────┐         ┌─────────┐         ┌─────────┐
    │ Alice's │         │ Grant's │         │ User N  │
    │Mycelium │◄───────►│Mycelium │◄───────►│Mycelium │
    └────┬────┘         └────┬────┘         └────┬────┘
         │                   │                   │
         │    Federation Protocol (open)         │
         │    ─────────────────────────          │
         │    • Topology resonance discovery     │
         │    • Encrypted peer communication     │
         │    • Shared context pools             │
         │    • Agents talk to agents            │
         │                                       │
         └───────────────────┬───────────────────┘
                             │
                   ┌─────────▼─────────┐
                   │   OPEN NETWORK    │
                   │                   │
                   │  Agentic Reddit   │
                   │  Agents creating  │
                   │  context for the  │
                   │  creation of      │
                   │  context          │
                   │                   │
                   │  Everyone hosts   │
                   │  their own data   │
                   │  = no memory cost │
                   │  problem          │
                   └───────────────────┘

Mastodon failed because federation is expensive — servers store everyone's posts. Mycelium solves this: each user hosts their own data. The network coordinates; it doesn't store.

Technical Stack
MCP Layer (ships first)
Node.js / TypeScript
37 MCP tools
SQLite local storage
npm distribution
Zero dependencies beyond Node
@mycelium/mcp

Topology Layer
Python
FAISS vector index
Leiden community detection
Nomic embeddings (384-dim)
Docker distribution
mycelium/topology

Encryption
BIP-39 / AES-256-GCM
24-word recovery phrase
Client-side encryption
Per-category subkeys (HKDF)
Server stores only ciphertext
zero-knowledge

Federation (future)
Open Protocol
Topology-based discovery
End-to-end encrypted channels
Agent-to-agent communication
Shared context pools
protocol TBD

MCP Tools (37)
Category	Tools	Function
Memory	search, store, retrieve, getDailyMessages	Full-text + semantic search across all history
Topology	exploreTerritory, mindscapeStructure, listTerritories	Navigate the cognitive map
Measurement	getHarmonicState, getMetricSeries, getTrajectoryHistory	Live cognitive metrics
Documents	get, save, update, list, publish	Long-form content management
Agents	delegate, createTask, getTeamStatus	Multi-agent coordination
Social	reply, getDailyMessages, calendar	Communication layer
Discovery	searchMindscape, getTopMovers, getFlowFeatures	Pattern detection

What Ships First
The Atomic Unit
One npm install. One command. Your topology on your conversations.

$ npm install -g @mycelium/mcp
$ mycelium init
$ mycelium connect claude     # or: chatgpt, gemini, any MCP client

✓ Vault created (local SQLite, encrypted)
✓ MCP server running on localhost:3847
✓ Connect your AI client → Settings → MCP → localhost:3847

That's it. Your AI now has persistent, private, searchable memory.
Topology computation available via --topology=cloud or self-hosted Docker.

The Proton Parallel
Proton (email)
Privacy-first email
End-to-end encrypted
Bootstrapped on product
No VC needed for launch
Premium tiers fund growth
Now: 100M+ users, profitable

Mycelium (AI memory)
Privacy-first AI infrastructure
Client-side encrypted
Bootstrap on npm package
Self-hosted = zero hosting cost
Managed + topology tiers fund growth
Target: the people who chose Proton over Gmail

mycelium.id · May 2026
Self-sovereign memory infrastructure for the AI age.

---

## V1 reality deltas (reconciliation, 2026-05-31)

The pitch is the destination. This section lists where it diverges from the **built + locked V1** so the two are never confused. Verified against `src/`, `CLAUDE.md`, and `docs/V1-BUILD-SPEC.md` (decisions D1–D7). The code is ground truth; the pitch is the aim.

| # | Pitch says | V1 reality (verified) | Note |
|---|---|---|---|
| 1 | **"37 tools"** (hero diagram, Layer 1, MCP-tools table) | **30 live tools** today (spec target was ~34 single-user). | The pitch's tool table lists `delegate`, `getTeamStatus`, `reply`, `calendar` — **none are registered in V1**. Use "30+ and growing" or drop the exact number in external copy. Live set: getContext, captureMessage, search/mindscape/topology/metrics/health/tasks/documents/mind-files families. |
| 2 | **"BIP-39 / 24-word recovery phrase"** (Encryption stack) | **Two 64-char hex keys (USER_MASTER + SYSTEM_KEY), explicitly NO BIP-39** — decisions D4 + D6, per-key KCV. | BIP-39 is a **V2 / Layer-5** roadmap item (`CLAUDE.md:117`), not V1. The "zero-knowledge / client-side / server-stores-ciphertext / HKDF-subkeys" framing IS accurate. |
| 3 | **"Nomic embeddings (384-dim)"** | **Nomic v1.5 ONNX, 768-dim** search + **256-dim** matryoshka for clustering — decision D2. | 384 is simply wrong; correct to 768 (with 256 for clustering) in external copy. |
| 4 | **"Agent Coordination" box + "Agents: delegate, getTeamStatus" as a shipped layer** | Single-user V1 — **multi-agent coordination is dropped/deferred** (`delegate_to_agent`/`getTeamStatus` not registered). | Legitimate **future** tier; present it as roadmap, not shipping. `createTask`/`listTasks` (single-user task list) ARE built. |
| 5 | **"npm install @mycelium/mcp" / "localhost:3847" / "mycelium init/connect"** | No published npm package yet; transports are **stdio + OAuth-HTTP** (Streamable HTTP); port is configurable (not 3847). | The packaging/CLI is aspirational. "Ships first / one command" describes the *intended* DX, not today's. |
| 6 | **Federation in the hero "Shape" diagram** | Federation is **Layer 3 / deferred** — gated until V1 ships + validates (`docs/V1-BUILD-SPEC.md:1225`). | The pitch *does* label federation "future / protocol TBD" in the stack + deployment sections — only the hero diagram oversells it as core. |
| 7 | **Managed infra / topology-cloud / Curious Life tiers** | All **future business model**, not built. | Appropriately tiered as future in the Business Model section — no fix needed, just don't imply availability. |

### What the pitch gets right (and is built or locked)
- **Model-agnostic MCP core** — real: low-level MCP `Server`, any MCP client connects (stdio + OAuth-HTTP). ✅ built.
- **Self-hosted encrypted BYOS vault, "server stores only ciphertext"** — real: AES-256-GCM wrapped-DEK envelope, transparent at the query layer, fail-closed. ✅ built + verified.
- **Topology / co-firing / harmonics measurement moat** — the pipeline is ported (Tier-1; clustering wheels need a networked host for Tier-2). ✅ built, the differentiator is genuine.
- **Semantic search** — in-RAM ANN + BM25 + RRF (the real `searchMindscape`, not FTS5). ✅ built.
- **Federation-as-future, Proton playbook, open-source Layer 0** — strategy matches the architecture's deferral ordering. ✅ consistent.

### Recommended external-copy fixes (minimal, no strategy change)
1. **37 tools → "30+ tools (and growing)"**, and update the tools table to the registered set (drop delegate/getTeamStatus/reply/calendar or move them to a "roadmap" column).
2. **BIP-39 / 24-word → "hex master key (AES-256-GCM)"** for V1; keep "BIP-39 recovery — roadmap."
3. **384-dim → 768-dim** (256-dim clustering).
4. Mark **Agent Coordination**, the **npm package/CLI**, and **federation** as **roadmap**, not "ships first / core."

These keep the vision and strategy fully intact while ensuring no shipped/spoken claim is factually false — consistent with the project's "flag contradictions proactively" discipline.
