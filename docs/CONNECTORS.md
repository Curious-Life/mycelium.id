# Mycelium V1 — Messaging Connectors (Phase 5b)

> **Status.** Design/spec, reconciled against the **built** ingestion surface (2026-05-31).
> The original addendum targeted a `POST /api/v1/createMessage` endpoint + an `external_id`
> column that **do not exist**. This doc maps the same intent onto what's actually built:
> the `captureMessage` choke-point (`src/ingest/capture.js`, shipped `2c982a6`) reached via
> the generic REST router `POST /api/v1/captureMessage`. **No schema migration is needed** —
> dedup already works on the message `id`. Connectors are **buildable today** (they only need
> `captureMessage` + REST, both live); the bridge processes need real platform tokens + network,
> so they're verified against the platform APIs on a connected host, not in CI.

**Purpose.** Lightweight bridge processes that authenticate with a messaging platform, listen for
messages, normalize them, and POST to Mycelium so every channel becomes searchable + feeds topology.

**Where it slots in.** Phase 5b, parallel track. Depends only on **Phase 1 Step 5 (REST router)** +
the **`captureMessage` choke-point** — both shipped. No dependency on search/topology/OAuth.

---

## Reconciliation with the built surface (READ FIRST)

| Original addendum | Built reality (verified) | Resolution |
|---|---|---|
| `POST /api/v1/createMessage` | REST is generic `POST /api/v1/:toolName`; the tool is **`captureMessage`** | Use **`POST /api/v1/captureMessage`** (JSON body = the tool args). No new endpoint. |
| add `external_id` column + `(channel, externalId)` unique constraint | **no `external_id` column**; dedup is on the **`id` PK** via `getExistingIds` + `insertIgnore` (`src/ingest/capture.js:60`) | **Map `externalId` → the message `id`** (e.g. `tg-<msgId>-<chatId>`). Dedup already works. **No migration, no constraint.** |
| `channel` field | `messages.source TEXT` (nullable, arbitrary) | `channel` → **`source`** (`"telegram"`, `"discord"`, …). |
| `senderRole: "user" \| "other"` | `messages.role` is `user`/`assistant` only | Both are humans → `role: 'user'`. Put sender identity + owner-flag in **`metadata`** (`sender`, `senderRole`). "other" ≠ assistant. |
| `POST /api/v1/importMessages` (batch) | doesn't exist | Add an **`importMessages` tool** (loops `captureMessage`; idempotent). One small build. |
| "encryption: connectors POST plaintext over localhost" | matches — db layer encrypts at rest automatically | ✅ correct. Remote connectors must use the **OAuth-HTTP** surface (`server-http.js`), not the no-auth localhost REST. |

**Net:** the addendum's only required schema/endpoint changes are **unnecessary** — the built
`captureMessage` already provides id-based dedup + `source` provenance + `metadata` extras. The one
genuine addition is the optional `importMessages` batch tool for history backfill.

---

## Architecture

```
 Telegram Bot API   WhatsApp Business   Discord Gateway
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│           Connector process (one per platform)            │
│  • auth with platform • listen (webhook/poll)             │
│  • normalize → ConnectorMessage                           │
│  • POST /api/v1/captureMessage  (externalId → id = dedup) │
│  • handle rate limits, retries                            │
└───────────────────────────┬──────────────────────────────┘
                            ▼
        Mycelium REST (localhost)  or  OAuth-HTTP (remote)
        POST /api/v1/captureMessage → captureMessage()
        → insertIgnore(id) → encrypt → store → nlp_processed=0 → enrich → searchable
```

## Normalized shape → captureMessage args

```ts
// ConnectorMessage (normalize.ts) → captureMessage tool args
{
  content: string,                 // → content
  id: `${channel}-${externalId}`,  // → id  (idempotency key; dedup is automatic)
  source: channel,                 // → source ("telegram" | "discord" | "whatsapp" | "signal")
  role: 'user',                    // humans only; assistant replies aren't ingested here
  conversationId?: channelId,      // → conversation_id
  metadata: {                      // → metadata (JSON, encrypted at rest)
    sender, senderRole,            // senderRole: 'owner' | 'other'  (was "user"/"other")
    chatTitle?, replyTo?, mediaType?, mediaUrl?,
  }
}
```

## Connector priority + effort
1. **Telegram** (~2d) — Bot API, `getUpdates` poll or webhook; token from @BotFather; full history via Telegram data-export → `importMessages`.
2. **Discord** (~2d) — Gateway WS + REST, `MESSAGE_CONTENT` intent; backfill via `GET /channels/{id}/messages` pagination.
3. **WhatsApp** (~2d) — Meta Business Cloud API webhook; incoming-only (no history via official API).
4. **Signal** (deferred, ~3d) — `signal-cli` daemon, unofficial.
5. **iMessage** (deferred) — macOS-only, batch export only.

## Proposed layout (when built)
```
connectors/
  shared/   client.ts (POST /api/v1/captureMessage) · normalize.ts · config.ts
  telegram/ index.ts · listener.ts · mapper.ts
  discord/  …
  whatsapp/ …
```
Each connector is a standalone process (systemd/pm2/docker) — no coupling to the server process.

## Config (env, per connector)
```env
MYCELIUM_API_URL=http://localhost:<port>/api/v1   # REST (localhost) — or the OAuth-HTTP base if remote
MYCELIUM_API_KEY=<Bearer token>                   # required only for the remote OAuth-HTTP path
TELEGRAM_BOT_TOKEN=… TELEGRAM_OWNER_ID=… TELEGRAM_MODE=polling
DISCORD_BOT_TOKEN=… DISCORD_OWNER_ID=…
WHATSAPP_TOKEN=… WHATSAPP_PHONE_ID=… WHATSAPP_VERIFY_TOKEN=…
```

## Required build work (reconciled — smaller than the addendum)
1. **`importMessages` tool** — `src/tools/ingest.js`: accept an array, loop `captureMessage` (idempotent), return `{ created, skipped }`. (The single-message path + dedup already exist.)
2. **`connectors/` framework** — REST client (`captureMessage` POST), normalize, config, retry/backpressure.
3. **Per-platform mappers + listeners** — Telegram first; verified against the live platform API on a connected host.
4. **No schema change, no new REST endpoint, no unique constraint** — id-based dedup covers it.
5. **Connector setup docs** — per platform (this file is the spec; per-platform runbooks added when built).

## Exit criterion
A Telegram message appears in `searchMindscape` within ~5s of being sent (requires the embed/enrichment
path live — see D7; until then it's searchable via BM25 immediately, semantic once embedded).

## Security notes
- Localhost REST has **no auth** by design — only safe same-machine. Any connector on a **different host**
  MUST use the **OAuth-HTTP** surface (Bearer) + HTTPS, never the localhost REST exposed to a network.
- Messages encrypt at rest automatically (the db query layer). Connectors handle **plaintext in transit**
  only on loopback; over a network, TLS is mandatory.
- `metadata` (incl. `sender`, `chatTitle`) is in `ENCRYPTED_FIELDS.messages` → encrypted at rest. ✅

## Status
**Deferred / buildable.** Prerequisites (`captureMessage` + REST) are shipped. Start with the
`importMessages` tool (small, in-CI-testable) + the Telegram connector (platform-token-gated,
host-verified). Tracks as Phase 5b in `docs/V1-IMPLEMENTATION-PLAN.md`.
