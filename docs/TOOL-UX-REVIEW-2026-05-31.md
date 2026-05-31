# Tool surface UX review + consolidation proposal

**Date:** 2026-05-31 · **Surface:** 30 tools (post-getContext) · **Audience:** operator decision + next implementer.
**Status:** PROPOSAL — no code changed. getContext (built) and naming/description polish (low-risk) are tracked separately; this doc is the *structural consolidation* question.

## Lens: how a connecting Claude experiences the surface
An MCP client sees a flat list of 30 `{name, description, inputSchema}` tools and must choose. The UX problem is **decision cost**: when several tools answer the same question ("where am I cognitively?"), the model hesitates, picks inconsistently, or calls three when one would do. Consolidation is worth it *only* where tools genuinely overlap — not as a count-reduction exercise.

---

## Cluster A — cognitive metrics (8 tools) → propose 5. **Highest overlap; recommend consolidation.**

Two underlying systems, currently flattened into 8 sibling tools:
- **Fisher trajectory** = cognitive *movement* (phase, velocity, direction): `getCurrentPhase`, `getTrajectoryHistory`, `getActiveMilestones`, `getTopMovers`
- **Information harmonics** = cognitive *rhythm/shape*: `getHarmonicState`, `getFlowFeatures`, `getShape`, `getMetricSeries`

**The overlaps:**
1. **`getHarmonicState` already bundles** amplitudes + flow features + shape for the latest window. `getFlowFeatures` and `getShape` are **sub-views of the same window** — a model can't tell when to call the bundle vs. the slice. → **Fold `getFlowFeatures` + `getShape` into `getHarmonicState`** (it already returns them; drop the two thin wrappers, OR keep them as `getHarmonicState(detail:'flow'|'shape')`).
2. **`getCurrentPhase` (movement-now) and `getHarmonicState` (rhythm-now)** are the two "orient me right now" tools. They answer different questions but a model reaching for "how am I doing" sees both. → Keep both, but **say so in the descriptions** (movement vs rhythm) rather than merging — they're genuinely distinct axes.

**Proposed Cluster A surface (8 → 5):**
| Keep | Role |
|---|---|
| `getCurrentPhase` | movement snapshot (phase/velocity/direction) |
| `getHarmonicState` | rhythm snapshot — absorbs flow + shape as the bundle, or via `detail` param |
| `getTrajectoryHistory` | movement over time |
| `getMetricSeries` | any single metric over time (the power-user time-series) |
| `getActiveMilestones` | "what just changed" alerts |
| ~~`getFlowFeatures`~~ | → folded into getHarmonicState |
| ~~`getShape`~~ | → folded into getHarmonicState |
| ~~`getTopMovers`~~ | → arguably a mode of getTrajectoryHistory (top contributors per window already exist there) — **weakest cut, verify usage first** |

**Risk:** these are real ported tools with handlers; folding means moving logic, not deleting. Medium effort. The `getTopMovers` fold is the least certain (it has a distinct `windowEnd` param).

---

## Cluster B — topology explorers (5 tools) → **recommend KEEP AS-IS.**

`exploreTerritory` (neighborhood/co-firing), `territoryDetail` (deep single), `listTerritories` (list/filter), `mindscapeStructure` (global overview), `timeView` (temporal lens). These are **five genuinely different verbs** — low overlap. A model picks cleanly: "explore around X" vs "everything about X" vs "list all" vs "big picture" vs "over time". The only soft overlap is `timeView(territory)` vs `territoryDetail` (which includes an activity timeline) — minor, not worth merging. **No consolidation; just description polish.**

---

## Cluster C — documents (6) + mind files (6) → **KEEP; one note.**

Documents (`save/update/get/list/publish/getShareStatus`) and mind files (`read/write/edit/snapshot/updateInternalModel/flagForDiscussion`) are coherent and distinct (library docs vs the agent's private scratchpad). One UX note: `updateDocument` (append timestamped entry) vs `saveDocument` (create/revise) is a subtle distinction the descriptions should sharpen. No structural change.

---

## What's MISSING (additions worth considering)
1. **`getContext`** — ✅ **DONE** this session (the entry point). Was the biggest gap.
2. **A "capture a thought" path for messages.** There's `getDailyMessages` (read) but no first-class *write a message/note into the stream* tool — capture currently only happens via `createTask` or document writes. Worth confirming whether ingestion is intended to be REST-only (bots/webhooks) or also a tool. **Operator question.**
3. **`getTask`/`listTasks`** — `createTask` exists but there's no task read-back tool. Tasks are write-only from the MCP surface right now. Likely worth a `listTasks`. **Low effort, real gap.**

---

## Recommendation (priority order)
1. ✅ getContext — **done** (`51e9b93`).
2. ✅ **Polish pass** (de-jargon descriptions + rhythm-vs-movement distinction) — **done** (`1635881`).
3. ✅ **Cluster A consolidation** — **done**: getFlowFeatures + getShape folded into `getHarmonicState(detail:'flow'|'shape')`, capability-preserving (verify M5). 8→6 metrics-family tools. getTopMovers held pending usage (see open Q2).
4. ✅ **Add `listTasks`** — **done** (`7a04795`), closes the write-only-tasks gap.
5. Leave Cluster B + C structurally as-is.

**Still parked on operator input:** getTopMovers fold (needs usage data) + message-capture surface (product decision). See open questions below.

## Open questions for the operator
1. **Cluster A fold:** collapse getFlowFeatures/getShape into getHarmonicState (sub-views via `detail` param), or keep them separate? Recommendation: fold via `detail` — one tool, discoverable, no lost capability.
2. **getTopMovers:** keep standalone, or make it a mode of getTrajectoryHistory? Recommendation: keep for now (distinct param); revisit with real usage data.
3. **Message capture:** is writing to the message stream a tool, or REST-only? Affects whether we add a `captureNote`-style tool.
4. **listTasks:** add now? (Recommendation: yes, small.)
