# Channel Access Policy + Settings-to-UI — Design (2026-06-06)

> `/sweep-first-design`. **Design + plan only — no implementation in this doc.** Two tracks:
> **(A)** bring the four env-only knobs into the vault config bridge + Channels UI;
> **(B)** a per-channel **access policy** (owner-only · allowlist of specific senders · open) — the real capability gap.
> Companion to `CHANNEL-INTEGRATIONS-DESIGN-2026-06-06.md` + `CHANNEL-DEPTH-SWEEP-2026-06-06.md`.

## TL;DR

- **The gap (B):** once a Telegram group / Discord channel is authorized (`/allow`), the daemon responds to **anyone**
  in it — the sender is *logged but never checked* (`inbound.js` isAuthorized, `discord-inbound.js` isAuthorized).
  There is **no per-user allowlist** anywhere. The canonical bot only has a *global* `allowedUsers` (Discord), not
  per-channel. So we design fresh: a per-(kind,value) **access policy** `{ mode, allowedSenders[] }`.
- **The plumbing (A):** the env-only knobs follow the *exact* settings pattern already built — store in `secrets` →
  `channel-config` (loopback, decrypted) → `applyChannelConfigToEnv` → daemon env → `loadConfig`. Pure extension.

## Sweep findings (file:line)

- **Sender NOT checked post-authorization** — `packages/channel-daemon/inbound.js` `isAuthorized` (telegram group →
  `isGroupAuthorized(chatId)` only) and `packages/channel-daemon/discord-inbound.js` `isAuthorized` (owner OR
  `isChannelAuthorized(chatId)`); `msg.fromId` is logged, never gated. **This is the gap.**
- **Storage:** `telegram_groups` has an unused `settings_json` (migrations/0001_init.sql:1309; `src/db/telegram-groups.js`
  never reads it). `identity_channels` (0001_init.sql:879-926) has flag columns (`auth_enabled`/`delivery_enabled`/
  `aka_published`) + `evidence_json` (binding proof). **Neither table is encrypted** — `ENCRYPTED_FIELDS`
  (`src/crypto/crypto-local.js:378-385`) lists only the `secrets` table.
- **Migrations** apply **all** `migrations/*.sql` in lexical order, idempotent (`CREATE TABLE IF NOT EXISTS` + guarded
  `ADD COLUMN`) — `src/db/migrate.js applyMigrations`. Next file: `0011_*`.
- **Settings bridge:** `src/portal-channels.js` GET/PUT ↔ `db.secrets`; `src/internal-router.js`
  `/api/v1/internal/channel-config` returns decrypted; `packages/channel-daemon/config.js applyChannelConfigToEnv`
  hydrates env. Owner ids (`OWNER_TELEGRAM_ID`/`OWNER_DISCORD_ID`) already live in `secrets` → **the vault can resolve
  the owner** for an access decision.
- **Canonical reference:** only channel-level on/off + a *global* Discord `allowedUsers` (`packages/core/discord-bot.js:68`,
  `routing.js:71-77`); no per-channel allowlist, no access modes. We improve on it.

## Decisions (with rationale)

1. **New unified `channel_access` table** (not `settings_json`/`evidence_json` overloading) — symmetric across
   Telegram + Discord, keeps the access *policy* cleanly separate from the *binding/registry*. Keyed by
   `(channel_kind, channel_value)` matching the existing ids.
2. **Three modes**, default **`open`** on authorize (preserves today's behavior — the operator `/allow`-ed the
   channel to make it interactive; tightening is opt-in):
   - `owner` — only the operator's sender id.
   - `allowlist` — the operator + an explicit set of sender ids.
   - `open` — anyone in the (already-authorized) channel.
3. **Decision resolved IN THE VAULT** (not the daemon): a new `GET /api/v1/internal/channel-access?kind=&id=&sender=`
   returns `{ respond, mode, reason }`. The allowlist + owner id stay in the vault; the daemon sends only the inbound
   sender id. This keeps the operator's social-graph (allowed contact ids) off the daemon and centralizes policy.
4. **Encrypt the allowlist** — add `channel_access: ['allowed_senders_json']` to `ENCRYPTED_FIELDS` (a list of the
   operator's contacts' ids is social-graph metadata, CLAUDE.md §7 spirit). The vault decrypts server-side; the
   daemon never sees raw ids (only sends one + gets a boolean).
5. **Group-A prefs in `secrets`** (consistent with the existing bridge), surfaced + hydrated like tokens. (Alternative:
   `users.settings`; rejected to keep one bridge.)
6. **Sensitivity still wins** — the auto-router's sensitive→local rule is independent of access mode; access policy
   gates *who can trigger a turn*, not *where it runs*.

## Data model

`migrations/0011_channel_access.sql`:
```sql
CREATE TABLE IF NOT EXISTS channel_access (
  channel_kind         TEXT NOT NULL,   -- 'telegram-group' | 'discord'
  channel_value        TEXT NOT NULL,   -- groupId / channelId
  mode                 TEXT NOT NULL DEFAULT 'open' CHECK (mode IN ('owner','allowlist','open')),
  allowed_senders_json TEXT,            -- JSON array of platform sender ids (encrypted at rest)
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_kind, channel_value)
);
```
`ENCRYPTED_FIELDS` += `channel_access: ['allowed_senders_json']`.

`src/db/channel-access.js` (new namespace):
- `get(kind, value) -> { mode, allowedSenders[] } | null`
- `set(kind, value, { mode, allowedSenders }) -> void` (upsert)
- `decide(kind, value, sender, ownerId) -> { respond:boolean, mode, reason }` — pure policy:
  `owner` → sender===ownerId; `allowlist` → sender===ownerId || allowedSenders.includes(sender); `open` → true.
  Missing row → default `open` (channel was authorized; policy not yet tightened).

## Access-decision flow (inbound)

```
inbound msg (group/channel, sender S)
  → channel authorized?  (existing: telegram_groups.active / identity_channels.delivery_enabled)   ── no → drop
  → vault GET /internal/channel-access?kind&id&sender=S
        owner = secrets[OWNER_<PLATFORM>_ID]; policy = channel_access.get(kind,id)
        respond = channelAccess.decide(kind,id,S,owner)
  → respond ? capture + turn : drop (logged)
```
Daemon side: `inbound.js` / `discord-inbound.js` `isAuthorized` gains a sender-policy step **after** the existing
channel-authorized check. Owner fast-paths (DM owner; discord owner-anywhere) stay local + unchanged. New
`vault-client.checkChannelAccess({kind,id,sender})`.

## Settings bridge — Track A (env knobs → vault + UI)

New fields, same path as tokens:
| Setting | secret key | env hydrated |
|---|---|---|
| Router mode | `CHANNEL_ROUTER` | `MYCELIUM_CHANNEL_ROUTER` |
| Sensitive patterns | `CHANNEL_SENSITIVE_PATTERNS` | `CHANNEL_SENSITIVE_PATTERNS` |
| Ollama model / url | `CHANNEL_OLLAMA_MODEL` / `OLLAMA_URL` | same |
| Coalesce window | `CHANNEL_COALESCE_MS` | same |
| Rate-limit max / window | `CHANNEL_RATELIMIT_MAX` / `CHANNEL_RATELIMIT_WINDOW_MS` | same |

- `src/portal-channels.js`: PUT accepts a `routing` object; GET returns current values (router/ollama/coalesce/
  ratelimit/sensitive — non-secret, returned as values; nothing here is a credential).
- `src/internal-router.js` `channel-config`: add a `routing` block (decrypted passthrough).
- `config.js applyChannelConfigToEnv`: map the `routing` block → env.
- UI: a collapsible **"Routing & tuning"** subsection in `ChannelsSection.svelte` (select for router mode, text for
  Ollama model/url, number inputs for coalesce/rate-limit, textarea for sensitive patterns).

## UI — Track B (access policy)

In `ChannelsSection.svelte`, each authorized group/channel row gains:
- a **mode** select (Owner only · Allowlist · Open),
- when `allowlist`: an editable list of sender ids (add field + per-id remove).
- `GET /portal/channels` returns each group/channel with `{ mode, allowedSenders }`; a new
  `PUT /portal/channels/access { kind, id, mode, allowedSenders }` persists.
- Optional follow-on (not required): in-chat `/mode owner|allowlist|open` + `/allow @user` commands.

## Verification table

| Assumption (load-bearing) | Verified at |
|---|---|
| Sender is never checked once a channel is authorized (the gap) | `packages/channel-daemon/inbound.js` isAuthorized · `discord-inbound.js` isAuthorized (sweep) |
| Migrations apply all `*.sql` lexically + idempotently → new `0011` works | `src/db/migrate.js applyMigrations` (read) |
| `telegram_groups`/`identity_channels` are NOT encrypted; only `secrets` is | `src/crypto/crypto-local.js:378-385` (sweep) |
| Owner ids live in `secrets` → vault can resolve owner for the decision | `src/portal-channels.js` PUT writes `OWNER_TELEGRAM_ID`/`OWNER_DISCORD_ID` (sweep) |
| Settings bridge = secrets → channel-config → applyChannelConfigToEnv | `portal-channels.js` · `internal-router.js` · `config.js` (sweep) |
| `users.settings` exists (alt store, not chosen) | `src/db/users.js:41-50` |
| `db.secrets` auto-encrypts via SYSTEM_KEY; adapter encrypts named ENCRYPTED_FIELDS columns | `src/db/secrets.js` header · `crypto-local.js` |

## Threat model / security

- **Fail-closed:** unauthorized channel → drop (unchanged). `allowlist`/`owner` with an empty/unknown sender → drop.
  A vault-unreachable access check → **deny** (daemon treats indeterminate as no-respond), matching the existing
  authority fail-closed posture.
- **Allowlist confidentiality:** stored encrypted (`ENCRYPTED_FIELDS`), resolved in the vault, never sent to the
  daemon (daemon sends one sender id, gets a boolean). Loopback only.
- **Owner always reachable:** owner is implicitly allowed in every mode (can't lock yourself out).
- **No new plaintext in logs:** sender ids redacted in daemon logs as today; the decision endpoint records nothing
  plaintext.
- **Group-A prefs** are non-secret config; storing in `secrets` over-encrypts harmlessly. `sensitivePatterns` are
  operator-authored regexes — validate/compile defensively (already done in `parseSensitivePatterns`).

## Edge cases (explicit)

- **DMs:** Telegram DM is owner-only by nature (chatId == owner); Discord DM is a channel → owner-anywhere fast-path.
  Access policy applies only to authorized *group/channel* turns. (A non-owner DM is already dropped.)
- **Mode change mid-conversation:** takes effect on the next inbound (vault read per turn; no caching beyond the
  request). Acceptable.
- **Removing a sender:** their next message is dropped; in-flight turn (if any) completes.
- **`open` + sensitive content from a stranger:** still captured + turned, but the auto-router keeps sensitive turns
  local (no cloud egress) — the two policies compose.
- **Coalescer + per-sender:** coalescing is per-chat, not per-sender; an `allowlist` channel with multiple allowed
  senders coalesces their interleaved messages into one turn (acceptable for v1; note for future per-sender lanes).

## Test strategy

- **Pure DI:** `channel-access.decide()` truth table (owner/allowlist/open × owner/allowed/stranger) →
  `verify:channel-access`. Daemon `isAuthorized` with an injected `checkChannelAccess` (drop stranger in owner/
  allowlist; allow in open; owner always).
- **Real-vault:** `0011` migration applies; `channel_access` set/get/decide round-trip; `allowed_senders_json`
  encrypted at rest (raw row ciphertext ≠ plaintext id); `/internal/channel-access` decision endpoint; group-A
  `routing` round-trip through `channel-config` + `applyChannelConfigToEnv`. Extend `verify:channel-settings`.
- **UI:** `portal:build` GO; the access selector + allowlist editor + routing subsection render.
- **Regression:** full channel suite + `verify:rest`/`verify:mcp` GO (the new column/namespace is additive).

## Implementation order (phased, each shippable)

1. **B1 — schema + namespace:** `0011_channel_access.sql` + `ENCRYPTED_FIELDS` + `src/db/channel-access.js` (get/set/
   decide) wired into `getDb`. Verify: `verify:channel-access` (decide truth table) + real-vault encryption.
2. **B2 — vault decision endpoint + daemon filter:** `/api/v1/internal/channel-access`;
   `vault-client.checkChannelAccess`; thread the sender-policy step into `inbound.js` + `discord-inbound.js`
   `isAuthorized`. Verify: daemon DI (stranger dropped, owner/allowed pass) + real-vault decision.
3. **B3 — access UI + set endpoint:** `PUT /portal/channels/access` + GET exposes `{mode, allowedSenders}` per
   group/channel; `ChannelsSection` mode select + allowlist editor. Verify: settings round-trip + `portal:build`.
4. **A — routing/tuning settings:** the five knobs through `portal-channels` PUT/GET + `channel-config` +
   `applyChannelConfigToEnv` + a "Routing & tuning" UI subsection. Verify: `verify:channel-settings` extension.

Each phase is independently committable; A is parallelizable with B.

## Deferred (named)

In-chat `/mode` + `/allow @user` commands (UI is the primary surface); per-sender lanes; access *tiers* beyond the
three modes (e.g. respond-to-mentions-only); allowlist by username instead of raw id (needs identity resolution).
