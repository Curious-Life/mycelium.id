# Channel-daemon — Depth Sweep + Fixes + Plan (2026-06-06)

> Applied `/sweep-first-design` to the channel-daemon (Phases 0–3 + Telegram hardening) BEFORE building Discord.
> Five sweeps (2 web — Claude Agent SDK + Telegram Bot API; 3 repo — AGENT_URL/reply contract, TTS keys + ffmpeg,
> MCP http attach). Goal: find where the implementation was **shallow / assumption-laden** and close it.
> Companion to [`CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md`](CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md).

## TL;DR — what the sweep caught

Two real `oAuthProvider`-class defects (code written against an *assumed* API), now fixed + regression-locked:

1. **Claude Agent SDK message interpretation was structurally wrong.** I detected the reply tool's `delivered`
   verdict by scanning for a `tool_result` block *inside the same assistant message* as the `tool_use`. The real SDK
   (v0.3.x) delivers `tool_result` on a **later `type:'user'` SDKMessage** — so the old code would have reported
   `delivered:false` for every successful reply. **Fixed:** `createReplyTracker()` correlates `tool_use` (assistant)
   → `tool_result` (user) by `tool_use_id`. Unit-locked (`verify:channel-agent` S1–S4).
2. **Telegram `reply_to_message_id` is deprecated** (Bot API 7.0 → `reply_parameters`). **Fixed** in `sendMessage`
   + `sendVoice`.

Plus the `env` spread for the SDK subprocess, and a startup **preflight** that warns when the vault MCP isn't
advertising `reply` (the http-mode wiring gap). Everything else swept **confirmed correct**.

## Revision history

- **v1 (Phases 0–3 + hardening)** — built against assumed Agent SDK + Telegram APIs.
- **v2 (this doc)** — pivots after web-verifying both APIs against official docs / the published `@anthropic-ai/
  claude-agent-sdk@0.3.x` types and core.telegram.org. Two message/field-shape pivots; wiring + key-provenance
  gaps documented with decisions.

## Sweep findings (consolidated, with citations)

### A. Claude Agent SDK (web-verified against v0.3.x types + platform.claude.com docs)
- Package `@anthropic-ai/claude-agent-sdk`, `query({prompt, options})` returns an **`AsyncGenerator<SDKMessage>`**
  (we `for await` — correct). ✅
- Options all real: `systemPrompt`, `mcpServers` (a **`Record<name,config>`** — we pass a dict ✅), `allowedTools`
  (`string[]` ✅), `permissionMode:'bypassPermissions'` (valid ✅), `maxTurns`, `model`, `abortController` ✅.
  `env` is handed to the **bundled Claude Code CLI subprocess** → must spread `process.env` (**pivot**: was
  `{ANTHROPIC_API_KEY}` only).
- MCP server configs: http `{type:'http', url, headers}` ✅, stdio `{command, args, env}` ✅.
- Tool naming `mcp__<server>__<tool>` ✅ (so `mcp__mycelium__reply`).
- **Message shapes (PIVOT):** `tool_use` rides `type:'assistant'` at `msg.message.content[]` ({type:'tool_use',
  name, id}); `tool_result` rides a **later `type:'user'`** at `msg.message.content[]` ({type:'tool_result',
  tool_use_id, content}). Correlate by `tool_use_id`.
- Requires Node ≥18 + peer `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`; bundles per-platform CLI.

### B. Telegram Bot API (web-verified against core.telegram.org)
- `getUpdates({offset, timeout, allowed_updates:['message']})` ✅; offset = last `update_id`+1 ✅; response
  `{ok, result:[Update]}` ✅.
- **`reply_to_message_id` deprecated → `reply_parameters:{message_id}`** (Bot API 7.0+). **PIVOT** (both send paths).
- `sendVoice` multipart with an OGG/Opus `voice` field; Node `FormData`+`Blob('voice.ogg','audio/ogg')` is correct ✅.
- Message fields (`message_id`, `date`, `chat{id,type,title}`, `from`, `text`, `caption`, `voice`,
  `reply_to_message`) ✅.
- Practical rate limits: ~1 msg/s per chat, ~20/min per group, ~30/s global — our default 20/60s per target is
  within group limits (acceptable; not a per-second burst limiter — noted).
- 409 / "can't poll + webhook on one token" → single-instance discipline; our poller tolerates via backoff. Lockfile
  deferred.

### C. AGENT_URL + reply contract (repo, /private/tmp/myc-channels)
- reply tool ↔ daemon contract is **field-complete**: `reply.js` buildSendBody (telegram) sends
  `{chatId,text,voice,replyToMessageId,sourceKind,sourceId}` (`src/tools/reply.js:69-78`) — every field is read by
  the chokepoint (`chokepoint.js` destructure) and every `turn.*` it reads is set by `setActiveTurn`
  (`inbound-context.js`). ✅
- `reply` is gated on `process.env.AGENT_URL` at `src/mcp.js:124-127`. In **stdio mode** the daemon sets it
  (`claude-sdk.js` mcpServers env). In **http mode (default)** nothing sets it on the vault → **GAP**: the operator
  must boot the vault with `AGENT_URL=<daemon>` or `reply` never registers. **Fixed with a preflight warning**
  (`index.js`) + docs.

### D. TTS keys + ffmpeg (repo + canonical)
- The harvested TTS module reads **`process.env` only** (`tts/providers/openai.js` `OPENAI_API_KEY`,
  `tts/providers/elevenlabs.js` `ELEVENLABS_API_KEY`). V1 keeps BYOK keys **encrypted in the vault**
  (`src/db/providers.js` credentials column). **GAP/decision:** the keyless daemon can't read vault-encrypted keys →
  for now the operator sets `OPENAI_API_KEY`/`ELEVENLABS_API_KEY` in the **daemon env**. Planned: a loopback
  `GET /api/v1/internal/tts-credentials` so vault-managed keys hydrate the daemon (keeps the vault the key-holder).
- ffmpeg remux is **fail-soft** (`tts/shared/remux.js` catch → returns raw audio; `voice-pipeline.js` swallows total
  failure; text already delivered). Documented "requires ffmpeg on PATH"; not a package dep (system binary).

### E. MCP http attach (repo)
- `/mcp` is a Streamable HTTP transport on `:4711` (`src/server-http.js`), authorized by a **static bearer**
  `MYCELIUM_MCP_BEARER` (constant-time, ≥24 chars). CORS `*`, no origin/session blocker for a Node client. The Agent
  SDK **can attach headlessly** with `Authorization: Bearer <MYCELIUM_MCP_BEARER>`. Same tool set as stdio; `reply`
  present iff `AGENT_URL` set. ✅ — reinforces the C gap (vault needs both envs in http mode).

## Fixes applied this pass
- `agent/backends/claude-sdk.js` — `createReplyTracker()` (correct assistant→user tool_use/tool_result correlation);
  `env:{...process.env,…}`. Unit-locked S1–S4.
- `telegram-api.js` — `reply_parameters:{message_id}` in `sendMessage` + `sendVoice`.
- `index.js` — http-mode preflight: warns if the vault MCP lacks `reply`.
- `vault-client.js` — `listToolNames()` for the preflight.

## Verification table

| Assumption (load-bearing) | Verified at |
|---|---|
| `query()` is an AsyncGenerator; options `mcpServers` dict / `allowedTools` / `bypassPermissions` / `abortController` real | web: `@anthropic-ai/claude-agent-sdk@0.3.x` `sdk.d.ts` (sweep A) |
| tool_use on `type:'assistant'`.message.content; tool_result on `type:'user'`.message.content, keyed by `tool_use_id` | `agent/backends/claude-sdk.js` `createReplyTracker`; `scripts/verify-channel-agent.mjs` S1–S4 |
| SDK `env` is forwarded to a CLI subprocess (spread process.env) | `agent/backends/claude-sdk.js:96` |
| Telegram current reply field is `reply_parameters:{message_id}` | core.telegram.org Bot API 7.0 (sweep B); `telegram-api.js` sendMessage + sendVoice |
| `getUpdates` offset/allowed_updates + `sendVoice` multipart shapes correct | sweep B; `telegram-api.js` |
| reply buildSendBody fields == chokepoint destructure == setActiveTurn fields | `src/tools/reply.js:69-78`, `packages/channel-daemon/chokepoint.js`, `inbound-context.js` (sweep C) |
| `reply` registered iff `process.env.AGENT_URL` set | `src/mcp.js:124-127` |
| http-mode requires vault booted with AGENT_URL + MYCELIUM_MCP_BEARER; preflight warns | `packages/channel-daemon/index.js` preflight; `src/server-http.js` bearer (sweep C+E) |
| TTS reads process.env only; V1 BYOK keys are vault-encrypted | `tts/providers/*.js`, `src/db/providers.js` (sweep D) |
| ffmpeg missing → fail-soft (raw audio / text stands) | `tts/shared/remux.js` catch, `voice-pipeline.js` catch (sweep D) |
| Agent SDK can attach to `/mcp` headlessly via static bearer | `src/server-http.js` authenticate/static-bearer (sweep E) |

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK message shapes drift across versions | med | replies marked undelivered | `createReplyTracker` sniffs defensively (id-correlated, content-regex); pin SDK in optionalDependencies; host-smoke after install |
| Operator forgets AGENT_URL on the vault (http mode) | high | replies silently not delivered | startup preflight warns loudly; documented in README "Enabling two-way" |
| TTS key double-management (daemon env vs vault) | med | confusing/insecure key handling | documented; plan loopback `tts-credentials` endpoint |
| ffmpeg absent → Telegram rejects raw voice | low | no voice (text fine) | fail-soft; documented host requirement |
| Two daemon instances → 409 polling conflict | low | poll churn | backoff tolerates; lockfile deferred |

## Deferred (named, not ambushing Discord)
- Loopback `tts-credentials` endpoint (vault-managed TTS keys).
- Single-instance lockfile (canonical pattern).
- Per-second burst rate-limit (current is per-window).
- Voice-inbound transcription (voice-only inbound is currently skipped → no `voiceMode`-driven voice replies).
- Real host smoke: live Telegram poll/send/voice (token + ffmpeg), real Claude SDK turn (`npm i` SDK + key).

## Discord plan (the reuse — next phase)
Reuse **unchanged**: `inbound-context`, `dedup`, `ratelimit`, `coalescer`, `lane`, all of `agent/*`,
`voice-pipeline` (Discord voice messages differ — use `synthesizeForDiscord` already in `tts/`), `vault-client`,
internal router, `egress_audit`, `captureMessage`, the `reply` tool (it already platform-switches on `turn.source`).
New (Discord-specific): a `transport/discord-gateway.js` (WS, no poll), a `transport/discord-normalize.js`, and a
Discord `apiCall`/`inferKind`/contentField. **Refactor to do first:** extract the chokepoint's gate sequence
(`chokepoint.js`) into a platform-agnostic `egress/send-handler.js` core + a thin `{platform, apiCall, inferKind,
contentField, kindFor}` adapter — the canonical send-handler shape — then register telegram + discord adapters.
Verify: a `verify:channel-discord` mirroring the telegram gates + a 2nd-platform e2e.
