# DESIGN — Fisher "movement" metric faithfulness (depth + scope)

**Status:** LOCKED design, research-agent bounce RESOLVED (2026-06-19). Ready to build P0.
**Date:** 2026-06-19
**Branch (when built):** `fix/fisher-faithfulness`
**Skill:** sweep-first-design (5 parallel Explore sweeps + own-eyes verification of every load-bearing claim)

### Revision history
- **v1** — sweep + initial design (4 open questions, Part 8).
- **v3 (P0 BUILT, 2026-06-19)** — branch `fix/fisher-faithfulness`. Display-layer only (no migration, no recompute): `src/metrics/baseline-z.js` (reusable trailing-exclusive baseline-z primitive, degenerate fail-closed) + `velocity_baseline_z`/`entropy_baseline_z` in `/trajectory/summary` + headline + retired cumulative toggle options in `CuriousLifeView.svelte` + `verify:fisher-display` gate (8/8 GO). **The gate's two assertions — honest-headline AND degenerate-fail-closed — are the construct-validity test for this metric in miniature, the same discipline the CVP gate enforces globally; this is the template for any future metric's display contract.** All four build-specifics baked in: trailing+exclusive baseline (D5), std≈0 fail-closed (D3/D4), run-boundary safe (one pinned `clustering_run_id`), #307 coordination (docs-only → no live collision). **Deferred fast-follow:** theme-default chart altitude (entangled with the realm/clustering-run reconciliation blocker) — kept at realm for now.
- **v2 (research-agent bounce, 2026-06-19)** — both code-verified refinements affirmed. P0 gains a **baseline-relative** headline z (`velocity_baseline_z`) — the pooled-null z describes "above noise," but the headline copy promises "unusual for me," which is a *different* number that disagrees exactly for a stable low-volume writer (high pooled-z, low baseline-z). All 4 questions resolved (see Part 8); none required a structural rethink. P1 (smoothing recompute) demoted to opportunistic-only — entropy's dimension inflation is fixed by displaying it as a baseline-z too, not by recomputing.

### The through-line (state this once, globally, in the page spec)
**Every "weird number" this session — cumulative R, LZ pinned at 1.0, territory-scope distortion, entropy inflation — has the same fix: display the self-normalized / baseline-relative form, never the raw accumulator.** Fisher pooled-z, LZ surrogate-normalization, velocity-baseline-z, entropy-baseline-z are one principle. This is why P0 (the display contract) is the real fix and P1 (recompute) is mostly avoidable. The page spec should assert this rule globally so no future metric re-introduces a raw accumulator.

---

## Part 0 — Headline

The Fisher **foundation is faithful** and should be built on, not replaced:

- Fisher-Rao geodesic `d = 2·arccos(Σ√(pᵢqᵢ))` is the exact closed form — `fisher.py:77-87`.
- `null_model_z` resamples from the pooled distribution at the **same message_count and same dimension** as the observed week — so the z-score is **count- and dimension-aware by construction** — `fisher.py:205-247`.
- Phase already reads `phase_recent` (rolling 90-day), not the degenerate cumulative phase — `compute-fisher.py:688-689`, #286.

The problems are entirely about **which derived quantities are depth/scope-invariant and which are not**, and which ones the page surfaces. Two code-verified refinements to the research-agent hypotheses:

1. **The displayed `exploration_ratio` is ALREADY period-windowed**, not the degenerate cumulative column. The REST endpoint filters rows to the period (`cutoff = now − PERIOD_DAYS[period]`) and recomputes D/L over the period's first/last rows — `portal-measurement.js:280-290`. So "R decays with depth" does **not** manifest in that headline stat. It manifests elsewhere (see below). The research agent's "the page is at risk of displaying the cumulative R" is half-true: it displays a *period-windowed* R, but it *also* exposes the raw cumulative columns through the chart toggle.

2. **The z-score and R are largely scale-invariant**, so the scope (smoothing) artifact is **real but narrower** than "a 3.6σ at territory ≠ a 3.6σ at realm." The z is standardized (smoothing rescales observed AND null together → cancels to first order); R = D/L is a ratio (scale cancels); phase thresholds on R inherit that. The smoothing distortion bites the **raw velocity magnitude** and **activation_entropy** (a 192-dim smoothed vector has an inflated entropy floor) — quantities that ARE cross-scope-compared and ARE plotted. This reorders the fix priority: the display contract (Phase 0) is what fixes what the user sees; the smoothing change (Phase 1) is correctness hygiene whose effect on the *headline* is small.

**The fix is a display contract + a smoothing-primitive correction + an optional basis-free cross-check** — same shape as the LZ and topology fixes.

---

## Part 1 — What is faithful (build on this)

| Component | Verdict | Evidence (own-eyes) |
|---|---|---|
| Fisher-Rao distance | Exact closed form | `fisher.py:77-87` |
| `null_model_z` resampling | Count + dimension aware; pooled-null; clamped (K1) | `fisher.py:205-247` |
| `phase_recent` (90-day rolling) is authoritative | Milestones + phase read recent, not cumulative | `compute-fisher.py:688-689`, #286 |
| Displayed `exploration_ratio` | Period-windowed recompute, not cumulative column | `portal-measurement.js:280-290` |
| At-rest encryption | 8 metric columns enveloped, structural plaintext | `compute-fisher.py:107-115` |

---

## Part 2 — What is broken (ranked by user-visible impact)

### B1 — Cumulative columns plotted as a time series (DEPTH artifact, HIGH user impact)
The chart metric toggle lets the user select `fisher_trajectory_length` (cumulative L → monotonic ramp) and `fisher_displacement` (since-anchor D → saturates toward π) — `CuriousLifeView.svelte:54,129-133`. Plotted over time these are depth-dominated and read as "weird numbers." `displacement_normalized = since-anchor D / π` is also surfaced — `portal-measurement.js:306`.
**These are the literal "scope and temporal depth" numbers the user saw.**

### B2 — The honest envelope (`velocity_z`) is computed but never headlined (HONESTY gap, HIGH)
`fisher_velocity_z` is stored and even returned (`avg_velocity_z`, `peak_velocity.z`) — `portal-measurement.js:295,303` — but appears **nowhere** in the component (no σ binding, not in the chart toggle). The page leads with the phase badge + a raw-velocity sparkline, not "this week is X.Xσ above your 90-day normal." This is the "validated-mathematical, trustworthy" number the research agent (correctly) wants as the headline.

### B3 — Scope-dependent smoothing (SCOPE artifact, MEDIUM — narrower than claimed)
`EPSILON = 0.01` added **per category**, normalized by the total → total pseudo-mass = `0.01 × n_categories` — `fisher.py:61-62, 71-72`. Realm (~13) ≈ 0.13; territory (~192) ≈ 1.92. Effect, corrected for scale-invariance of z/R:
- **Distorted:** raw `fisher_velocity` magnitude (territory systematically smaller), `activation_entropy` (inflated floor at high dimension). These are cross-scope-compared and plotted.
- **Largely protected:** `fisher_velocity_z` (standardized), `exploration_ratio`/`R_recent` (ratios), `phase` (ratio thresholds).

### B4 — Two overlapping ~90-day exploration ratios (CLARITY, LOW)
`exploration_ratio` (period=quarter recompute) and `R_recent` ("recent reach") are both ~90-day and shown together — `portal-measurement.js:290,317` → `CuriousLifeView.svelte:684,687`. Redundant/confusing.

### B5 — Movement reads are not surface-gated (CONSISTENCY, MEDIUM)
Vitality/anchors route through the CVP surface-gate (#294); `db.fisher.getTrajectory` has no freshness/confidence guard — `src/db/fisher.js`. A stale or low-window movement card can present numbers as authoritative.

### B6 — Clustering-basis dependence (ROBUSTNESS / SOTA, MEDIUM)
The simplex basis is `SELECT DISTINCT territory_id` over all-time clusters — `extract_activations.py:80-107`. Re-clustering redraws the basis, so a velocity spike can reflect "the map was redrawn," not real movement. A basis-free embedding-space trajectory is the modern cross-check and is **cheap and feasible** (~1-2s Python; reuse harmonics decrypt path) — sweep 5.

---

## Part 3 — The fix (phased, each independently shippable)

### Phase 0 — Display contract (no recompute, NO migration; highest honesty/lowest risk; ship first)
**Principle: surface self-normalized / baseline-relative quantities; never raw accumulators as headline numbers.** Entirely display-layer (REST summary shaping + Svelte) — all inputs are in the already-fetched `weekly_step` series.

1. **Headline = `velocity_baseline_z` (the "unusual for ME" number), gated by the pooled-null z (the "above noise" number).** These are different and must both appear:
   - `velocity_baseline_z = (v_now − mean(v over the K=13 recent windows)) / std(those v)`, where `v = fisher_velocity` per `weekly_step` window. Computed in the REST summary endpoint from the last K=13 fetched rows — **no pipeline change, no migration** (reuses the same 90-day slice `R_recent` already implies).
   - The existing pooled-null `fisher_velocity_z` (`fisher.py:205-247`) stays as the **confidence gate** behind the headline ("is it even above measurement noise").
   - Honest combined copy: *"a real change (above noise) and a large one for you (3.6σ)"* vs *"a real change, but a typical size for you"* (high pooled-z, low baseline-z — the stable low-volume writer case the pooled-z alone would misreport).
2. **Display `activation_entropy` as a baseline-z too** — `entropy_baseline_z` over the same K=13 slice. The per-category smoothing inflates raw entropy toward `log n` at high dimension, but that inflation **cancels in the baseline-z exactly like velocity's does** → this removes entropy from the list of reasons to recompute the smoothing (see P1).
3. **Retire cumulative columns from the chart toggle.** Drop `fisher_trajectory_length` and `fisher_displacement` from `moveMetricOpts` (`CuriousLifeView.svelte:129-133`); default the series to `fisher_velocity` with a `velocity_baseline_z` band option. Keep the columns as internal/archival (do not delete).
4. **Stop surfacing `displacement_normalized`** as a headline (or relabel "net travel since you started — archival").
5. **Scope contract (Q4 resolved):** **realm = headline σ** (most reliable/stable, least distorted); **theme = default chart altitude** (resolution without territory's noise + basis instability); **territory = opt-in drill only**, with the wide-noise-band caveat. **Never headline territory-σ.** Pragmatic sequencing: realm-level is currently blocked on the clustering-run reconciliation, so **ship theme-as-default now, promote the realm headline once that lands.**
6. **Consolidate B4:** one recent reach (R_recent), window labeled; drop or clearly distinguish the redundant period-recompute.

### Phase 1 — Dimension-aware smoothing (DEFERRED to opportunistic-only; Q1 resolved)
**Do NOT ship as a standalone migration.** The bounce confirmed: z/R/phase are scale-protected, and entropy — the one surfaced quantity smoothing genuinely distorts — is fixed in P0 by displaying it as a baseline-z (the dimension inflation cancels). So a standalone full recompute "barely moves the headline" and isn't worth it.
- **When it does happen** (only when the stage already recomputes for another reason, e.g. a re-cluster): replace per-category `EPSILON` with a **constant total concentration** (Perks/minimax Dirichlet): `epsilon_i = α / n`, `α = 1` (total pseudo-mass = 1 message-equivalent at every scope).
- **Caller audit (load-bearing, applies whenever P1 lands):** `null_model_z` calls `activation_vector_from_array(...)` with the *default* epsilon — `fisher.py:235-236`. The new `α/n` epsilon MUST thread into BOTH the observed activation vectors AND the null resampling, or observed and null use different priors and the z breaks. Every caller of `activation_vector` / `activation_vector_from_array` must pass the same dimension-aware epsilon.

### Phase 2 — Surface-gate movement (consistency)
Route `db.fisher` movement reads through the same CVP/freshness surface-gate as vitality/anchors (#294): require a minimum confident-window count and freshness before presenting numbers as validated; otherwise return the "early signal · advisory" envelope the component already renders.

### Phase 3 — Basis-free embedding-trajectory cross-check (SOTA robustness; optional)
New `pipeline/compute-embedding-trajectory.py` (Python — `embedding_768` is NEVER_AUTO_DECRYPT, `crypto-local.js:1784-1795`):
- Reuse `fetch_envelopes_chunked` + `decrypt_vectors` (768D float32) — `compute_information_harmonics.py:404-446`.
- Join embeddings → `clustering_points` for `(territory_id, realm_id)` (~15 lines new join, sweep 5).
- **Metric (Q3 resolved): centroid angular distance as PRIMARY + one cheap dispersion scalar — NOT Fréchet/MMD.** Full Fréchet needs a 256/768D covariance from ~100–300 weekly messages (n ≲ d → badly conditioned exactly where robustness is needed). Per-week-per-scope **centroid**; velocity = angular/cosine distance between consecutive week centroids (degrades gracefully at low n, directly interpretable: "your semantic center moved"). Centroid is blind to spread, so pair it with **mean within-week cosine-to-centroid** ("did the week diversify") — captures what Fréchet would without the conditioning disaster. Two robust scalars > one fragile distributional distance. (MMD only if centroid+dispersion later proves to miss something real.)
- Headline these as a baseline-z (same principle); z-normalize against the recent-window baseline.
- Store + display as a **cross-check** beside the Fisher velocity: agreement ⇒ "real movement"; divergence ⇒ "the clustering redrew the map." Health via `stage_result.run_main`; encrypt via `stage_crypto.enc`.
- Cost: ≤1–2s/vault (sweep 5).

**Unifying principle across LZ, complexity-novelty, and movement: normalize the observed value against the same-dimension, same-N null, and display the normalized form — never the raw accumulator.**

---

## Part 4 — Verification table (every load-bearing assumption, own-eyes)

| Assumption | Verified at |
|---|---|
| Fisher-Rao distance is the exact closed form | `pipeline/fisher.py:77-87` (read) |
| Smoothing is per-category → total mass = ε×n_categories | `pipeline/fisher.py:61-62, 71-72` (read) |
| `null_model_z` resamples at same count + same dimension (z is scale-robust) | `pipeline/fisher.py:205-247` (read) |
| Stored `exploration_ratio`/`length`/`displacement` columns are cumulative | `pipeline/compute-fisher.py:678-680` (sweep, quoted insert+params) |
| Anchor = first ≥N_MIN window, static for the series | `pipeline/compute-fisher.py:596-601` (sweep, quoted) |
| `R_recent`/`phase_recent` are the windowed fix, written alongside cumulative | `pipeline/compute-fisher.py:643-689` (sweep, quoted) |
| Displayed exploration_ratio is period-windowed recompute, not the cumulative column | `src/portal-measurement.js:280-290` (read) |
| `displacement_normalized` (since-anchor D/π) is surfaced | `src/portal-measurement.js:306` (read) |
| Chart toggle exposes cumulative `trajectory_length` + `displacement` | `portal-app/.../CuriousLifeView.svelte:54,129-133` (read) |
| `velocity_z` is in the REST payload but headlined/plotted nowhere in the component | `portal-measurement.js:295,303` (read) + grep σ/velocity_z in component = none |
| Category basis = all-time `DISTINCT territory_id/realm_id/theme_id` | `pipeline/extract_activations.py:80-107` (sweep, quoted) |
| `embedding_768` is NEVER_AUTO_DECRYPT → cross-check must be Python | `src/crypto/crypto-local.js:1784-1795` (sweep, quoted) |
| Embedding decrypt path reusable; per-week-per-scope feasible ≤2s | `compute_information_harmonics.py:404-446` (sweep, quoted) |

---

## Part 5 — Threat model / security

- Phase 3 reads `embedding_768` (semantic fingerprints, CLAUDE.md §7). It MUST be Python via the existing decrypt path; results stored via `stage_crypto.enc` (enveloped). No new plaintext surface; no embedding vector leaves Python. No logging of vectors.
- Phases 0–2 touch only already-decrypted metric columns through `db.fisher`. No new boundary.
- Phase 1 recompute writes through the existing caller-encrypt path; no schema-encryption change.

---

## Part 6 — Test strategy

- `verify:fisher` — extend: assert the chart-facing payload no longer leads with cumulative columns; assert `velocity_z` present + finite; assert dimension-aware epsilon (Phase 1) makes realm vs territory raw-velocity scale comparable on a seeded two-scope fixture (the cross-scope-comparability invariant).
- New `verify:fisher-display` (Phase 0) — gate the display contract: REST summary computes `velocity_baseline_z` (mean/std over K=13) AND keeps pooled-null `velocity_z` as the gate; assert the stable-low-volume case (high pooled-z, low baseline-z) is reported honestly on a seeded fixture; `entropy_baseline_z` present; cumulative columns NOT in the toggle set; theme is the default chart altitude.
- Phase 1 caller-audit gate: a test that the SAME epsilon flows into both observed and null (compute z with α/n and assert null used α/n, not 0.01).
- Phase 3: `verify:embedding-trajectory` mirroring `verify:embedding-novelty` (stage exits 0, rows written + enveloped, centroid-drift deterministic under seed, agreement metric vs Fisher velocity sane on fixture).

---

## Part 7 — Implementation order

1. **Phase 0** (display contract — REST shaping + Svelte; no migration, no recompute). Ship + live-verify on the rebuilt app. *This is the user-visible fix.* Ship **theme-as-default** now; the realm headline σ promotes once the clustering-run reconciliation lands.
2. **Phase 2** (surface-gate) — small, consistency.
3. **Phase 3** (embedding cross-check) — new independent Python stage (centroid angular + dispersion).
4. **Phase 1** (smoothing) — **deferred, opportunistic-only**: fold into the next re-cluster recompute, never as a standalone migration.

---

## Part 8 — Research-agent bounce: RESOLVED (2026-06-19)

1. **Is Phase 1's full recompute worth it?** → **No — defer to opportunistic-only.** z/R/phase are scale-protected; entropy (the one distorted surfaced quantity) is fixed by displaying it as a baseline-z (P0.2), so the dimension inflation cancels without recompute. Do the Perks α=1 ε only when a re-cluster recomputes anyway; never as a standalone migration.
2. **velocity_z headline framing / null choice?** → **Both nulls, different jobs.** Pooled-null = "signal vs measurement noise" = the **confidence gate**. Baseline (mean/std over K=13) = "unusual vs my own dynamics" = the **headline** (what the copy already promises). Prefer the mean/std baseline over a history-shuffle surrogate — equivalent at K=13, cheaper, no resampling. Folded into P0.1.
3. **Embedding metric: centroid angular vs Fréchet/MMD?** → **Centroid angular distance primary + a dispersion scalar (mean within-week cosine-to-centroid); NOT Fréchet** (n ≲ d conditioning failure). Folded into P3.
4. **Primary scope: realm vs theme?** → **Realm = headline σ; theme = default chart altitude; territory = drill-only (never headline territory-σ).** Realm-level is currently blocked on the clustering-run reconciliation → ship **theme-as-default now, promote realm headline once that lands.** Folded into P0.5.

**Verdict: ship P0 (with `velocity_baseline_z` folded in) as the first change. No structural rethink required.**
