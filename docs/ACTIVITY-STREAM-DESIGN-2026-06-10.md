# Activity-stream aggregator — design (2026-06-10, supersedes the 2026-06-06 memo)

Operator: "understand the module that gathers the state of all active inference/computation
processes; when describing realms+territories I want to see how many are queued, how many
done, ETA from the last-5-item speed." Scope chosen: **unified aggregator** (one feed over all
producers), with the chronicle queued/done/ETA as a first-class row.

## Revision history
- **v1 (memory, 2026-06-06):** db.activity over `background_jobs`; `/portal/pipeline/status`
  (chip shape) + `/portal/activity`; instrument clustering/discovery/drainer/connector/gateway;
  reaper. Surface = `PipelineStatusChip.svelte`.
- **v2 (this doc):** PIVOT — `PipelineStatusChip` was **removed** (PR #138; operator: "broken +
  duplicated by the newer active-process indicator"). So the surface is the **newer indicator**
  (`MindscapeActivityChip` + a small header stream dot), NOT the old chip. Plus: the chronicle
  pass now needs **per-item progress + ETA** (done/total + last-5 rolling speed), which v1 didn't
  specify; `background_jobs` already has `step`/`total_steps` for done/total, and ETA is computed
  on read from `(now - started_at)/done × remaining` with a last-5 rolling refinement held by the
  parent in memory.

## Current state (sweep) — there is NO single aggregator today
| Producer | Tracked in | Progress | Exposed |
|---|---|---|---|
| Clustering/Generate | `src/jobs.js` `jobs` Map (parses `Step N/16` stdout) | step/16 | `/portal/mycelium/generate/status/:id` |
| Embedding | `src/embed/supervisor.js` `getEmbedderHealth()` | status | `/portal/mycelium/processing-status` |
| Enrichment | drainer | `pending` count | `/portal/enrichment/status` |
| **Describe/chronicles** | `startChronicleNarrationJob` fire-and-forget | **none** | **nowhere** |
| Claims | `startClaimDiscoveryJob` fire-and-forget | none | nowhere |

`background_jobs` (migrations/0001_init.sql:165) exists, is **plaintext, content-free, unused** —
it is the cross-process store (the DB is the IPC channel; children already `getDb()`). The
in-memory `jobs` Map is lost on restart; the table survives.

## Design

### A. `db.activity` namespace (src/db/activity.js, attached in src/db/index.js)
A thin CRUD over `background_jobs` — content-free (kind/status/step/total/stage only; NEVER any
message text):
- `begin({ kind, id?, totalSteps?, stageLabel?, pid? })` → upserts a `running` row, `started_at=now`.
- `heartbeat(id, { step?, totalSteps?, stageLabel? })` → updates progress + `last_heartbeat=now`.
- `finish(id, { status='done', error? })` → sets terminal status + `finished_at`.
- `active(userId)` → rows where status='running' AND last_heartbeat fresh (< STALE_MS).
- `recent(userId, limit)` → recent finished rows.
- `reap(userId)` → mark rows `abandoned` whose `last_heartbeat` is older than STALE_MS (fail-closed:
  a crashed child never shows "running" forever).

### B. Producer instrumentation
- **Clustering** (`startClusteringJob`): already parses `Step N/16` → also `db.activity.begin/heartbeat/finish`
  (kind `mycelium_generate`). One row, step-level.
- **Describe/chronicles** (the operator's ask): `describe-chronicles.js` + `describe-clusters.js` emit
  a `[progress]` stdout line per item: `[progress] {"done":N,"total":M,"ms":itemMs}`.
  `startChronicleNarrationJob` (a) registers `db.activity.begin({kind:'describe', totalSteps:M})`,
  (b) parses each `[progress]` → `heartbeat(step:done, totalSteps:total)` AND keeps a **last-5 ms ring
  buffer in memory** for ETA, (c) `finish` on close. The status getter computes
  `etaSeconds = round(avg(last5) × (total-done) / 1000)`.
- **Enrichment / embedding**: surfaced by reading their existing status (drainer pending, embedder
  health) and projecting into the same activity shape at read-time (no new writes needed; they are
  long-lived, not discrete jobs).

### C. Endpoints (src/portal-activity.js)
- `GET /portal/activity` → `{ active:[{kind,stageLabel,step,total,etaSeconds,startedAt,pid}], recent:[…] }`
  — the rich feed (active + recent), reaped first.
- `GET /portal/pipeline/status` → the compact summary `{ state, summary, currentStage,
  progress:{completed,total}, etaSeconds, lastActivity }` for the header dot.

### D. Surface (frontend)
- **Header stream dot** (`shell/Header.svelte`): a tiny pulsing dot + count when `active.length>0`,
  click → a popover listing active processes (kind · N/M · ETA). Replaces the removed PipelineStatusChip.
- **MindscapeActivityChip**: when a `describe` activity is active, show `Describing areas · 5/11 ·
  ~28s left` (done/total + ETA), driven by `/portal/activity` (the chip already polls; add the describe row).
- A small `$lib/stores/activity.ts` store polling `/portal/activity` every ~2.5s while anything is active.

### E. Reaper (fail-closed)
A 30s interval in server-rest calls `db.activity.reap(userId)` so a killed child's row flips to
`abandoned` (never a zombie "running"). STALE_MS = 45s (> the 30s embed/heartbeat cadence).

## Module shape (LOC ≈ 480, staged)
1. `src/db/activity.js` (~90) + attach in `src/db/index.js` (+2). [Step 1]
2. `describe-chronicles.js` + `describe-clusters.js` emit `[progress]` lines (~+8 each). [Step 2]
3. `startChronicleNarrationJob`/`startClusteringJob` parse progress + write activity rows + ETA ring
   buffer (~+70 in jobs.js). [Step 3]
4. `src/portal-activity.js` (~90) + mount in server-rest (+2). [Step 4]
5. `$lib/stores/activity.ts` (~45) + MindscapeActivityChip describe row (~+25) + header dot (~+40). [Step 5]
6. Reaper wire-up in server-rest (~+6). [Step 6]
7. Tests: `scripts/verify-activity.mjs` (begin/heartbeat/finish/active/reap/ETA) + chip smoke. [Step 7]

## Threat model / security
- `background_jobs` is plaintext by design — rows carry **kind/status/step/stage only**, NEVER
  message content, names, or model output (§1 zero-plaintext-leakage: the stage label is a constant
  like "Describing areas", not the realm name). Reaper is fail-closed. No new egress. The endpoints
  are loopback/authed like the rest of `/portal`.

## Edge cases — explicit decisions
- **Restart mid-job** → the in-memory ring buffer is lost (ETA falls back to elapsed/done linear);
  the table row's `last_heartbeat` is stale → reaper marks it `abandoned`; the UI clears. Correct.
- **Two describe passes** (clusters inline + chronicles async) → two rows, kinds `describe:name` +
  `describe:chronicle`; the chip shows whichever is active.
- **No content leak** in stage labels — assert in verify (no realm/territory name ever in a row).
- **ETA before 1 item done** → null (UI shows "starting…"), not Infinity.

## Test strategy
- `scripts/verify-activity.mjs`: begin→heartbeat(step)→finish round-trips; `active` excludes stale;
  `reap` flips stale→abandoned; ETA math (last-5 avg × remaining); **leak assertion** (no content
  columns / no free-text beyond the constant stage label).
- describe smoke: run describe-chronicles with a stub that sleeps → `/portal/activity` shows
  done/total climbing + a finite etaSeconds.
- Add `verify:activity` to the suite; `portal:check` 0 for the frontend.

## Implementation order (each independently shippable, smoke per step)
Step 1 db.activity + verify:activity green → Step 2/3 instrument describe (the operator's ask) +
live smoke (Illuminate shows 5/11 · ETA) → Step 4 endpoints → Step 5 frontend dot + chip → Step 6
reaper → Step 7 instrument clustering/enrichment into the same feed.

## Verification table
| Assumption | Verified at |
|---|---|
| `background_jobs` exists, plaintext, content-free, unused | `migrations/0001_init.sql:165-179`; grep: only ref is the schema |
| db namespaces attach in getDb | `src/db/index.js:52-67` |
| clustering tracks step via stdout parse; getJob is the public view | `src/jobs.js:122-132,190-194` |
| chronicle/claims are fire-and-forget (stdout ignored) — no progress | `src/jobs.js:285-314` (`stdio:['ignore','ignore','pipe']`) |
| PipelineStatusChip removed (surface must change) | PR #138 (deleted `shell/PipelineStatusChip.svelte`) |
| existing status endpoints to fold in | `portal-mindscape.js:265,322`; `portal-compat.js:715` |
| describe emits per-item now (after this change) | `pipeline/describe-chronicles.js` loop (Step 2) |

## Out of scope (deferred)
SSE live push (poll is fine at V1 scale); telegram/discord activity fan-out; per-inference rows
(the audit_log already has the per-call content-hash trail — activity stays task-level).
