# Agent-driven, temporally-aware, context-rich, UI-controlled mindscape narration — design (2026-06-18)

**Status:** design only (sweep-first). No narration run, no code shipped. Three shippable phases.

## Revision history
- **v1** (committed `a118075`) — three phases: temporal columns + sampler range + prompt (Phase 1);
  gated `describeEntity` tool + `narration-walk` reusing `conversation_summaries` (Phase 2);
  UI start/pause/resume + provider toggle (Phase 3).
- **v2** (this) — operator asked the agent to also **see what areas it's connected to by name,
  how activity has looked over the whole timeline, what span the prior summary was based on, and
  what span it's looking at now.** That turns Phase 1 from "two date columns" into a single
  **Context Capsule** — the one assembly that feeds batch describe, the `describeEntity` tool, and
  the agent walk. Sweep verified the connected-by-name surface and the activity-timeline data
  **already exist** (`src/db/topology.js`, plaintext `clustering_points.created_at`, unused
  `territory_profiles.activity_timeline`), so the capsule is assembly over existing data + ONE new
  covered-period pair of columns. Also added: the **walk-level provenance** (the agent is told,
  every turn, which entities it has already described and through what period) so its retained
  awareness is explicitly temporal, not just a free-text summary.

---

## Goal (from the operator)
Replace the current one-shot, stateless, temporally-blind batch `describe` with a narration
system that:
1. **Is UI-controlled** — start/pause/resume from the portal, per-realm/territory, with progress
   and an explicit provider choice (local vs cloud, because narration sends private content to the
   model).
2. **Assembles tight, rich context** — each narration knows:
   - the **prior description + the time-span it was based on**, and the **time-span of the new
     messages** being folded in ("prior essence covered Jan–Mar; here are Apr–Jun additions");
   - **how activity has looked across the whole timeline** for this entity (not just the sample);
   - **what areas it is connected to, by name** (neighbours + parent realm + what it descended from).
3. **Is agent-driven** — the native agent *traverses* the mindscape, describes as it goes, **takes
   notes and retains a summarized, temporally-explicit awareness** of what it has already traversed,
   so realm-level understanding accumulates from territory passes (not independent one-shots).
4. **Never loses context** — skip/inherit "stayed" clusters; fold-not-replace; coverage-aware.

## Why now / current state
A live re-cluster (2026-06-17) reorganized the mindscape (13→12 realms, 243→372 territories, 29%
point churn); 154 territories inherited names via dominant-successor, 218 are new/unnamed, realms
mostly need naming, `explored_percent` is stale. **Generate stays kill-switched.** The measurement
stages (run-clustering.sh steps 4–16: cofire, neighbors, …) have NOT run since the recovery, so the
behavioural adjacency tables (`territory_cofire`, `territory_neighbors`) are empty/stale. We need a
*controlled, context-preserving* way to (re)narrate — not a blind batch to a cloud provider.

---

## Sweep findings (consolidated, file:line — verified by reading)

### Narration today is stateless, temporally blind, and topology-blind
- Name/essence prompt (`pipeline/describe-clusters.js:91-120`, read): samples (content≤5000) +
  existing name/essence + topTags + entities. **Zero temporal info** (says "WHOLE timeline" but no
  dates), **zero adjacency** (the model never learns what this cluster sits next to).
- Chronicle prompt (`pipeline/describe-chronicles.js:100-129`, read): shows the prior
  `story_birth/arc/current_chapter` to refine, + tags/entities + samples. Same blindness.
- Sampler (`pipeline/lib/narrate-sample.js`, read): `loadMembers` selects `cp.created_at` and orders
  `ORDER BY cp.created_at ASC` (lines 48-62); each sample carries `created_at` (line 124) **but no
  min/max range is exposed**, and the activity distribution is discarded. Coverage ledger
  `territory_seen_points` (user,territory,source PK + `pass_number` + `seen_at`); `exploredPercent`
  (lines 156-159) is real but stale + not in the prompt. 70/30 unseen/seen draw (lines 103-118).
- `territoryDocs.upsertDescription` (`src/db/territory-docs.js:139-183`, read): writes name/essence/
  chronicle + `last_described_at` + `point_count_at_description` + `describe_input_hash`. **Pure
  overwrite** (ON CONFLICT … DO UPDATE) — the fold-in happens only in the prompt; history lives in
  `entity_snapshots` (encrypted, append-only).

### The four requested signals — what exists vs. what's missing
| Signal the agent must see | Source that EXISTS | Gap |
|---|---|---|
| Prior summary's covered span | `last_described_at`, `point_count_at_description` (territory-docs.js:147) | **No `described_period_start/end`** (grep empty across migrations/src/pipeline) — must add |
| New-content span (this pass) | `clustering_points.created_at` of unseen members (plaintext, narrate-sample.js:49) | Not computed/exposed — sampler must return it |
| Activity over the whole timeline | `clustering_points.created_at` GROUP BY month (plaintext, SQL-groupable); `territory_profiles.activity_timeline TEXT` **already exists, unused** (0001_init.sql:1408); `first_active/last_active/days_active` (0001_init.sql:1408) | Never computed, never in the prompt — must compute + persist + render |
| Connected areas, by name | `src/db/topology.js` (read) — `getCoFiring:131`, `walkGraph:268`, `getCluster:243`, `getOrphanGaps:317`, `getBridges:182`, `getDescendants:469`/`getAncestors:483`; name map `loadTerritories:100`; `realms.name` | Behavioural tables (`territory_cofire`/`territory_neighbors`) **empty now** (Generate-only) → need the **always-available** path |

**Always-available "connected by name" (the load-bearing pivot):** `getOrphanGaps`
(`src/db/topology.js:317-369`, read) computes nearest territories by **cosine over plaintext
`territory_profiles.centroid_256`** (`JSON.parse` at :329/:354) — no encrypted column, no
Generate dependency. Plus the **structural** floor from `clustering_points` plaintext keys
(`realm_id`/`theme_id`/`territory_id`): the parent realm name, same-realm siblings, same-theme
peers (`getCluster:243-266` already joins same-theme). Plus **lineage** `territory_lineage`
(`getDescendants/getAncestors:469-496`, joined to `tp.name`) — "this territory descended from
‹old name›", populated by cluster.py on the 2026-06-17 re-cluster. So named adjacency is available
*today* even with empty cofire tables.

### The native agent harness is fully built + merged to main (`src/agent/`, 29 gates GO)
- `runAgentTurn(deps,{userMessage,systemExtra,enabledTools,history,conversationId,recentN,localTools})`
  (`src/agent/run-turn.js:43-46`, read) — shared headless turn; wraps `loop.run` (line 103).
- **Running awareness exists**: auto-compaction persists ONE summary per `conversationId` via
  `db.harness.getSummary/putSummary` (`run-turn.js:83-84`), rehydrated by `hydrateHistoryBlock`
  (`run-turn.js:81`) as a `## Earlier conversation (summarized)` preamble. Encrypted at rest.
- **Tool grant** (`src/agent/autonomy-tools.js:20-31`, read): `SAFE_AUTONOMOUS_TOOLS` (always) =
  getContext, searchMindscape, **mindscape**, listDocuments, getDocument, cognitiveState/History,
  readMindFile, personaClaims, getHealthData. `AUTONOMY_TOOLS` (gated, opt-in) = schedule_task,
  reply, … **No tool writes a territory/realm description.**
- **⚠ Local model → no tools** (`run-turn.js:92-93`: `granted = (isLocal && !localTools) ? [] : …`).
  An agent *walk* needs tools → must run on a tool-capable provider, OR pass `localTools:true`
  (accepting the TTFB hit on a small local model). This constrains the provider choice (Phase 3).

### Portal Generate / jobs (`src/jobs.js`, read/grep; `src/portal-mindscape.js`)
- `startClusteringJob` spawns run-clustering.sh; kill-switch `generateLocked()` (jobs.js:31,72);
  **cancel only, no pause** (jobs.js:234). `startChronicleNarrationJob` (jobs.js:305-363) spawns
  `pipeline/describe-chronicles.js` fire-and-forget, single-flight, bulk.
- Activity feed: `begin/heartbeat/finish/reap` (45s stale); `GET /portal/activity`; UI polls 2.5s.
- **No per-entity narrate endpoint, no "describe this realm" UI.** Provider per task via
  `resolveInferenceConfigForTask(db,userId,'narrate')`.

---

## Design

Three layers, each a shippable phase. Phase 1 (the Context Capsule) is independent and valuable on
its own — it upgrades even today's batch describe; Phases 2–3 deliver the agent + UI vision.

### The Context Capsule (the heart of v2)
One pure assembler, `pipeline/lib/narrate-context.js`, used by **all three** narration paths so
context assembly is single-sourced. Given `(db, userId, kind, id, members, seenIds)` it returns:

```
{
  identity:  { name, essence, priorChronicle?,  describe_input_hash },
  temporal:  {
    coveredRange: { start, end, points } | null,   // what the PRIOR description was based on
    newRange:     { start, end, points },          // UNSEEN members folded in THIS pass
    exploredPercent,                               // coverage after this pass
    lifespan:     { first_active, last_active, days_active }
  },
  activity:  { histogram: [{period:'2026-01', count:8}, …], sparkline:'▁▃▁▂█▆…', grain:'month' },
  neighborhood: {
    parentRealm:  { id, name } | null,
    siblings:     [{ id, name, sharedBy:'realm'|'theme' }],     // structural, always available
    nearest:      [{ id, name, similarity }],                   // centroid_256 cosine, always available
    cofiring:     [{ id, name, strength, scale }] | [],         // behavioural, ONLY if tables populated
    descendedFrom:[{ id, name, transfer_strength }]             // territory_lineage
  },
  samples:   [{ id, content, created_at }]                      // existing timeline-stratified draw
}
```

Assembly cost is cheap and plaintext-only in SQL: the histogram is one
`SELECT strftime('%Y-%m', created_at) AS p, COUNT(DISTINCT source_id) FROM clustering_points
WHERE user_id=? AND <col>=? GROUP BY p` (col ∈ {territory_id, realm_id, theme_id} — the
`ALLOWED_COLS` whitelist from narrate-sample.js); `coveredRange`/`newRange` are min/max over the
already-loaded `members` split by `seenIds` (no extra query); `nearest`/`siblings`/`descendedFrom`
reuse the **existing** `topology.js` methods (centroid cosine, same-realm/theme, lineage). Names
resolve through `territory_profiles.name` / `realms.name` (the `loadTerritories` map). **Never logs
content** (§1); the capsule is built in-process for the chosen provider only.

**Rendered into the prompt** as a compact, deterministic block (before the samples):

```
AREA: "Grief & repair" (territory) — currently: "where loss is metabolized into care".
TIMELINE: active 2023-11 → 2026-06 (· 71 days active). Activity by month: ▁▁▃▂▁▅█▆▃ (peak 2026-04).
PRIOR DESCRIPTION covered 2023-11 → 2026-02 (118 items). NOW FOLDING IN 2026-03 → 2026-06
  (42 new items; 78% of this area now described).
CONNECTED TO: realm "Inner weather" · neighbours by meaning: "Caretaking", "Endings", "The body keeps score"
  · co-activates with: "Sleep" (weekly) [if populated] · descended from: "Loss" (pre-recluster).
Fold the new period into the existing understanding; keep what still holds; note what changed.
```

### Phase 1 — Context Capsule (data + assembler + prompt; provider-agnostic) ~260 LOC + migration + gate
- **Schema (migration `00NN_described_period.sql`):** add `described_period_start TEXT`,
  `described_period_end TEXT` to `territory_profiles` and `realms`. (Plaintext, like the sibling
  describe metadata.) `activity_timeline TEXT` already exists on both — **reuse it** for the
  persisted histogram JSON (no new column).
- **Sampler (`narrate-sample.js`):** `sampleMembers` returns `coveredRange {start,end,points}`
  (members ∈ `seenIds`) and `newRange {start,end,points}` (members ∉ `seenIds`) — min/max over the
  already-loaded list (no query). ~25 LOC.
- **Assembler (`narrate-context.js`, new):** `buildContextCapsule(...)` (above) — histogram query,
  neighborhood via topology.js (cofire if populated else centroid-cosine `nearest` + structural
  `siblings` + `descendedFrom`), `renderCapsule(capsule)` → the prompt block. ~180 LOC.
- **Prompt wiring:** `describe-clusters.js` and `describe-chronicles.js` prepend `renderCapsule(...)`
  before the samples. ~40 LOC across both.
- **Store on write:** after a successful narration set `described_period_start/end` = min/max
  `created_at` of all *seen* members (existing ∪ this pass), and persist `activity_timeline` JSON.
  Co-located with the existing `explored_count/explored_percent` writes (describe-clusters.js:288,
  describe-chronicles.js:215).
- **Gate `verify:narrate-context`:** synthetic entity with two time-bands + two centroid-near peers;
  assert the rendered block carries (a) prior-covered range, (b) new-delta range + %, (c) a month
  histogram/sparkline, (d) ≥1 neighbour BY NAME, and that the columns + `activity_timeline` persist.
  Assert the neighbourhood degrades gracefully (centroid `nearest` present) when `territory_cofire`
  is empty.

### Phase 2 — Agent traversal with temporally-explicit retained awareness (reuse the harness) ~240 LOC
The user's core ask. Reuses `runAgentTurn` + `conversation_summaries`.
- **New gated write tool `describeEntity`** (`src/agent/narration-tools.js`): args
  `{kind:'territory'|'realm', id, name, essence, chronicle?}` → `territoryDocs.upsertDescription`
  (+ a new thin `mindscape.setNameEssence` DAL writer for realms) + stamps `described_period_*` and
  `activity_timeline` from the in-scope capsule. Added to `AUTONOMY_TOOLS` (gated, opt-in) so only
  the walk grants it; validates (name 2–4 words, essence non-empty) and is fail-soft (never wipes a
  good description with junk); never logs content.
- **Traversal adapter `src/agent/narration-walk.js`:** drives `runAgentTurn` over an ordered worklist
  (each realm's territories, then the realm) on **one `conversationId = narration-walk:<runId>`** so
  `conversation_summaries` accumulates the running understanding. Per item the `userMessage` is
  `renderCapsule(capsule)` (Phase 1) + the samples; the agent may read more (`mindscape`,
  `getDocument`, `searchMindscape`) and then calls `describeEntity`.
- **Temporally-explicit awareness (v2 addition):** the per-turn `systemExtra` carries a **walk ledger**
  the adapter maintains in-process and re-states each turn:
  `So far you have described: "Caretaking" (through 2026-05), "Endings" (through 2026-04), … . You
  are now at "Grief & repair"; its new content spans 2026-03 → 2026-06.` This makes the agent's
  retained awareness explicitly *temporal and named* — it knows which areas (by name) and which
  spans its summary already reflects, and exactly which span the current entity adds. The
  free-text `conversation_summaries` block carries the qualitative understanding; the ledger
  carries the precise provenance.
- **Realm synthesis from accumulated awareness:** after a realm's territories, the realm turn
  synthesizes the realm essence **from the running summary + ledger** (territory understanding +
  spans already in the awareness block) — realm-level understanding accrues from territory passes,
  not a fresh re-read.
- **Skip/inherit:** the walk skips entities that are named AND `describe_input_hash`-unchanged AND
  fully covered (`newRange.points === 0`) — reusing the existing gate (describe-clusters.js:181/252)
  + the capsule's coverage. Fold-not-replace via prior essence + temporal delta. "Stayed" clusters
  are not regenerated; only new/changed ones are.
- **Gate `verify:narration-walk`:** a 3-territory/1-realm synthetic walk — each territory described;
  the ledger grows and is present in each turn's prompt; the realm essence is synthesized from the
  summary (assert it references ≥1 territory's theme); a stayed (unchanged+covered) entity is skipped.

### Phase 3 — UI control (portal: start/pause/resume, per-entity, provider) ~260 LOC
- **Job `startNarrationWalkJob`** (`src/jobs.js`): runs the Phase-2 walk; **adds pause/resume** (the
  current jobs have none). Checkpoint in a new `narration_runs` table
  (`run_id, scope, mode, done_ids JSON, status∈{running,paused,done,canceled}, provider,
  cluster_version, started_at, updated_at`); pause = stop after the current entity (never mid-write);
  resume = continue from `done_ids`. Reports per entity via the activity feed
  (`stage_label="naming ‹entity›"`, step/total) — content-free.
- **Routes (`src/portal-mindscape.js`):**
  `POST /portal/mycelium/narrate {scope:'all'|{realm_id}|{territory_id}, mode:'preserve'|'fold', provider?}`
  and `POST /portal/mycelium/narrate/pause|resume|cancel`. Per-entity = the same route scoped to one id.
- **Provider choice (privacy):** the route honors `taskModels['narrate']`; the UI exposes a
  local-vs-cloud toggle and **shows which provider + a "content leaves this machine" flag when
  cloud**. Default = the configured narrate provider; no silent cloud egress. (Note the local→no-tools
  constraint: a local walk must set `localTools:true` or fall back to the deterministic
  capsule-prompt path; the UI explains the trade-off.)
- **Portal panel (`MindscapeView`):** a "Narrate" control — overall + per-realm progress
  (% explored from the capsule), pause/resume, "re-describe this realm/territory" buttons, the
  provider toggle, and a per-entity peek at the capsule (covered-span vs new-span, the activity
  sparkline, the named neighbours) so the user sees the *context* a narration will use before
  running it. Polls `/portal/activity` + `narration_runs`.
- **Gate `verify:narration-job`:** start→pause→resume→done checkpointing via `narration_runs`;
  per-entity scope; provider honored; heartbeats; aborts on `cluster_version` change.

---

## Edge cases — explicit decisions
- **Behavioural adjacency tables empty (now)** → the neighbourhood degrades to centroid-cosine
  `nearest` + structural `siblings` + `descendedFrom` (all plaintext, no Generate dependency); the
  capsule never blocks on a missing cofire table. `cofiring` simply renders empty.
- **Entity has no prior description** (the 218 unnamed) → `coveredRange = null`; the prompt says
  "first description; content spans ‹newRange›" instead of a fold-in instruction.
- **Re-clustered territory with a name but stale period** → `coveredRange` is recomputed from the
  seen ledger (which survives re-cluster); if the ledger is also stale, fall back to
  `first_active..last_described_at`. Documented as best-effort, not exact.
- **Agent writes a bad/empty description** → `describeEntity` validates; on reject the entity stays
  unnarrated (retried next pass) — never wipes a good description.
- **Pause mid-realm** → checkpoint is per-entity (after the write commits); resume re-enters at the
  next undone territory; the realm-synthesis turn re-runs (idempotent — reads the summary+ledger).
- **Re-cluster changed ids mid-walk** → the walk snapshots its worklist + `cluster_version` at start;
  a concurrent re-cluster invalidates it → the job aborts cleanly (checkpoint preserved). Generate
  stays kill-switched during a walk.
- **Awareness summary drift** → per-`conversationId`; each walk uses a fresh `runId` → no stale
  cross-walk bleed; within a walk it accrues. The ledger is in-process (rebuilt from `done_ids` on
  resume), so it can't desync from the checkpoint.
- **Stayed cluster absorbed new content** → not skipped (`newRange.points>0` / hash changed) →
  folded (prior essence + new-period delta), preserving + enriching context.

## Threat model / security
- **Narration = content egress to the chosen model.** Provider choice is explicit (Phase 3),
  defaults to the configured narrate provider, and the UI flags cloud. The walk runs **server-side
  (loopback)**, reading decrypted content in-process — same boundary as today's pipeline; no new
  network surface beyond the already-configured provider.
- **The capsule widens what's assembled, not what's exposed.** Neighbour names + activity counts are
  the user's own vault data, sent only to the user's chosen narration provider, same as the samples.
  Counts/sparklines are aggregates (no content). `described_period_*` + `activity_timeline` are
  plaintext metadata (dates + counts), consistent with the existing plaintext describe metadata
  (`last_described_at`, `explored_percent`); they leak coarse activity timing at rest — accepted, as
  the existing columns already do, and the DB is the [[at-rest-blindness]] candidate for whole-file
  encryption separately.
- **Writes encrypted at rest** — name/essence/chronicle + `conversation_summaries` ∈ ENCRYPTED_FIELDS;
  `describeEntity` never logs content (§1).
- **New tool is gated** (autonomy-tools opt-in) — only the walk grants `describeEntity`; interactive
  chat cannot write descriptions. No new cross-process pattern (existing loopback + DB).

## Test strategy
- `verify:narrate-context` (Phase 1) — capsule carries covered+new ranges, %, month histogram, ≥1
  named neighbour; columns + `activity_timeline` persist; neighbourhood degrades gracefully with
  empty cofire.
- `verify:describe-entity-tool` (Phase 2) — gated tool writes name/essence/chronicle +
  `described_period_*`; validates; fail-soft on junk; absent without opt-in.
- `verify:narration-walk` (Phase 2) — 3-territory/1-realm walk: each described; ledger present+grows
  each turn; realm synthesized from summary; stayed entity skipped.
- `verify:narration-job` (Phase 3) — start→pause→resume→done checkpointing; per-entity scope;
  provider honored; heartbeats; abort on cluster_version change.

## Implementation order
1. **Phase 1** sampler ranges + `narrate-context.js` capsule (histogram + neighborhood + render) +
   migration (`described_period_*`) + prompt wiring + store + `verify:narrate-context`.
   Smoke: re-narrate one territory (CLI, deterministic path) → prompt shows the full capsule, columns
   + activity_timeline set.
2. **Phase 2a** `describeEntity` gated tool + `mindscape.setNameEssence` DAL + `verify:describe-entity-tool`.
3. **Phase 2b** `narration-walk` adapter (runAgentTurn + conversation_summaries + walk ledger) +
   `verify:narration-walk`. Smoke: walk a 2-realm DB copy with a tool-capable provider → descriptions
   written, summary + ledger accumulated, realm essence cites its territories.
4. **Phase 3** `startNarrationWalkJob` (+ pause/resume + `narration_runs`) + routes + portal panel +
   provider toggle + `verify:narration-job`. Smoke: drive a scoped narrate from the UI on a DB copy;
   pause/resume; confirm progress + capsule peek.

Each phase is independently shippable; Phase 1 improves the existing batch describe before the
agent/UI land.

## Decision criteria to adopt agent narration as default
- On a copy: the agent walk narrates the 218 unnamed territories + the realms with the running
  summary measurably accumulating (summary length grows; realm essences cite their territories), the
  ledger correctly tracking covered spans, stayed entities skipped, descriptions temporally anchored
  and topology-aware.
- Cost/latency acceptable for the chosen provider; pause/resume verified; no content in logs.

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Agent writes lower-quality essence than the deterministic prompt | M | M | `describeEntity` validation; keep the deterministic capsule-prompt path as fallback; A/B on a copy first |
| Cloud egress of private content | M | H | explicit provider choice + UI flag; default to configured; per-entity batching keeps it interruptible |
| Long walk thrashes the 16GB box (local model w/ tools) | M | M | per-entity turns; pause/resume; cloud option for speed; or deterministic path on local |
| Behavioural adjacency empty → "connected to" looks thin | M | L | centroid-cosine `nearest` + structural siblings + lineage are always present and named |
| Capsule histogram/neighbor query cost on a 1k-point territory | L | L | one GROUP BY + one centroid scan over ≤few-hundred territories — trivially fast (topology.js note) |
| `conversation_summaries` grows unbounded over a big walk | L | M | auto-compaction caps it; fresh runId per walk; ledger is bounded (names+dates) |
| Re-cluster mid-walk → stale ids | L | H | snapshot worklist + cluster_version; abort on change; Generate kill-switched during walk |

## Open questions resolved during sweep
- *"Can the agent see what it's connected to, by name?"* → yes, today — `topology.js` resolves
  neighbours to names; `getOrphanGaps` uses plaintext `centroid_256` so it works even with the
  cofire tables empty; `territory_lineage` gives "descended from ‹name›".
- *"How activity looked over the timeline?"* → `clustering_points.created_at` is plaintext +
  SQL-groupable; `activity_timeline TEXT` already exists to persist the histogram. No new table.
- *"What span was the prior summary based on / what span now?"* → no covered-period column exists;
  Phase 1 adds `described_period_*` and the sampler computes `coveredRange`/`newRange` from the seen
  ledger split — cheap, no extra query.
- *"Build the agent from scratch?"* → no — the harness (loop/runAgentTurn/conversation_summaries) is
  merged; we add an adapter + a gated tool + the in-process walk ledger.
- *"Local model for the walk?"* → only with `localTools:true` (run-turn.js:92) — small local models
  lose tools by default; the UI surfaces this trade-off.

## Open questions deferred
- Realm-level *chronicles* (full story, not just essence) via the agent — Phase 2 covers territory
  chronicles + realm essence; realm chronicles = a follow-up.
- Re-narrating `time_chronicles` (temporal-period stories) — separate pipeline, out of scope.
- Finer activity grain (week/day) + adaptive grain by lifespan — month is the v1 default; the grain
  field is in the capsule for later.
- Cross-walk learning (an agent that remembers *prior walks*) — deferred; each walk is self-contained.

---

## Verification table
| Assumption | Verified at |
|---|---|
| Name/essence prompt has no temporal + no adjacency info | `pipeline/describe-clusters.js:91-120` (read) |
| Chronicle prompt shows prior story, no dates/adjacency | `pipeline/describe-chronicles.js:100-129` (read) |
| No `described_period_*` columns anywhere | grep `migrations/ src/ pipeline/` → empty (run) |
| `activity_timeline TEXT` exists on territory_profiles (+ sibling table); first/last_active, days_active exist | `migrations/0001_init.sql:1408` (+1075) (read) |
| `clustering_points.created_at` is plaintext, selected + ordered by sampler | `pipeline/lib/narrate-sample.js:48-62` (read) |
| Coverage ledger = territory_seen_points (pass_number, seen_at); exploredPercent real | `pipeline/lib/narrate-sample.js:136-159` (read) |
| upsertDescription is overwrite; writes last_described_at/point_count_at_description, no period | `src/db/territory-docs.js:139-183` (read) |
| Connected-by-name surface exists: cofire/walk/cluster/bridges + name map | `src/db/topology.js:131,243,268,182,100` (read) |
| Always-available named neighbours via plaintext centroid_256 cosine | `src/db/topology.js:317-369` (read, `JSON.parse` :329/:354) |
| Lineage "descended from ‹name›" via territory_lineage joined to tp.name | `src/db/topology.js:469-496` (read) |
| Harness merged: runAgentTurn signature incl. localTools/conversationId | `src/agent/run-turn.js:43-46` (read) |
| Retained awareness = conversation_summaries via harness.get/putSummary + hydrateHistoryBlock | `src/agent/run-turn.js:81-87` (read) |
| Local model → no tools unless localTools:true | `src/agent/run-turn.js:92-93` (read) |
| Agent read tools incl. mindscape; gated set = schedule_task/reply/…; no description writer | `src/agent/autonomy-tools.js:20-31` (read) |
| Jobs: cancel only, no pause; kill-switch; bulk chronicle job | `src/jobs.js:31,72,234,305-363` (read/grep) |
| No per-entity narrate route/UI; provider via resolveInferenceConfigForTask('narrate') | `src/jobs.js:354` env; `resolveInferenceConfigForTask` (read/sweep) |
