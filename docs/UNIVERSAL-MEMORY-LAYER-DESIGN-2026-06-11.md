# Universal Memory Layer — capture + context enforcement across agent harnesses

**Status:** BUILT — core tiers shipped + gated (`verify:memory-bridge` GO, 17/17) · **Date:** 2026-06-11 · **Branch:** feat/universal-memory-layer

> **As-built (2026-06-11):** Steps 1-4 of §7 done. `POST /context` shim, the bridge
> client (`tools/memory-bridge/bridge.mjs`), the Claude Code adapter (`on-prompt.mjs`
> + `on-stop.mjs`), and the gateway capture+inject (opt-in `X-Mycelium-Capture`) are
> built and verified by `scripts/verify-memory-bridge.mjs` (GO) with no regression in
> `verify:gateway` / `verify:ingest`. Live-smoked against the real vault (`/context`
> 401-without-bearer + real context, idempotent capture). **Native adapters BUILT +
> GATED 2026-06-11** — hermes (`tools/memory-bridge/hermes/`), opencode + openclaw
> (`tools/memory-bridge/{opencode,openclaw}/`), code-verified against the local repos,
> covered by `verify:memory-adapters` (GO, 10/10: inject + both-sides capture each).
> **Remaining:** the TS `index.ts` wrappers compile against their host SDKs at install
> (logic is in the gated `.mjs` cores); first real proof of the Claude Code hooks is a
> session restart with `:4711` running + `MYCELIUM_MCP_BEARER` exported.
**Predecessor:** [DESIGN-harness-connect-2026-06-06.md](DESIGN-harness-connect-2026-06-06.md) (the "two doors" connection config — shipped) and [HARNESS-RECIPES.md](HARNESS-RECIPES.md).
**This doc adds:** the *capture + context* layer those two explicitly do **not** provide.

---

## 0. Headline

The user wants Mycelium to be a **universal memory layer**: every connected agent — Claude Code, opencode, hermes-agent, openclaw, and arbitrary future harnesses — should, on every turn, (1) **pull** context from the vault and (2) **push** *both* the user's message and the assistant's reply back into the vault. Reliably, not at the model's discretion.

The connection plumbing already exists (two doors: Memory MCP `:4711/mcp`, Model gateway `:4711/v1`). **What's missing is enforcement:** the gateway is a pass-through that captures nothing, and MCP tool-calls are model-discretion (the model *may* call `getContext`/`captureMessage`, or may not). This design adds a **capture + context layer** in three tiers over one common HTTP contract, so capture becomes *structural*.

**Decisions locked with the user (2026-06-11):** both tiers (universal gateway + native hooks); capture **everything, both sides**; add the custom-model-endpoint (gateway) tier.

---

## 1. The load-bearing surprise (PIVOT from the naive plan)

The naive plan — "point every agent's base_url at Mycelium's gateway and it captures both sides for free" — is **structurally false**, and a second naive plan — "capture every message in `messages[]`" — would **duplicate the entire history every turn**. Two sweep findings forced the design:

1. **The gateway captures nothing and injects nothing.** `chatCompletions` flattens `messages[]` → prompt → router → completion, with no `captureMessage` and no `getContext` ([src/gateway/openai-compat.js:279-327](../src/gateway/openai-compat.js)). "Set your base_url to Mycelium" today buys sovereign inference, *not* memory.

2. **Dedup is id-keyed, with NO cross-id content dedup.** `captureMessage` dedups only when the *same id* is re-sent; a *different id* with identical content inserts a **new row** ([src/ingest/capture.js:104-138](../src/ingest/capture.js)). OpenAI chat requests are **stateless** — the harness resends the full `messages[]` every turn. So a gateway that captured the whole array each request would re-insert all prior turns as fresh rows, exploding the vault.

**Therefore:** capture must store **only the new turn** (the last `user` message + the produced `assistant` text), each with a **deterministic id**, so re-sends are idempotent no-ops. The gateway must never iterate `messages[]` for capture.

---

## 2. Architecture — one contract, three tiers

```
                          ┌──────────── Mycelium :4711 (Bearer / OAuth) ────────────┐
  any agent harness  ───► │  POST /ingest/message   (capture — EXISTS)              │
                          │  POST /context          (pull context — NEW thin shim)  │ ──► one vault
                          │  POST /v1/chat/completions (gateway — capture+inject NEW)│     (captureMessage
                          │  ALL  /mcp              (rich tools — EXISTS)            │      + getContext)
                          └──────────────────────────────────────────────────────────┘
```

### 2.1 The common contract — "the bridge endpoints"
Everything an adapter needs is **two HTTP calls**, both already Bearer-guarded on `:4711` alongside `/mcp` and `/v1`:

- `POST /ingest/message` — **EXISTS** ([server-http.js:401-417](../src/server-http.js)). Body = `captureMessage` args (`{content, role, source, conversationId, id, metadata, createdAt}`). Idempotent.
- `POST /context` — **NEW** (~25 LOC shim). Returns `{ text }` from the existing `getContext` handler; optional `{ query }` adds a `searchMindscape` slice. This is what a hook `curl`s to inject context — no MCP JSON-RPC required.

> "Easily connectable to any agent system" = *can it POST to these two URLs with a Bearer token?* That is the entire generic-adapter surface. Documented in [HARNESS-RECIPES.md](HARNESS-RECIPES.md) "Custom" row + a new "Auto-capture" section.

### 2.2 Tier A — Native hooks (PREFERRED: agent keeps its own model; guaranteed both-sides capture)
A reusable **bridge client** (one small script) + a thin per-harness adapter that wires the harness's lifecycle hooks to the bridge endpoints. The agent keeps its own model (Claude, GPT, local); only memory flows to Mycelium.

| Harness | Capture (push) hook | Context (pull) hook | Certainty |
|---|---|---|---|
| **Claude Code** | `Stop` → read `transcript_path` JSONL, capture last `user` + `assistant` entries by their `uuid` | `UserPromptSubmit` → `hookSpecificOutput.additionalContext` from `/context` | High (official hooks) |
| **hermes-agent** | `post_llm_call` (once/turn) | `pre_llm_call` | High (Python `ctx.register_hook`) |
| **openclaw** | `llm_output` / `message_sending` | `llm_input` / `before_agent_run` | High (typed `api.on`, needs `allowConversationAccess`) |
| **opencode** | `message.updated` (`message.*`) | same | **Medium — timing fuzzy → fall back to Tier B** |

### 2.3 Tier B — Gateway capture + inject (UNIVERSAL fallback; zero per-harness code)
Enhance `/v1/chat/completions`: when **opted in** (header `X-Mycelium-Capture: <conversationId>`, or a per-bearer setting), the gateway:
1. **injects** `getContext` as a prepended **system** preamble (separate from user content),
2. **captures** the **last** `user` message (the new turn) with a deterministic id,
3. **captures** the assistant response after inference — accumulating streamed deltas before `[DONE]`.

Default (no opt-in header) → behavior **unchanged** (pure proxy), preserving existing `verify:gateway` and not surprising agents that don't want history stored. This is the lowest common denominator: any harness that can set a base_url gets memory without writing adapter code.

### 2.4 Tier C — MCP tools (rich pull + deliberate curation; ALREADY SHIPPED)
`getContext`, `searchMindscape`, `remember`, `link`, tasks, etc. Tiers A/B guarantee the *baseline* (every turn captured + context pulled); MCP adds *agency* (the model can deliberately recall, link, or curate). Not mutually exclusive — a harness can run Tier A hooks **and** expose MCP tools.

---

## 3. Module shapes (exact)

### 3.1 `POST /context` shim — `src/server-http.js` (~25 LOC, after `/ingest/import`)
```js
// POST /context — return the getContext preamble (+ optional search slice) as
// plain JSON so a shell hook can inject it without speaking MCP JSON-RPC.
app.post('/context', async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  const { query, maxChars = 4000 } = req.body || {};
  try {
    let text = await ingest.handlers.getContext({});           // returns a STRING
    if (typeof query === 'string' && query.trim()) {
      const s = await ingest.handlers.searchMindscape({ query, limit: 5 });
      text += '\n\n' + (typeof s === 'string' ? s : '');
    }
    res.json({ ok: true, text: String(text).slice(0, Math.min(maxChars, 16000)) });
  } catch { res.status(500).json({ ok: false, error: 'context failed' }); }
});
```
Add `X-Mycelium-Capture, X-Mycelium-Conversation` to the CORS allowlist ([server-http.js:475](../src/server-http.js)).

### 3.2 Deterministic capture id — shared helper
```js
// Same conversation + role + content ⇒ same id ⇒ idempotent (capture.js dedups).
const captureId = (source, conversationId, role, content) =>
  'cap-' + sha256(`${source}|${conversationId}|${role}|${content}`).slice(0, 32);
```
Claude Code adapter overrides this with the transcript entry's `uuid` (already stable).

### 3.3 Gateway capture + inject — `src/gateway/openai-compat.js` (~70 LOC)
- Parse `X-Mycelium-Capture` (conversationId) → enables the behavior.
- **Inject:** prepend a `system` message with `getContext` text *before* `flattenMessages` (NOT into the captured user content).
- **Capture user:** the last element of `messages[]` if `role==='user'`, via `/ingest/message` semantics (deterministic id, `source:'gateway:<conv>'`). Never loop the array.
- **Capture assistant:** in `streamCompletion` accumulate deltas → on `[DONE]` capture full text; in non-stream capture `completion.choices[0].message.content`.
- All capture is **fire-and-forget, non-fatal** (matches `capture.js` audit pattern) — a capture failure must never break inference.
- **Tools-passthrough path** ([openai-compat.js:261-270](../src/gateway/openai-compat.js)) pipes provider SSE verbatim → assistant-capture there is deferred (capture user turn only); documented limit.

### 3.4 Bridge client + Claude Code adapter — `tools/memory-bridge/`
- `bridge.mjs` — `capture({role,content,conversationId,id})` + `context({query})`; reads `MYCELIUM_BASE_URL` + `MYCELIUM_MCP_BEARER`; optional secret-redaction pass (off by default).
- `claude-code/on-prompt.mjs` — UserPromptSubmit: read stdin JSON, `context()`, emit `{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext}}`. Fail-open (exit 0, no context) on error.
- `claude-code/on-stop.mjs` — Stop: read `transcript_path`, capture the last `user` and `assistant` text entries by `uuid` (idempotent). Fire-and-forget.
- `.claude/settings.json` hooks block wiring both (this project dog-foods it first).

**LOC budget:** `/context` ~25 · gateway ~70 · bridge+CC adapter ~140 · `verify:memory-bridge` ~130 · recipes/doc updates ~60. **Core ≈ 425 LOC.** hermes/openclaw/opencode adapters ~40-60 LOC each, incremental.

---

## 4. Threat model

Deployment is **local-primary, single-user** (own machine), per [[deployment-local-primary]] — triage same-user-trust first, not VPS multi-tenant.

| Surface | Assessment |
|---|---|
| **Vault context → external model provider (NEW, biggest)** | Injecting `getContext` into a request bound for the agent's *own* provider (Anthropic/OpenAI for Claude Code/opencode) means **vault plaintext egresses the box**. Inherent to "give the agent memory." Mitigations: opt-in per harness; `maxChars` cap; `/context` can be scoped; the gateway's `X-Mycelium-Sensitive` hard-block applies only to the gateway path, not external providers. **Accepted with loud documentation** — it is the user's own agent + explicit choice. |
| **Capture auth** | `/ingest/message` + `/context` + `/v1` all behind `requireAuth` (Bearer/OAuth), fail-closed ([server-http.js:391-399](../src/server-http.js)). Loopback-only today. |
| **Secrets in captured assistant output** | Coding agents emit/echo keys. Optional regex redaction in the bridge (off by default per user's "everything both sides"; on is one flag). |
| **Dedup / duplication** | Deterministic ids + `content_hash` ([capture.js:101-130](../src/ingest/capture.js)) make re-sends no-ops. |
| **Context-inject bloat / latency** | `maxChars` cap; UserPromptSubmit has a **30 s** timeout → `/context` must be fast and fail-open. |
| **Plaintext leakage in logs** | Unchanged: capture/gateway never log content (§1); audit logs `source` only ([capture.js:110](../src/ingest/capture.js)). |

---

## 5. Edge cases — explicit decisions

1. **Stateless full-history requests** → capture last turn only, deterministic id. (§1)
2. **conversationId source** → Claude Code: `session_id`; gateway: `X-Mycelium-Capture` value, else `sha256(systemPrompt+firstUser)`; others: harness session id.
3. **Where to capture the user turn (Claude Code)** → in the **Stop** hook (transcript has `uuid`s for both roles); `UserPromptSubmit` does context-injection **only**. Avoids capturing the user message under two different ids.
4. **Injected context must not be captured as user content** → inject as a separate `system` message; capture only the original last user message.
5. **Streaming capture** → accumulate deltas in `streamCompletion`, capture on `[DONE]`. Tools-passthrough verbatim pipe → assistant-capture deferred (user-turn captured).
6. **Capture failure** → fire-and-forget, never breaks the turn/inference.
7. **opencode timing uncertainty** → recommend opencode use Tier B gateway (deterministic) until `message.*` timing is empirically confirmed.
8. **Sub-agents (Claude Code)** → hooks fire for sub-agents too; tag `source:'claude-code'` + thread on session, accept sub-agent turns as part of the conversation (or filter by `agent_id` if noise).

---

## 6. Test strategy (`scripts/verify-memory-bridge.mjs`)
- **B1** `POST /context` returns non-empty `{text}`; respects `maxChars`; 401 without bearer.
- **B2** `POST /ingest/message` captures; re-send same id → `deduped:true`, no new row.
- **B3** Gateway with `X-Mycelium-Capture: c1`: asserts (a) a `system` context preamble reached the router (stub router echoes prompt), (b) exactly **one** new `user` row for the last turn (not the whole array), (c) one `assistant` row after completion.
- **B4** Gateway **without** the header → zero captures (default proxy unchanged); `verify:gateway` + `verify:ingest` still GO.
- **B5** Capture-sink throws → inference still returns 200 (fire-and-forget).
- **B6** Claude Code `on-stop.mjs` against a sample transcript JSONL → captures last user+assistant by `uuid`; re-run → all `deduped`.

---

## 7. Implementation order (each independently shippable)
1. **`POST /context` shim** + `verify:memory-bridge` B1. Smoke: `curl -s :4711/context -H "Authorization: Bearer $B" -d '{}'`.
2. **Bridge client + Claude Code adapter** + `.claude/settings.json` hooks (dog-food this repo) + B6. Smoke: a real turn here auto-captures `source:claude-code` both roles.
3. **Gateway capture+inject** (opt-in header) + B2-B5. Smoke: point a throwaway OpenAI client with `X-Mycelium-Capture` → both rows appear.
4. **hermes / openclaw / opencode** plugin adapters (one each) + recipes update.
5. **Docs:** new "Auto-capture (memory bridge)" section in HARNESS-RECIPES.md + CONNECT-YOUR-AI.md; Portal picker note.

## 8. Decision criteria — proceed past Tier A
After step 2 ships, query the vault over a few days: messages `source='claude-code'` show **both roles**, **zero duplication** (id dedup holding), and transcripts show injected context. If true → build Tier B gateway capture. If duplication appears → fix the deterministic-id / dedup path before fanning out to other harnesses.

## 9. Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| History duplication on gateway capture | Med | High (vault bloat) | Capture last-turn-only + deterministic id; B3/B4 gate |
| Vault data egress to external provider | High (by design) | Med | Opt-in, `maxChars`, scope `/context`, document loudly |
| 3rd-party hook API drift (hermes/openclaw/opencode) | Med | Low | Recipes carry "verify against current docs" disclaimer; Tier B fallback always works |
| UserPromptSubmit 30 s timeout on slow `/context` | Low | Low | Fast read, fail-open exit 0 |
| Secret capture from coding agents | Med | Med (local-trust) | Optional redaction flag |

## 10. Open questions
**Resolved during sweep:** gateway doesn't capture (not "just turn it on"); dedup is id-keyed not content-keyed (capture last turn only); `/ingest/message` already exists (no MCP-from-shell needed); no REST `getContext` (need the shim); real streaming already exists (capture must accumulate deltas).
**Deferred:** assistant-capture on the tools-passthrough verbatim-SSE path; remote (relay) auto-capture (loopback-only today); cross-harness conversation stitching (one logical thread spanning CC + opencode) — out of scope for v1.

---

## 11. Verification table

| # | Load-bearing assumption | Verified at (read myself) |
|---|---|---|
| 1 | Gateway `chatCompletions` does NO capture and NO context injection | [src/gateway/openai-compat.js:279-327](../src/gateway/openai-compat.js) |
| 2 | Real token-streaming exists (capture must accumulate deltas) — file header's "non-streaming v1" is stale | [src/gateway/openai-compat.js:158-188](../src/gateway/openai-compat.js) |
| 3 | Tools-passthrough pipes provider SSE verbatim (assistant-capture there is hard) | [src/gateway/openai-compat.js:261-270](../src/gateway/openai-compat.js) |
| 4 | `POST /ingest/message` exists, Bearer-guarded, body = captureMessage args | [src/server-http.js:401-417](../src/server-http.js) |
| 5 | `/ingest/*` and `/v1/*` share `requireAuth` (fail-closed) | [src/server-http.js:391-399](../src/server-http.js), [:480](../src/server-http.js) |
| 6 | CORS allowlist already carries custom `X-Mycelium-*` headers (easy to extend) | [src/server-http.js:472-476](../src/server-http.js) |
| 7 | Dedup is id-keyed; different id + same content ⇒ NEW ROW (no cross-id content dedup) | [src/ingest/capture.js:104-138](../src/ingest/capture.js) |
| 8 | captureMessage fields: role/source/conversationId/metadata/createdAt; content_hash dedup | [src/ingest/capture.js:62-102](../src/ingest/capture.js) |
| 9 | No REST `getContext` endpoint (only `/contexts` mindscape CRUD) → shim needed | grep `src/` 2026-06-11 (only `src/portal-compat.js:613-665`) |
| 10 | `getContext` returns a bare STRING, not `{content:[...]}` | live boot + raw dump 2026-06-11 (this session) |
| 11 | Two-door connection (MCP + gateway) config already shipped for all harnesses | [docs/HARNESS-RECIPES.md:1-128](HARNESS-RECIPES.md) |
| 12 | Claude Code: `UserPromptSubmit` has `prompt` + `additionalContext` inject; `Stop` reads `transcript_path` JSONL | Claude Code hooks docs (external, verified via claude-code-guide 2026-06-11) — *re-verify against installed CC version at build* |
| 13 | **hermes** `pre_llm_call` (inject via return `{"context"}` appended to user msg) + `post_llm_call` (gets `assistant_response`) | **CODE-VERIFIED** [hermes-agent/agent/turn_context.py:316-341](../../hermes-agent/agent/turn_context.py), [turn_finalizer.py:287-306](../../hermes-agent/agent/turn_finalizer.py), [conversation_loop.py:624-626](../../hermes-agent/agent/conversation_loop.py), hooks `plugins.py:128-170` |
| 14 | **openclaw** uses the **plugin-SDK** (`definePluginEntry`/`OpenClawPluginApi`), NOT the raw session `api.on` ExtensionAPI; inject via `api.on("before_prompt_build", …)→{prependContext}`, capture via `message_end`/`agent_end` | **CODE-VERIFIED** [openclaw/src/plugin-sdk/plugin-entry.ts:255-280](../../../Developer/openclaw/src/plugin-sdk/plugin-entry.ts), [extensions/active-memory/index.ts:3004-3116](../../../Developer/openclaw/extensions/active-memory/index.ts), config `src/config/types.plugins.ts` |
| 15 | openclaw install = `plugins.load.paths` + `plugins.entries.<id>.config` in `~/.openclaw` (no install CLI); hermes install = `~/.hermes/plugins/<name>/` (plugin.yaml + `register(ctx)`) | **CODE-VERIFIED** openclaw `types.plugins.ts`; hermes `plugins.py:register`, `plugin.yaml` manifest |
| 16 | **opencode** is the authentic `anomalyco/opencode` (= `sst/opencode` redirect); user plugin API is `@opencode-ai/plugin` v1.17.7 — inject via `experimental.chat.system.transform`, capture via `chat.message` + `event` | **CODE-VERIFIED** [opencode/packages/plugin/src/index.ts:222-330](../../opencode/packages/plugin/src/index.ts); provenance: opencode.ai → anomalyco, GH redirect, 174k★ non-fork |
| 17 | opencode plugin install = config `plugin:[…]` (npm/`[pkg,opts]`/path) via `PluginBoot`, or `.opencode/plugin/` autoload; Bun runtime, `fetch` unrestricted; MCP via `mcp.servers.<name>` | **CODE-VERIFIED** [opencode/packages/core/src/plugin/boot.ts](../../opencode/packages/core/src/plugin/boot.ts), `core/src/config/mcp.ts`, `customize-opencode.md:295` |

---

---

## 12. Addendum — code-verified harness adapter specs (2026-06-11)

Built after sweeping the **local** hermes-agent + openclaw repos (the web-doc hook
names were partly wrong — openclaw especially). These are the exact, code-verified
shapes to build against. **PIVOT:** my v1 design's openclaw hooks (`llm_input`/
`llm_output`) do not exist; the real surface is the plugin-SDK below.

### Hermes-agent (Python plugin — `~/.hermes/plugins/mycelium-memory/`)
- `plugin.yaml`: `name`, `version`, `hooks: [pre_llm_call, post_llm_call]`, `requires_env: [MYCELIUM_BASE_URL, MYCELIUM_MCP_BEARER]`.
- `__init__.py`: `def register(ctx): ctx.register_hook("pre_llm_call", on_pre); ctx.register_hook("post_llm_call", on_post)`.
- `on_pre(*, user_message, conversation_history, session_id, turn_id, **kw)` → POST `/context`, **return `{"context": text}`** (hermes appends it to the user message — [conversation_loop.py:624-626](../../hermes-agent/agent/conversation_loop.py)).
- `on_post(*, user_message, assistant_response, session_id, turn_id, **kw)` → POST `/ingest/message` twice (user + assistant), ids `<session_id>:<turn_id>:user|assistant`. Observer-only. In-process `import httpx`; fires once/turn, only when not interrupted.

### Openclaw (TS plugin-SDK — shipped dir + `plugins.load.paths`)
- `openclaw.plugin.json`: `{ id:"mycelium-memory", name, description, activation:{onStartup:true}, configSchema:{baseUrl, … } }`.
- `index.ts`: `export default definePluginEntry({ id, name, description, register })` from `openclaw/plugin-sdk/plugin-entry`.
- Inject: `api.on("before_prompt_build", async (event, ctx) => { … return { prependContext: text }; }, { timeoutMs })` — `event.prompt` is the user input ([active-memory/index.ts:3004-3116](../../../Developer/openclaw/extensions/active-memory/index.ts)). Requires `hooks.allowPromptInjection: true` in the user's entry config.
- Capture: `api.on("message_end", (event) => …)` (`event.message` = final assistant reply) + capture the user turn from `before_prompt_build`'s `event.prompt`. POST `/ingest/message`; `fetch()` is unrestricted (Node ≥22).
- Config via `api.pluginConfig` / `resolveLivePluginConfigObject(...)`; user enables in `~/.openclaw` under `plugins.load.paths` + `plugins.entries.mycelium-memory.config`.

### Opencode (TS `@opencode-ai/plugin` — verified `anomalyco/opencode`, cloned 2026-06-11)
**PIVOT:** a first sweep read the wrong subsystem (`core/src/plugin.ts` = the *provider* plugin system: `catalog.transform`/`aisdk.*`) and wrongly concluded "opencode can't inject → gateway-only." The real **user** plugin API is `@opencode-ai/plugin` v1.17.7 ([packages/plugin/src/index.ts](../../opencode/packages/plugin/src/index.ts)) and fully supports native inject + capture.
- Plugin shape: `export const server: Plugin = async (input, options) => Hooks` where `Plugin = (input: PluginInput, options?) => Promise<Hooks>` (index.ts:74). `PluginInput` gives `{ client (opencode SDK), project, directory, worktree, serverUrl, $: BunShell }` (index.ts:56-66). Runtime Bun; `fetch()` unrestricted.
- **Inject:** `"experimental.chat.system.transform"(input:{sessionID?,model}, output:{ system: string[] })` — push the `/context` text into `output.system` (index.ts:291-296). (`experimental.chat.messages.transform` is the heavier alternative.)
- **Capture user:** `"chat.message"(input:{sessionID,messageID,…}, output:{ message: UserMessage; parts: Part[] })` (index.ts:234-243) → POST `/ingest/message` role user.
- **Capture assistant:** `event?(input:{ event: Event })` (index.ts:224) → on the assistant message-completed event, read final text via `input.client` SDK (exact `Event` variant confirmed at build). `experimental.text.complete` is a per-text-part alternative.
- Config/secrets: the `options` arg (from `plugin: [["@mycelium/opencode-memory", { baseUrl, bearer }]]`) or env. **Install:** opencode config `plugin: [...]` (npm pkg / `[pkg,opts]` / local path — type `Config.plugin`, index.ts:70-72) loaded by `PluginBoot` ([core/src/plugin/boot.ts](../../opencode/packages/core/src/plugin/boot.ts)), or drop a file in `.opencode/plugin/` (autoload, `customize-opencode.md:295`). MCP also supported: `mcp.servers.<name>` `{type:"remote",url,headers,oauth}` (`core/src/config/mcp.ts`).

*Sweep-first protocol applied (4 cycles): gateway/connect/mechanism map → CC + harness hook APIs (web) → REST surface + capture dedup reads → **local hermes + openclaw repo reads** (rows 13-15). Rows 1-11, 13-15 are file:line read against real code; row 12 (Claude Code) is official docs, re-verified at restart. Earlier web-doc openclaw hook names were refuted and corrected here.*
