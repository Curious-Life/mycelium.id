# Agent-driven, temporally-aware, UI-controlled mindscape narration — design (2026-06-18)

**Status:** design only (sweep-first). No narration run, no code shipped. Three shippable phases.

## Goal (from the operator)
Replace the current one-shot, stateless, temporally-blind batch `describe` with a narration
system that:
1. **Is UI-controlled** — start/pause/resume from the portal, per-realm/territory, with progress
   and an explicit provider choice (local vs cloud, because narration sends private content to
   the model).
2. **Assembles tight, temporal context** — each narration knows the **prior description + the
   time-span it covered** and the **time-span of the new messages** being folded in
   ("prior essence covered Jan–Mar; here are Apr–Jun additions").
3. **Is agent-driven** — the native agent *traverses* the mindscape, describes as it goes,
   **takes notes and retains a summarized awareness** of what it has already traversed, so
   realm-level understanding accumulates from territory passes (not independent one-shots).
4. **Never loses context** — skip/inherit "stayed" clusters; fold-not-replace; coverage-aware.

## Why now / current state
A live re-cluster (2026-06-17) reorganized the mindscape (13→12 realms, 243→372 territories,
29% point churn); 154 territories inherited names via dominant-successor, 218 are new/unnamed,
realms mostly need naming, `explored_percent` is stale. Generate stays kill-switched. We need a
*controlled, context-preserving* way to (re)narrate — not a blind batch to a cloud provider.

---

## Sweep findings (consolidated, file:line — verified by reading)

**Narration today is stateless + temporally blind.**
- Prompt (`pipeline/describe-clusters.js:91-120`): samples (content≤5000) + existing name/essence
  + topTags + entities. **Zero temporal info** (says "WHOLE timeline" but no dates).
- Chronicle narration (`pipeline/describe-chronicles.js`): per-territory *story* via
  `db.territoryDocs.upsertDescription` (drift-gated on `description_version`/point drift);
  per-territory incremental sampling `sampleTerritoryContent` + `territory_seen_points`. Does
  NOT write `time_chronicles` (that table is import/temporal only).
- Narrator (`pipeline/lib/narrate-infer.js:34-82`): `createNarrator().infer(prompt,{maxTokens})`
  — **one-shot, stateless**; local Ollama `/api/chat` or cloud `router.infer({task:'narrate'})`,
  bound by `resolveInferenceConfigForTask(db,userId,'narrate')` (per-task provider).
- Sampler (`pipeline/lib/narrate-sample.js`): members `ORDER BY created_at ASC`, each carries
  `created_at`, but **no min/max range is exposed**. Coverage ledger `territory_seen_points`
  (user,territory,source PK + `pass_number` + `seen_at`).

**No stored "period a description covered."** `territory_profiles`/`realms` have
`last_described_at`, `first_active`, `last_active`, `describe_input_hash`,
`point_count_at_description`, `explored_count`/`explored_percent` — but **no
`described_period_start/end`** (migrations/0001_init.sql:1376-1410, 1457-1475 verified).

**The native agent harness is fully built + merged to main** (`src/agent/`, 29 gates GO):
- `runAgentTurn(deps,{userMessage,systemExtra,enabledTools,history,conversationId,recentN})`
  (`src/agent/run-turn.js:43-45`) — the shared headless turn; wraps `loop.run` (`src/agent/loop.js:62`).
- **Running awareness exists**: auto-compaction persists ONE summary per `conversation_id` in
  `conversation_summaries` (`src/db/harness.js:188-208`), iteratively UPDATED, rehydrated as a
  `## Earlier conversation (summarized)` preamble (`src/agent/history.js:26`). Encrypted at rest.
- Agent read tools (`src/agent/autonomy-tools.js:20`): `getContext, searchMindscape, mindscape,
  listDocuments, getDocument, readMindFile, cognitiveState/History, personaClaims`. Gated:
  `schedule_task, reply, …`. **No tool writes a territory/realm description** (only `saveDocument`
  writes *documents*; `territoryDocs.upsertDescription` is pipeline-only).
- State: `harness_runs` (per-turn), `messages` (conversation-threaded), `conversation_summaries`,
  `scheduled_tasks`.

**Portal Generate/jobs (`src/jobs.js`, `src/portal-activity.js`, `portal-mindscape.js`):**
- `startClusteringJob` spawns run-clustering.sh; kill-switch `generateLocked()`; **cancel only,
  no pause** (jobs.js:234). `startChronicleNarrationJob` (jobs.js:330) spawns describe-chronicles
  fire-and-forget, single-flight, bulk.
- Activity feed: `begin/heartbeat/finish/reap` (45s stale), `GET /portal/activity` (active/recent
  + ETA). UI polls every 2.5s (no SSE). Trigger: `POST /portal/mycelium/generate`.
- **No per-entity narrate endpoint, no "describe this realm" UI.** Provider per task via
  `resolveInferenceConfigForTask('narrate')` + Settings "Model per task".

---

## Design

Three layers, each a shippable phase. Layer 1 is independent and valuable on its own; Layers 2–3
deliver the agent + UI vision.

### Phase 1 — Temporal context assembly (data + prompt; provider-agnostic)
Makes *any* narration (batch or agent) temporally aware. ~90 LOC + migration + gate.
- **Schema (migration):** add `described_period_start TEXT`, `described_period_end TEXT` to
  `territory_profiles` and `realms`. (Plaintext, like the other describe metadata.)
- **Sampler:** `narrate-sample.js` returns `coveredRange {min,max}` (all members) and
  `newRange {min,max,count}` (UNSEEN members — those not in `territory_seen_points`). Cheap:
  min/max over the already-loaded members; no extra query.
- **Prompt:** `describe()` + the chronicle prompt prepend:
  `Prior description covered {described_period_start}–{described_period_end}.`
  `New content is from {newRange.min}–{newRange.max} ({newRange.count} items, {explored_percent}% covered overall).`
  `Fold the new period into the existing understanding; keep what still holds.`
- **Store on write:** after a successful narration, set `described_period_start/end` =
  min/max `created_at` of all *seen* members (existing seen ∪ this pass). `last_described_at`
  already set.
- **Gate:** `verify:narrate-temporal` — synthetic territory with two time-bands; assert the
  prompt carries the prior-covered + new-delta ranges and the columns persist.

### Phase 2 — Agent traversal with retained awareness (reuse the harness)
The user's core ask. ~220 LOC. Reuses `runAgentTurn` + `conversation_summaries`.
- **New gated write tool** `describeEntity` (`src/agent/narration-tools.js`): args
  `{kind:'territory'|'realm', id, name, essence, chronicle?}` → `territoryDocs.upsertDescription`
  + `mindscape.setNameEssence` (new thin DAL writer) + stamps `described_period_*` (Phase 1).
  Gated like `reply` (only the walk grants it); writes are encrypted at rest; never logs content.
- **Traversal adapter** `src/agent/narration-walk.js`: drives `runAgentTurn` over an ordered
  worklist (realms, then each realm's territories), all on **one `conversationId`
  `narration-walk:<runId>`** so `conversation_summaries` accumulates the running understanding.
  Per item the turn gets: the entity's Phase-1 temporal context + a sample (via the existing
  sampler) in `userMessage`; the agent reads more if it wants (`mindscape`/`getDocument`),
  writes via `describeEntity`, and moves on. After a realm's territories, the realm turn
  synthesizes the realm essence **from the running summary** (territory understanding already in
  the awareness block) — realm understanding accrues from territory passes.
- **Notes:** the auto-compaction summary IS the retained awareness (robust, automatic). The
  agent MAY also append explicit notes to a `mindscape-walk/<runId>.md` doc via `saveDocument`
  (a visible scratchpad), but the summary is the load-bearing mechanism.
- **Skip/inherit:** the walk skips entities that are named AND `describe_input_hash`-unchanged
  AND fully covered (`explored_percent`≈100 / no unseen) — reusing the existing gate
  (describe-clusters.js:181/252) + Phase 1 coverage. Fold-not-replace via the prior essence +
  temporal delta. So "stayed" clusters are not regenerated; only new/changed ones are.

### Phase 3 — UI control (portal: start/pause/resume, per-entity, provider)
~260 LOC. Makes it operable + safe.
- **Job** `startNarrationWalkJob` (`src/jobs.js`): runs the Phase-2 walk; **adds pause/resume**
  (the current jobs have none). Checkpoint progress in a new `narration_runs` table
  (`run_id, scope, mode, done_ids, status∈{running,paused,done,canceled}, provider, …`); pause =
  stop after the current entity (no kill mid-write); resume = continue from `done_ids`.
  Reports via the activity feed per entity (`stage_label = "naming <entity>"`, step/total).
- **Routes** (`src/portal-mindscape.js`):
  `POST /portal/mycelium/narrate {scope:'all'|{realm_id}|{territory_id}, mode:'preserve'|'fold', provider?}`,
  `POST /portal/mycelium/narrate/pause|resume|cancel`. Per-entity is the same route scoped to one id.
- **Provider choice (privacy):** the route honors `taskModels['narrate']`; the UI exposes a
  local-vs-cloud toggle and **shows which provider + "content leaves the machine" when cloud**.
  Default = the configured narrate provider; no silent cloud egress.
- **Portal panel** (`MindscapeView`): a "Narrate" control — overall + per-realm progress
  (% explored from Phase 1), pause/resume, "re-describe this realm/territory" buttons, the
  provider toggle. Polls `/portal/activity` (existing) + `narration_runs` for checkpoint state.

---

## Edge cases — explicit decisions
- **Agent writes a bad/empty description** → `describeEntity` validates (name 2-4 words, essence
  non-empty); on reject the entity stays unnarrated (fail-soft, retried next pass) — never wipes
  an existing description with junk.
- **Pause mid-realm** → checkpoint is per-entity; resume re-enters at the next undone territory;
  the realm-synthesis turn re-runs (idempotent — reads the running summary).
- **Provider = cloud** → explicit opt-in in the route + UI; the walk batches per entity (not the
  whole vault in one prompt) so a cloud run is interruptible + rate-limit friendly.
- **Re-cluster changed ids mid-walk** → the walk snapshots its worklist at start; a concurrent
  re-cluster invalidates it → the job aborts cleanly (checkpoint preserved) rather than narrate
  stale ids. (Generate stays kill-switched during a walk.)
- **Awareness summary drift** → `conversation_summaries` is per-`conversationId`; each walk uses a
  fresh `runId` so a new walk starts clean (no stale cross-walk bleed); within a walk it accrues.
- **Stayed cluster absorbed new content** → not skipped (coverage<100 / hash changed) → folded
  (prior essence + new-period delta), preserving + enriching context.

## Threat model / security
- **Narration = content egress to the chosen model.** The provider choice is explicit (Phase 3),
  defaults to the user's configured narrate provider, and the UI flags cloud. The agent walk runs
  **server-side (loopback)**, reading decrypted content in-process — same boundary as today's
  pipeline; no new network surface beyond the already-configured provider.
- **Writes encrypted at rest** — `territoryDocs.upsertDescription` + `conversation_summaries` are
  in `ENCRYPTED_FIELDS`; `describeEntity` never logs content (§1).
- **New tool is gated** (autonomy-tools opt-in) — only the narration walk grants `describeEntity`;
  interactive chat cannot write descriptions.
- No new cross-process pattern — uses the existing loopback + DB; no fourth pattern.

## Test strategy
- `verify:narrate-temporal` (Phase 1) — prompt carries covered + new-delta ranges; columns persist.
- `verify:describe-entity-tool` (Phase 2) — the gated tool writes name/essence/chronicle +
  `described_period_*`, validates input, fail-soft on junk, is gated (absent without opt-in).
- `verify:narration-walk` (Phase 2) — a 3-territory/1-realm synthetic walk: each territory
  described, the realm synthesizes from the running summary (assert the summary grew + the realm
  essence references territory themes), stayed entities skipped.
- `verify:narration-job` (Phase 3) — start→pause→resume→done checkpointing via `narration_runs`;
  per-entity scope; provider honored; activity-feed heartbeats.

## Implementation order
1. **Phase 1** temporal columns + sampler range + prompt + store + `verify:narrate-temporal`.
   Smoke: re-narrate one territory (CLI) → prompt shows ranges, columns set.
2. **Phase 2a** `describeEntity` gated tool + `mindscape.setNameEssence` DAL + gate.
3. **Phase 2b** `narration-walk` adapter (reuses runAgentTurn + conversation_summaries) + gate.
   Smoke: walk a 2-realm copy with a local model → descriptions written, summary accumulated.
4. **Phase 3** `startNarrationWalkJob` (+ pause/resume + `narration_runs`) + routes + portal panel
   + provider toggle + `verify:narration-job`.
   Smoke: drive a scoped narrate from the UI on a DB copy; pause/resume; confirm progress.

Each phase is independently shippable; Phase 1 improves the existing batch describe even before
the agent/UI land.

## Decision criteria to adopt agent narration as default
- On a copy: agent walk narrates the 218 unnamed territories + 19 realms with the running summary
  measurably accumulating (summary length grows; realm essences cite their territories), stayed
  entities skipped, descriptions temporally anchored.
- Cost/latency acceptable for the chosen provider; pause/resume verified; no content in logs.

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Agent writes low-quality vs deterministic prompt | M | M | `describeEntity` validation; keep the deterministic describe as fallback; A/B on a copy first |
| Cloud egress of private content | M | H | explicit provider choice + UI flag; default to configured; per-entity batching keeps it interruptible |
| Long walk thrashes the 16GB box (local model) | M | M | per-entity turns (not whole-vault); pause/resume; cloud option for speed; run when box quiet |
| conversation_summaries grows unbounded over a big walk | L | M | auto-compaction caps it (summaryCap); fresh runId per walk |
| Re-cluster mid-walk → stale ids | L | H | snapshot worklist; abort on cluster_version change; Generate kill-switched during walk |
| Pause leaves a half-written entity | L | L | checkpoint is per-entity, after the write commits |

## Open questions resolved during sweep
- *"Do we have % explored?"* → yes (`explored_percent`/`territory_seen_points`), but it's stale
  post-recluster and not surfaced in the prompt — Phase 1 fixes both.
- *"Did import mark what was described?"* → yes (`last_described_at`, 917 territories) — but no
  *period-covered* record; Phase 1 adds it.
- *"Build the agent from scratch?"* → no — the harness (loop/runAgentTurn/conversation_summaries)
  is merged + provides the traversal + retained-awareness primitives; we add an adapter + a tool.
- *"Write via saveDocument?"* → no — that's for documents; territory/realm descriptions go through
  `territoryDocs.upsertDescription` + a new `mindscape.setNameEssence` (need a gated tool wrapper).

## Open questions deferred
- Whether realm-level *chronicles* (story, not just essence) get the same agent treatment (Phase 2
  covers territory chronicles + realm essence; realm chronicles = a follow-up).
- Re-narrating `time_chronicles` (temporal period stories) — out of scope; this is the
  territory/realm narration. The temporal-period chronicle pipeline is separate.
- Cross-walk learning (an agent that remembers *prior walks*' insights) — deferred; each walk is
  self-contained for now.

---

## Verification table
| Assumption | Verified at |
|---|---|
| Narration prompt has no temporal info | `pipeline/describe-clusters.js:91-120` (read) |
| No `described_period_*` columns; only last_described_at etc. | `migrations/0001_init.sql:1376-1410,1457-1475` (read) |
| Sampler orders by created_at, exposes per-sample but no range | `pipeline/lib/narrate-sample.js` member SQL + sampleMembers (read) |
| Coverage ledger = territory_seen_points (pass_number, seen_at) | `pipeline/lib/narrate-sample.js` getSeenIds/recordSeen (read) |
| describe-chronicles writes per-territory via territoryDocs.upsertDescription (not time_chronicles) | `pipeline/describe-chronicles.js:8-11,84-87` (read) |
| Narrator is one-shot/stateless, provider via resolveInferenceConfigForTask('narrate') | `pipeline/lib/narrate-infer.js:34-82` (read) |
| Harness merged: runAgentTurn signature | `src/agent/run-turn.js:43-45` (read) |
| Retained awareness = conversation_summaries, iteratively updated + rehydrated | `src/db/harness.js:188-208`, `src/agent/history.js:26` (read) |
| Agent read tools incl. mindscape/searchMindscape; no description-write tool | `src/agent/autonomy-tools.js:20-31` (read) + tools grep |
| Jobs: cancel only, no pause; kill-switch; bulk narration job | `src/jobs.js:31,234,330` (read/sweep) |
| No per-entity narrate route/UI; provider per task in Settings | `src/portal-mindscape.js:282`; `resolveInferenceConfigForTask` (read/sweep) |
| min/max created_at per territory is cheap (clustering_points.created_at) | `pipeline/lib/narrate-sample.js` member SQL (read) |
