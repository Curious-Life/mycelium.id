# channel-daemon

Single-user, single-agent **agent-server** for two-way conversational channels
(Telegram first). It sits beside the vault REST/MCP server and reaches the vault
**only over loopback HTTP** — the vault stays the single DB writer and single
key-holder. This daemon is the host the deferred `reply` MCP tool
(`src/tools/reply.js`) was written against.

See the design: [`docs/CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md`](../../docs/CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md).

## Status — Phase 0–2 (egress + inbound + the agent turn = two-way works)

Built:
- `POST /telegram/send` — the egress chokepoint. Gate order: content present →
  fail-closed routing (chatId required) → trivial-content block → provenance
  classification (strict-loopback header) → channel authority (fail-closed) →
  envelope dedup → Telegram send → egress audit (hash only) + outbound persist.
- `GET /internal/inbound-context/current` — the active-turn registry the `reply`
  tool reads (404 when empty → tool returns `no-active-turn`).
- **Inbound long-poll** (`getUpdates` over raw fetch, no Grammy) → normalize →
  fail-closed owner-DM auth → `captureMessage` over REST (idempotent
  `tg-<msgId>-<chatId>`) → the lane.
- **The agent turn** — `AgentRuntime` interface (`agent/runtime.js`), default
  Claude Agent SDK backend (`agent/backends/claude-sdk.js`, optional dep,
  lazy-imported), single-user serialized lane (`agent/lane.js`,
  set→run→clear). `reply` is un-deferred in the vault MCP when `AGENT_URL` is set.

Phase 3 hardening (platform-agnostic — Discord reuses these):
- **Coalescing** (`transport/coalescer.js`) — rapid fragments → one turn
  (`CHANNEL_COALESCE_MS`, 0 disables). **Rate-limit** (`ratelimit.js`) —
  per-target fixed-window cap, chokepoint gate
  (`CHANNEL_RATELIMIT_MAX`/`_WINDOW_MS`). Poller backoff jitter.

Not yet built:
- Voice/TTS, group binding + group inbound auth, Discord + WhatsApp transports.
  The local **ollama** runtime backend is a declared slot (selectRuntime returns
  null until it lands).

### Enabling two-way replies

Two-way is **config-implied** (design §2). Provide an Anthropic BYOK key and the
SDK; without them the daemon runs **capture-only** (ingestion still works):

```bash
npm i @anthropic-ai/claude-agent-sdk          # optional dep, only for two-way
ANTHROPIC_API_KEY=sk-ant-…                     # → cloud Claude Agent SDK (default)
```

The vault MCP server must be reachable (default `MYCELIUM_MCP_URL=…:4711/mcp`)
**and booted with `AGENT_URL` pointing at this daemon** so its `reply` tool calls
the egress chokepoint back here. (Or set `CHANNEL_MCP_MODE=stdio` to have the SDK
spawn its own MCP server — then the daemon env must carry the vault keys.)

## Run

```bash
TELEGRAM_BOT_TOKEN=<from @BotFather> \
OWNER_TELEGRAM_ID=<your telegram chat id> \
MYCELIUM_API_URL=http://127.0.0.1:8787 \
npm run channel:telegram
```

The daemon binds `127.0.0.1:3010` by default (`CHANNEL_DAEMON_PORT`). Point the
`reply` tool's `AGENT_URL` at it.

### Env

| Var | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot API token (@BotFather). Never logged. |
| `OWNER_TELEGRAM_ID` | yes | — | Operator chatId — the one chat deliverable before the Phase 3 binding flow. |
| `MYCELIUM_API_URL` | no | `http://127.0.0.1:8787` | Vault REST base (no trailing `/api/v1`). |
| `CHANNEL_DAEMON_HOST` / `CHANNEL_DAEMON_PORT` | no | `127.0.0.1` / `3010` | Where this daemon listens. |
| `CHANNEL_AGENT_ID` | no | `personal-agent` | agent_id stamped on egress_audit rows. |

## Verify

```bash
npm run verify:channel-egress       # chokepoint gates, DI fakes (19 checks)
npm run verify:channel-inbound      # inbound transport + capture, DI fakes (18 checks)
npm run verify:channel-agent        # lane lifecycle + runtime selection, DI fakes (12 checks)
npm run verify:channel-coalesce     # inbound coalescer, virtual clock (7 checks)
npm run verify:channel-egress-e2e   # real vault + real daemon + fake Telegram (14 checks, incl. inbound)
npm run verify:channel-agent-e2e    # the WHOLE two-way loop, only the LLM faked (8 checks)
```

## Security

- **Explicit-send only** (CLAUDE.md §11): this chokepoint is the only path agent
  text reaches Telegram. Raw model output is never delivered by any other route.
- **Zero plaintext in audit** (§1): egress rows carry `sha256(content)` + length,
  never the body. The vault audit endpoint 400s on any payload with a `content`
  field.
- **Fail-closed authority** (§3): a target is deliverable only via owner-bootstrap
  (the configured `OWNER_TELEGRAM_ID`) or a `delivery_enabled` `identity_channels`
  row. An unreachable vault denies the send.
- **Loopback trust**: the daemon↔vault REST is no-auth on localhost by design. If
  ever split across hosts it MUST switch to the OAuth-HTTP surface + TLS.
