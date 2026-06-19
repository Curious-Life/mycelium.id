# Curious Life — Interaction & Component Spec

**Date:** 2026-06-19 · **Status:** Draft for review (pairs with the metric/validity spec)
**Owns:** the page's *components, interactions, layout, and the event-anchor loop*.
**Defers to:** [`SPEC-curious-life-page-2026-06-19.md`](SPEC-curious-life-page-2026-06-19.md) (metric definitions, reliability tiers, the detection→correlation→prediction staircase, the CVP gate) and [`CURIOUS-LIFE-METRICS-CATALOG.md`](CURIOUS-LIFE-METRICS-CATALOG.md) (per-metric plain-language + rigor).
**Reconciliation:** this and the metric spec are two halves of one design and must be reconciled explicitly — several findings from the 2026-06-19 working session (Fisher depth/scope, dimension-aware smoothing, the AI stream) belong in *both* and are flagged inline + in §8.

This spec says *how the page behaves and is built*. Where it names a metric's trustworthiness it cites the metric spec rather than re-deciding it.

---

## 0. The one idea: a bidirectional timeline ("one instrument")

The page is **one shared time axis** seen through stacked lenses. Two parties write to it:

- **The system annotates downward** — detected shifts, milestones, early-signal marks.
- **The person annotates upward** — *events they lived* ("since I started the new project").

**Correlation lives in the overlap.** Every anchored event is a labeled `(shift ↔ event)` pair; over months that overlap is what lets the system (and the AI) learn whether a detected shift means anything *for this person*. The event-anchor is therefore not UX garnish — it is the ground-truth collection engine that earns the right to ever say more (per the metric spec's staircase).

**A third writer — the AI.** The same shift-marks and event-anchors flow to the AI surface (the always-on cognitive preamble + on-demand tools defined in the metric spec §7), so the human page and the AI never fork on *what shifted* or *what you lived*. The timeline has three participants: the system marks shifts, you mark events, the AI reads both and reflects — in conversation, at the right moment, framed as a question.

Everything derived drills down to one floor: the **week × top-3 territories** view (the literal, checkable base layer). Nothing on the page is an orphan number.

---

## 1. Design principles (the honesty contract, as interaction)

1. **Honest mirror, not analytics dashboard.** Names the *experience* ("Movement", "Patterns", "The Map"), never the machinery ("Metrics", "Insights", "Analytics", "quantified"). Passes the *reads-like-a-mirror-not-a-diagnosis* test.
2. **Always self-relative.** Every comparison is "vs *your* normal," never absolute or population. Surfaced as baseline-z, never a raw clinical-looking score.
3. **Drill-to-evidence everywhere.** Any claim → the window → the territories → the actual messages. Turns "X rose" into something checkable.
4. **Present-tense, never future-tense.** Descriptive ("you've been slower to return to your usual rhythm") — never predictive ("a shift is coming"). The science can't carry the second (≈33% sensitivity, direction-blind — see metric spec).
5. **Confidence is visible, not hidden.** Rigor badge per component (validated / heuristic / experimental); low-confidence and small-n states say so inline.
6. **Cold-start degrades by layer, never blank.** Each component below its noise floor shows "what fills this in," not an empty box.

---

## 2. Page skeleton (top → bottom)

A confidence gradient — trustworthy/legible at the top, interpretive deeper. ✓ = shipped, + = new in this spec.

| # | Band | Component | Tier | Status |
|---|---|---|---|---|
| 0 | — | **Header** (name + one-line now-state) | A | ✓ (retitle) |
| 1 | A | **The Map / territory river** (anchor bands + active count + novelty overlays + status) | A | ✓ |
| 2 | A | **Week × top-3 territories** (message volume, the drill-floor) | 0/A | + |
| 3 | A | **Anchor count over time** (stable-core size) | A | ✓ |
| 4 | A | **Movement** (Fisher velocity z + D/L/R + shift markers) | A* | ✓ (promote shifts) |
| 5 | A | **Connectivity over time** (anchor co-fire drift + transition texture) | 0/A | + |
| 6 | B | **Novelty surface** (coarse LZ + fine embedding-novelty) | A/B | + |
| 7 | B | **Texture** (coherence as "flow/fragment", harmonics exploratory-only) | B | + (gated) |
| — | all | **Event anchors** (the upward annotations, overlaid on every time graph) | — | + |

\* Fisher geometry + z-score are validated-mathematical *within a clustering run*; phase labels are heuristic (badge softer). See §6.

---

## 3. Components

Each component: **purpose · data source · interaction · hover · drill · cold state · reliability**.

### 3.0 Header (retitle)
- **Purpose:** orient in one mirror-voiced line. The tab/sidebar already says "Curious Life"; the giant centered gradient hero ("Your mind, quantified.") is out of house style and the wrong register — remove it.
- **Replace with:** a modest left-aligned section label (e.g. **Movement** / **The Map**) + the **now-line** (the existing summary band, plain-language, Band-A only): *"You've been cycling for ~2 weeks; attention anchored in [work] and [health]; first time in 8 weeks you touched [creative]."*
- **Reliability:** A. Plain language, stated as fact.

### 3.1 The Map / territory river — ✓ shipped
- **Data:** `/portal/territory-river` (persisted-cached, #301). Anchor bands + per-week share, active-territory count, status (anchor/active/dormant), novelty overlays.
- **Add:** join the shared-hover (§4) and the event-anchor overlay (§3.7). Keep it the spine.
- **Reliability:** A (counts/shares; no Fisher). Names gated on the describe pipeline (see §8).

### 3.2 Week × top-3 territories — + new (the drill-floor)
- **Purpose:** the literal, checkable base everything else drills to: *what did I actually write about, and how much, each week.*
- **Spec:** per week, a small bar = that week's **message volume**, split by its **top-3 territories**; remainder = "other". Stacked bar or small-multiple.
- **Data decision:** activation vectors are *normalized shares*, not raw counts — so for true "how many messages each got" aggregate **`clustering_points` per week × territory** (real counts), not `share × weekly-total`. New light endpoint `/portal/territory-weekly-top` (or fold into the river payload as `weekly_top: [{end, total, top:[{territory_id, name, count}]}]`).
- **Hover:** the three territory **names + counts** + one line ("this week was 41% [creative]").
- **Drill:** click a week → its messages (Tier-0→Tier-2, local, explicit crossing).
- **Reliability:** A (raw counts, basis-internal). This is the trust anchor for the whole page.

### 3.3 Anchor count over time — ✓ shipped
- Keep. Add shared-hover (show the count + the week) and the event-anchor overlay.
- **Reliability:** A.

### 3.4 Movement (Fisher) — ✓ shipped, promote the shift layer
- **Purpose:** *did my attention just reorganize unusually* — the shift layer.
- **Display the *baseline* z, not the raw value or the pooled-null z:** *"Unusual movement this week — 3.6σ above your baseline — driven by [creative] rising as [logistics] faded."* Use **`velocity_baseline_z`** (trailing-exclusive "unusual for *me*", `src/metrics/baseline-z.js`) for the headline copy — NOT the pooled-null z (that answers "above measurement noise", a different question; they disagree exactly for a stable low-volume writer). `top_contributors` supplies the "driven by" clause.
- **A shift-mark is the same object as the cross-check layer (P3).** A velocity-z spike alone isn't a confirmed shift — each mark carries its **agreement quadrant** (corroborated / basis-suspect / hidden-drift, from convergent signals). Until P3 lands, marks render a **"cross-check pending"** state — they must not imply confirmation they don't yet have. Sequence B3 with P3 so the mark renders the quadrant.
- **Cycling vs exploring — use depth-invariant forms only.** Show "going somewhere vs circling" via **`R_recent` (rolling)**, a **windowed displacement `D_K`**, and **mean step size** — **NOT** the stored cumulative `fisher_displacement` / `fisher_trajectory_length` / `exploration_ratio` columns. Those are since-anchor cumulative → depth-degenerate (L→∞, D measured from 2018, R→0 as history grows) — they are the exact source of the weird numbers seen this session. `R_recent` exists; `D_K` is computed inline to derive it but then discarded — so this is a small **data addition** (persist/expose `D_K` + mean step size), not just a label swap. ⚠️ **Fix before the Movement component is built.** Phase labels stay one notch softer (heuristic thresholds).
- **Shift markers:** velocity-z spikes become clickable marks *on the shared timeline* (the system's downward annotations).
- **Reliability:** geometry + z-score validated-mathematical **within one clustering run** (null = surrogate shuffles of your own history); do **not** compare z across re-clusters — pin the series to a run and show the run boundary. Caveat: the per-category smoothing (ε = 0.01 × n) makes the z's σ-unit differ across scopes (territory vs realm), so "validated within run" is slightly optimistic across scopes until the dimension-aware smoothing fix lands (§8). Phase labels = heuristic.

### 3.5 Connectivity over time — + new (high priority) — build it as an *idiographic temporal network*
- **What it actually is (the framing that gives it grounding + a fix-list):** this is a personal **temporal network psychometric model** (graphicalVAR / mlVAR; Epskamp 2018). Its two reads map exactly onto the two networks that framework estimates from one person's time series:
  - **Co-firing = the contemporaneous network** (which territories are active *in the same window*).
  - **Transition texture `T[a→b]` = the temporal network** (this window's distribution predicts the next).
- **⚠️ Do NOT use raw co-occurrence — it's volume-confounded.** "Active in the same week" makes the densest edges just the *most active* territories, not the most *associated* (busy weeks make everything co-occur with everything). Required fixes (this is the correction that matters most in B):
  - **Normalize against marginals + sparsify.** First cut: **PPMI** (positive pointwise mutual information = log[observed / expected-under-independence], floored at 0 — PPMI over PMI to avoid rare-pair inflation) + keep only top edges. SOTA target: **regularized partial correlation (GGM / graphical-LASSO)**, which additionally drops edges explained by a common third territory.
  - **Drift = compare PPMI/partial-corr edges across windows, flag only beyond resampling noise** — the same chance-normalized / surrogate principle as the Fisher-z and the LZ surrogate. An edge (or a drift) is "real" only above chance.
- **Transitions must be realm/theme-level + share-weighted — never territory-argmax.** A 200×200 territory transition matrix from ~150 weekly observations is ~0 obs/cell (pure noise — the undersampling that has recurred all session). Compute at **realm/theme (13–~50 nodes)**, where partial-correlation is also feasible (sane n/p), and use **share-weighted soft transitions** (distribution→distribution flow), not the argmax-per-week (which throws the whole distribution away).
- **Snapshot `territory_cofire`, don't re-derive it.** `territory_cofire` already carries 4 decayed timescales (hour/4h/day/week) — *richer* than a weekly re-derivation. The right design is a **cofire-snapshot table over time** (keep the rich signal, add history) — a storage/pipeline choice, not a modeling one. The activation-derived PPMI is the build-now fallback (coarser, weekly) when the snapshot job isn't there yet.
- **Interaction:** select an anchor → its (chance-normalized) evolving neighborhood; hover a transition → its share-weighted frequency + example windows. Shares the page `hoverDate`.
- **Reliability:** as a chance-normalized idiographic network it's genuinely Tier-A/basis-robust **once built right**; shipping the raw-co-occurrence version would put a volume-confounded graph that *looks* authoritative on the page — worse than none. Promote above coherence. Co-fire edges are still associational (label honestly, not "linkage").
- **Dependency:** realm/theme transitions need the realm/theme layer to be *consistent + named* — which re-surfaces the clustering-reconciliation blocker (realms currently collapsed to 2 + id-inconsistent). So B1-done-right is gated on that, not just on naming.

### 3.6 Novelty surface — + new
- **Purpose:** *am I breaking new ground or circling familiar ground* — globally and per-territory. Never "smarter/better"; only "wider/narrower."
- **Multi-grain (per the metric-spec correction):**
  - **Coarse** (whole-history / whole-territory aggregate): **surrogate-normalized LZ** (reliable here).
  - **Fine** (per-territory, per-moment): **embedding-novelty** (NN distance) as primary — it degrades gracefully at short n where LZ saturates to 1.0 artifactually. LZ is the coarse cross-check only.
  - **Text compressibility (gzip):** basis-independent, the most reliable novelty signal — keep as a convergent weak signal.
- **Display:** a novelty field/surface readable globally and per-territory; convergent signals agree → trust, disagree → show both.
- **Reliability:** text gzip = A; coarse LZ = B (validated math, #296 fix); embedding-novelty = Tier-1, surface only as the CVP gate allows.

### 3.7 Event anchors — + new (the ground-truth engine)
- **Purpose:** the person's *upward* annotations; the labeled-data loop that makes correlation/prediction *measurable* instead of asserted.
- **⚠️ Primary capture is system-PROPOSED, not retrospective scrolling.** Retrospective self-recall captures only ~70% of events with date + valence reconstructed under hindsight bias — and for a metric whose whole job is to *be* ground truth, biased labels → biased correlation → false confidence. The mitigation is in-situ capture. So the primary path: the system detects a shift → **prompts near when it happened** ("something moved here around [date] — what was it?") → the person confirms/labels. That's in-situ-ish (low recall bias) and produces labeled pairs *at the right moments*, which scrolling never will. This is where "the AI is the third writer" lands concretely, and it **couples B2 to B3/P3** (they detect the shifts worth prompting on). Free-text **"anchor anytime"** is the fallback, not the main road.
- **Stored as** `{date (fuzzy/range OK — "around mid-March"), label (free-text; no structured taxonomy in V1), valence, valence_ts, note?}`.
  - **Valence/direction is required, but not binary, and timestamped** — EWS are direction-blind, so the human's label is the *only* way to learn direction. Offer **good / hard / neutral / mixed / unsure** (forcing binary is its own dishonesty; "mixed"/"unsure" are real signal). **Timestamp the valence** (anchored-at-the-time vs reconstructed-later is itself signal).
- **Two payoffs from one capture:** (1) per-user `(shift ↔ event)` correlation over time; (2) CVP labeled data for the validity gate.
- **Display:** event markers overlaid on every time graph (the bidirectional timeline); an **"since [event]"** lens that splits any chart before/after — *"since you started the new project, your Water dropped 30% and your trajectory accelerated."*
- **Storage:** new `user_events` table + `GET/POST /portal/events/anchor` (distinct from the existing `cognitive_events` system-detected events). Encrypted (label/note/valence are personal).
- **Reliability:** the anchor itself is ground truth; any "since X" delta is descriptive, baseline-relative.

---

## 4. Cross-cutting interactions

- **Shared-hover sync (makes it one instrument):** hovering any week highlights *that same window across every stacked graph at once* — river, week×top-3, anchor count, movement, connectivity. One hovered date, one cursor line, every lens lit. Implement as a single page-level `hoveredWeek` store the graphs subscribe to.
- **The bidirectional timeline:** system shift-marks below the axis, user event-anchors above it; tap either to inspect; the overlap is the correlation surface.
- **Drill-to-evidence:** every derived claim is clickable to its window → territories → messages. The week×top-3 is the universal drill-floor.
- **Cross-graph "since" lens:** dropping an event-anchor (or selecting one) re-frames every chart as before/after that date.

---

## 5. The staircase, as interaction (detection → correlation → prediction)

Mirrors the metric spec; this is how each stage *appears*:

- **Detection (ships now):** shift-marks on the timeline; tap → "what moved" (top contributors) + drill to messages. Honest, checkable.
- **Correlation (earned, quiet):** the event-anchor loop runs in the background; no claims until enough anchored pairs accrue. The UI never asserts a shift "means" something — it invites the person to anchor what it was.
- **Prediction (present-tense only, gated):** the early-signal battery (autocorrelation↑, perturbation-from-baseline, **recovery / return-to-cycling time**) renders **only as present-tense observation** — *"you've taken longer than usual to return to your baseline rhythm these past three weeks."* Never *"a transition is coming."* Direction-blind by construction; the person's anchored valence is what could ever add direction. Recovery-time = the lag for velocity-z to fall back below threshold after a spike (computable from the trajectory; cross-check `criticality` ar1/variance) — **with an N-floor like every other signal** (needs a minimum run of windows before it reads anything; below it, say so).

---

## 6. Reliability → display mapping

| Tier (per metric spec) | Components | Display rule |
|---|---|---|
| **A — validated / counts** | week×top-3, anchor count, active count, turnover, Fisher-z (within-run), text-gzip novelty, transitions | Stated plainly, named territories, baseline-relative |
| **B — heuristic** | coarse LZ, coherence (as texture), phase labels, co-fire | "pattern, not verdict" badge; softer language |
| **C — experimental / CVP-pending** | embedding-novelty (fine), harmonics amplitude, affect | opt-in, "not yet validated" badge; coupling (PAC/PLV) **off the page entirely** |

---

## 7. Build order (reliable-now first)

**0. Territory naming — kick off NOW, in parallel (the real unblock).** A map of "Territory 2660" is illegible regardless of the title, so naming is the true first move — but it's *backend* (a describe-pipeline pass), so it runs alongside the frontend work, not before it. ⚠️ Must be a **describe-only** pass — a full re-cluster collapses realms (known issue), so this is owned by the pipeline/metrics-audit session or a verified describe-only trigger, not a blind re-run.

Frontend, in order:
1. ✅ **Title fix** + now-line header (shipped, #312).
2. ✅ **Shared-hover sync** (river + week×top-3) — the "one instrument" backbone (shipped, #312).
3. ✅ **Week × top-3 territories** — the drill-floor (shipped, #312; counts derived from share×weekly-volume, not yet raw `clustering_points`).
4. **B1 — Connectivity as an idiographic temporal network** (§3.5): PPMI/partial-correlation + sparsify (NOT raw co-occurrence), realm/theme share-weighted transitions, cofire-snapshot. **Do not ship the naive raw-co-occurrence version.** Gated on the realm/theme layer being consistent + named.
5. **B2 — Event-anchor**, primary path = **system-proposed at detected shifts** (in-situ), free-text anchor as fallback (§3.7). Run **alongside B1** — it's the keystone and couples to B3/P3, not to B1. Capture/storage/overlay infra is unblocked now; the system-proposed path lands with shift-detection.
6. **B3 — Movement shift-marks** — once depth-invariant `D_K`/mean-step columns land; uses `velocity_baseline_z`; each mark renders its **P3 agreement quadrant** (or "cross-check pending").
7. **Novelty surface** (gzip + coarse LZ now; embedding-novelty fine grain as CVP allows).
8. **Texture** (coherence-as-flow; harmonics exploratory) — last, most gated.
9. **Recovery/early-signal battery** — present-tense only, after the anchor loop exists to (eventually) validate it.

---

## 8. Open questions & dependencies

- **Naming (blocking legibility):** 218/312 territories unnamed → bands read "Territory 2660". Re-run the describe pipeline (describe-only — no re-cluster); zero frontend change after ([FINDING-territory-naming-incomplete](FINDING-territory-naming-incomplete-2026-06-19.md)). This is the real first move (§7.0).
- **Dimension-aware Fisher smoothing (metric/pipeline spec):** the per-category ε = 0.01 × n smoothing distorts the velocity-z's σ-unit across scopes (territory vs realm aren't comparable). Fix = ε = α/n with a fixed total prior mass. New this session — belongs in the metric spec; until it lands, "validated within run" is optimistic across scopes (§3.4).
- **Fisher depth-invariant columns:** `D_K` (windowed displacement) + mean step size are computed inline but not persisted; the Movement component needs them as clean columns/fields, not the cumulative `fisher_*` columns (§3.4).
- **Per-week-per-territory message counts:** week×top-3 currently uses `round(share × weekly volume)` (lightly smoothed); a `clustering_points`/`messages` aggregation would give true raw counts if the approximation proves insufficient.
- **Connectivity measure (B1) — the methodology, not just the data:** must be chance-normalized (PPMI → partial-correlation) + sparsified, never raw co-occurrence (volume-confounded); transitions at realm/theme + share-weighted (territory-level undersamples to noise). Reference estimators: Epskamp's graphicalVAR / mlVAR / bootnet ecosystem (patterns, not porting).
- **Cofire-snapshot pipeline job:** to show co-firing *drift*, `territory_cofire` (current-state only) needs periodic snapshots over time — a pipeline-side addition (owned by the metrics/pipeline session). Activation-derived weekly PPMI is the build-now fallback.
- **Realm/theme consistency for transitions:** B1's realm/theme transition matrix needs that layer consistent + named — same clustering-reconciliation blocker as the realm river.
- **In-situ anchoring couples B2↔B3:** the event-anchor's primary (system-proposed) path needs shift-detection (B3/P3) to know *where* to prompt; B2's free-text capture is unblocked, the proposed path lands with B3.
- **`user_events` storage + endpoints + encryption** — net-new; the event-anchor keystone (fuzzy/range dates, timestamped valence, free-text label).
- **Backward-coherence:** adopt the principle (proxy-confound-immune coherence); validate the specific method before it ships.
- **CVP gate (#294):** governs when embedding-novelty / affect / any Tier-1 construct may be stated rather than hedged.
- **Realm altitude:** the named *realm*-level river remains gated on clustering reconciliation ([FINDING-clustering-run-inconsistency](FINDING-clustering-run-inconsistency-blocks-topic-river-2026-06-19.md)); ship at territory altitude meanwhile.

---

*Companion to the metric/validity spec. The page is one bidirectional timeline: the system marks where your thinking shifted, you mark what you lived, and over months the overlap — not a forecaster — is what lets you and the AI recognize your real patterns. Detection ships now; correlation is earned through anchored events; prediction stays present-tense until your own data proves otherwise.*
