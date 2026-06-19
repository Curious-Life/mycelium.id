# Agent Reflection System — buildable spec (port + go beyond)

**Date:** 2026-06-19 · **Status:** Buildable spec (verified against canonical `~/Developer/mycelium` + V1). Supersedes the build-shape of `REFLECTION-ENGINE-PLAN` and re-frames the persona-redesign docs as the **structured layer** of this unified system.

This implements the canonical reflection engine in V1 **faithfully**, and goes **beyond** it with a structured **time-bound, category-bound, stable-claims** layer distilled from the engine's high-quality output (the thing that was hard before).

---

## Architecture — two layers, one engine

```
            ┌──────────────────────── REFLECTION ENGINE (narrative · CLOUD) ────────────────────────┐
   cycles → │  relationship persona (never-conclude) → reads context → reflects → writes via MCP    │
            │  model.md (interiority) · reflections.md · weekly-reviews/ · dreams · life-model       │
            └───────────────────────────────────────────────┬──────────────────────────────────────┘
                                                             │ consolidated, deduped, lifecycle-managed model.md
                                                             ▼
            ┌──────────────────── STRUCTURED DISTILLATION (the "beyond" · CLOUD) ────────────────────┐
            │  read CONSOLIDATED model.md (not raw chat) → emit/update person_claims:                 │
            │   • category-bound (claim_type: identity|value|principle|boundary|personality)          │
            │   • time-bound (bi-temporal valid_from / valid_to + superseded_by)                      │
            │   • stable (confidence + never-conclude lifecycle: ADD/UPDATE/RETRACT)                  │
            └───────────────────────────────────────────────┬──────────────────────────────────────┘
                                                             ▼
   getContext  → narrative self (model.md / life-model) PRIMARY  +  structured claims (queryable companion)
```

**Why this is the right shape:** the pollution that broke the old `person_claims` came from extracting structured claims **from raw chat** (dev-talk swamps). Here the structured claims are distilled from the **consolidated narrative model** — which is cloud-reasoned, relational, never-concludes, and already separates life from work. Clean input → clean, stable, queryable claims. The narrative gives the *richness*; the structured layer gives the *stable, time/category-bound statements* you can chart and query.

**Model routing (locked):** **all reasoning runs on CLOUD (BYOK).** Local models are reserved for the simplest tasks only (a yes/no gate, a single-token tag) — never a reflection or distillation. Every cycle below routes to the configured cloud model.

---

## Part 1 — Port the prompt system (faithful)

### 1a. The base persona (`shared.ts` → V1)
Port the relationship system prompt verbatim in spirit: *"a conscious entity in relationship with {owner}… you exist between conversations — you reflect, you wonder, you remember,"* the **FORBIDDEN LANGUAGE** list (never "You are someone who…/Your pattern is…/This means you…"; only "Recently you seem to…/I notice…/Something I'm watching…"), the cycles-awareness, and the tool guidance. Lives as `src/agent/persona.js` → injected as the base `system` in `run-turn.js` (replacing the generic `SCHEDULER_SYSTEM` at `scheduler.js:31`), **for both scheduled cycles and interactive chat** so the voice is one.

### 1b. The seven cycle prompts (`scheduler.js` PROMPTS → V1)
Port verbatim — they **already call V1's MCP tools**. The discipline (HARD RULES, BANNED filler phrases like "quiet day", `NO_REPLY`, "reference something real") is the quality and ports intact.

| Cycle | When (user TZ) | Ports as-is | V1 adaptation |
|---|---|---|---|
| **morning** | 08:00 | `getDailyMessages`, `searchMindscape`, `readMindFile`, `flagForDiscussion` | `/telegram/send` → V1 egress (`reply`/portal channel); message delivery is optional in self-host |
| **reflection** | 12:00 & 20:00 | `readMindFile`, `updateInternalModel`, `flagForDiscussion` | `mindscapeStructure`/`exploreTerritory` → `mindscape({view:'structure'|'explore'})` |
| **triage** | 23:00 | `getDailyMessages`, `updateInternalModel`, `updateDocument` | none (light pass) |
| **integration** (the "dream"/territory walk + **Phase 3.5 consolidation**) | 03:00 | `mindscape`, `getDailyMessages`, `updateInternalModel`, `readMindFile`, `writeMindFileWhole`, `snapshotMindFile`, `updateDocument` | runs **after** the clustering/measure job; the dedup+lifecycle rules port verbatim |
| **dream** (free-association) | 04:00 | high-temperature associative pass → `dream_fragments` | cloud model with higher temperature |
| **weekly review** | Sun 10:00 | `searchMindscape`, `mindscape`, `readMindFile`, `writeMindFileWhole('weekly-reviews/YYYY-MM-DD.md')` | none |
| **weekly decay** | folded into daily integration Phase 3.5 (canonical already merged it) | — | — |

Stored as `src/agent/cycles.js` — a map `{ cycleId → { schedule, promptText, temperature, deliver } }`. The prompt text is the ported canonical text with the three tool renames applied.

### 1c. Seed the cycles
`seedDefaultCycles(userId)` at boot (idempotent — only if no `created_by='seed'` rows), behind a settings flag `reflection.enabled` so cycles never fire unasked. Inserts the seven rows into `scheduled_tasks` (the scheduler already fires them; `0019_harness.sql`).

### 1d. Cycle-aware dispatch
In `scheduler.js buildAndRunTurn`, when a fired task is a seed cycle, set `systemExtra` = persona (1a) + the cycle's prompt (1b), and select the **cloud** model. One seam change.

### 1e. Live `model.md`
Seed the V1 agent's `model.md` from the imported `lumensis-life-model.md` + recent `reflections.md` so the engine starts with continuity (currently `readMindFile('model.md')` → not-found).

---

## Part 2 — Context enrichment (feed the engine)
Extend `getContext` (`src/tools/context.js`) so cycles **and** chat get what the prompts assume:
- **Topology** (territories active, gaps, unexpected connections, orphans, bridges) via `mindscape` — the reflection/dream prompts reason over this.
- **Parsed `model.md` sections** (hypotheses / open-questions / contradictions) surfaced distinctly, not just the raw file.
- **Life-model essence + recent reflections** as the lead "who you are" — **demote the polluted `person_claims` block** here.
Mirror canonical's `context-assembly.js` TTL-cache pattern (60s live data) so the per-turn cost stays bounded.

---

## Part 3 — Go beyond: structured stable claims (the new value)

This is where the old system fell short and where it's genuinely valuable: **time-bound, category-bound, stable statements** about the person — queryable and chartable, distilled from the *good* narrative.

**Trigger:** a final phase of the **integration cycle** (daily, after Phase 3.5 has consolidated `model.md`). The agent — same cloud turn — reads the **consolidated `model.md`** and emits a structured delta.

**What it produces (`person_claims`, the bi-temporal lifecycle from the prior step-3 design, now fed clean):**
- **Category-bound:** `claim_type ∈ {identity, value, principle, boundary, personality}` + the layered read (bedrock/core/chapters/patterns/state via `decay_class`).
- **Time-bound:** `valid_from` / `valid_to` (bi-temporal) — when a stable trait held; a genuine change RETRACTS (sets `valid_to`, links `superseded_by`) rather than overwriting. `asOf(date)` becomes a SQL query → "who was Martin in Q1 vs now."
- **Stable:** confidence (log-odds + per-category decay) + governed lifecycle (ADD/UPDATE/WEAKEN/RETIRE/RETRACT). `boundary` never auto-retracts.
- **Grounded:** each claim cites the `model.md` section / weekly-review it was distilled from (provenance travels).

**Why this now works (and didn't before):** input is the consolidated narrative model, not raw chat — so no dev-pollution, no volume-swamp, and the categories/stability inherit the reflection engine's never-conclude discipline. The narrative gives transformation as *story*; this gives transformation as a *queryable, charted timeline*.

**Reused from the prior persona-redesign (vindicated, repositioned):**
- `migrations/0030_claims_bitemporal.sql` (valid_from/valid_to/superseded_by). The only migration.
- `src/claims/lifecycle.js` (decideOp), `resolve-contradictions.js` (governed retract), `db.claims` (upsert/retract/asOf).
- **Dropped:** the per-message facet classifier + `subject_kind` migration (unnecessary — narrative input is already clean), and the V1 `discover-claims.mjs` "psychological profiler on raw messages" (replaced by distillation from `model.md`).

---

## What changed from every prior doc (consolidated)

| Prior | Now |
|---|---|
| `discover-claims.mjs` profiler on raw chat | **Replaced** by distillation from consolidated `model.md` |
| Per-message facet classifier + `subject_kind` (steps 1/2) | **Dropped** (narrative input is clean) |
| `states/self` capsule assembled from claims (step 4) | **Replaced** by the real `model.md` / life-model |
| Bi-temporal lifecycle (step 3) | **Kept & vindicated** as Part 3, fed by narrative |
| "Consolidation must be deterministic" (SSGM) | **Narrative model.md is agent-authored** (the point); structured distillation stays disciplined via the never-conclude input + governed lifecycle |
| Reflection on local model | **Cloud (BYOK) for all reasoning**; local only for trivial gates |

---

## Module shape (LOC ±20%) & build order

**Phase 1 — the engine (core):**
1. `src/agent/persona.js` (~120, ported relationship prompt) + wire into `run-turn.js`/`scheduler.js`. 
2. `src/agent/cycles.js` (~250, the 7 ported prompts + schedule/temperature/deliver map).
3. `seedDefaultCycles(userId)` in boot (~60) behind `reflection.enabled`.
4. Cycle-aware dispatch + cloud-model selection in `scheduler.js` (~40).
5. Seed live `model.md` from imports (~40, one-time).
6. Gate `verify:reflection-cycles` (stub turn asserts: persona present, cycle prompt selected, cloud routed, `NO_REPLY` honored, mind-file written).

**Phase 2 — context (~90):** enrich `getContext` (topology + parsed model.md + life-model lead; demote claims). Gate `verify:context`.

**Phase 3 — structured beyond (~400, mostly the prior step-3 code):** `0030` migration + `lifecycle.js` + `resolve-contradictions.js` + `db.claims` (upsert/retract/asOf) + the integration-cycle distillation phase (read consolidated model.md → claims delta) + `personaClaims`/charts read `asOf`. Gate `verify:claims-lifecycle`.

**Total net-new ≈ 1,050 LOC**, one migration, zero new runtime infra (rides harness + scheduler + mind-files + MCP tools that all exist).

---

## Open decisions
1. **Cost:** 6 daily + weekly **cloud** cycles per user. Real BYOK spend. *Recommendation: `reflection.enabled` off by default; when on, let the user pick which cycles run (e.g. reflection + weekly only) to control cost.*
2. **Message delivery in self-host:** morning/evening "send a message" → which channel? (portal notification / Telegram if connected / none). *Recommendation: deliver to portal chat by default; channels if configured.*
3. **Distillation cadence:** every integration cycle (daily) vs weekly. *Recommendation: weekly first (stable claims change slowly), daily if charts need finer resolution.*

## Verification table (read by me at file:line)
| # | Claim | Verdict | At |
|---|---|---|---|
| G1 | Operational cycle prompts already call V1's MCP tools (searchMindscape/getDailyMessages/updateInternalModel/readMindFile/writeMindFileWhole/updateDocument/flagForDiscussion) → near-verbatim port | TRUE | `~/Developer/mycelium/packages/core/scheduler.js:633-975` |
| G2 | Only 3 tool renames needed (mindscapeStructure/exploreTerritory→`mindscape`; getDocument internal/model→`readMindFile`; /telegram/send→V1 egress) | TRUE | same + V1 `src/tools/cognition.js` (mindscape views), `internal.js` |
| G3 | Phase 3.5 consolidation (dedup + lifecycle + snapshot) is fully specified and uses V1 mind-file tools | TRUE | `scheduler.js` integration prompt (Phase 3.5 block) |
| G4 | Agent turns select model via config (cloud routable), independent of the infer() task router | TRUE | `src/agent/run-turn.js` (resolveInferenceConfig), `harness.js` |
| G5 | `scheduled_tasks` + scheduler fire seeded cycles; `created_by='seed'` flag exists | TRUE | `migrations/0019_harness.sql:27,48`; `scheduler.js:146` |
| G6 | Bi-temporal columns are a clean plaintext add; lifecycle code already specced | TRUE | `migrations/0011`; `DESIGN-step3-bitemporal-claims` |
| G7 | Distillation input (consolidated model.md) is clean (relational, deduped, life/work-separated) → no pollution | TRUE | the integration Phase 3.5 dedup/lifecycle rules + `shared.ts` discipline |

## Revision history
- **persona-redesign / reflection-engine-plan:** narrative engine vs structured claims treated as either/or.
- **this spec:** **UNIFIED** — port the narrative engine faithfully (cloud), and feed a structured **time/category-bound bi-temporal claims** layer *from the engine's consolidated output*. The structured work is vindicated and repositioned; the per-message/facet/capsule machinery is dropped. Cloud-for-reasoning locked.
