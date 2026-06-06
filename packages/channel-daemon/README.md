# channel-daemon

Single-user, single-agent **agent-server** for two-way conversational channels
(Telegram first). It sits beside the vault REST/MCP server and reaches the vault
**only over loopback HTTP** — the vault stays the single DB writer and single
key-holder. This daemon is the host the deferred `reply` MCP tool
(`src/tools/reply.js`) was written against.

See the design: [`docs/CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md`](../../docs/CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md).

## Status — Phase 0 + Phase 1 (egress chokepoint + inbound capture)

Built:
- `POST /telegram/send` — the egress chokepoint. Gate order: content present →
  fail-closed routing (chatId required) → trivial-content block → provenance
  classification (strict-loopback header) → channel authority (fail-closed) →
  envelope dedup → Telegram send → egress audit (hash only) + outbound persist.
- `GET /internal/inbound-context/current` — the active-turn registry the `reply`
  tool reads (404 when empty → tool returns `no-active-turn`).
- **Inbound long-poll** (`getUpdates` over raw fetch, no Grammy) → normalize →
  fail-closed owner-DM auth → `captureMessage` over REST (idempotent
  `tg-<msgId>-<chatId>`) → `runTurn` (Phase 1 stub sets the active turn).

Not yet built (later phases):
- The agent turn (Claude Agent SDK behind the `AgentRuntime` interface) — Phase 2.
- Voice/TTS, group binding, text coalescing, rate-limit/backoff, Discord +
  WhatsApp — Phase 3.

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
npm run verify:channel-egress-e2e   # real vault + real daemon + fake Telegram (14 checks, incl. inbound)
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
