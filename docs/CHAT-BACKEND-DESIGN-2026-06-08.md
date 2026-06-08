# Chat Backend Design — provider-agnostic tool-using agent over the vault (production)

**Date:** 2026-06-08
**Status:** Design locked (pre-implementation). Sweep-first protocol applied — **three sweep cycles** (6 + 4 + 2 Explore sweeps) + operator-verified reads + Claude API tool-use reference.
**Author:** Claude (Opus 4.8) + operator
**Scope:** Make the already-ported floating chat (`ChatFloat.svelte`) a **real tool-using agent** in the **web** and **Tauri** apps for launch — one that works well **as an isolated MCP tool surface** (external clients) **and** as an **in-app agent harness driven by the intelligence the user selects** (Anthropic / OpenAI-compatible / EU-ZDR / local Ollama). Backend built on the existing 52-tool handler map + inference/provider layer.

---

## AS-BUILT (2026-06-08) — ✅ implemented + verified on `feat/chat-agent-harness`

Built end-to-end and verified. New code: [`src/agent/harness.js`](../src/agent/harness.js) (provider-agnostic tool loop, Anthropic + OpenAI-compat adapters), [`src/agent/tool-domains.js`](../src/agent/tool-domains.js) (the grantable "areas"), [`src/portal-chat.js`](../src/portal-chat.js) (`/agents` · `/chat/history` · `/chat/stream` · `/ai-access`), [`AIAccessSection.svelte`](../portal-app/src/lib/components/settings/AIAccessSection.svelte). Wired in `server-rest.js`; `cloud.js` exports `openStream`/`ssePayloads`/`postJson`; ChatFloat fetch fixed + Header launcher + Cmd/Ctrl+J. Tests: `npm run verify:harness` (23 checks), `npm run verify:chat` (real-vault route test) — both in the `verify` chain; `verify:nav` N6 updated to "chat live".

**Pivots found during build (sweep-first caught these in code, not in prod):**
1. **`AGENT_SCOPES` is process-env-global, not per-request** (`messages.js:16`, `crypto-local.js:1127`). Per-turn cryptographic *scope restriction* can't be done safely in a shared single-user process without threading `allowedScopes` through every handler→db→decrypt call. **So v1 enforces "areas" at the TOOL-DOMAIN level** (the harness only ever receives granted-domain tools — fully enforced, fail-closed); `scopes` are stored forward-compatibly; `getContext` already withholds `sensitive`-marked rows as the cloud backstop. Data-scope restriction → **deferred** (§14).
2. **Two adapters, not three** — local Ollama is driven through its **OpenAI-compatible `/v1`** surface by the same OpenAI adapter (with a tools-unsupported → text-only fallback), so there's no separate `/api/chat` adapter.
3. **`/agents` shadowing stub** — `portal-compat.js` had a placeholder `GET /agents → {agents:[]}` mounted earlier that shadowed the real endpoint. Removed (caller-audited: only ChatFloat consumes it). Caught by the full-server smoke, not the route unit test.
4. **No adaptive-thinking param sent** — omitted for cross-model safety (older Anthropic models 400 on it); revisit to opt Opus 4.x into `thinking:{type:'adaptive', display:'summarized'}`.

## 0. TL;DR

- The movable chat UI from canonical is **already ported** ([`ChatFloat.svelte`](../portal-app/src/lib/components/chat/ChatFloat.svelte), mounted at [`+layout.svelte:111`](../portal-app/src/routes/(app)/+layout.svelte)). **Tauri shares the same build** (`frontendDist:"../portal"`, server on `127.0.0.1:8787`). **Zero separate Tauri UI work.**
- **The unification is the architecture.** All 52 vault tools are `createXDomain(deps)→{tools,handlers}` with `handlers[name](args)→string` directly callable, JSON-Schema inputs. The **same handler map** is consumed two ways: (a) by external MCP clients over `/mcp` (already shipped), and (b) by a **new in-process agent harness** the in-app chat drives. One tool surface, two consumers — exactly the "isolated MCP tool **and** agent harness" requirement.
- **The harness is the real build.** V1 has **no agent loop today** (canonical/reference spawn the Claude CLI; this repo doesn't). The inference layer is **text-only** — no provider here does tool-calling yet. So we build `src/agent/harness.js`: a **provider-agnostic tool-use loop** (Anthropic `tool_use` ⋅ OpenAI `tool_calls` ⋅ Ollama `/api/chat` adapters) that streams, calls the 52 handlers **in-process**, and feeds results back until the model is done.
- **"Intelligence you select"** is honored: the harness drives whatever provider/model `resolve.js` returns. Tool-capable providers (Anthropic, OpenAI-compat, EU-ZDR, tool-capable local models) get the full agent; a no-tool local model degrades to the context relay.
- **Access = areas the user defines, full access within.** An "AI Access" settings panel grants **data scopes** (`personal/org/wealth/health` — each crypto-enforced by its own DEK + fail-closed guardian) and **tool domains** (full tool set each). The harness applies the policy every turn as the effective `AGENT_SCOPES` + granted-domain tools. Denying a scope is cryptographic, not advisory — non-granted data won't decrypt. Built entirely on existing primitives (no new permission system, no migration).
- **D5 is respected.** D5 forbids the *autonomous* loop (scheduler/lanes/recovery/compaction). This is a **user-driven, single-turn, bounded** agent loop — request → (think · call tools · respond) → idle. No scheduler, no background work. The repo already ships a server-side chat completion (`/v1/chat/completions`, server-http.js:480); this extends that posture to tool use.

---

## 1. What exists vs. what's missing (verified)

| Piece | State | Evidence |
|---|---|---|
| Movable chat UI, mounted; Tauri parity | ✅ | `ChatFloat.svelte`; `+layout.svelte:111`; `main.rs:25,224-349`; `tauri.conf.json` |
| 52 tool handlers, directly callable, JSON-Schema | ✅ | `collectTools` → `{tools,handlers}` `src/mcp.js:190-214`; `handlers[name](args)→string` `src/tools/curate.js:135`; dispatch `src/mcp.js:237-268` |
| Handler map already at the portal seam | ✅ | `boot()`→`{tools,handlers}` `src/index.js:96-105`; `buildVaultSubApp({…,handlers})` `src/server-rest.js:281` |
| `getContext` preamble | ✅ | `createContextDomain(deps).handlers.getContext`→markdown `src/tools/context.js:27-60` |
| Provider selection ("intelligence") | ✅ | `resolve.js:38-52` (anthropic / openai / baseUrl / jurisdiction); `portal-providers.js`; `ai_providers` table |
| §4g egress audit + sensitive jurisdiction hard-block | ✅ | `router.js:114-127,151`; `egress.js:20-39`; gateway `toolsPassthrough` §4g `openai-compat.js:236` |
| SSE precedent in a portal route | ✅ | `portal-hardware.js:76-90` |
| Persistence funnel + history | ✅ | `captureMessage(db,msg,enq)` `ingest/capture.js:62`; `db.messages.selectRecent(userId,{limit,agentId})` `db/messages.js:456` |
| **Agent/tool-use loop** | ❌ **Missing** | no `@anthropic-ai/sdk`, no `tool_use`/`tool_calls`/`stop_reason` parsing in `src/`; canonical spawns Claude CLI (`runner.js:322`) — not present here |
| **Tool-calling in inference layer** | ❌ **Missing** | `cloud.js:102,129,194-209` build no `tools`, parse text only; `local.js` uses `/api/generate` |
| `openStream` / `ssePayloads` reuse | ⚠️ module-private | `cloud.js:151,174` — must be exported for the harness |
| `/portal/chat/stream` · `/chat/history` · `/agents` | ❌ **Missing** | bare `/portal/*` 404s (server-rest.js:339,358) |
| Launcher entry point | ❌ **Missing** | `toggleChat()` exists unused `navigation.ts:133`; Cmd+J disabled `+layout.svelte:69` |

---

## 2. The structural defect the sweep caught (must-fix)

ChatFloat's stream uses a **raw `fetch('/portal/chat/stream')`** ([`ChatFloat.svelte:666`](../portal-app/src/lib/components/chat/ChatFloat.svelte)) that **bypasses** the `api()` `/portal/*`→`/api/v1/portal/*` rewrite ([`api.ts:40`](../portal-app/src/lib/api.ts)). Self-hosted V1 mounts portal routers only at `/api/v1/portal` (server-rest.js:111-153); bare `/portal/*` is a vault-data path **excluded from the SPA fallback** (server-rest.js:339,358) → **404**. The cloud product served bare `/portal/*`, so it worked there. **Fix:** point the stream fetch at `/api/v1/portal/chat/stream`. (History + agents already go through `api()` and are fine.)

---

## 3. Architecture — one tool surface, two consumers

```
            EXTERNAL MCP CLIENTS                       IN-APP CHAT (web + Tauri)
            (Claude Desktop, etc.)                     ChatFloat.svelte
                    │  /mcp (OAuth, :4711)                     │  POST /api/v1/portal/chat/stream
                    ▼                                          ▼
          StreamableHTTPServerTransport            portalChatRouter (NEW)
                    │                                          │  auth · build messages · persist
                    └──────────────┐            ┌──────────────┘
                                   ▼            ▼
                          handlers[name](args)  ← the SAME 52-tool map (src/index.js:96) →
                                   ▲            ▲
                                   │            │  in-process tool calls (no HTTP, no MCP)
                    ┌──────────────┘            └──────────────┐
                    │                                          ▼
        (external model is the agent)            src/agent/harness.js (NEW)
                                                 provider-agnostic tool-use loop:
                                                   resolve provider ("intelligence you select")
                                                   ├─ Anthropic adapter   (tool_use / tool_result)
                                                   ├─ OpenAI-compat adapter(tool_calls / role:tool)
                                                   └─ Ollama adapter      (/api/chat tools; else relay)
                                                 loop: stream → tool_use? → handlers[name] → feed back
                                                       → until end_turn (bounded; §4g + audit honored)
```

**The in-app harness calls tool handlers directly in-process** — not over `/mcp`. Verified rationale: the `:4711` MCP server only runs when remote mode is on (desktop default = `:8787` only, `main.rs:264-340`) and spins a **fresh isolated DB per session** (server-http.js:336) — wrong for the unlocked vault; the handlers are already in memory in the `:8787` process; and there is **no MCP-client SDK** in `package.json`. Direct dispatch (`handlers[name](args)`) is fewer moving parts and shares the open DB.

**Why a new module, not the router (Sweep E):** `inferStream` is text-only and the text path must stay simple; `openStream`/`ssePayloads`/`postJson` are clean provider-agnostic utilities. So the harness is a standalone module that **exports + reuses** those helpers and keeps the tool loop out of the router.

---

## 4. Provider × tools × jurisdiction matrix (load-bearing)

The harness drives the user-selected provider (`resolve.js`). Tool-calling protocol + §4g jurisdiction differ:

| Selected "intelligence" | Tool-calling | Jurisdiction | Behavior |
|---|---|---|---|
| **EU-ZDR** (Regolo/Scaleway, OpenAI-compat) | `tool_calls` | `eu-zdr` | ✅ **Full tool agent**, vault context allowed (§4g permits) |
| **Local Ollama**, tool-capable model | `/api/chat` `tools` | `local` | ✅ **Full tool agent**, all context (never leaves box) |
| **Local Ollama**, no-tool model | — | `local` | ⤵ Degrades to **context relay** (getContext preamble, no loop) |
| **Anthropic** (native) | `tool_use` | `us-standard` | ✅ tool agent; **sensitivity-filtered context** (see §6.1) |
| **OpenAI** (native) | `tool_calls` | `us-standard` | ✅ tool agent; **sensitivity-filtered context** (see §6.1) |

JSON-Schema is the lingua franca: Mycelium tool defs map to Anthropic `input_schema`, OpenAI `function.parameters`, and Ollama tools with near-zero transformation.

---

## 5. SSE contract — now we emit the rich events natively

Because the harness *knows* tool boundaries, it produces the events the UI already handles ([`ChatFloat.svelte:566-625`](../portal-app/src/lib/components/chat/ChatFloat.svelte)) — no longer a degraded subset:

| Event | Shape | Source in the loop |
|---|---|---|
| `stream_start` | `{type:'stream_start',streamIndex:0}` | turn start |
| `thinking_delta` | `{type:'thinking_delta',content}` | adaptive-thinking summary (Anthropic; opt-in `display:"summarized"`) |
| `tool_start` | `{type:'tool_start',name}` | on `tool_use` / `tool_calls` block detected |
| `tool_complete` | `{type:'tool_complete',name}` | after `handlers[name]` returns |
| `tool_error` | `{type:'tool_error',name}` | handler threw (result fed back `is_error`) |
| `text_delta` | `{type:'text_delta',content}` | assistant text deltas |
| `keepalive` | `{type:'keepalive'}` | every ~15s |
| `error` | `{type:'error',message:<safe const>}` | failure — **never** echo `err.message` (§1) |
| `done` | `{type:'done',toolsUsed}` | `stop_reason:end_turn`; then `data:[DONE]` |

`usage` is emitted when the provider returns token counts (Anthropic `message_delta.usage`; OpenAI usage chunk) — never fabricated (§10).

---

## 6. Module shape (exact)

### 6.1 `src/agent/harness.js` (NEW, ~420–560 LOC)
```js
export function createAgentHarness({ resolveProvider, openStream, ssePayloads, postJson, emitEgress, logger }) {
  // streamTurn drives ONE user turn to completion, emitting events via send().
  // tools: [{name, description, inputSchema}] (the allowlisted subset, §6.3)
  // call:  async (name, args) => string   (in-process handlers[name])
  async function streamTurn({ system, messages, tools, call, send, signal, maxIterations = 8 }) {
    const cfg = await resolveProvider();                 // {kind:'anthropic'|'openai'|'local', model, baseUrl, key, jurisdiction}
    const adapter = pickAdapter(cfg);                    // anthropic | openaiCompat | ollama | textRelay(no-tool local)
    for (let i = 0; i < maxIterations; i++) {
      emitEgress(/* hash+len only */);                   // §8 audit per model call
      const { text, toolCalls, stopReason, usage } = await adapter.streamOnce({ cfg, system, messages, tools, send, signal });
      messages.push(adapter.assistantTurn(text, toolCalls));
      if (stopReason !== 'tool_use') { send({type:'usage',...usage}); return { messages }; }
      const results = [];
      for (const tc of toolCalls) {
        send({type:'tool_start', name: tc.name});
        let out, isErr=false;
        try { out = await call(tc.name, tc.args); }      // ← the SAME 52-tool handler map, in-process
        catch { out = 'tool failed'; isErr=true; send({type:'tool_error', name: tc.name}); }
        if (!isErr) send({type:'tool_complete', name: tc.name});
        results.push(adapter.toolResult(tc, out, isErr));
      }
      messages.push(adapter.toolResultsTurn(results));
    }
    // maxIterations hit → final no-tools pass for a clean answer (log the cap, §"no silent caps")
  }
  return { streamTurn };
}
```
**Three adapters** (each ~80–130 LOC), reusing `openStream`/`ssePayloads` (exported from `cloud.js`):
- **Anthropic** `/v1/messages`: body adds `system`, `tools:[{name,description,input_schema}]`, `tool_choice:{type:'auto'}`, `thinking:{type:'adaptive'}` (Opus 4.x — adaptive only; **no** `budget_tokens`/`temperature`, per Claude API ref), `stream:true`. Parse SSE: `content_block_start{type:'text'|'tool_use',id,name}`, `content_block_delta{type:'text_delta'|'input_json_delta'(partial_json)|'thinking_delta'}`, `content_block_stop`, `message_delta{stop_reason,usage}`. `tool_result` blocks `{type:'tool_result',tool_use_id,content,is_error}` go back in a user turn. **Default model `claude-opus-4-8`** unless the user's `model_preference` says otherwise.
- **OpenAI-compatible** `/v1/chat/completions` (covers OpenAI, OpenRouter, Regolo, Scaleway, vLLM): body adds `tools:[{type:'function',function:{name,description,parameters}}]`, `tool_choice:'auto'`, `stream:true`. Parse: `choices[0].delta.content`, `choices[0].delta.tool_calls[i]{index,id,function:{name,arguments(partial)}}`, `finish_reason:'tool_calls'`. Feed back `{role:'assistant',tool_calls}` + `{role:'tool',tool_call_id,content}`.
- **Ollama** `/api/chat` with `tools` (tool-capable models). Capability probe → if the model rejects/ignores tools, fall back to **textRelay** (getContext preamble, plain `inferStream`, no loop).

### 6.2 `src/portal-chat.js` (NEW, ~280 LOC)
```js
export function portalChatRouter({ db, userId, handlers, domainTools, contextDomain, inference, readAccessPolicy, enqueueEnrichment, authenticatePortalRequest }) {
  // GET  /portal/agents              → single synthetic 'personal-agent' (status:'online')
  // GET  /portal/chat/history        → selectRecent → ChatMessage[] (omit metadata/entities/embedding — §1/§7)
  // POST /portal/chat/stream         → SSE: load policy → build messages → harness.streamTurn → persist both turns
}
```
- Loads the **AI Access policy** (`readAccessPolicy()` → `{scopes,domains,includeSensitiveOnCloud}`, §6.6).
- Builds `system` = `getContext()` preamble **+** retrieval, **run under the granted `scopes`** (scope guardians enforce); `messages` = recent history + user message; `tools` = union of the granted **domains**' tool defs (§6.3); `call = (n,a)=>handlers[n](a)` (also scope-bounded).
- Persists user + assistant turns via `captureMessage(..., source:'portal-chat')` on success (encrypted at rest, enqueued for embedding/enrichment).

### 6.3 Tool access = user-defined areas, full access within (operator decision)
**No hardcoded allowlist.** The user defines, in an **"AI Access" settings panel**, which **areas** the connected AI may use; within a granted area the AI gets **full access** (read + write + destructive). Two orthogonal axes, both grounded in primitives that already exist:

- **Data scopes** (`personal` · `org` · `wealth` · `health`) — granting a scope sets it in the effective `AGENT_SCOPES` for the turn, which is **cryptographically enforced**: each scope has its own DEK (HKDF `mycelium:scope:<scope>:v1`, `crypto-local.js:992-1017`) and a **fail-closed guardian** refuses to unwrap ciphertext for a non-granted scope (`crypto-local.js:84-169`). Denying a scope means the AI's retrieval/getContext/handlers physically cannot decrypt that data — not an advisory filter.
- **Tool domains** (~14: `memory/curate` · `documents` · `mind-files/internal` · `mindscape/topology` · `messages` · `health` · `cognition` · `metrics` · `tasks` · `claims` · `federation` · `context` …) — granting a domain exposes **all** its tools to the harness, including destructive ones (`forget`, `publishDocument`, mind-file overwrites) per "full access within the area." Domain exposure uses the existing per-tool gate pattern (`collectTools` gate, `mcp.js:206-208`).

**Default policy (single-user, own vault, own AI):** broad — all of the user's own scopes + all **functional** domains — so it works out of the box; the panel lets the user *restrict* (carve out a scope like `wealth`, or disable a domain like `federation`/publish). Still excluded regardless (not user-grantable at launch): `reply` (channel-egress chokepoint, only wired when `AGENT_URL` set — §11), and the D5-dropped non-functional tools (`delegate_to_agent`, `getTeamStatus`, `schedule_task`, `list_my_schedules`, `create_space`, `seed_space`, `list_spaces`) + deferred `drive`/`calendar`. Topology-gated tools stay gated until `isTopologyReady()`.

**Informed-consent egress:** granting the AI an area means the user accepts that area's data reaches the connected intelligence — including a cloud provider if that's what they selected. The user defining the areas **is** the consent boundary. The §4g hard-block on explicitly **sensitive-marked** items (`mark` → `sensitive=1`, advisory at recall) remains a secondary backstop: sensitive-flagged rows are withheld from a US-jurisdiction cloud turn unless the policy explicitly opts them in. (`sensitive` flag: `migrations/0004_context_bank.sql`; honored in `getContext`.)

### 6.4 Wiring — `src/server-rest.js` `buildVaultSubApp` (~8 LOC)
```js
v.use('/api/v1/portal', portalChatRouter({
  db, userId, handlers, toolDefs: HARNESS_ALLOWLIST,
  contextDomain: createContextDomain({ getDb, readMindFile, userId }),
  inference: createInferenceRouter({ /* db-bound + createEgressAuditSink(db,userId) */ }),
  enqueueEnrichment,
  authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
}));
```
`handlers` is already in scope at this seam (server-rest.js:281). Export `openStream`/`ssePayloads`/`postJson` from `cloud.js` for the harness.

### 6.5 UI fixes (~30 LOC)
1. `ChatFloat.svelte:666` raw fetch → `/api/v1/portal/chat/stream` (§2).
2. Launcher button in [`Header.svelte`](../portal-app/src/lib/components/shell/Header.svelte) + `BottomTabBar` entry → `navigationState.toggleChat()`.
3. Re-enable Cmd+J at `+layout.svelte:69`.

---

## 6.6 "AI Access" policy — storage, panel, and how the harness applies it

The access model from §6.3 is realized as:

- **Storage (no migration):** a JSON policy in the encrypted `secrets` table under key `AI_ACCESS_POLICY` (the table takes arbitrary values, `secrets`-encrypted under SYSTEM_KEY). Shape: `{ scopes: ['personal','org',...], domains: ['memory','documents',...], includeSensitiveOnCloud: false }`. Read/written via `portal-settings.js`'s existing generic secret GET/PUT (or a thin `/portal/settings/ai-access` pair matching the TTS pattern).
- **Settings panel:** `AIAccessSection.svelte` (~120 LOC) following the `VoiceSection.svelte` template (onMount `GET` → form of scope + domain toggles → `PUT` → reload). Lives in the existing settings surface.
- **Harness application (per turn):** `portalChatRouter` loads the policy, then (1) passes the granted `scopes` as the effective `AGENT_SCOPES` into the context/retrieval/handler calls — so the **scope guardians cryptographically enforce** the data boundary (non-granted scopes won't decrypt); (2) builds the harness `tools` list from the granted **domains** (full tool set per domain). If the policy is absent, fall back to the broad single-user default (§6.3).

This makes "full access to the areas the user defines" literal: areas = scopes (crypto-enforced) + domains (full tools), defined by the user, applied every turn. It supersedes the earlier blunt `sensitive:true` decision; sensitivity-marked items remain a secondary backstop (§6.3, `includeSensitiveOnCloud`).

---

## 7. Threat model & security review (CLAUDE.md §1–13)

| § | Invariant | How honored |
|---|---|---|
| §1 | Zero plaintext leakage | `error` events use a safe constant, never `err.message` (mirrors `openai-compat.js:156`); history omits `metadata/entities/embedding`; prompts/tool I/O never logged |
| §2 | Defense in depth | auth gate **+** at-rest encryption **+** tool allowlist **+** §4g jurisdiction backstop |
| §3 | Fail closed | `getContext` throws → 500, never bare inference; unknown tool name → error result, not crash; provider unresolved → refuse |
| §4 | Master-key discipline | key stays in session memory; never passed to/logged by harness |
| §7 | Embeddings sensitive | history/tool outputs never return `embedding_768` |
| §8 | Audit everything | `emitEgress` (hash+len only) fires **per model call** in the loop, every provider |
| §10 | Validate / no fake success | no fabricated usage; persist only non-empty replies; **log the `maxIterations` cap** (no silent truncation) |
| §11 | Explicit-send only | harness allowlist **excludes** `reply`/channel egress + `publishDocument`; the chat reply renders in the user's own browser — not a channel egress |
| §13 | No ad-hoc servers | adds routes to the existing server; binds no port; calls handlers in-process |

**New attack surface:** an LLM now invokes vault tools autonomously within a turn, with full access inside the user-granted areas. Mitigations: **the user-defined access policy is the boundary** — granted **scopes are cryptographically enforced** (non-granted data won't decrypt — fail-closed scope guardians, `crypto-local.js:84-169`), and only granted **domains'** tools are even exposed to the harness; plus bounded `maxIterations`, per-turn timeout, abort-on-disconnect, topology gating, and handlers that encrypt-at-rest + validate their own args. `reply`/channel-egress stays ungrantable at launch (§11). Prompt-injection from retrieved content can at worst exercise a granted-domain tool **within a granted scope** on the user's own single-tenant vault — bounded by exactly what the user authorized; it cannot reach a denied scope (crypto) or an ungranted domain (not exposed). Informed consent: granting an area accepts that area reaches the connected intelligence.

---

## 8. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Selected model can't do tools (no-tool Ollama) | Degrade to context relay (preamble + text), emit no tool events |
| `maxIterations` (default 8) hit | Final no-tools pass for a clean answer; `log()` the cap (§ no silent caps) |
| Tool handler throws | Feed `is_error` result back so the model recovers; emit `tool_error`; never leak `err.message` |
| Client disconnect mid-loop | `signal` aborts the provider stream + halts the loop; do **not** persist a partial assistant turn |
| Tier-2 tool called before topology ready | Gated handler returns `TOPOLOGY_NOT_READY_MESSAGE` (existing `mcp.js` gate) |
| Model tries an excluded tool | Not in the sent tool list → can't call it; if a stale name appears, dispatch returns "unknown tool" result |
| `agentId` / `spaceId` | Single synthetic `personal-agent`; spaces ignored (V1) |
| `docPath/docTitle` | UI appends `[Re: …]` to the message; optional doc-body injection deferred |
| Attachments | Out of scope for v1 chat backend (upload pipeline stays separate) |
| Secure-channel (relay) path | UI's `channel.requestStream('chat',…)` path is a separate workstream; local web/Tauri use the plain fetch path |

---

## 9. Test strategy

- **`test/agent-harness.test.js`** (~180 LOC) — drive `streamTurn` with **stubbed provider streams** (fixture SSE byte sequences) per adapter:
  - **Anthropic adapter:** `content_block_start{tool_use}` + `input_json_delta` chunks → assembles args, calls `call(name,args)`, feeds `tool_result`, loops, ends on `end_turn`. Assert event order `stream_start→tool_start→tool_complete→text_delta*→done`.
  - **OpenAI adapter:** `delta.tool_calls` assembly + `finish_reason:'tool_calls'` → `{role:'tool'}` feedback.
  - **Ollama no-tool model:** falls back to textRelay (no tool events).
  - **Safety:** handler throws → `tool_error` + `is_error` result, loop continues, `err.message` absent. `maxIterations` hit → capped + logged. Abort signal → loop stops, no persist.
- **`test/portal-chat.test.js`** (~150 LOC) — supertest against the express sub-app: `/agents` shape + 401 fail-closed; `/chat/history` maps `selectRecent`, **omits `metadata/entities/embedding_768`**; `/chat/stream` happy path persists user+assistant (`source:'portal-chat'`); **allowlist** enforced (excluded tool not in sent defs); **sensitivity filter** withholds marked items from a cloud-config turn; pre-token error → 500 JSON; mid-stream error → safe `error` event.

Match existing supertest conventions used by the other `portal-*` route tests.

---

## 10. Implementation order (each step independently shippable + smoke)

1. **Export helpers** — `openStream`/`ssePayloads`/`postJson` from `cloud.js`; unit-smoke they still serve the gateway. *(~3 LOC + test run.)*
2. **Harness core + Anthropic adapter** — `src/agent/harness.js` loop + Anthropic `tool_use`. Smoke: a Node script runs `streamTurn` with a 2-tool allowlist against a real Anthropic key → observes tool_start/complete.
3. **OpenAI-compat + Ollama adapters** — add the other two; Ollama capability probe + textRelay fallback. Smoke: same script against an OpenAI-compat baseURL and local Ollama.
4. **`src/portal-chat.js` + wiring** — `/agents`, `/chat/history`, `/chat/stream` calling the harness with `handlers` + allowlist + getContext + retrieval; mount in `buildVaultSubApp`. Smoke: `curl …/api/v1/portal/agents`; web chat answers + uses a tool.
5. **AI Access policy + settings panel (§6.3, §6.6)** — `AI_ACCESS_POLICY` storage via `portal-settings.js`; `AIAccessSection.svelte` (scope + domain toggles); harness reads it per turn → effective `AGENT_SCOPES` + granted-domain tool set; `sensitive` backstop. Smoke: deny `wealth` scope → confirm wealth rows don't decrypt for the AI (guardian fail-closed); disable a domain → its tools vanish from the harness; grant all → full access.
6. **UI fix + launcher** — `ChatFloat.svelte:666` path, Header button, Cmd+J. Smoke: open chat anywhere, agent streams with tool pills.
7. **Tauri smoke** — `tauri build`/dev; chat streams + tools work in WKWebView (`csp:null`, same-origin). No code change expected — verification gate.
8. **Tests** — both suites green; add to `npm run verify`.
9. **Living docs + `/deploy-and-verify`** — update `V1-BUILD-SPEC.md` (D5 note: bounded user-driven tool loop ≠ autonomous loop), `ARCHITECTURE.md`, build-handoff.

**LOC budget:** **~1,200–1,460 net new** — harness ~420–560, portal-chat ~280, AI-Access panel + policy plumbing ~200, tests ~360, UI ~30, wiring/exports ~12. ~2.5–3× the thin-relay alternative; the delta is the provider-agnostic tool loop + the user-defined access model the requirements demand.

---

## 11. Decisions (operator)

| # | Decision | Status |
|---|---|---|
| 1 | Harness driver | ✅ **Provider-agnostic in-process loop** (Anthropic + OpenAI + Ollama adapters) |
| 2 | Launch scope | ✅ **Full harness at launch** |
| 3 | Persist chat turns to vault | ✅ Yes (encrypted, embedded, enriched; `source:'portal-chat'`) |
| 4 | Retrieval at launch | ✅ Yes (deterministic `searchMindscape` before the loop) — and the model can also call it as a tool |
| 5 | **Access model (§6.3, §6.6)** | ✅ **User-defined areas, full access within.** An "AI Access" panel grants scopes (`personal/org/wealth/health` — crypto-enforced via scope guardians) + tool domains (full tools each); harness applies the policy per turn as effective `AGENT_SCOPES` + domain tool set. Default broad (own vault/own AI), user restricts. Supersedes the earlier blunt `sensitive:true`. |
| 6 | **Tool access** | ✅ **Full access within granted areas** (incl. destructive `forget`/`publishDocument`/mind-file writes). Only `reply` (channel-egress chokepoint) + D5-dropped/deferred tools stay ungrantable at launch; topology tools stay gated until ready. |
| 7 | **Anthropic SDK vs hand-rolled** | ✅ **Hand-roll all three adapters** in the existing `cloud.js` raw-fetch pattern (egress-audit + §4g in one place; the SDK covers only Anthropic, not the OpenAI/Ollama paths). Conscious deviation from the claude-api skill's SDK default, on security/consistency grounds. |
| 8 | **Informed-consent egress** | ✅ Granting an area = accepting that data reaches the connected intelligence (incl. cloud). `sensitive`-marked items remain a backstop withheld from US-cloud turns unless `includeSensitiveOnCloud`. |

---

## 12. Verification table (every load-bearing claim, read by me)

| Assumption | Verified at |
|---|---|
| 52 tools are `createXDomain→{tools,handlers}`; handlers `async(args)=>string`, directly callable | `src/tools/curate.js:135,250`; `src/tools/context.js:27` |
| Single dispatch `handlers[name](args)` wrapped into MCP content | `src/mcp.js:237-268` |
| `handlers` map already passed into `buildVaultSubApp` (portal seam) | `src/server-rest.js:281`; `src/index.js:96-105` |
| Tool `inputSchema` is JSON-Schema (maps to all 3 providers) | `src/tools/context.js:43-53` |
| Topology gating exists (`TIER2_TOOLS`, `collectTools` gate) | `src/mcp.js:159-161,206-208` |
| `:4711` MCP only when remote on; `:8787` always; `/mcp` per-session fresh DB | `src-tauri/src/main.rs:224-340`; `src/server-http.js:336` |
| No agent loop / no Anthropic SDK / no claude binary in this repo | `package.json` (`@modelcontextprotocol/sdk` only); `src-tauri/binaries/` (frpc+caddy) |
| Canonical/reference get tools by spawning Claude CLI (not present here) | `../mycelium/packages/core/runner.js:322,388-426`; `reference/server-routes/portal-ws.js:849` |
| Inference layer is text-only — cloud builds no `tools`, parses text | `src/inference/cloud.js:102-115,129-143,194-209` |
| `inferStream` yields text deltas only (relay fallback) | `src/inference/router.js:182-211` |
| §4g sensitive hard-block + egress audit in router; gateway refuses sensitive tool calls to US | `src/inference/router.js:151`; `src/inference/egress.js:20-39`; `src/gateway/openai-compat.js:236` |
| `openStream`/`ssePayloads`/`postJson` are reusable but module-private (must export) | `src/inference/cloud.js:69,151,174` |
| Provider resolution + jurisdiction (`anthropic`/`openai`/`baseUrl`/`local`/`eu-zdr`) | `src/inference/resolve.js:38-52`; `src/inference/presets.js:42-49` |
| Anthropic tool-use streaming shapes (`content_block_start{tool_use}`, `input_json_delta`, `message_delta.stop_reason`) + `tool_result` feedback; Opus 4.8 adaptive-thinking-only | claude-api skill — Tool Use + Streaming + Opus 4.8 sections |
| `getContext` markdown preamble; factory `createContextDomain({getDb,readMindFile,userId})` | `src/tools/context.js:27-60` |
| `captureMessage(db,msg,enq)` encrypts content/metadata; `selectRecent(userId,{limit,agentId})` | `src/ingest/capture.js:62-86`; `src/db/messages.js:456` |
| Tool safety classes (read / mutate / egress / D5-dropped) | `src/tools/*` per Sweep F; `docs/V1-BUILD-SPEC.md:33` (~34-tool reconciliation) |
| Data scopes `personal/org/wealth/health`; scope-fan rule in `selectRecent` | `src/db/messages.js:470-476`; `migrations/0001_init.sql` (`scope` defaults) |
| `AGENT_SCOPES` gates SQL reads **and** decryption; null = admin/unfiltered | `src/db/messages.js:15-24,484-489` |
| Per-scope DEK (HKDF `mycelium:scope:<scope>:v1`) + fail-closed scope guardians (encrypt+decrypt) | `src/crypto/crypto-local.js:84-169,992-1017` |
| `sensitive`/`pinned` flags on messages/documents/facts/entities; set by `mark`; advisory at recall | `migrations/0004_context_bank.sql`; `src/tools/curate.js:225-279` |
| Settings stored in encrypted `secrets` KV table (arbitrary JSON value, no migration); GET/PUT pattern | `src/portal-settings.js`; `migrations/0001_init.sql` (`secrets`) |
| Settings-panel UI pattern (onMount GET → form → PUT → reload) | `portal-app/src/lib/components/settings/VoiceSection.svelte` |
| Tools group into ~14 domains; assembled in `buildDomains`; per-tool gate precedent | `src/mcp.js:55-128,159-209`; `src/index.js:93-100` |
| ChatFloat stream raw-fetches `/portal/chat/stream` (bypasses rewrite) → 404 in V1; `api()` rewrite client-side only; bare `/portal` unrouted | `ChatFloat.svelte:666`; `api.ts:40`; `server-rest.js:339,358` |
| Portal routers mount at `/api/v1/portal`; SSE precedent | `server-rest.js:111-153`; `portal-hardware.js:76-90` |
| `streamCompletion` SSE template (open headers + role frame, loop, `[DONE]`, never echo `err.message`) | `src/gateway/openai-compat.js:158-188` |
| D5 forbids autonomous loop/scheduler/lanes/recovery; server-side completion already shipped | `docs/V1-BUILD-SPEC.md:21`; `src/server-http.js:480` |
| Tauri spawns `server-rest.js` on `127.0.0.1:8787`, same-origin, `csp:null`, SSE works | `src-tauri/src/main.rs:25,224-349`; `tauri.conf.json` |

---

## 13. Revision history

- **v3 (2026-06-08)** — operator direction: the connected AI should have **full access to the areas the user defines** (not a fixed allowlist), and **full tool access** within them; adapters hand-rolled (confirmed). Fourth sweep cycle (data-scope/access primitives + settings/tool-domain surfaces) found the model already exists: `personal/org/wealth/health` scopes with **per-scope DEKs + fail-closed guardians** (`crypto-local.js:84-169,992-1017`) gated by `AGENT_SCOPES` (`messages.js:15-24`), the encrypted `secrets` table for policy storage (no migration), and the `VoiceSection.svelte` settings pattern. **Pivot:** replaced the hardcoded read+safe-write allowlist (§6.3) and the sensitivity-filter decision with a **user-defined "AI Access" policy** — granted scopes (cryptographically enforced) + granted tool domains (full access within) — applied per turn by the harness. Added `AIAccessSection.svelte` + `AI_ACCESS_POLICY` storage (+~200 LOC → ~1,200–1,460 total). Decisions 5–8 resolved.
- **v2 (2026-06-08)** — operator requirement: chat must work **as an isolated MCP tool surface AND with the agent harness + intelligence you select**. Second + third sweep cycles (MCP tool surface · harness availability · provider tool-calling · in-app-MCP-client feasibility · `cloud.js` extensibility · tool-safety) + the Claude API tool-use reference. **Major pivot:** v1's *thin text relay* is replaced by a **provider-agnostic in-process tool-use harness** (`src/agent/harness.js`) over the existing 52-tool handler map — unifying the external-MCP and in-app surfaces. **New load-bearing facts:** no agent loop / no Anthropic SDK / no tool-calling exists in this repo today (canonical spawns Claude CLI); `openStream`/`ssePayloads` are private and must be exported; the `:4711` MCP server isn't always running and uses a per-session DB, so the harness must call handlers in-process. **Refined decision:** sensitivity = *filter marked items from cloud context* (not a blunt all-sensitive flag), §4g as backstop. LOC re-scoped ~1,000–1,260 (from ~450–520).
- **v1 (2026-06-08)** — initial thin-relay design. Six sweeps + verified reads. Caught the raw-`fetch('/portal/chat/stream')` 404 defect; established getContext preamble + persistence + Tauri parity. Superseded by v2 after the "agent harness + selectable intelligence" requirement landed.

---

## 14. Deferred (named so a later phase isn't ambushed)

- **Per-turn data-scope restriction** — thread `allowedScopes` through the harness's handler→db→decrypt calls so an unchecked scope (e.g. `wealth`) is cryptographically withheld from the AI specifically. Blocked today by env-global `AGENT_SCOPES` (AS-BUILT pivot 1). The policy already carries `scopes`.
- **Tool-confirmation UI** → re-enable the destructive/egress tier (`forget`, `publishDocument`, mind-file overwrites, `reply`) via an `always_ask`-style round-trip in ChatFloat.
- **Relay/secure-channel parity** — `channel.requestStream('chat',…)` for networked (non-loopback) clients.
- **Attachments in chat turns**; **multi-agent fleet** (canonical's per-agent ports — V2); **scheduler/autonomous loop** → Phase 5: Extensions (D5).
