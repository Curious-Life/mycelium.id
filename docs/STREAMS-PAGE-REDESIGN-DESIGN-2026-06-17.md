# Streams page redesign (spec #11) — Design

**Date:** 2026-06-17
**Branch:** `feat/streams-redesign` (worktree `mycelium-worktrees/prelaunch-remaining`, off merged `main` `18655cd`)
**Spec:** §11 "Streams page redesign" (P1) — adjacent to #10 (ingestion connectors, design `docs/STREAMS-INGESTION-MCP-DESIGN-2026-06-16.md`) and #12 (simple connect toggle, shipped).
**Protocol:** `/sweep-first-design` — 3 sweep cycles (frontend audit · backend/ingestion audit · union-at-read data-model audit), file:line citations, red-team before build.

---

## 0. Headline

The Streams page claims to show "everything flowing into your vault" but actually shows **4 chat platforms** out of **~16 real ingest sources**, all of which already converge on one choke-point (`captureMessage`, `src/ingest/capture.js:88`) and the `messages` table's plaintext `source` tag. Worse, the page is split into two disconnected mental models — **Stream** (a hardcoded-4 timeline) and **Sources** (import + connector health) — that never reference each other.

**The redesign makes Streams one living river of *everything* ingested, fed by a "source spectrum" that is simultaneously the legend, the health display, and the filter — all derived from real data, never a hardcoded list.**

Operator decisions locked (2026-06-17):
- **D-A — River scope: EVERYTHING ingested.** Union across `messages` + `documents` + `health_daily` + `tasks`, interleaved chronologically. (Not messages-only.)
- **D-B — Sources surface: river-first, manage in a drawer.** Default landing is the river + spectrum; connect/import/health move into a "Manage sources" drawer. The two-facet segmented control is removed.
- **D-C — Life-domain chips REMOVED.** Wealth/Intel/Body/Vitality/Activity are derived dashboards, not "data passing through" — deleted from Streams.

---

## 1. Sweep findings (load-bearing, file:line)

### 1a. Frontend today (`portal-app/src/lib/views/`)
- `StreamsView.svelte` — two facets (`stream`, `sources`) behind a segmented control + 5 disabled life-domain chips (`['Wealth','Intel','Body','Vitality','Activity']`, lines 12–41); URL-driven `?facet=`.
- `TimelineView.svelte` — the river. Loads `GET /portal/messages?limit=50&before=` (lines 90–100), `/portal/agents`, `/portal/identity`. **Hardcoded 4-source filter** (telegram/discord/whatsapp/portal) + channel pills (lines 45,127–139). Rich row rendering: source badge, speaker classification, reply context, attachments (image/voice/video/file), clamped markdown (DOMPurify+marked).
- `ImportView.svelte` — the Sources facet. Import cards (mycelium/claude/chatgpt/obsidian/linkedin) + **live connector cards** with a consistent `ConnectorStatus` health shape (status badge · last-sync · items · daily budget · reconnect, lines 75–81,510–533).
- Source identity map lives in `portal-app/src/lib/timeline/utils.ts:93–100` — **hardcoded** telegram/discord/whatsapp/portal → {bg,text,label}. Gmail/Linear/Obsidian/agent/apple have **no badge, no color, no chip** → they render with a fallback.
- Nav: `Sidebar.svelte:39` + `BottomTabBar.svelte:88` — label "Streams", wavy-lines icon, `/streams`.

### 1b. Ingestion + provenance (already unified at the write boundary)
- **One choke-point:** `captureMessage(db, msg, enqueueEnrichment)` — `src/ingest/capture.js:88–179`. Dedup on `id` PK + `content_hash`; audit `message_captured`.
- **~16 sources**, all tagged in `messages.source` (plaintext): `mcp`, `api`, `apple`, `gmail`, `linear`, `telegram`, `telegram-group`, `discord`, `discord-thread`, `whatsapp`, `obsidian`, `claude-import`, `chatgpt-import`, `import`, agent-capture (`claude-code`/`gateway`/`opencode`/`openclaw`/`hermes`/`bridge`, opt-in gated `capture.js:98`), portal (`inference:chat`).
- **Connector framework** (the scalable ingestion backbone, reused by #10): `connectors` table with plaintext op columns (status/cursor/last_sync_at/last_ok_at/last_error_at/idle_streak/items_*/budget) + encrypted `account_label`/`last_error`/`recent_runs` (`migrations/0008_connectors.sql`); adapters gmail/linear/mock (`src/connectors/registry.js`); 5-min scheduler with idle-backoff + daily budget (`src/connectors/scheduler.js`).
- **Existing per-source aggregate** (the spectrum template): `messages.listDataSources(userId)` — `src/db/messages.js:662–678`: `GROUP BY source, agent_id` → `{source, row_count, oldest, newest, embedded}`.

### 1c. The other tables (D-A union targets) — `src/db/` + `migrations/0001_init.sql`

| Table | Order ts (plaintext) | Source (plaintext) | Title/preview (ENCRYPTED) | Soft-delete | List fn | Index on (user,created_at)? |
|---|---|---|---|---|---|---|
| `messages` | `created_at` | `source` | `content` | `forgotten_at` | `selectTimeline` (messages.js:596) | `idx_messages_scope_created`, `idx_messages_created_at`, `idx_messages_source` ✓ |
| `documents` | `created_at` (also `updated_at`) | `source_type` | `title`,`summary` | `forgotten_at` | `list` (documents.js:134) | `idx_documents_scope_created` (scope,updated_at) ⚠ |
| `health_daily` | `created_at` (also `date`) | `source` (`apple_health`) | all 19 metrics | — (hard delete) | `getRange` (health.js:68) | `idx_health_daily_user_date` (date) ⚠ |
| `tasks` | `created_at` | none → synth | `title` | — (hard delete) | `list` (tasks.js:33) | none ❌ |

**No cross-table union or unified feed exists** — `selectTimeline` is messages-only; `activity-feed.js` tracks *job progress*, not content. **Must be built.**

---

## 2. The crux — why the union cannot be a raw SQL `UNION` (red-team finding)

The d1 adapter auto-encrypts/decrypts at the query boundary **keyed on table name + column name** via `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js`). A hand-written `SELECT … FROM messages UNION ALL SELECT … FROM documents …` returns rows with **no table identity**, so:
1. The adapter cannot route each row's `content`/`title` to the right decrypt key → previews come back as ciphertext or throw.
2. A `SELECT *` in any arm leaks `embedding_768` / `centroid_*` — the §7 vector-exfil tripwire (`hasVectorKey()` exists precisely to catch this; `documents.get()` is already a known `SELECT *` leak).

**Therefore the union is performed in JS, per-table, each arm going through its own namespace's decrypt path** — never a cross-table SQL UNION, never `SELECT *`.

### 2a. Unified river algorithm (`db.streams.feed`)
```
feed(userId, { limit=50, before, sources, types, since }):
  # before = ISO cursor (created_at); sources/types = optional filters; since = time-scope floor
  per-table (only those allowed by `types`), each via its OWN decrypting list fn with
  EXPLICIT column projection (no SELECT *), WHERE created_at < before AND created_at >= since
  AND <soft-delete filter>, ORDER BY created_at DESC LIMIT (limit+1):
    M = messages.selectTimeline-style  → type:'message'
    D = documents (explicit cols: path,title,summary,source_type,created_at) → type:'document'
    H = health_daily.getRange-ish (last N days) → type:'health'  (summarized, see 3c)
    T = tasks.list (title,status,priority,created_at) → type:'task'
  normalize each to a StreamItem (§3a), k-way merge-sort by created_at DESC,
  take top `limit`, nextCursor = created_at of the last returned item (or null).
```
Bounded cost: ≤ 4×(limit+1) decrypted rows per page (≤204 at limit 50). Cursor carries only a timestamp — no sensitive data.

### 2b. Source spectrum algorithm (`db.streams.spectrum`) — **plaintext only, zero decryption**
```
spectrum(userId, { windowDays=7 }):
  per table: GROUP BY source(_type) over created_at >= now-windowDays →
    { source, kind, total, lastActivity, dailyBuckets[windowDays] }
  (messages: extend listDataSources + DATE(created_at) bucket; documents: GROUP BY source_type;
   health: source='apple_health'; tasks: synth source='task')
  LEFT JOIN connectors (plaintext status/last_sync_at/last_error_at/idle_streak) keyed by provider
    → status: live | synced | idle | error(needs-reconnect)
  classify each source → kind via the server-side source registry (§3b).
```
Uses only plaintext aggregate columns → **fail-safe: the at-a-glance surface never touches ciphertext.**

---

## 3. Design

### 3a. `StreamItem` (normalized feed row)
```ts
{ id, type: 'message'|'document'|'health'|'task',
  source: string,            // raw provenance tag (telegram, gmail, obsidian, apple_health, task…)
  createdAt: string,         // ISO, the merge key
  title?: string,            // documents/tasks (decrypted, truncated)
  preview: string,           // decrypted + TRUNCATED to ~240 chars (never full content)
  meta?: {                   // type-specific, minimal
    channel?, senderName?, attachmentType?,   // message
    status?, priority?,                        // task
    metrics?: { steps?, sleepMin?, hrvAvg? },  // health (summarized)
    path?, published?                          // document
  } }
```
**Never** includes `embedding_768`/`centroid_*`/`metadata`(raw). A `hasVectorKey()` assertion guards the serialized payload in the gate.

### 3b. Source registry — one source of truth
- **Server-side** (`src/streams/source-registry.js`): `source → kind` classifier (`messaging`|`connector`|`knowledge`|`agent`|`device`|`portal`) with a sensible default (`other`) so new/unknown sources self-place. Drives spectrum grouping.
- **Client-side** (`portal-app/src/lib/streams/sources.ts`): `kind`/`source → { label, icon, color }` presentation map, replacing the hardcoded `timeline/utils.ts:93`. New sources get a neutral default badge, not a fallback void.

### 3c. Health summarization (sensitive — minimal surface)
A health row becomes **one** StreamItem/day: `preview = "Sleep 7h · 8,432 steps · HRV 45"` built from the few headline metrics, decrypted server-side. No raw metric dump, no full-table read. Owner-only over the authed portal (same boundary as today's `getSummary`).

### 3d. Endpoints (`src/portal-compat.js`, owner-authed like the rest of `/portal/*`)
- `GET /portal/streams?limit&before&sources=a,b&types=message,document&since=` → `{ items: StreamItem[], nextCursor }`
- `GET /portal/streams/spectrum?windowDays=7` → `{ sources: [{ source, kind, label?, status, total, lastActivity, dailyBuckets:number[] }] }`
- Reuse existing `/portal/connectors*` for the Manage-sources drawer (no new connector surface here; #10 adds the kinds).

### 3e. Frontend
- `StreamsView.svelte` → **river-first**: `<SourceSpectrum>` (top, the hero) + search box + time-scope (Today/7d/All) + `<StreamRiver>` (feed). Remove the segmented facets and the 5 life-domain chips.
- `<SourceSpectrum>` — chips from `/portal/streams/spectrum`: icon · name · status dot · last-activity · 7-bar daily sparkline; faint grouping by `kind`; **multi-select → drives the river filter**. Quiet sources fade; error sources show "needs reconnect".
- `<StreamRiver>` — `/portal/streams` feed, date markers, **type-aware row renderers**: reuse the message row from `TimelineView`; add compact `document` (title+summary), `health` (metric chips), `task` (title+status) renderers. Cursor "load older".
- `<ManageSourcesDrawer>` — wraps the existing `ImportView` content (connectors + imports) behind the "Manage sources" button; keeps the shipped connector health UI verbatim.

### 3f. Migration
- `migrations/00NN_streams_indexes.sql` — add `idx_tasks_user_created ON tasks(user_id, created_at DESC)` (closes the ❌ gap so the per-source task bucket/merge avoids a table scan). documents/health/messages indexes are adequate (`created_at` covered).

---

## 4. Security red-team (cognitive vault — §1, §7, fail-closed)
- **No SELECT * anywhere in the feed** — explicit columns only (documents.get's `SELECT *` leak is NOT reused); `embedding_768`/`centroid_*` never selected. Gate asserts `hasVectorKey(payload)===false` on the serialized river response.
- **Spectrum is plaintext-only** — the always-on at-a-glance surface performs zero decryption, so it cannot leak ciphertext-derived data even on a bug.
- **Previews truncated** (~240 chars), not full content — limits blast radius of the read surface; same auth boundary as existing `GET /messages`.
- **Redaction honored** — `forgotten_at IS NULL` on messages+documents; deleted tasks excluded by `status`. Forgotten items never surface in the river or the counts.
- **Owner-only** — all `/portal/streams*` behind the same vault-auth gate as the rest of `/portal/*` (loopback always-signed-in; networked requires session). No new public surface.
- **Health sensitivity** — summarized headline metrics only, server-side decrypt, owner boundary; no new exposure vs. today's health summary.
- **Cursor safety** — pagination cursor is a bare timestamp; no ids or content encoded.

## 5. Verification gates (build-time)
| Gate | Asserts |
|---|---|
| `verify:streams-feed` | union merge-sorts by created_at; cursor pagination stable; forgotten/deleted excluded; **`hasVectorKey(response)===false`**; previews truncated; per-table decrypt correct (no ciphertext in output) |
| `verify:streams-spectrum` | per-source counts + daily buckets + lastActivity correct over window; connector status joined; **zero decryption path** (plaintext columns only); unknown source → `other` kind, not a crash |
| `verify:streams-registry` | every known source maps to a kind; unknown self-places to `other`; client map has no fallback void |
| `portal:check` + `vite build` | StreamsView/SourceSpectrum/StreamRiver/ManageSourcesDrawer type-check + build; life-domain chips + facet control removed |

## 6. Phasing (each phase independently shippable + gated + live-verified in browser preview)
1. **P1 — Spectrum (the at-a-glance hero).** Source registry (server+client) + `/portal/streams/spectrum` + `<SourceSpectrum>`. All plaintext, lowest risk, highest immediate value. Gate `verify:streams-spectrum`+`streams-registry`.
2. **P2 — Unified river.** `db.streams.feed` (JS union) + `/portal/streams` + `<StreamRiver>` type-aware rows + the migration index. Gate `verify:streams-feed`.
3. **P3 — Layout.** River-first StreamsView; `<ManageSourcesDrawer>` folds ImportView; remove facets + life-domain chips. `portal:check`+build; live browser verify (per `portal-ui-live-verify` recipe — vite :5174 proxied to live :8787).
4. **P4 — (ties to #10).** Generic `http-poll`/`webhook` connector kinds (already designed) surface automatically in the spectrum/drawer — no extra Streams work.

## 7. Out of scope / deferred
- #10 connector worker build (separate design, separate PR).
- MCP→Settings repositioning (separate; Streams shows only the #10 signpost if needed).
- Connections galaxy (#13) — separate.
- Realtime push (SSE live-append): river polls/refreshes for v1; live-append is a follow-up.
