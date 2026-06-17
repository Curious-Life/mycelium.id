# Streams river — Phase 2: the unified "everything" feed — Design

**Date:** 2026-06-17
**Branch:** `feat/streams-redesign` (worktree `mycelium-worktrees/prelaunch-remaining`)
**Builds on:** Phase 1 (source spectrum, shipped PR #214) + the locked design `docs/STREAMS-PAGE-REDESIGN-DESIGN-2026-06-17.md` (decision **D-A: river scope = EVERYTHING ingested**).
**Protocol:** `/sweep-first-design` — 2 fresh sweep cycles this phase (decrypt-boundary/§7 + river-render/cursor), file:line citations, security red-team. Security-sensitive: per-row decryption + the §7 vector tripwire.

---

## 0. Headline

Today the river (`TimelineView` → `GET /portal/messages`) shows **only the `messages` table**. Phase 2 makes it the **unified river of everything ingested** — `messages` + `documents` + `health_daily` + `tasks` — interleaved chronologically, each row type-aware, filterable by the Phase-1 spectrum.

The one hard constraint that shapes the whole design (proven by sweep): **the union CANNOT be a SQL `UNION`.** The d1 adapter auto-decrypts keyed on *table name* (`autoDecryptResults` against `ENCRYPTED_FIELDS[table]`, `src/adapter/d1.js:51`), so a cross-table `UNION` returns rows it can't route to the right decrypt key, and any `SELECT *` arm drags in `embedding_768` (the §7 leak). **So the union is done in JS, per-table, explicit columns only, each arm through its own auto-decrypting `d1Query`.**

---

## 1. Sweep findings (load-bearing, file:line)

### Decrypt boundary + §7
- Auto-decrypt on read is keyed on **table + column** via `ENCRYPTED_FIELDS` — `src/adapter/d1.js:51` (`autoDecryptResults`), registry at `src/crypto/crypto-local.js:235` (messages), `:261` (documents), `:311` (health_daily), `:344` (tasks). **A plain `d1Query` SELECT of explicit columns returns decrypted `content`/`title`/metrics — no caller decrypt step.**
- `embedding_768` is a real column on `messages` (`migrations/0001_init.sql:950`) and `documents` (`:651`) but is **NOT** in `ENCRYPTED_FIELDS` → `SELECT *` returns it (as a raw envelope) and leaks it. `health_daily` + `tasks` have **no** vector column.
- The §7 tripwire `hasVectorKey(obj)` is exported from `src/federation/lexicon.js:12` (regex `/(embedding|vector|centroid|matryoshka|\bvec\b)/i`, recursive, depth-8) — already the egress guard at `src/federation/handlers.js:247`. **Reuse it.**
- Template for a vector-free read: `db.documents.getForShare()` — explicit `path, title, summary, content, source_type, created_by, updated_at` — `src/db/documents.js:101`. (It omits `created_at`; the feed needs it — see §3a.)
- `db.documents.get()` is the known `SELECT *` leak — `src/db/documents.js:86`. **Do not reuse.**
- `messages.selectTimeline` is already vector-free (`SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id, metadata`) with a `before` cursor — `src/db/messages.js:596`.

### Cursor / timestamp comparability (the merge-sort key)
- **All four tables store `created_at` as the SAME ISO-8601 string** `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (ms precision): messages `0001_init.sql:950` (writer `src/ingest/capture.js:27` `.toISOString()`), documents `:632`, health_daily `:841` (writer `src/db/health.js:52` `.toISOString()`), tasks `:1297`. **⇒ lexicographic string comparison sorts correctly across tables.** This is the linchpin that makes a unified cursor work.

### Row shapes to render
- The message `<article>` (badge · speaker · channel · time · reply · attachments · clamped markdown) — `TimelineView.svelte:347`. Date grouping `:189`; `loadMore` cursor = last item `created_at` `:109`.
- `/messages` already does the attachment join + **metadata strip** — `src/portal-compat.js:121-152`. (metadata is encrypted triage/delivery state; never serve it raw.)
- health metrics per day after `parseHealthRow` (`src/db/helpers.js:27`): `sleep_duration_min`, `steps`, `hrv_avg`, `resting_hr`, `active_energy_kcal`, `workout_minutes`, `mindful_minutes`, …
- tasks: `title` (encrypted→decrypted), `status`, `priority`, `due_date`, `completed_at` — `src/db/tasks.js:33`.

### Index gaps
- `messages` has `idx_messages_created_at`; `health_daily` has `(user_id, date)`. **`tasks` has NO `created_at` index; `documents` indexes `(scope, updated_at)` not `(user_id, created_at)`.** A `created_at < cursor … ORDER BY created_at DESC` scan on those two needs an index.

---

## 2. Design — `db.streams.feed`

```
feed(userId, { limit=40, before, types, sources, since }):
  # before = ISO cursor (exclusive); types = subset of [message,document,health,task];
  # sources = canonical source keys (spectrum filter); since = ISO floor (time scope)
  for each requested table, run its OWN explicit-column, auto-decrypting reader with
     WHERE user_id=? AND created_at < before AND created_at >= since AND <soft-delete>
     ORDER BY created_at DESC LIMIT limit+1   # +1 = "has more" probe per table
  normalize each row → StreamItem (§2a), TRUNCATE previews server-side
  k-way MERGE-SORT all arms by created_at DESC  (string compare — proven comparable)
  take top `limit`; nextCursor = created_at of the last kept item (null if drained)
  ASSERT hasVectorKey(items) === false   # §7 belt-and-suspenders on the serialized payload
```
Bounded cost: ≤ `4·(limit+1)` decrypted rows per page (≤164 at limit 40). Cursor is a bare timestamp (no ids/content).

### 2a. `StreamItem` (normalized)
```ts
{ type:'message'|'document'|'health'|'task', id, source, createdAt,
  // message → carries the SAME fields the timeline renders today (so the message
  // row renderer is reused verbatim): role, content, agent_id, message_type,
  // attachment?, + safe sender/channel derived server-side (NOT raw metadata)
  // document → title, summary(truncated), path, sourceType
  // health   → date, summary("Sleep 7h · 8,432 steps · HRV 45"), metrics{steps,sleepMin,hrvAvg}
  // task     → title, status, priority, dueDate, completedAt
}
```
Never includes `embedding_768`/`centroid_*`/raw `metadata`.

### 2b. Per-table readers (new, explicit, vector-free)
- **message** — reuse `selectTimeline` + factor the `/messages` attachment-join + metadata-strip into a shared `assembleTimelineMessages(db, rows, userId)` so the river and `/messages` can't drift. `source`/`sources` filter via the canonical registry.
- **document** — new `documents.listForFeed(userId, {before,since,limit})`: `SELECT path, title, summary, source_type, created_by, created_at FROM documents WHERE … forgotten_at IS NULL` (getForShare shape **+ created_at**, **− content** — the row shows the summary; full content is a click-through, Phase 2.1). Excludes internal docs (`is_internal=0`).
- **health** — `health.listForFeed`: explicit metric columns + `date,created_at`; build the summary string server-side.
- **task** — `tasks.listForFeed`: `SELECT id, title, status, priority, due_date, created_at, completed_at … ORDER BY created_at DESC` (excludes deleted by status).

### 2c. Endpoint
`GET /portal/streams?limit&before&types=message,document&sources=telegram,gmail&since=` → `{ items: StreamItem[], nextCursor }`. Owner-authed like the rest of `/portal/*`. `/portal/messages` is kept (other callers) but the river switches to `/portal/streams`.

### 2d. Frontend
- Factor the message `<article>` into **`MessageRow.svelte`** (props: item, agentMap, owner, expand state, markdown cache) — a careful lift-and-shift to avoid regressing the rich rendering (markdown/DOMPurify cache, attachments, speaker, reply).
- New **`DocumentRow` / `HealthRow` / `TaskRow`** — compact, type-distinct (document: title + summary + source badge; health: metric chips; task: title + status pill).
- New **`StreamRiver.svelte`** — fetches `/portal/streams`, date-groups, dispatches by `type`, cursor "load older"; accepts `externalSource` (spectrum filter) + `types`/`since`. Replaces `TimelineView` in the Stream facet. `TimelineView` stays for any legacy `/messages` use until removed.
- Spectrum chip → `sources` filter on the feed (today it filters client-side; Phase 2 pushes it into the query so pagination is correct).

### 2e. Migration
`migrations/00NN_streams_feed_indexes.sql`: `idx_tasks_user_created ON tasks(user_id, created_at DESC)` + `idx_documents_user_created ON documents(user_id, created_at DESC)`. (messages/health already covered.)

---

## 3. Security red-team (cognitive vault — §1, §7, fail-closed)
- **No `SELECT *`; explicit vector-free columns only** — `embedding_768`/`centroid_*` never selected. Final `hasVectorKey(items)` assert on the serialized payload (reuse `lexicon.js`), throw/empty on violation.
- **Raw `metadata` never served** — message items carry only derived safe display fields (sender/channel), mirroring the `/messages` strip.
- **Previews truncated server-side** (~240 chars for document/task; health = a short summary line; message = full content as today, client-clamped). Limits the read-path blast radius.
- **Redaction honored** — `forgotten_at IS NULL` on messages+documents; deleted tasks excluded by status. Forgotten rows never surface.
- **Owner-only** — `/portal/streams` behind the same vault-auth gate; no new public surface. Health stays summarized + owner-bound.
- **Cursor safety** — bare timestamp; no ids/content encoded. `since`/`limit` clamped.
- **DoS bound** — `limit` clamped (≤100); per-table `limit+1` over-fetch is bounded; no unbounded scans (indexes added).

## 4. Verify gate — `verify:streams-feed` (real vault)
Seeds all four tables with interleaved timestamps + a redacted row + a doc carrying `embedding_768`, then asserts:
- union **merge-sorts by created_at DESC** across types; cursor pagination is stable + non-overlapping; `nextCursor` drains to null.
- `types`/`sources`/`since` filters select the right arms/rows.
- forgotten message + deleted task + forgotten doc are **excluded**.
- **§7: `hasVectorKey(response)===false`**, no `embedding_768`/`centroid` substring, no raw `metadata`, no `content` envelope ciphertext in the bytes.
- previews are truncated; health summary string is well-formed; message items keep attachment + speaker fields.
- per-table decrypt correct (plaintext previews, never ciphertext).

Plus: `portal:check` + `vite build`; **browser live-verify** (seeded multi-source vault, the `dev-streams-preview` harness): all four row types render interleaved, date-grouped, paginate, and the spectrum filter narrows the feed.

## 5. Build order (incremental, each gated)
1. `db.streams.feed` + the 3 new readers + `assembleTimelineMessages` refactor + the migration. Gate `verify:streams-feed`.
2. `GET /portal/streams`.
3. `MessageRow` extraction (visual parity check vs current TimelineView) → `DocumentRow`/`HealthRow`/`TaskRow` → `StreamRiver`; swap into StreamsView. Browser verify.
4. Push spectrum `sources` filter into the query (server-side), retire client-side source filtering.

## 6. Out of scope (later)
- Full-text **search** across the river (encrypted content can't `LIKE`; route via `searchMindscape` / blind-index) — Phase 2.1.
- Document **content** click-through expansion; health day detail.
- Realtime SSE live-append (river polls/refreshes for now).
- Multi-select spectrum (single-select today).
