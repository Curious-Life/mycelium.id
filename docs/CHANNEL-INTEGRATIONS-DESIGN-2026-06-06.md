# Channel Integrations — Two-Way Conversational (Telegram first)

> **Status.** Design / plan (2026-06-06). Branch `feat/channel-integrations`, worktree `/private/tmp/myc-channels`.
> **Scope (locked with operator):** TWO-WAY conversational channels. Inbound message → agent reasons over the
> vault → reply delivered back on the same channel. **Telegram is the first end-to-end vertical slice.**
> Discord + WhatsApp follow on the same spine.
>
> This doc reconciles three codebases: the **built** V1 ingestion surface here, the **reference/** harvest already
> copied into this repo, and the **canonical production repo** `Curious-Life/mycelium`
> (`/Users/altus/Documents/GitHub/mycelium`) which runs the full two-way path in production today.

---

## 0. TL;DR

V1 (mycelium.id) is, by Decision **D5**, a **pure MCP tool server** — no agent loop, no scheduler, no lanes. The
ingestion half of "channels" is already built and solid (`captureMessage` choke-point + REST + dedup + enrichment).
The **two-way** half needs the one thing D5 deliberately dropped: an **agent loop** that, on an inbound message,
runs an LLM turn with the vault's tools and delivers a reply.

The canonical repo already has this entire path working in production, but coupled to its **multi-agent PM2
orchestration** (per-agent processes on ports 5000–5029, D1, Cloudflare Worker, orchestrator). The transports and
egress chokepoints inside it are **cleanly harvestable**; the orchestration is not.

**Plan:** build a single new process — the **`channel-daemon`** (a single-user, single-agent "agent-server") — that
sits beside the existing REST/MCP server. It:
1. runs the **Telegram transport** (harvested), receives inbound messages;
2. **captures** every inbound via the already-built `captureMessage` path;
3. runs **one agent turn** (Claude, headless) with **V1's own MCP tools attached** — the agent reads/searches the
   vault and composes a reply;
4. the agent delivers via the **`reply` MCP tool** (already written, currently deferred) → through a minimal
   **`/telegram/send` egress chokepoint** (harvested) → back to the user.

This keeps V1's MCP tool server as the unchanged core. The daemon is a **client** of it. We are not reversing D5
inside the tool server; we are adding an *optional* agent runtime as a separate, self-hostable process.

---

## 1. What exists today (code-grounded)

### 1a. This repo (mycelium.id) — INGESTION is built, EGRESS is deferred

| Piece | State | Evidence |
|---|---|---|
| `captureMessage()` choke-point — id-dedup, content-aware upsert, auto-encrypt, enrich hook | ✅ built | `src/ingest/capture.js:62` |
| `captureMessage` + `importMessages` MCP tools | ✅ built | `src/tools/ingest.js:20,39` |
| REST `POST /api/v1/captureMessage` (localhost no-auth; OAuth-HTTP remote) | ✅ built | `src/server-rest.js`, `docs/CONNECTORS.md` |
| `messages` dedup + content-hash upsert (migrations 0007) | ✅ built | `src/ingest/capture.js:95-138` |
| Channel DB plumbing: `identity_channels`, `telegram_groups`, `user_identities`, `egress_audit` | ✅ schema built | `src/db/{identity-channels,telegram-groups,user-identities,egress-audit}.js`, `migrations/0001_init.sql` |
| `reply` MCP tool (agent-explicit egress) | ⚠️ **deferred** — calls `${agentUrl}/internal/inbound-context/current` + `${agentUrl}/{platform}/send`, **neither exists in `src/`** | `src/tools/reply.js:103,112`; deferred at `src/mcp.js:119` |
| Telegram/Discord/WhatsApp **bridge processes** | ❌ not ported — reference only | `reference/bots/*.js` |
| `/telegram/send` send-handler chokepoint + inbound-context active-turn registry | ❌ not ported — reference only | `reference/egress/{send-handler,inbound-context,agent-egress}.js` |
| **Agent loop** (inbound → LLM turn → reply) | ❌ **does not exist** — D5 dropped it; inference router is single-shot only | `src/inference/router.js:24-26` (tasks = summarize/classify/extract/narrate/complex) |
| Data connectors (Gmail/Linear/Obsidian *pull*) — distinct from chat channels | ✅ framework built | `src/connectors/` |

**Net:** ingest is done; the missing half is (a) the transport bridge, (b) the egress chokepoint the `reply` tool
already targets, and (c) the agent loop that ties inbound → reply.

### 1b. Canonical repo (`Curious-Life/mycelium`) — full two-way, but PM2-coupled

Harvestability verdict per component (from a full read of the production code):

| Component | Canonical path | Harvest |
|---|---|---|
| **Telegram transport** | `packages/bots/telegram-bot.js` (~1660 LOC) | ✅ clean — Grammy long-poll, lockfile guard, text-coalescing/debounce, `/telegram/send` + `/telegram/send-file`, voice TTS, owner/group auth. Pure transport. **Strip to ~300 LOC for single-user.** |
| **WhatsApp transport** | `packages/bots/whatsapp-bot.js` (~756 LOC) | ✅ clean — Baileys wrapper. (Phase 3.) |
| **Discord transport** | `packages/core/discord-bot.js` + agent shims | ⚠️ partial — core is clean, shims are PM2-coupled. (Phase 2.) |
| **Send-handler factory** (gate sequence) | `packages/server/lib/send-handler.js` (~479 LOC) | ✅ clean — requireSecret → kill-switch → content → assertDeliverable → envelope-dedup → channel-authority → API call → persist+hook. Optional gates degrade cleanly. |
| **Active-turn registry** | `packages/server/lib/inbound-context.js` (~83 LOC) | ✅ clean — minimal singleton. Already mirrored at `reference/egress/inbound-context.js`. |
| **Lane serialization** | `@mycelium/core/lanes.js` | ✅ clean — single-user needs only a trivial 1-deep queue; can reimplement in ~30 LOC. |
| **Message persistence I/O** | `packages/server/lib/messages-io.js` | ◑ superseded — V1's `captureMessage` already covers inbound + the metadata contract; harvest the metadata *shape* only. |
| **Channel-auth registry** | `packages/server/routes/channel-auth.js`, `services/channel-auth/` | ✅ clean — V1 already has the `identity_channels` table; port the upsert/verify routes. |
| **Agent /chat loop** | `packages/server/routes/chat.js` (~2200 LOC) | ⚠️ hard — runs the agent via `spawn(CLAUDE_BIN)` + `runWithContinuation` (session resume). Deeply wired to multi-agent prompt sections, checkpoints, PM2. **Do NOT port wholesale — reimplement the single-user core (~200 LOC).** |
| **PM2 / port-range / orchestrator / D1 / Worker** | `ecosystem.config.cjs`, `index.js` | ❌ leave behind — multi-tenant infra. |

**Key reuse insight:** the canonical agent runtime is **`claude` CLI spawned headless** with MCP tools, not a
bespoke loop. V1 is already an MCP server. So the daemon's agent turn = "spawn a headless Claude (or Agent SDK
`query()`) pointed at V1's MCP server." That is a small, well-trodden integration, not a from-scratch agent.

---

## 2. The architectural decision (the fork)

Two ways to get a two-way loop:

- **Option A — Port the canonical agent-server monolithically.** Lift `chat.js` + `agent-server.js`, strip
  multi-agent/PM2/D1. *Rejected:* drags in checkpoints, continuation, lanes, team-directory prompt assembly, and a
  2200-LOC file built for an architecture we explicitly left behind. High coupling, high surface, fights D5.

- **Option B — Thin single-user `channel-daemon` over V1's MCP server.** ✅ **RECOMMENDED.** The MCP tool server
  stays the untouched core. The daemon is a separate process that owns the transport + egress + a *minimal* agent
  turn, and reaches the vault **only through V1's existing MCP tools** (the same surface a desktop client uses).
  This is the smallest thing that is correct, it honours the "D5 = tool server" boundary (the loop lives outside
  it, opt-in), and it reuses the `reply` tool exactly as already designed.

### Why Option B fits the `reply` tool that's already written

`src/tools/reply.js` already expects an agent-server exposing `GET /internal/inbound-context/current` and
`POST /{platform}/send`. **The daemon IS that agent-server.** We are not redesigning the egress contract — we are
finally building the host the contract was written against. The deferred tool flips on the day the daemon ships.

### Agent runtime sub-decision — RESOLVED (operator delegated to recommendation, 2026-06-06)

**Decision: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, `query()`) behind a one-method `AgentRuntime`
interface.** Most elegant, robust, and secure of the four candidates:

| Candidate | Verdict |
|---|---|
| **Claude Agent SDK `query()`** ✅ **CHOSEN** | V1 is already an MCP server → the SDK attaches to it as a native MCP client with **zero glue**. Eliminates the single riskiest component we'd otherwise hand-write: the agentic tool-use loop (parallel tool calls, max-tokens mid-tool, malformed tool args, loop bounds, session resume) — all maintained by Anthropic. Least code, highest robustness. |
| Spawn `claude` CLI headless | Proven (canonical uses it) but drags in a subprocess + `.claude` config dir + stdout-JSON parsing + a **secrets-env blacklist** (canonical had to build exactly this to keep keys out of `pm2 dump`). More attack surface, less elegant. |
| Raw Messages API loop | No new dep, full control — but we then **own every edge case** the SDK handles for us. More code, lower robustness. Kept as the SDK-less fallback backend. |
| Local Ollama loop | Weaker tool-calling reliability → not default-grade. Kept as the **sovereign/offline backend**. |

**The security feature is the abstraction, not the runtime.** We define:

```
AgentRuntime.runTurn({ systemPrompt, userMessage, mcpServerRef, signal }) -> { delivered, usedReplyTool, audit }
```

with pluggable backends: `claude-agent-sdk` (cloud BYOK, default), `messages-api` (cloud, SDK-less fallback),
`ollama` (local, sovereign). Transport / capture / egress / chokepoint are **identical** regardless of backend —
so we are never locked to cloud, and a future local-first posture is a drop-in, not a rewrite.

### Inference-locus plan — RESOLVED: locus is implied by configuration (fail-closed)

The operator asked for a thought-through plan that is **flexible + simple and defaults to the recommended pick**.
Rather than add a mode flag, **the locus is selected by what's configured** — one rule, no extra knob:

| Configuration present | Locus | Rationale |
|---|---|---|
| BYOK cloud key (e.g. `ANTHROPIC_API_KEY`) | **cloud Agent SDK** (the default pick) | Best reply quality + reliable tool-use; consistent with V1's existing *opt-in, audited* cloud BYOK egress stance. |
| only a local tool-capable model | **local Ollama runtime** | Full sovereignty, no off-box egress. |
| neither | **two-way replies disabled** (ingestion still works) | Fail closed — never silently degrade to an unconfigured path. |

**Security wrapping of the cloud locus** (this is a cognitive vault — a reply turn pulls intimate vault context into
the prompt, a larger egress than a one-shot `narrate`):
- Every cloud reply-turn is recorded through V1's **existing inference egress audit** (`src/inference/egress.js`):
  provider · jurisdiction · decision · **content hash + length only, never plaintext**. Fail-closed.
- BYOK = the user's own key; supplying it *is* the opt-in. No key ⇒ no cloud egress, by construction.
- Logs redact message bodies; `egress_audit` (channel side) already stores only a content hash.

**Evolution path (NOT built in v1 — keeps v1 simple):** an `auto` router that runs simple/short turns locally and
escalates only complex turns to cloud, reusing the `LOCAL_TASKS`/`CLOUD_TASKS` split already in
`src/inference/router.js:24-26`. Add it once both backends are validated; the `AgentRuntime` interface already
accommodates it with no caller changes.

---

## 3. Target architecture (Option B)

```
            Telegram Bot API (long-poll or webhook)
                        │  inbound
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  channel-daemon  (NEW single process — packages/channel-daemon)│
│                                                               │
│  1. transport (harvested telegram-bot.js, stripped)           │
│       owner/group auth · text debounce · /telegram/send       │
│  2. on inbound:                                               │
│       a. captureMessage(...)  ──────────►  REST /api/v1/captureMessage  (BUILT)
│       b. setActiveTurn({source, channelId, inboundMessageId}) │
│       c. run ONE agent turn (runtime = §6 decision)           │
│            tools = V1 MCP server (search/getContext/reply…)   │
│       d. agent calls `reply` tool ──► /internal/inbound-context/current
│                                   └──► POST /telegram/send  (chokepoint)
│  3. egress chokepoint (harvested send-handler.js, single-platform)
│       kill-switch · content · envelope-dedup · channel-authority
│       · egress_audit · Telegram API call · audit outbound captureMessage
└─────────────────────────────────────────────────────────────┘
                        │  outbound
                        ▼
            Telegram Bot API  →  user
```

**Process model:** two processes on the host — (1) the existing REST+MCP server (`src/server-rest.js`,
the vault), (2) the new `channel-daemon`. The daemon talks to the vault over **localhost REST/MCP** (no-auth
loopback, same trust boundary as today) or the OAuth-HTTP surface if split across hosts. No PM2 required; a
single `npm run channel:telegram` (or a systemd unit) is enough for single-user.

**Security invariants preserved (CLAUDE.md §11, §12, §13):**
- **Explicit-send only** — the agent's free text is never delivered; the *only* egress path is the `reply` tool →
  `/telegram/send` chokepoint. The daemon never echoes raw model output to Telegram.
- **Every artifact persists** — inbound captured before the turn; outbound captured by the chokepoint after send.
- **No ad-hoc ports** — the daemon binds one documented loopback port (the chokepoint), like the canonical bot.
- **Channel authority** — `/telegram/send` resolves the target against `identity_channels`; unbound chats are
  refused (fail-closed). Owner binding bootstrapped from `OWNER_TELEGRAM_ID` on first run.
- **Plaintext discipline** — chatId/content redacted in logs; `metadata` encrypted at rest (already in
  `ENCRYPTED_FIELDS.messages`); `egress_audit` stores only a content **hash**.

---

## 4. Build plan — Telegram first (phased)

Each phase ends at a runnable, verifiable state (per `/deploy-and-verify`). Remote/Telegram phases are
host-verified against the live Bot API (token-gated), not CI.

### Phase 0 — Scaffold + flip the deferred egress (no LLM yet) — ✅ BUILT (2026-06-06)
- `packages/channel-daemon/` — `config.js`, `inbound-context.js` (harvested), `dedup.js`, `telegram-api.js`,
  `vault-client.js`, `chokepoint.js`, `server.js`, `index.js`, `README.md`.
- `GET /internal/inbound-context/current` + `POST /telegram/send` (`server.js`). Chokepoint gate order
  (`chokepoint.js`): content present → fail-closed routing → trivial-content → provenance (strict-loopback header) →
  channel-authority (fail-closed) → envelope-dedup → Telegram send → egress-audit (hash only) + outbound persist.
- Vault side (additive, no tool-behavior change): wired `egressAudit` + `identityChannels` into `getDb`
  (`src/db/index.js`); new `src/internal-router.js` (`POST /api/v1/internal/egress-audit`,
  `GET /api/v1/internal/channel-authority`) mounted in `buildVaultSubApp` (`src/server-rest.js`).
- **Verified:** `npm run verify:channel-egress` (19/19 GO — chokepoint gates, DI fakes) +
  `npm run verify:channel-egress-e2e` (12/12 GO — REAL vault + REAL daemon + fake Telegram: fail-closed authority,
  registry binding flips delivery, real `egress_audit` + outbound `messages` rows written, zero-plaintext sweep).
  Regression: `verify:rest` + `verify:mcp` GO (caught + fixed a router-order bug where the internal router's
  `express.json` stole `apiRouter`'s malformed-JSON envelope). The `reply` MCP tool now resolves end-to-end against
  the daemon. *Egress proven before any agent exists.*
- **Not yet host-verified (token-gated, per the design's convention):** a real message to `api.telegram.org` — the
  `telegram-api.js` Bot API call path is exercised only via a fake `fetch` in CI; smoke against a live bot token on
  the operator's host.

### Phase 1 — Inbound transport + capture (no reply yet) — ✅ BUILT (2026-06-06)
- Raw-`fetch` long-poll (NO Grammy dep — `telegram-api.js` `getUpdates`/`getMe`; `transport/telegram-poller.js`
  confirm-by-offset loop with capped backoff + single-instance 409 tolerance). Pivot from the design's "harvest
  Grammy bot": V1 carries no Telegram lib, so a ~60-LOC raw poller fits the house "platform APIs over built-in
  fetch" idiom and adds zero deps.
- `transport/normalize.js` (update → normalized inbound) + `inbound.js` (`createInboundHandler`): fail-closed owner-DM
  authorization (groups deferred to the Phase 3 binding flow), `captureMessage` via REST
  (`id = tg-<msgId>-<chatId>`, `source:'telegram'`, `role:'user'`, `conversationId`, owner/sender `metadata`,
  original `createdAt`), then `runTurn(turnCtx)`. Phase 1 `runTurn` stub sets the active-turn registry so the egress
  chokepoint + `reply` tool work against a live inbound; Phase 2 swaps in the real lane (set → agent → clear).
- Wired into `index.js` (`getMe` token validation → server + poller, graceful SIGTERM).
- **Verified:** `npm run verify:channel-inbound` (18/18 GO — normalization, offset advance, capture shape,
  idempotent id, fail-closed auth for non-owner + groups, voice/empty skip, soft-fail capture) + the e2e now also
  proves inbound capture against the REAL vault (`E8b/E8c`: a real `role=user/source=telegram` row + active turn).
- **Not yet host-verified (token-gated):** a real `getUpdates` poll against a live bot. Voice transcription, group
  binding, and text coalescing/debounce are deferred (Phase 2/3).

### Phase 2 — The agent turn (two-way closes) — ✅ BUILT (2026-06-06)
- `agent/runtime.js` — `selectRuntime(cfg)` config-implied locus (BYOK key → Claude Agent SDK; none → null =
  capture-only). `agent/backends/claude-sdk.js` — the default runtime, **lazy-imports** the optional
  `@anthropic-ai/claude-agent-sdk` (declared in `optionalDependencies`), attaches the vault MCP (http to the running
  vault, or stdio-spawn), runs one `query()` turn with `getContext`/`searchMindscape`/`reply`, reports
  delivered/usedReplyTool. `agent/prompt.js` — the reply system prompt with the mandatory delivery contract.
- `agent/lane.js` — the single-user lane: **serializes** turns (the active-turn registry is one global; overlap
  would corrupt it), enqueue-and-return so polling continues, `setActiveTurn → runtime.runTurn → clearActiveTurn`
  in `finally`, per-turn AbortController timeout.
- `reply` **un-deferred** in `src/mcp.js`, gated on `AGENT_URL` (set by the daemon) — the default tool surface
  (Claude Desktop / CI) is unchanged; the tool soft-fails outside a channel turn.
- `index.js` wires runtime→lane→runTurn (null runtime → capture-only fallback).
- **Verified:** `npm run verify:channel-agent` (12/12 GO — lane set-during/clear-after, no-overlap serialization,
  error isolation, timeout abort, config-implied selection, prompt contract) + `npm run verify:channel-agent-e2e`
  (8/8 GO — the WHOLE loop with only the LLM faked: REAL vault + REAL daemon inbound→lane→chokepoint, fake agent
  behaving exactly like the reply tool: inbound user row + outbound assistant row both real, agent sees the active
  turn, delivery audited `agent-explicit-via-tool`, active turn cleared, zero-plaintext). Regressions GO.
- **Not yet host-verified (token-gated):** a real Claude Agent SDK turn (needs the SDK installed + `ANTHROPIC_API_KEY`
  + a running vault MCP with `AGENT_URL` set). The SDK message-shape sniffing in `claude-sdk.js` (usedReplyTool /
  delivered detection) is the one part exercised only on the host.

### Phase 3 — Hardening + 2nd/3rd platform — ◑ IN PROGRESS (2026-06-06)
Built (all platform-agnostic, so Discord reuses them unchanged):
- **Inbound coalescing** (`transport/coalescer.js`) — rapid fragments per chat merge into ONE turn after a quiet
  window (debounce); every fragment is still captured per-message. Wired ahead of the lane in `index.js`
  (`CHANNEL_COALESCE_MS`, 0 disables). Verified `verify:channel-coalesce` (7/7).
- **Outbound rate-limit** (`ratelimit.js`) — fixed-window per-target cap, wired as a chokepoint gate after dedup
  (deduped resends don't consume budget); over-limit → audit `denied`/`rate-limited` + 429 (reply tool surfaces
  `rate-limited`, no retry). `CHANNEL_RATELIMIT_MAX`/`_WINDOW_MS`. Verified `verify:channel-egress` C13–C15 (now 22/22).
- **Poller backoff jitter** (±30%) so repeated failures don't hammer the API in lockstep.

Also built (2026-06-06, second hardening pass):
- **Voice (TTS) replies** — the canonical `packages/core/tts/` module **harvested verbatim** into
  `packages/channel-daemon/tts/` (openai + elevenlabs providers, markdown strip, sentence chunking, **ffmpeg remux to
  Telegram mono/48k/32k opus**, per-chunk error codes, 120s provider + 30s remux timeouts, temp-dir cleanup,
  partial-success). `voice-pipeline.js` bridges it to a no-Grammy multipart `sendVoice` (`telegram-api.js`); wired
  into the chokepoint AFTER the text send, strictly fail-soft (synthesis/upload failure never fails the text reply).
  Config-implied: enabled only when `OPENAI_API_KEY` / `ELEVENLABS_*` is set. Verified `verify:channel-tts` (13/13,
  pure parts) + `verify:channel-egress` C16–C18 (voice wiring + fail-soft). ffmpeg + provider HTTP are host-verified.
- **Group binding** — `commands.js` (`/allow` · `/disallow` · `/channels`, owner-only, acks via the chokepoint as
  trusted system-template). `telegramGroups` wired into `getDb`; internal router gains
  `GET/POST/DELETE /api/v1/internal/telegram-group` + list. Inbound routes a group message through binding
  (fail-closed: unauthorized groups dropped; owner `/allow` works in an unbound group and is never captured/turned);
  outbound authority for groups consults `telegram_groups`. Verified `verify:channel-groups` (14/14: commands DI +
  inbound routing + real-vault endpoint round-trip).

### Discord — ✅ BUILT (2026-06-06, the planned reuse)
The chokepoint refactor + a second platform, proving the spine generalizes:
- **Refactor:** extracted the gate sequence into `egress/send-handler.js` (platform-agnostic core, canonical
  send-handler shape) driven by a per-platform **adapter** `{platform, contentField, targetField, sourceModule,
  inferKind, send}`. `chokepoint.js` (Telegram) + `discord-chokepoint.js` are now ~15-line adapters over it.
  Behaviour-preserving — all 8 prior Telegram gates stayed GO through the refactor.
- **Egress (raw fetch, CI-testable):** `discord-api.js` — `POST /channels/{id}/messages` (Bot token,
  `message_reference` for replies, 2000-char chunking) + voice via REST multipart (`flags: 8192` IS_VOICE_MESSAGE +
  waveform/duration_secs — the proven canonical path; the web sweep's "not feasible" was wrong). `discord-voice.js`
  uses `synthesizeForDiscord` (single buffer).
- **Inbound (gateway):** `transport/discord-gateway.js` lazy-imports **discord.js** (optional dep — only the
  stateful WS gateway uses it; egress stays raw fetch). Intents: Guilds + GuildMessages + **MessageContent**
  (privileged) + DirectMessages. `transport/discord-normalize.js` + `discord-inbound.js` (owner-only auth,
  `dc-<msg>-<chan>` capture, bot-loop guard). Reused unchanged: lane, runtime, dedup, coalescer, ratelimit,
  vault-client, inbound-context, and the `reply` tool (it platform-switches on `turn.source`).
- **Authority:** Discord sends are allowed to the active inbound turn's channel (reply path); cross-channel is
  fail-closed (allowlist deferred). **Settings:** Channels pane + `channel-config` + hydration extended for
  `DISCORD_BOT_TOKEN`/`OWNER_DISCORD_ID`; `assertEgressConfig` now needs ≥1 platform.
- **Verified:** `verify:channel-discord` (18/18 — normalize, REST shapes, egress gates via the shared core, inbound
  auth) + `verify:channel-settings` extended + full suite (12 gates) + `portal:build` GO. Host-verified only: live
  Discord gateway (needs discord.js + token + MESSAGE_CONTENT enabled) + real voice upload.

### Discord allowlist + threads — ✅ BUILT (2026-06-06)
Reuses the generic `identity_channels` registry (kind `discord`) + the existing channel-authority resolver — no new
table. `/allow`·`/disallow`·`/channels` (owner-only, `commands-discord.js`); inbound responds to the operator
anywhere OR anyone in an authorized channel (fail-closed otherwise); threads tagged `discord-thread` (normalize +
`reply` tool mapping). Settings list + revoke in the Channels pane. Verified `verify:channel-discord` (26) +
`verify:channel-settings` (20).

### Local Ollama runtime — ✅ BUILT (2026-06-06, sovereign)
`agent/backends/ollama.js` behind the `AgentRuntime` interface: a hand-rolled tool-use loop over Ollama `/api/chat`
(tools) + an **MCP client** (`@modelcontextprotocol/sdk` — no new dep) to the vault's own tools. `selectRuntime` is
now fully config-implied: Anthropic key → cloud SDK; else an Ollama model (`CHANNEL_OLLAMA_MODEL`) → local Ollama (no
cloud egress); else null (capture-only). The loop (`runOllamaTurn`) is exported pure + unit-verified
(`verify:channel-agent` OL1–OL4 with fake Ollama + fake MCP); a real Ollama + vault MCP is host-verified.

Deferred: WhatsApp (same spine), `auto` local/cloud router, voice-inbound transcription.

---

## 5. Harvest manifest (what to copy from where)

| Target (new) | Source | Transform |
|---|---|---|
| `channel-daemon/transport/telegram.js` | `reference/bots/telegram-bot.js` **and** canonical `packages/bots/telegram-bot.js` | strip multi-agent/PM2/D1/orchestrator; single owner; REST capture instead of `/chat` POST |
| `channel-daemon/egress/send-handler.js` | `reference/egress/send-handler.js` + canonical `lib/send-handler.js` | single platform (telegram) first; keep optional gates as no-ops until built |
| `channel-daemon/egress/inbound-context.js` | `reference/egress/inbound-context.js` | use almost verbatim (already single-process) |
| `channel-daemon/agent/turn.js` | canonical `routes/chat.js` (concept only) | reimplement minimal single-user turn; **do not** port checkpoints/continuation/team-prompt |
| `channel-daemon/agent/lane.js` | canonical `@mycelium/core/lanes.js` (concept) | ~30 LOC 1-deep queue |
| channel-auth routes (Phase 3) | canonical `routes/channel-auth.js` + `services/channel-auth/` | reuse V1's `identity_channels` table |
| metadata contract | canonical `lib/messages-io.js` + `docs/.../MESSAGE-PERSISTENCE.md` | adopt the `{channelId, fromName, messageId, origin, delivery,...}` shape into `captureMessage` metadata |

Already present here (no harvest needed): `captureMessage`, `importMessages`, `reply` tool, `egress_audit`,
`identity_channels`, `telegram_groups`, `user_identities`.

---

## 6. Decisions

**Resolved (2026-06-06):**
1. **Agent runtime** → **Claude Agent SDK `query()` behind an `AgentRuntime` interface** (§2). Backends:
   `claude-agent-sdk` (default), `messages-api` (fallback), `ollama` (sovereign).
2. **Inference locus** → **implied by configuration, fail-closed** (§2): BYOK key → cloud SDK (default); local model
   only → Ollama; neither → two-way disabled, ingestion still works. Cloud turns audited via `src/inference/egress.js`.
   `auto` local/cloud router deferred to the evolution path.
3. **D5 framing** → agent loop lives **outside** the MCP tool server as an opt-in daemon. D5 (pure tool server)
   stays intact.

**Still open (lighter — can be settled at Phase boundaries, not blockers for Phase 0):**
4. **Transport mode:** long-poll (zero infra, matches reference — recommended for v1) vs webhook (needs the public
   Tunnel remote-connect already ships). *Decide at Phase 1.*
5. **Persona/prompt source:** which mind-files / `getContext` slice seeds the agent's reply system prompt.
   *Decide at Phase 2.*

---

## 7. Risks / watch-items

- **Explicit-send regression** is the highest-severity failure class (the canonical repo spent real incidents on
  duplicate-send + silent-leak). The chokepoint + `reply`-tool path must be the *only* egress; assert it at boot.
- **Loopback trust:** the daemon→vault REST is no-auth on localhost by design. If daemon and vault ever split hosts,
  it MUST switch to OAuth-HTTP + TLS (CLAUDE.md §4, `docs/CONNECTORS.md` security notes).
- **Tool-call reliability on local models** — if sovereignty is required, validate Ollama tool-use before committing
  it as default; otherwise gate two-way replies behind cloud BYOK.
- **Single-writer dedup** — `id = tg-<msgId>-<chatId>` + envelope-dedup handle resends; verify under reconnect storms.

---

## 7b. Settings UI + the config bridge — ✅ BUILT (2026-06-06)

Closed the UI↔daemon mismatch found in the depth pass (the daemon read `process.env`; the portal wrote the
encrypted vault — they talked past each other). Now the **portal is authoritative** and the daemon hydrates from it:

- **Vault**: `/portal/settings/tts` GET/PUT (the VoiceSection backend — was never ported; now wired, secrets-backed)
  in `src/portal-settings.js`; new `src/portal-channels.js` (`/portal/channels` GET/PUT + `/channels/groups/:id`
  DELETE) for Telegram token/owner, the assistant (Anthropic) key, and the authorized-groups list. All values live in
  the encrypted `secrets` table under the same key names the daemon reads; **GET is zero-leak** (hasX booleans only).
- **Bridge**: `GET /api/v1/internal/channel-config` (loopback, in `src/internal-router.js`) returns those settings
  **decrypted** so the keyless daemon can use vault-managed config — the same same-machine trust model as
  captureMessage (the one place a plaintext key crosses loopback; never expose the REST surface to a network).
- **Daemon**: `vault-client.getChannelConfig()` + `applyChannelConfigToEnv()` hydrate `process.env` at startup
  (vault overrides env; env is the fallback) — the TTS module + `loadConfig` then read env unchanged.
- **UI**: `portal-app/.../settings/ChannelsSection.svelte` (Telegram token [write-only], owner id, two-way assistant
  key, model, authorized-groups list + revoke) mounted in `SettingsView`; `VoiceSection` now has a working backend.
- **Verified:** `verify:channel-settings` (16/16 — round-trips, zero-leak, decrypted bridge, env hydration, group
  authorize/list/revoke) + `npm run portal:build` GO. Regressions `verify:rest`/`verify:mcp` GO.
- **Deferred:** TTS `/preview` (returns 501 — synthesis needs the key in-process + ffmpeg; the daemon owns voice);
  per-setting live push (daemon picks up changes on next start, not hot-reload).

## 8. Next action

Runtime + locus are resolved (§6). **Execute Phase 0** — the egress chokepoint + inbound-context — which is
provable end-to-end *without any LLM* and flips the already-written `reply` tool from deferred to live. The
`AgentRuntime` interface lands in Phase 2; nothing in Phases 0–1 depends on the runtime choice.
