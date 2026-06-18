# Measurement & Narration Hardening — Design

**Date:** 2026-06-18
**Status:** BUILT (steps 1–6) on branch `feat/measurement-health`. Gap #3 (fail-loud accounting) + measurement-health (pipeline_state populated + `/measurement-health` + Mindscape card) + Gap #4 (stalled surfaced, false-reap fixed). Realm-chronicles + reorder closed as non-issues. New/extended gates GO; 13/13 touched gates GO. Remaining: full `npm run verify` + live portal-ui smoke of the card at PR time.

**As-built deltas from the design:** (a) the Python helper lives at `pipeline/stage_result.py` (flat, beside `stage_base.py`), not `pipeline/lib/` (Python convention); (b) Python adoption used a `run_main()` __main__ wrapper (no body reindent) applied to ALL 9 stages incl. harmonics/fisher (so the `cognitive-harmonics` freshness probe resolves) + `cluster` (fixes era rung 1) — `SystemExit` is treated as intentional control-flow to avoid false-quarantining benign insufficient-data exits; (c) the health surface extends the existing `/metric-freshness` (shared `computeFreshness()`) into a sibling `/measurement-health` rather than a standalone endpoint; (d) the card lives in MindscapeView next to MeasureControl.

**Status (design):** LOCKED (sweep-first, three cycles + self-verified reads)
**Scope:** Close the open issues identified in the measurement/narration deep-dive: the silent partial-data failure mode (Gap #3), the un-surfaced/false-reaped "stalled" job state (Gap #4); add a **measurement-health / trackability layer** (failures visible, per-family health knowable) by *populating the pipeline_state ledger that already exists and is already wired into era-resolution + freshness*; and formally resolve two items that the sweep proved are **non-issues** (realm chronicles, pipeline reorder).

---

## 0. Headline

The deep-dive named four open items. Sweeping the live code (not the handoff notes) collapsed them to **two real fixes + two closures**:

| # | Item | Sweep verdict | Action |
|---|------|---------------|--------|
| Gap #3 | Silent partial-data in compute stages | **REAL** — but it is a *failure-accounting* bug, not the key bug the comments describe (keys are already fixed). 5 JS + 6 Python stages swallow per-row failures and exit 0. | **BUILD** — shared stage-result accounting + fail-loud policy |
| Gap #4 | Stalled flag not in header chip | **REAL and worse than stated** — the feed actively *false-reaps* a slow-but-alive job as `abandoned` (45 s freshness gate vs 5 min stall), because jobs.js only heartbeats on Step transitions. | **BUILD** — keep-alive heartbeat + `stalled` column + UI |
| Realm chronicles | "designed, not built" | **WRONG** — fully built (`describe-chronicles.js:280-305`, `upsertRealmDescription`) **and gated** (`verify-chronicles.mjs` C8/C9). | **CLOSE** — no work; correct the record |
| Pipeline reorder | "analysis before describe, not built" | **UNNECESESSARY** — chronicles run async *after* the full metric pipeline, so the rich narrator already sees full measured shape. Only foreground name-pass sees partial shape, and names don't consume vitality. | **CLOSE** — document; optional freshness guard |
| **Health/trackability** (new ask) | "failures visible + know the health of measurements" | **MOSTLY ALREADY SCHEMA'D** — `pipeline_state` is a per-stage health ledger (success/failure/duration/consecutive_failures/quarantine) already read by era-resolution + the `/metric-freshness` endpoint, but **nothing writes it**. | **BUILD** — populate it from the Gap #3 helper; surface it |

Net: one medium pipeline-correctness fix (Gap #3) that *doubles as* the health recorder, one small observability fix (Gap #4), a health-surfacing layer that reuses existing tables, two documented closures. Everything stays inside the existing process/encryption boundaries — no new IPC pattern, no new egress, **no new telemetry table**.

---

## 1. Revision history

- **v1 (handoff sketch):** "Fix Gap #3 (silent cofire), Gap #4 (stalled chip), build realm chronicles, reorder the pipeline." — four build items.
- **v2 (after Sweep 1 + self-read of `compute-cofire.js:58-62`, `compute-vitality.js:314-336`):** PIVOT — the "silent cofire" key bug is **already fixed** (cofire uses `boot()`; vitality/neighbors/complexity/audit too). The residual bug is *failure accounting*: per-row `catch`→continue→`run()` resolves→exit 0. Re-scoped Gap #3 from "fix the key" to "make stages fail loud on materially-incomplete output," and widened the blast radius to all 11 swallow-partial stages.
- **v3 (after Sweep 3 + self-read of `describe-chronicles.js` whole-file + `verify-chronicles.mjs:122-135`):** PIVOT — **realm chronicles are fully built and gated.** The "not built" gap is stale. Removed it as a build item; reclassified as a documentation correction. Likewise reclassified the pipeline reorder as unnecessary after tracing that async chronicles (post-Step-16) already see full measured shape.
- **v3 (after Sweep 2 + self-read of `activity-feed.js:57-90`, `jobs.js:153-189`):** REFINED Gap #4 — discovered the 45 s `active()`/`reap()` freshness gate false-reaps slow stages; the fix is a keep-alive heartbeat, not just a flag.
- **v4 (health ask + self-read of `migrations/0001_init.sql:994-1007`, `src/db/metrics.js:90-98`, `src/portal-measurement.js:454-496`, `pipeline/stage_base.py:61-76`):** PIVOT — a second sweep proposed new `measurement_runs`/`measurement_stage_health` tables. Reading the schema myself: **`pipeline_state` already is that table** (per-stage `last_success_at`/`last_failure_at`/`last_failure_reason`/`consecutive_failures`/`quarantined`/`last_duration_ms`/`last_details_json`), and it's *already read* by era-resolution and `/metric-freshness` — but **no stage writes it**. Rejected the new tables; the health layer is "populate `pipeline_state` from the Gap #3 helper + surface it." This also explains a latent bug: era-resolution always falls through to rung 2/3 because the cluster stage never records `last_success_at`.

---

## 2. Sweep findings (consolidated, file:line)

### 2.1 Gap #3 — the real failure mode

- **Keys are fine.** `compute-cofire.js:62`, `compute-vitality.js:330`, `compute-territory-neighbors.js:154`, `compute-complexity.js:213`, `topology-audit.js:256` all use `boot({ userHex, systemHex })`, which runs `unlock()` → CryptoKeys before any encrypted write. `describe-chronicles.js:441-442` and `snapshot-entities.js:45-46` use `getDb()` but with `loadKey()`-imported CryptoKeys. The "argument is not of type CryptoKey" failure the comments warn about (`compute-cofire.js:58-61`) is the **old** bug — it no longer fires.
- **The residual bug is exit-code dishonesty.** Each stage wraps the per-row write in `try/catch`, logs the error, and continues without incrementing the success counter; `run()`/`computeX()` then resolves normally and the process exits 0. Example: `compute-vitality.js:280-296` — `written++` only on success, `catch` only logs; `compute-cofire.js:191-200` — same. There is no check that `written` ≈ `attempted`. A *systematic* failure (a schema regression, a future key regression, a constraint) fails **every** row identically → table silently empty → **exit 0** → `jobs.js` reports "Complete" → user sees stale/empty metrics with no signal.
- **`jobs.js` only reads stderr on non-zero exit.** `src/jobs.js:174-177` captures a bounded stderr ring buffer; `:210-217` surfaces `lastErrLine()` **only when `code !== 0`**. On exit 0 the per-row error logs are discarded. So today the orchestrator is structurally blind to partial failure.
- **`set -euo pipefail` is the lever.** `run-clustering.sh:39` aborts the whole script on any non-zero child exit, and `jobs.js:215` already names the failing stage ("Step 9/16 (Scoring territory vitality) failed: …"). **So if a stage exits non-zero on incomplete output, the existing #262 machinery surfaces it for free.** The fix is entirely inside the stages.
- **Blast radius (swallow-partial → exit 0):**
  - JS, must fix: `compute-cofire.js`, `compute-territory-neighbors.js`, `compute-vitality.js`, `compute-complexity.js`, `topology-audit.js`.
  - Python, must fix: `compute-frequency.py` (per-window `except: continue` at :216/:283, stage `except` at :341), `compute-cross-scale-coupling.py` (:193/:210), `compute-criticality.py`, `compute-coherence.py`, `compute-behavioral.py` (:191), `compute-anchors.py`.
  - Already fail-loud (no change): `compute_information_harmonics.py:644` (`raise # fail-closed`), `compute-fisher.py:816` (`raise`) — both propagate uncaught → exit 1.
  - Intentionally fail-soft (no change, by design): `snapshot-entities.js:93` (`process.exit(0)` — history is a best-effort change-log), and `describe-chronicles.js` (narration is fail-soft: no model → skip is correct).
  - Out of scope: `cluster.py` (Generate re-cluster is kill-switched; structural sync `sync-clustering-points.js` already exits 1 on fatal at :47/:115/:193).

### 2.2 Gap #4 — stalled state never reaches the chip, and slow jobs get false-reaped

- **`stalled` is in-memory only.** `jobs.js:187` sets `state.stalled = true` after `STALL_MS` (5 min) of stdout silence; `getJob()` exposes it (`:245`). But the **header chip reads the activity feed, not getJob** (`portal-app/.../shell/Header.svelte` polls `/portal/activity`).
- **The feed strips it.** `background_jobs` has no `stalled` column (`migrations/0001_init.sql:165-179`); `activity-feed.js heartbeat()` (:37-45) accepts only `{step,totalSteps,stageLabel}`; `portal-activity.js shape()` emits no `stalled`/`error`.
- **The feed false-reaps slow stages.** `active()` only returns rows whose `last_heartbeat` is < `STALE_MS` (45 s) old (`activity-feed.js:63`); `reap()` flips older `running` rows to `abandoned` (:83-89). But `jobs.js:165` heartbeats the feed **only on a `Step N/M` stdout line** — and a heavy Python stage (harmonics, fisher, frequency) routinely runs >45 s silent. So a legitimately-running job's feed row goes stale → reaped → the chip shows it vanish or flip to "abandoned," **before** the 5-min stall flag would even trip. This is the more user-visible half of the bug.
- **The UI copy already exists.** `MeasureControl.svelte:49` already renders "Taking longer than usual on this step — still working." because it polls the rich `/portal/mycelium/generate/status/:id` endpoint. We reuse that string in the header chip.

### 2.4 Health/trackability — what already exists (and why it's dark)

- **`pipeline_state` is the per-stage health ledger** (`migrations/0001_init.sql:994-1007`), PK `(user_id, stage_name)`: `last_success_at`, `last_failure_at`, `last_failure_reason`, `consecutive_failures`, `quarantined` (1 when `consecutive_failures ≥ 3`), `one_shot_complete_at`, `last_duration_ms`, `last_details_json`, `updated_at`. This is precisely a measurement-health table — counts/timestamps/short-reason, content-free.
- **It is already consumed by two readers.** Era resolution: `src/db/metrics.js:90-98` and `pipeline/stage_base.py:61-76` both read `pipeline_state` where `stage_name='cluster'` as rung 1 of `derive_era_id()`. Freshness: `src/portal-measurement.js:463` probes `last_success_at` for the families whose budget says "use a pipeline_state probe."
- **But nothing writes it.** `grep` across `pipeline/` + `src/` shows only **reads** — there is no `INSERT/UPDATE pipeline_state` anywhere in V1. The canonical repo's stage runner recorded it; the V1 `run-clustering.sh` orchestrator never ported that. Consequences, all currently live: (a) era-resolution always falls through to rung 2/3 (`MAX(territory_profiles.updated_at)`), because `cluster.last_success_at` is forever NULL; (b) the freshness endpoint's `pipeline_state` probe always returns "missing/empty," masking *why* a family is stale (failed? never ran?); (c) there is **zero per-stage failure history** — `consecutive_failures`/`quarantined` are dead columns.
- **The freshness endpoint already gives a verdict map.** `src/portal-measurement.js:454-496`: `METRIC_BUDGETS` (per-family `{table, timestamp_column, budget_ms, cadence, description}`) → each probed via `MAX(timestamp_column)` (plaintext columns, SQL-valid) → `verdict ∈ {fresh, stale, empty, missing}` + a summary `{total, fresh, stale, missing, empty}`. This is the existing health *read*; it just lacks the *failure* dimension that an unpopulated `pipeline_state` can't supply.
- **Telemetry conventions to match** (so the recorder is idiomatic): `llm_usage` (`migrations/0014_llm_usage.sql`) is the content-free-telemetry precedent (plaintext counts/dimensions, `d1QueryAdmin`); namespace factory pattern is `createXNamespace({ d1QueryAdmin, randomUUID })` wired in `src/db/index.js`; portal route + auth guard pattern is `src/portal-measurement.js`/`portal-health.js`; the Svelte status-card pattern is `UsageSection.svelte` (apiGet → loading/error/data → stat list).

### 2.3 Closures (proven non-issues)

- **Realm chronicles — BUILT + GATED.** `describe-chronicles.js`: territory pass (:193-239), theme pass (:241-278), **realm pass (:280-305)**; `getRealmsToNarrate` with the child-change trigger (`:343-363`, re-narrate when a child territory's `last_described_at > realm.generated_at`); `sampleRealmContext` + `buildRealmPrompt` synthesize from member-territory digests; write via `db.mindscape.upsertRealmDescription` (UPDATE-only, fail-closed). All three kinds hit the history hook `recordNarrative` (:326-335). `verify-chronicles.mjs:122-135` C8 asserts "realm chronicle written via UPDATE-only (no row created)"; C9 asserts realm `raw_response` stays NULL. **No work — correct the docs.**
- **Pipeline reorder — UNNECESSARY.** Chronicle narration runs **async, after Generate completes** (`run-clustering.sh:116-124` + `jobs.js:204 startChronicleNarrationJob`), i.e. after Steps 4-16, so the rich narrator already reads full measured shape (`current_vitality`/`current_phase` from Step 9, fisher phase from Step 7). The only path that sees partial shape is the **foreground name pass** (`describe-clusters.js`, Step 3) — and names/essences do not consume vitality. The agent narration walk is user-triggered independently and reads whatever is in the DB at walk time (full shape if a measure/Generate ran first). Moving Step 9 before Step 3 would drag its dependencies (cofire Step 4) with it for **zero** narration benefit. **No reorder.** (Optional small guard in §6.)

---

## 3. Threat model

- **Plaintext leakage (§1).** Gap #3 summaries print **counts + integer entity ids + a DB error message** only — never territory/realm names, message content, or model output. The `stage-result` helper caps stored error strings and never accepts a name/content argument. Gap #4 adds a boolean `stalled` to `background_jobs`, which is already infrastructure-only (admin query, content-free by charter — `activity-feed.js:7-11`). No new sensitive field crosses any boundary.
- **Fail-closed (§3, §10).** Gap #3 *strengthens* fail-closed: a stage that today silently half-writes will now abort the run and name itself. The policy deliberately tolerates *sparse* per-row failures (one malformed row must not abort 16 stages) but treats *material* incompleteness (0 writes on non-empty input, or >10 % failure) as fatal — matching CLAUDE.md §10 "never log a warning and continue" for the catastrophic case while keeping resilience for the benign one.
- **New attack surface.** None. No new endpoint, no new IPC channel, no new egress. The migration adds one nullable column. The keep-alive heartbeat writes the same content-free row more often.
- **DoS / runaway.** The keep-alive heartbeat reuses the existing 15 s watchdog interval (`jobs.js:186`) — no new timer, no added load. `MAX_MS` (45 min) still backstops a true runaway.

---

## 4. Module shape (signatures + LOC budget)

### 4.1 `pipeline/lib/stage-result.js` (NEW, ~50 LOC)

```js
// Failure accounting for a measurement stage. Measurement MUST fail loud on
// materially-incomplete output (CLAUDE.md §10) but tolerate sparse per-row
// failures so one bad row doesn't abort the 16-stage run. Content-free: only
// counts + ids + DB error messages ever touch this (CLAUDE.md §1).
export class StageIncompleteError extends Error {}

export function createStageResult(stage, { failRatio = 0.1 } = {}) {
  let attempted = 0, written = 0, failed = 0;
  const samples = []; // up to 3 example error messages (no names/content)
  return {
    ok()        { attempted++; written++; },
    fail(err)   { attempted++; failed++; if (samples.length < 3) samples.push(err?.message || String(err)); },
    // content absent (not a failure) — not counted toward attempted
    skip()      {},
    counts()    { return { stage, attempted, written, failed }; },
    // Throw StageIncompleteError when output is materially incomplete; otherwise
    // log a one-line summary (the LAST stderr line jobs.js surfaces). Caller's
    // existing `.catch(() => process.exit(1))` turns the throw into a non-zero exit,
    // which `set -e` propagates and jobs.js names ("Step N/M (label) failed: …").
    finalize() {
      const incomplete = attempted > 0 && (written === 0 || failed / attempted > failRatio);
      const line = `[${stage}] ${written}/${attempted} written, ${failed} failed`
                 + (samples.length ? ` (e.g. ${samples[0]})` : '');
      if (incomplete) throw new StageIncompleteError(`${stage}: incomplete — ${line}`);
      console.error(failed ? line : `[${stage}] ${written}/${attempted} written`);
      return { stage, attempted, written, failed };
    },
  };
}
```

Per-stage adoption (×5 JS), ~4 lines each: construct `const res = createStageResult('vitality')`; replace `written++` → `res.ok()`, `catch(e){ log(...) }` → `catch(e){ res.fail(e) }`; call `res.finalize()` before `close()`. The existing `runCli().catch(err => { console.error(...); process.exit(1) })` already turns `StageIncompleteError` into a named non-zero exit — **no per-stage exit plumbing needed.**

### 4.2 `pipeline/lib/stage_result.py` (NEW, ~50 LOC)

Mirror for the 6 Python stages. Same policy; `finalize()` raises `StageIncomplete` (uncaught → traceback → exit 1). Adoption replaces `except Exception: continue` with `except Exception as e: res.fail(e)` and calls `res.finalize()` at the end of `main()`. Stages that wrap their whole body in a stage-level `except` (frequency `:341`) must narrow that to per-row so the final `finalize()` is reached.

### 4.3 Gap #4 wiring

- `migrations/0023_job_stalled.sql` (NEW, ~3 LOC): `ALTER TABLE background_jobs ADD COLUMN stalled INTEGER DEFAULT 0;`
- `src/db/activity-feed.js` (~10 LOC): `heartbeat(id, { step, totalSteps, stageLabel, stalled })` adds `stalled = COALESCE(?, stalled)`; `active()` + `recent()` SELECT `stalled` and `error` (active currently omits both).
- `src/jobs.js` (~8 LOC): the existing 15 s `stallTimer` (`:186`) also calls `db.activityFeed.heartbeat(jobId, { stalled: state.stalled })` — this both **keeps the row fresh** (kills the false-reap) and **carries the stalled flag**. On `Step` lines, pass `stalled: false`.
- `src/portal-activity.js` `shape()` (~4 LOC): emit `stalled: !!row.stalled` and `error: row.error ?? null`.
- `portal-app/src/lib/stores/activity.ts` (~3 LOC): add `stalled?: boolean; error?: string|null` to `ActivityJob`.
- `portal-app/src/lib/components/shell/Header.svelte` (~10 LOC): when `j.stalled`, render the existing "Taking longer than usual — still working" hint inline in the chip row.

### 4.4 Measurement health & trackability — populate `pipeline_state`, surface it

The recorder is **the same `StageResult.finalize()`** from §4.1 — every stage already calls it exactly once, with the counts it needs. Recording health is one UPSERT folded into that call. No second pass over the stages, no new table.

**`src/db/pipeline-state.js` (NEW namespace, ~60 LOC)** — mirrors `llm-usage.js`, uses `d1QueryAdmin` (content-free infrastructure, like `background_jobs`/`audit_log`):

```js
export function createPipelineStateNamespace({ d1QueryAdmin }) {
  const q = d1QueryAdmin;
  return {
    // Stage succeeded: stamp success, reset the failure streak, store a content-free detail blob.
    async recordSuccess(userId, stage, { durationMs = null, details = null } = {}) {
      await q(`INSERT INTO pipeline_state (user_id, stage_name, last_success_at, consecutive_failures,
                 quarantined, last_duration_ms, last_details_json, updated_at)
               VALUES (?, ?, datetime('now'), 0, 0, ?, ?, datetime('now'))
               ON CONFLICT(user_id, stage_name) DO UPDATE SET
                 last_success_at=datetime('now'), consecutive_failures=0, quarantined=0,
                 last_duration_ms=excluded.last_duration_ms, last_details_json=excluded.last_details_json,
                 updated_at=datetime('now')`,
        [userId, stage, durationMs, details ? JSON.stringify(details) : null]).catch(() => {});
    },
    // Stage failed/incomplete: stamp failure, increment the streak, quarantine at the 3rd strike.
    async recordFailure(userId, stage, { reason = null, durationMs = null } = {}) {
      await q(`INSERT INTO pipeline_state (user_id, stage_name, last_failure_at, last_failure_reason,
                 consecutive_failures, quarantined, last_duration_ms, updated_at)
               VALUES (?, ?, datetime('now'), ?, 1, 0, ?, datetime('now'))
               ON CONFLICT(user_id, stage_name) DO UPDATE SET
                 last_failure_at=datetime('now'), last_failure_reason=excluded.last_failure_reason,
                 consecutive_failures=pipeline_state.consecutive_failures + 1,
                 quarantined=CASE WHEN pipeline_state.consecutive_failures + 1 >= 3 THEN 1 ELSE 0 END,
                 last_duration_ms=excluded.last_duration_ms, updated_at=datetime('now')`,
        [userId, stage, reason ? String(reason).slice(0, 300) : null, durationMs]).catch(() => {});
    },
    async all(userId) {
      const r = await q(`SELECT stage_name, last_success_at, last_failure_at, last_failure_reason,
                 consecutive_failures, quarantined, last_duration_ms, last_details_json, updated_at
               FROM pipeline_state WHERE user_id = ?`, [userId]).catch(() => null);
      return (Array.isArray(r) ? r : r?.results) || [];
    },
  };
}
```

`StageResult.finalize()` (§4.1) gains two optional deps — `db` + `userId` + `stage` + a start timestamp — and on the success path calls `recordSuccess(userId, stage, { durationMs, details: {attempted, written, failed} })`; on the incomplete path calls `recordFailure(userId, stage, { reason })` **before** throwing. `reason` is the same bounded, content-free summary line (counts + a DB error class), never a name/content. Python stages call the mirror in `stage_result.py` via the querier `stage_base.py` already holds. `cluster.py` records `stage_name='cluster'` on success — which **also fixes era-resolution rung 1** as a free side-effect.

**Surface — extend the existing freshness endpoint, don't add a parallel one.** `src/portal-measurement.js` `/metric-freshness` already returns the per-family verdict map. Add a sibling `GET /portal/mycelium/measurement-health` (~25 LOC) that LEFT-JOINs the freshness verdicts with `db.pipelineState.all(userId)`, returning per family:

```
{ family, table, verdict,                 // from freshness (fresh|stale|empty|missing)
  lastComputed, ageMs, budgetMs, cadence, // from freshness
  lastSuccessAt, lastFailureAt, lastFailureReason,  // from pipeline_state
  consecutiveFailures, quarantined, lastDurationMs }
+ summary { total, fresh, stale, missing, empty, failing, quarantined }
```

This makes the three currently-invisible states legible: *stale because it failed* (lastFailureReason set), *stale because it never ran* (no success, no failure), and *chronically broken* (quarantined). An agent/`getContext` line and an MCP read are optional (§6); the human surface is one Svelte card.

**`MeasurementHealthSection.svelte` (NEW, ~70 LOC)** — copies `UsageSection.svelte`: `apiGet('/portal/mycelium/measurement-health')` → a per-family row list with a verdict dot (green fresh / amber stale / red failing / grey empty), "last computed", and an expandable last-failure reason; a quarantined family gets a red "needs attention" badge. Lives in the mindscape/settings surface next to `MeasureControl`.

**Robustness policy (failure → visibility → graceful degradation):**
1. **First/second/third failure of a stage:** fail-loud (Gap #3) — abort the run, name the stage (#262), record the failure + increment the streak. The user is not allowed to silently lose a metric.
2. **At the 3rd consecutive failure:** `quarantined=1`. The health surface shows a red "needs attention" badge for that family. Recorded, visible, persistent across runs.
3. **Quarantine-aware skip (deferred tier, §6):** once quarantined, future runs *skip* that one stage instead of aborting the whole pipeline — so one chronically-broken stage stops blocking all other metrics from refreshing, while staying loudly flagged until a manual fix + a clean run clears the streak. Deferred because it needs a per-stage guard in `run-clustering.sh` (a query before each stage); the core design ships loud-and-recorded first.

### 4.5 LOC budget

**Total: ~480** (JS stage-result helper 50, Py helper 50, JS adoption ~25, Py adoption ~35, Gap #4 ~40, **pipeline-state namespace 60, finalize→record wiring ~15, measurement-health route ~25, MeasurementHealthSection.svelte ~70**, new verify gates ~110, doc/test glue ~50). Within ±20 %.

---

## 5. Edge cases — explicit decisions

- **Sparse vs systematic failure.** Decided: tolerate `failed/attempted ≤ 10 %` (log, exit 0, downstream runs on slightly-degraded data); abort on `0 written` or `> 10 %`. Rationale: the observed bug is systematic (100 % failure ≫ threshold → caught); brittle "any failure aborts" would let one bad row nuke 16 stages. `failRatio` is constructor-tunable per stage.
- **Empty input.** `attempted === 0` ⇒ `incomplete = false` ⇒ exit 0. A territory-less vault must not be treated as a failure (it legitimately writes nothing). Verified against `compute-vitality.js:309` which already returns `{written:0}` happily on no territories.
- **Stage that depends on a skipped upstream.** With `set -e`, an aborted Step 4 (cofire) stops Steps 5-16. Decided: correct — vitality (Step 9) consumes cofire; running it on a half-written cofire graph produces silently-wrong vitality. Better to stop and name Step 4 than to cascade garbage.
- **Measure-only path.** Steps 4-16 only; the same fail-loud applies. Non-destructive — a failed metric stage leaves the prior metric tables intact (each stage overwrites its own rows only on success path). Verified: measure-only is the *primary* live path (`jobs.js:117-119`), so this is where the fix matters most.
- **False-reap vs genuine death.** The keep-alive heartbeat refreshes `last_heartbeat` every 15 s while the child is alive (`state.status === 'running'`); when the child dies, the watchdog stops and `reap()` correctly abandons the row after 45 s. So we keep fail-closed zombie detection while ending false-positives. Verified `reap()` keys on `last_heartbeat` not on stdout (`activity-feed.js:87`).
- **`stalled` persisting after recovery.** When output resumes, `jobs.js:155` clears `state.stalled`; the next 15 s tick writes `stalled:false`. On terminal `finish()`, status moves off `running` so the chip drops the row regardless. No sticky-stalled.
- **Chronicles/snapshot stay fail-soft.** Not migrated to the fail-loud helper: narration with no model legitimately skips, and the history change-log is best-effort. Documented so a future sweep doesn't "fix" them into brittleness.

---

## 6. Optional enhancements (deferred, not in this build)

- **Quarantine-aware skip** (robustness tier 3, §4.4): once a stage is `quarantined`, future runs skip it (and continue) instead of aborting the whole pipeline — so one chronically-broken stage stops blocking all other metrics. Deferred because it needs a per-stage guard in `run-clustering.sh` (`db.pipelineState` query before each stage). The core ships loud-and-recorded; this is the graceful-degradation follow-up. Named so it isn't lost.
- **`measurement_runs` history table** (time-series): `pipeline_state` holds *current* per-stage health (latest + streak), which answers "is it healthy / what's broken." If you later want *trend* ("complexity has failed 3 of the last 5 runs, median 12 s"), add an append-only `measurement_runs` row per stage per run keyed by `clustering_run_id`, mirroring `llm_usage`. Deferred: current-health covers the stated ask; history is additive and non-breaking.
- **MCP / `getContext` health line**: surface `summary {fresh, stale, failing, quarantined}` as one line in the `getContext` preamble (and/or extend the `cognitiveState` tool) so the agent sees measurement health, not just the human. Deferred: one-line addition once the read endpoint exists.
- **Narration freshness guard**: before an agent narration walk, check whether metrics are stale and surface "run Refresh analysis first." Now trivial once `/measurement-health` exists (it already reports `stale`). Deferred until narration runs live.

---

## 7. Test strategy

| Test (file) | Asserts |
|---|---|
| `scripts/verify-stage-accounting.mjs` (NEW) | (1) `createStageResult`: all-ok → exit-clean summary; (2) 0-written-on-N-input → throws `StageIncompleteError`; (3) >10 % failed → throws; (4) ≤10 % failed → returns (no throw); (5) `attempted===0` → no throw. Runs one real JS stage (`compute-vitality`) against an in-memory vault with a forced-failing write (monkeypatched `rawQuery`) and asserts non-zero `process.exitCode`. |
| `scripts/verify-stage-accounting.mjs` (Python arm) | Spawn `compute-behavioral.py` with a DSN that forces an insert error on all rows; assert exit code ≠ 0 and a `incomplete` last line. |
| `scripts/verify-activity.mjs` (EXTEND) | Feed `heartbeat(id,{stalled:true})` → `active()` returns `stalled:1` and the row is NOT reaped while heartbeat is fresh; `shape()` emits `stalled:true`. Regression: a job quiet on *Step lines* but kept alive by the watchdog tick is NOT reaped. |
| `scripts/verify-measurement-health.mjs` (NEW) | (1) `recordSuccess` sets `last_success_at`, zeroes `consecutive_failures`/`quarantined`, stores `last_details_json`; (2) `recordFailure` ×1/×2 increments streak, `quarantined=0`; ×3 sets `quarantined=1`; (3) a success after failures clears the streak + quarantine; (4) `last_failure_reason` is bounded + content-free (no name/content); (5) `/measurement-health` joins freshness verdict + pipeline_state and reports `failing`/`quarantined` in the summary; (6) after a real forced-fail measure run, the failed stage shows `verdict:stale` + `lastFailureReason` set (the "stale because it failed" case is now legible). |
| `scripts/verify-stage-accounting.mjs` (EXTEND) | `StageResult.finalize()` calls `recordSuccess` on the clean path and `recordFailure` before throwing on the incomplete path (assert the row written in both cases). |
| `scripts/verify-chronicles.mjs` (NO CHANGE) | Already covers the realm pass (C8/C9). Cited as the closure evidence. |
| `npm run verify` | Full chain green before merge — per the no-hotfixes discipline (never on a subset). |

---

## 8. Implementation order (each step independently shippable + smoke)

1. **`stage-result.js` + verify-stage-accounting (JS arm).** Land the helper + gate with synthetic stages. Smoke: `node scripts/verify-stage-accounting.mjs` → GO. No product behavior change yet.
2. **`pipeline-state` namespace + wire `finalize()` to record.** Add `src/db/pipeline-state.js`, register `db.pipelineState` in `src/db/index.js`, fold `recordSuccess`/`recordFailure` into `finalize()`. Smoke: `verify-measurement-health` GO; a synthetic stage writes a `pipeline_state` row. (Independently shippable; behavior-neutral until stages adopt it.)
3. **Adopt in the 5 JS stages.** cofire, neighbors, vitality, complexity, audit (each now both fails loud *and* records health). Smoke: `MYCELIUM_MEASURE_ONLY=1 run-clustering.sh` against a test vault; force a write failure in one stage; confirm the run aborts, `jobs.js` names it, **and** `pipeline_state` shows `last_failure_at`/`consecutive_failures`. Verify `verify:vitality` + `verify:measure-only` still GO on the happy path (+ a `last_success_at` row appears).
4. **`stage_result.py` + adopt in the 6 Python stages** (+ `cluster.py` records `stage_name='cluster'`, fixing era rung 1). Smoke: forced-failure harness per stage; confirm era-resolution now uses rung 1.
5. **Health surface: `GET /portal/mycelium/measurement-health` + `MeasurementHealthSection.svelte`.** Smoke: portal-ui live-verify — the card shows per-family verdict dots; after a forced fail, the failed family reads `stale` + a last-failure reason; 3 strikes → quarantined badge.
6. **Gap #4: migration 0023 (`stalled` col) + activity-feed + jobs.js keep-alive.** Smoke: start a measure job, watch `/portal/activity` keep returning the row past 45 s of stage silence (was: reaped); `stalled:true` after `STALL_MS`. `verify:activity` GO.
7. **Gap #4 UI.** Header chip renders the "taking longer" hint. Smoke: portal-ui live-verify; observe during a slow stage.
8. **Docs closure.** Update the living docs + MEMORY: realm-chronicles-built, reorder-unnecessary, the fail-loud invariant, and the `pipeline_state`-is-now-written invariant (era-resolution rung 1 live).

---

## 9. Decision criteria for "done"

- **Gap #3:** A forced systematic write failure in any of the 11 stages produces a **non-zero exit** that `jobs.js` surfaces as "Step N/M (label) failed: …" — verified by `verify-stage-accounting` (both arms) and one live forced-failure measure run. A sparse (<10 %) failure does **not** abort. Full `npm run verify` green.
- **Gap #4:** During a measure run with a >45 s-silent stage, `/portal/activity` keeps the row (no false `abandoned`), and after 5 min of true silence the chip shows the "taking longer" hint. `verify:activity` GO.
- **Health/trackability:** after a measure run, `pipeline_state` has a `last_success_at` row for every stage that ran (era-resolution rung 1 now lives); a forced stage failure leaves `last_failure_at` + `last_failure_reason` + `consecutive_failures≥1`; 3 strikes → `quarantined=1`; `/portal/mycelium/measurement-health` shows the family as `stale` *with* a failure reason (the "stale-because-failed" vs "stale-because-never-ran" distinction is legible), and the Svelte card renders it. `verify:measurement-health` GO.
- **Closures:** `verify:chronicles` C8/C9 cited green; docs updated; no reorder shipped.

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fail-loud aborts a previously-"passing" Generate that was always half-writing | Medium | Medium (user sees a failure that used to be silent) | This is the point — but the 10 % ratio tolerates benign sparseness; the error names the stage + count so it's actionable, not opaque (#262 machinery). |
| Narrowing Python stage-level `except` (frequency:341) changes control flow | Medium | Medium | Per-stage smoke with forced failure; keep the fatal-input `sys.exit(1)` guards intact; only the *partial-swallow* except is narrowed. |
| Migration 0023 re-runs each boot (applyMigrations re-execs files) | Low | Low | `ADD COLUMN` is guarded by SQLite erroring on duplicate; wrap pattern already used — follow the `IF NOT EXISTS`/try idiom of prior ALTERs (e.g. 0012/0021). Verify against `applyMigrations` idempotency. |
| Keep-alive heartbeat races the reaper at exactly STALE_MS | Low | Low | 15 s tick ≪ 45 s STALE_MS — three ticks per window; ample margin. |
| `stalled`/`error` surfaced to header leaks a stage label | Low | Low | Labels are constants ("Scoring territory vitality"), never names/content (`jobs.js STAGE_LABELS`). |
| `last_failure_reason` / `last_details_json` leaks plaintext into `pipeline_state` | Low | High if it happened | Recorder only ever receives the §4.1 summary (counts + a DB error *class*) — never a name/content arg; reason capped at 300 chars; `verify-measurement-health` test 4 asserts content-free. `pipeline_state` is infrastructure (`d1QueryAdmin`), same class as `audit_log`. |
| Writing `pipeline_state` from many spawned children races on the row | Low | Low | PK `(user_id, stage_name)` + `ON CONFLICT DO UPDATE` is atomic per stage; stages run sequentially within one run-clustering.sh process — no concurrent write to the same stage row. |
| Recording health adds latency to each stage | Low | Low | One UPSERT per stage (16 total per run), folded into the already-required `finalize()` call. Negligible vs minutes-long stages. |

---

## 11. Open questions resolved during sweep

- *Is the cofire silent-empty bug a key bug or an accounting bug?* — **Accounting.** Keys were fixed (boot); the comment describes history. (`compute-cofire.js:58-62`.)
- *Do all stages share it?* — 11 of 16 swallow partial; 2 (harmonics, fisher) already raise; 3 are intentionally fail-soft/structural.
- *Are realm chronicles built?* — **Yes, and gated.** (`describe-chronicles.js:280-305`, `verify-chronicles.mjs:122-135`.)
- *Does the pipeline need reordering for narration?* — **No.** Chronicles are async-post-pipeline → already full shape.
- *Why doesn't the header chip show stalled?* — Two reasons, not one: no column **and** a 45 s freshness gate that false-reaps slow jobs because heartbeats only fire on Step lines.
- *Do we need a new table for measurement health?* — **No.** `pipeline_state` already is it, already read by era-resolution + freshness; it's just never written. Reusing it also fixes a latent era-resolution fall-through (rung 1 dark) for free. Almost shipped two redundant tables (`measurement_runs`/`measurement_stage_health`) before reading the schema.
- *Is the stale-metric problem (May-05 cofire) a measurement bug?* — No, but it was *invisible*: with `pipeline_state` unwritten, the freshness endpoint can say "stale" but never "stale because the stage failed on date X." Populating it makes staleness diagnosable, not just detectable.

## 12. Open questions deferred (named, out of scope)

- Re-enabling the **Generate re-cluster** kill-switch (needs the realm-k collapse fix trusted on the live vault — separate operator decision; tracked in `REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md`).
- The **AnalysisEngine plugin boundary** (CLAUDE.md aspiration; pipeline is hardwired — not a bug).
- **Anchor (E1) CVP calibration** (needs operator-labeled data + running embed-service — by-design gate, not a defect).
- The **narration freshness guard** (§6) — small, deferred until narration runs live.
- A **live measure-only run** to refresh the stale (May-05 cofire) metrics — this design makes that run *trustworthy* (fail-loud), but executing it requires opening a healthy vault in the app and clicking "Refresh analysis." Operator action, post-merge.

---

## 13. Verification table

Every load-bearing assumption, verified at a line I read myself.

| Assumption | Verified at |
|---|---|
| cofire/vitality/neighbors/complexity/audit use `boot()` (keys correct) — Gap #3 is not a key bug | `pipeline/compute-cofire.js:62`, `compute-vitality.js:330`, `compute-territory-neighbors.js:154`, `compute-complexity.js:213`, `topology-audit.js:256` |
| Per-row `catch` logs+continues; success counter skipped; `run()` resolves → exit 0 on partial | `pipeline/compute-cofire.js:191-200`, `compute-vitality.js:280-296` |
| `jobs.js` reads stderr **only** on non-zero exit; names the failing stage | `src/jobs.js:174-177`, `:210-217` |
| `set -euo pipefail` aborts the script on any non-zero child exit | `pipeline/run-clustering.sh:39` |
| harmonics + fisher already raise (fail-loud, uncaught → exit 1) | `pipeline/compute_information_harmonics.py:644`, `compute-fisher.py:816` |
| frequency/coupling/criticality/coherence/behavioral/anchors swallow per-row + reach exit 0 | `compute-frequency.py:216,283,341`, `compute-cross-scale-coupling.py:193,210`, `compute-behavioral.py:191`, main() at `:266/:133/:169/:256` (no partial guard) |
| snapshot-entities is intentionally fail-soft (exit 0); sync exits 1 on fatal | `pipeline/snapshot-entities.js:93`; `sync-clustering-points.js:47,115,193` |
| `stalled` is in-memory only; `getJob()` exposes it but chip reads the feed | `src/jobs.js:187,245`; chip polls `/portal/activity` |
| `background_jobs` has no `stalled` column; `heartbeat()` accepts only step/total/label | `migrations/0001_init.sql:165-179`; `src/db/activity-feed.js:37-45` |
| feed `active()` has a 45 s freshness gate; `reap()` abandons stale `running` rows | `src/db/activity-feed.js:57-67`, `:82-90` |
| jobs.js heartbeats feed **only on Step lines**; watchdog ticks every 15 s | `src/jobs.js:165`, `:186-189` |
| Realm chronicle pass is built: getRealmsToNarrate + child-change trigger + UPDATE-only write | `pipeline/describe-chronicles.js:280-305`, `:343-363`; `src/db/mindscape.js upsertRealmDescription` |
| Realm chronicles are gated (UPDATE-only, no row created, raw_response NULL) | `scripts/verify-chronicles.mjs:122-135` |
| Chronicles run async after Generate (full metric shape available to the narrator) | `pipeline/run-clustering.sh:116-124`; `src/jobs.js:204` |
| current_vitality/current_phase written at Step 9 (after Step 3 foreground describe) | `pipeline/compute-vitality.js:298-307`; `run-clustering.sh:168-171` vs `:108-115` |
| MeasureControl already renders the stalled/error copy (reusable for header) | `portal-app/src/lib/components/mindscape/MeasureControl.svelte:49,52-54` |
| `pipeline_state` is a per-stage health ledger (success/failure/streak/quarantine/duration/details) | `migrations/0001_init.sql:994-1007` |
| `pipeline_state` is read by era-resolution (rung 1) — JS + Python | `src/db/metrics.js:90-98`, `pipeline/stage_base.py:61-76` |
| `pipeline_state` is read by the freshness endpoint (`last_success_at` probe) | `src/portal-measurement.js:463` |
| **Nothing writes `pipeline_state` in V1** (only reads exist → era rung 1 dark, no failure history) | `grep -rn pipeline_state pipeline/ src/` → reads only (`metrics.js`, `portal-measurement.js`, `stage_base.py`) |
| `/metric-freshness` returns per-family `verdict ∈ {fresh,stale,empty,missing}` + summary (the read to extend) | `src/portal-measurement.js:443-496` |
| `llm_usage` is the content-free telemetry precedent (`d1QueryAdmin`, plaintext counts/dims) | `migrations/0014_llm_usage.sql:1-33` |
