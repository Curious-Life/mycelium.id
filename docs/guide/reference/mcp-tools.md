# MCP tool reference

Every tool Mycelium exposes, grouped by domain. Tools are addressable over all three
transports — [stdio MCP](connect.md#claude-desktop-stdio), [HTTP
MCP](connect.md#any-http-mcp-client-4711), and [REST](rest-and-ingest.md) — with
identical behavior.

> **Source of truth.** Tool names and counts are verified by `npm run verify:mcp`
> against the running server. This page documents the tool *surface*; if a count
> differs from what your client lists, trust the live `tools/list`. `*` marks a
> required parameter.

## Conventions

- **Entities and refs.** Curation tools address things by a `{type, id}` ref where
  `type` is `message | document | fact | entity`.
- **Tiers.** Most tools work on a fresh vault. The three **cognition/topology** tools
  are *Tier-2*: they return an explicit "not ready — import + cluster first" message
  until your mindscape is computed (not a silent empty, not an error), and flip to real
  data mid-session the moment clustering lands.
- **Returns.** Each tool returns text (wrapped in the MCP `{content:[{type:'text'}]}`
  envelope). Errors are redacted — they never leak vault plaintext.

---

## Orientation

### `getContext`
One-call working-context briefing — **call this first.** Returns time, the agent's
private internal model, flagged items, known facts, people & projects (pinned-first,
sensitive excluded), recent messages, current cognitive phase, body state, and persona
claims.
`recentMessages` (1–40, default 10) · `include[]` = `mind|facts|people|messages|phase|health|claims`

→ Full page: **[`getContext`](getcontext.md)**

---

## Capture & messages

### `captureMessage`
Save one message into the vault's searchable stream. Idempotent on `id` (re-sending is
a no-op).
`content*` · `role` (user|assistant) · `source` · `conversationId` · `id` · `metadata` · `createdAt` · `attachmentId`

### `importMessages`
Bulk-import many messages (history backfill). Idempotent per id; returns created vs
skipped counts.
`messages[]*`

### `getDailyMessages`
Page through one day's messages chronologically (30 per page).
`date` (YYYY-MM-DD, default today) · `page` · `channel` · `agent`

---

## Tasks

### `createTask`
Create a task captured from conversation.
`content*` · `deadline` (ISO) · `priority` (1–5, default 3) · `projectPath`

### `listTasks`
List tasks newest-first; filter by status.
`status` (pending|completed|all) · `limit` (1–200, default 50)

---

## Curation — the four lean verbs

`remember` / `forget` / `mark` / `link` are the durable-memory verbs, all addressed by
a `{type, id}` ref.

### `remember`
Write a durable memory.
- `kind: 'fact'` → `category` / `key` → `value` (with optional `confidence`).
- `kind: 'entity'` → a person / project / place / org (`entityType` + `name` + `summary`).
Re-remembering the same fact or entity **updates it in place**.
`kind` (fact|entity) · fact: `category`/`key`/`value`/`confidence` · entity: `entityType`/`name`/`summary`/`aliases` · `sensitive` · `pinned`

### `link`
Link an entity to a message / document / fact (find-or-creates the entity by name +
type). Builds up an entity's dossier over time.
`entity*` (name) · `entityType` · `type*` (message|document|fact) · `id*`

### `forget`
Soft-redact a message / document / fact / entity: destroy the content **and** any
embedding fingerprints, evict from search and clustering, drop links, tombstone for
audit. **No undo.**
`type*` (message|document|fact|entity) · `id*`

### `mark`
Set salience.
- `pinned` → surfaced first in `getContext` (shown with 📌).
- `sensitive` → kept out of proactive recall, never published.
`type*` · `id*` · `pinned` · `sensitive`

---

## Documents & library

Documents live at **stable paths** — the path *is* the identity, so saving to the same
path revises the document rather than duplicating it.

### `saveDocument`
Create or revise a doc at a path.
`path*` · `content*` · `title` · `summary` · `folder` · `canvas`

### `updateDocument`
Append a timestamped entry to a living doc.
`path*` · `entry*` · `entryType*` (observation|shift|note|wondering) · `confidence*` (low|medium|provisional)

### `getDocument`
Retrieve full doc content by path.
`path*`

### `listDocuments`
List docs with paths + summaries.
`category`

### `publishDocument`
Make a doc publicly readable at `/p/<slug>` on your portal subdomain (needs the
[public server](rest-and-ingest.md#publishing-8788)). Idempotent.
`path*` · `slug`

### `getDocumentShareStatus`
Publish/share state: visibility, public URL, visit & reader counts, active share links.
`path*`

*(A `findDocuments` tool — topical search of the library before writing — is present in
the codebase and registered when a search client is available.)*

---

## Search & recall

### `searchMindscape`
One-call search across conversations, documents, territories, realms, and themes —
grouped results. Semantic ranking when the embedder is up, **BM25 fallback** otherwise.
Two recall modes:
- `query` — a crafted search string.
- `relatedTo` — paste the user's current message for **proactive recall** (excludes
  sensitive items).

`scope` narrows the layer: `scope:'facts'` lists facts; `scope:'entities'` lists
people/projects.
`query` · `relatedTo` · `scope` (all|messages|facts|entities|documents|territories|realms|themes) · `limit` · `includeTopology` · `agent`

---

## The agent's private model & mind-files

A private scratchpad the agent maintains *about* the user — **never shown to the
user**. Stored as encrypted `mind/` files.

### `updateInternalModel`
Append to a section of the private model. (The handler adds the date — don't prefix
it.)
`section*` (observations|hypotheses|questions|contradictions|patterns|uncertainty|notes|dream_fragments) · `content*`

### `flagForDiscussion`
Flag a topic to raise next conversation.
`topic*` · `context*`

### `readMindFile`
Read the decrypted content of a `mind/` file.
`filename*`

### `editMindFile`
Surgical exact-string edit of a `mind/` file (`old_string` must appear exactly once).
`filename*` · `old_string*` · `new_string*`

### `writeMindFileWhole`
Atomically rewrite a `mind/` file (auto-snapshots the prior state first).
`filename*` · `content*`

### `snapshotMindFile`
Atomic dated snapshot of a `mind/` file (first-write-wins, once per day).
`filename*`

---

## Persona claims

### `personaClaims`
Evidence-grounded, durable claims about the user (values, identity, boundaries) with
confidence.
- `mode: 'list'` → current active claims.
- `mode: 'series'` → confidence trajectory over time for one claim.
`mode` (list|series) · `claimId` (required for series) · `granularity` (day|week|month|quarter) · `limit`

---

## Body state

### `getHealthData`
Apple Health summaries — sleep, HRV, resting HR, steps, workouts, mindful minutes —
with trends and anomalies. Honest-empty until Apple Health is synced.
`days` (1–90, default 7) · `from` (YYYY-MM-DD) · `to` (YYYY-MM-DD)

---

## Cognition & topology *(Tier-2 — needs a computed mindscape)*

Three consolidated readers cover the full topology surface. They return an explicit
"import + cluster first" message until clustering has run.

### `cognitiveState`
The "now" in one call: **movement** (phase, velocity, exploration ratio), **rhythm**
(energy per timescale, flow, spread), and active **alerts** (phase shifts, cycling).
`level` (realm|theme|territory|all) · `granularity` (alpha|theta|delta) · `detail` (flow|shape)

### `cognitiveHistory`
Cognition over time: trajectory (phase / velocity / displacement per window) + the
territories that drove recent movement; optional named-metric series.
`level` · `period` (month|quarter|half_year|year|all) · `windowType` · `metric` · `granularity` · `from` · `to` · `limit` · `windowEnd`

### `mindscape`
The topology graph **by view**:
- `structure` — vitality / health / orphans / bridges
- `territories` — filterable list
- `territory` — deep view of one territory
- `explore` — co-firing + gaps
- `time` — activity timeline

`view*` · `territory` · `scale` (immediate|session|daily|weekly) · `range` (7d|30d|90d|all) · `phase` · `realm` · `minMessages` · `sortBy` (vitality|messages|name) · `limit` · `depth`

---

## Federation

Cross-instance connections by federated handle (e.g. `@alice@alice.mycelium.id`), built
on `did:web` identity. See [Shared Spaces](../handbook/shared-spaces.md) for the vision.

### `requestConnection`
Request a connection to another Mycelium instance by handle.
`handle*` (e.g. `@user@domain`)

### `listConnectionRequests`
List pending inbound connection requests awaiting your response.
*(no params)*

### `respondToConnectionRequest`
Accept, reject, or block a pending request.
`id*` · `action*` (accept|reject|block)

---

## Scheduling *(autonomous turns only)*

Available to autonomous/scheduled runs, not interactive chat turns.

### `schedule_task`
Schedule an autonomous task to run later on a cadence.
`prompt*` · `schedule*` (`daily:HH` | `weekly:DOW:HH` | `monthly:DOM:HH` | `every:Nh` | `interval:Nm` | `once` | `cron:<5 fields>`) · `name` · `tz` · `scheduled_at` (for `once`) · `output_target` · `enabled_tools`

### `list_my_schedules`
List scheduled tasks (name, cadence, next run, status). Prompts are never revealed.
`status`

### `cancel_task`
Cancel a scheduled task by id.
`id*`

---

## Not part of the standard surface

Some files in `src/tools/` are ported/reference code **not registered** in V1, or are
gated to specific contexts:

- **`reply`** — channel egress (Telegram/Discord/WhatsApp). Wired only inside a chat
  turn (when an `AGENT_URL` is set); soft-fails otherwise. All agent → channel sends go
  through this one chokepoint by design.
- **Internal-only** — `fisher-tools.js`, `metrics.js`, `topology-tools.js`: their
  handlers are reused *inside* `cognitiveState` / `cognitiveHistory` / `mindscape`, but
  their individual tool names aren't registered.
- **Dormant** — `schedules.js`, `delegation.js`, `services.js` ship in later waves.

---

→ Make every turn flow into memory: **[Memory bridge](memory-bridge.md)** ·
Route inference too: **[Model gateway](gateway-and-embeddings.md)**.
