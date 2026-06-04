# Measurement Layer — Honest State (as-built) — 2026-06-04

> **Purpose.** Mark the *true* current state of the measurement layer before we
> bring it out, fill the gaps, and redesign it. This is the shared reference for
> that work. Companion: [`MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md`](MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md).
>
> **Evidence standard.** Every claim below was read against source and the
> load-bearing ones grep-verified (no writer / no route / dead table). Citations
> are `path:line` in this repo. Where the code *advertised* something it doesn't
> do, the lie has been corrected in code in this same pass — see §8.
>
> **Scope.** This describes V1 (`src/` + `pipeline/`), not the canonical
> production system (`reference/`). The gap between them is a first-class subject
> here, because much of the redesign is "what survived the port, and should it?"

---

## 1. What the measurement layer is (and is meant to be)

The project positions measurement as the **entire moat**, not a feature:
*"Storage is commodity… measurement is the moat"* (`docs/VISION.md:96`; README
"The Measurement Layer"). Three advertised pillars:

| Pillar | The claim | Where computed |
|---|---|---|
| **Topology** | clustering → 200–400 hierarchical "territories" that split/merge | `pipeline/cluster.py` |
| **Co-firing** | which territories activate together across time windows | `pipeline/compute-cofire.js` |
| **Harmonics** | H0 entropy · β autocorrelation · γ momentum · α complexity — "the signature of how your mind moves" (§4.23/§4.33/§4.34) | `pipeline/compute_information_harmonics.py` + `harmonics.py` |

Plus a fourth, less-advertised surface that the agent tools assume exists:

| Pillar | The claim | Where computed |
|---|---|---|
| **Fisher trajectory** | cognitive *movement* — phase (stable/cycling/exploring/transforming), velocity, milestones; "getCurrentPhase" | **nowhere — see §3.4** |

Aspirational headline claims (the destination, not the build): *"detect cognitive
regime shifts before conscious awareness," "7+ distinct cognitive modes from
metric signatures alone," "phase transition detection"* (`docs/VISION.md:110-115`).
The design docs (`docs/reference/MEASUREMENT-PLANE-PR0.1/0.2/1.5-B3-*.md`) carry an
unusually rigorous **scientific-honesty discipline** (citation hygiene, "bands ≠ EEG
Hz," `low_confidence` hardwired on until calibration) — that discipline is the
asset we should preserve and extend.

---

## 2. The pipeline (5 stages) and how it runs

Spawned **only** by the user clicking **Generate** → `POST /api/v1/portal/mycelium/generate`
(`src/portal-mindscape.js:284`) → `startClusteringJob()` (`src/jobs.js:41`) →
`spawn('bash', ['pipeline/run-clustering.sh'])` (`src/jobs.js:97`). **No cron, no
timer** — generation is 100% user-initiated. Single-flight, 45-min cap, 5-min
stall watchdog; keys re-resolved at spawn and passed via an env allowlist only,
never argv, never logged (`src/jobs.js:58-80`).

```
1 sync      sync-clustering-points.js          messages w/ embedding_768 → clustering_points (768D→256D matryoshka)
2 cluster   cluster.py                         spherical k-means + Ward HAC → atoms/territories/themes/realms
3 describe  describe-clusters.js + describe-chronicles.js   names + essences + narratives (local Claude/Ollama, fail-soft)
4 cofire    compute-cofire.js                  territory co-firing edges (4 time-window buckets, time-decayed)
5 harmonics compute_information_harmonics.py   the 41 cognitive metrics
```

**Era.** An "era" is a string `clustering_run_id`, *derived* (not stored as a row)
from `pipeline_state(stage_name='cluster').last_success_at`. Reader
(`db.metrics.getCurrentEra`, `src/db/metrics.js:90-112`) and writer
(`pipeline/stage_base.py:56-92`) agree exactly, so the harmonics partition key is
consistent across the JS/Python boundary. Cold start → `era-bootstrap-YYYY-MM-DD`.

---

## 3. Subsystem-by-subsystem (as-built)

### 3.1 Topology / clustering — `pipeline/cluster.py` (~1880 lines) — **REAL**

- **Input:** 256D **matryoshka** truncation of the 768D `embedding_768` envelope,
  re-L2-normalized (`cluster.py:540-561`). Derived from the search embedding, not
  re-embedded. Attachments without `embedding_768` fall back to a local ONNX int8 pass.
- **Algorithm:** spherical k-means for atoms (`:674-708`), then **Ward agglomerative
  HAC** on the centroids of the level below for territories→themes→realms
  (`centroids_to_groups`, `scipy linkage(method='ward')` at `:759`; called `:821/828/843`).
  Nesting guaranteed by construction. Realm count via elbow on Ward merge distances,
  clamped 5–10.
- **Leiden is dead code in the hierarchy.** `leiden_for_k` (`:646`,
  `leidenalg.find_partition`) is defined/imported/parameterized but **never called**
  for clustering — rejected for pathologically imbalanced CPM output (`:805-819`).
  The FAISS k-NN graph it would consume survives, repurposed for **noise detection**
  only (`detect_noise`, `:765-780`). *(Labels that said "Leiden" were corrected — §8.)*
- **Counts:** `territories = clamp(n//300, 30, 300)` (`:88`). The **"200–400 territories"
  claim is overstated** — hard-capped at 300, ~150 at the design size of 45k points.
- **3D coords:** UMAP, **visualization-only**, decoupled from clustering (`:882-891`).
- **Cross-run identity:** membership **Jaccard** stabilization (`:913-1095`) with
  anchored-territory relaxation + centroid-cosine backup + lineage inheritance —
  genuinely sophisticated and complete. Events `formed/grew/stable/dissolved` →
  `cluster_events`. There is **no `shrank` event** (shrink folds into `stable`,
  `:996`) and **no `stuck` growth_state** (only growing/steady emitted, `:1495-1501`).
- **Per-territory dynamics** (`compute_dynamics`, `:1418-1541`): `energy` = attention
  share; `coherence` = mean pairwise cosine (sampled to 50); `velocity` = centroid
  drift — all real. **But `current_vitality`/`current_phase` are never written**, so
  they keep schema defaults `0.5` / `'gift'` for every territory.

### 3.2 Co-firing — `pipeline/compute-cofire.js` — **REAL**

For each territory-assigned point, bucket `created_at` into 4 windows — immediate
(hour), session (4h), daily, weekly — and within each, every co-present territory
pair accrues `weight = 0.5^(daysAgo/halfLife)` (`:51-55`), excluding catch-alls.
**Doc/intent drift (now flagged in code, value TBD in redesign):** the schema column
comments used to say half-lives 1h/4h/24h/7d, but the code decays with **7/14/30/90
days** (`compute-cofire.js:51`). The *window bucket* (hour/4h/day/week) and the *decay
half-life* (days) are two different axes; the old comment conflated them. Whether
7/14/30/90d is the intended design is an open question (§7, Q3).

### 3.3 Harmonics — the 41 metrics — **REAL, literature-grounded, uncalibrated**

- **Signal under everything:** `info_value(t) = 1 − cos_sim(e_t, e_{t+1})` over
  chronologically-ordered 768D embeddings — a semantic-**jump** series
  (`compute_information_harmonics.py:244-262`). Everything downstream is 1-D signal
  processing on this.
- **Bands (5) = temporal aggregation scales, NOT EEG Hz** (`harmonics`/`:88`):
  gamma=raw per-message · beta=10-msg rolling mean · alpha=daily-bin · theta=weekly-bin
  · delta=monthly-bin.
- **Granularities (3) = window grain** (a *separate* axis, confusingly sharing the
  alpha/theta/delta names): alpha=daily / theta=weekly / delta=monthly windows. One DB
  row = one (granularity, window_end); all 5 bands computed inside each window.
- **The 41** = **15** `harmonic_amplitude` (§4.23: 5 bands × K∈{1,2,3}) + **25** bigram
  flow (§4.33: mean_crossing_rate, slope_sign_change_rate, autocorrelation_lag1,
  variance, total_spectral_energy × 5 bands) + **1** `topology_h0_persistence_entropy`
  (§4.34). Verified by counting the UPSERT columns.
  - §4.23 = **OLS Fourier regression**, `A_k = √(β₁ₖ²+β₂ₖ²)` (`harmonics.py:28-99`).
  - §4.33 = standard EMG/bigram estimators; spectral energy via `np.fft` (Parseval).
  - §4.34 = **`ripser` Vietoris-Rips H0 persistence entropy** on a 256D matryoshka
    projection, only when **N ≥ 20** (`harmonics.py:201-252`) — the real source of the
    "N<20" floor. H1 (cycles) deferred (no gudhi ARM64 wheel).
- **Honest scaffolding, flagged in-code:** `low_confidence = True` is **hardwired on
  for every row** ("until Phase 6.2 calibrates," `:633`); the **41 `*_baseline_90d`
  columns are never populated**; **§4.24 cross-scale coupling (PAC/PLV/coherence) is
  explicitly deferred** (`:22-25`); `language='en'` hardcoded.

### 3.4 Fisher trajectory — **HOLLOW (wired for reads, no writer anywhere)**

This is the "cognitive *movement*/phase" subsystem behind `getCurrentPhase` (distinct
from harmonic "rhythm"). Tables `fisher_trajectory` + `fisher_milestones` exist
(`migrations/0001_init.sql:705-773`); `src/db/fisher.js` + `src/tools/fisher-tools.js`
read them end-to-end. **There is no writer — verified: zero `INSERT INTO
fisher_trajectory/_milestones` across `src/`, `pipeline/`, *and* `reference/`.** The
compute stage (`compute-frequency`/`check-milestones`) is among the 6 unported stages.
Consequence on a real vault: `getCurrentPhase` → `null`; `cognitiveState`'s movement +
alerts sections, `cognitiveHistory`'s trajectory + top movers — **all render their
empty-state strings.** One of the four surfaces the agent tools assume is entirely
absent.

### 3.5 Data model + MCP surface

```
message (embedding_768)
  └─sync→ clustering_points (256D, landscape_xyz)
        └─cluster.py→ territory_profiles · realms · semantic_themes · cluster_events · territory_lineage   [LIVE]
        └─compute-cofire.js→ territory_cofire (immediate/session/daily/weekly)                              [LIVE]
        └─harmonics.py→ cognitive_metrics_harmonic (41 metrics, keyed by era=clustering_run_id)             [LIVE]

NEVER WRITTEN (wired for reads, always empty): topology_audit_{snapshots,findings} ·
  territory_vitality · fisher_trajectory · fisher_milestones · current_vitality/current_phase ·
  cognitive_metrics_{window,trajectory,per_territory} · all *_baseline_90d columns
```

**Agent surface (the only registered MCP domain):** `buildDomains` registers **only**
`createCognitionDomain` (`src/mcp.js:115`) → exactly **3 Tier-2 tools** (the old 11
metrics/topology/fisher tools are *folded in* — their `.tools` arrays no longer
registered):

| Tool | Sub-parts | State |
|---|---|---|
| `cognitiveState` | Fisher movement + harmonic rhythm + milestones | movement/milestones **empty**; rhythm **LIVE** |
| `cognitiveHistory` | trajectory + named metric series + top movers | trajectory/movers **empty**; series **LIVE** |
| `mindscape(view)` | structure / territories / territory / time / explore | structure-health & explore-gaps **empty** (dead tables); territories/territory/time **LIVE** |

All 3 are **Tier-2-gated** by `clustering_points.total > 0` (`makeTopologyReadiness`,
`src/mcp.js:150-160`); until the pipeline has run once they return
`TOPOLOGY_NOT_READY_MESSAGE`.

---

## 4. The truth tables

### 4.1 Live & correct ✅
Clustering hierarchy · territory dynamics (energy/coherence/velocity) · co-firing ·
all 41 harmonic metrics incl. H0 persistence entropy · Jaccard stabilization +
lineage · era resolution (reader==writer) · the MCP rhythm / metric-series / topology
territory & time views · robustness plumbing (single-flight, key allowlist, watchdog,
deps preflight, fail-closed).

### 4.2 Wired but always empty ◑ — the read path exists, nothing populates it
- **Fisher trajectory** (`fisher_trajectory`, `fisher_milestones`) — no writer.
- ~~**Gaps** (`territory_neighbors`) — no writer.~~ **FIXED 2026-06-04** —
  `pipeline/compute-territory-neighbors.js` (centroid_256 cosine, top-K) now
  populates it; `getGaps` is live. verify:territory-neighbors GO (8/8).
- **Topology audit** (`topology_audit_snapshots`/`findings`) — no writer.
- **Territory vitality** (`territory_vitality`) — no writer.
- **`current_vitality`/`current_phase`** columns — never computed (show 0.50/'gift').
- **90-day baselines** (41 `*_baseline_90d`) — all NULL; `low_confidence` hardwired on.
- **`db.clusterEvents` namespace** — implemented but unwired (the table *is* written;
  nothing reads it through the namespace).
- **Dormant parallel tables** — `cognitive_metrics_{window,trajectory,per_territory}`
  (no reader/writer; the "next-gen" `era_id`-keyed designs).

### 4.3 Un-ported to V1 ✗ — exists in `reference/`, absent from `src/`
- **The entire measurement REST bridge:** `portal-metrics.js`, `portal-vitality.js`,
  `internal-metrics.js`, `portal-metric-freshness.js`. **Verified absent** — only
  `portalCompatRouter`, `portalMindscapeRouter`, `portalUploadsRouter` are mounted
  (`src/server-rest.js:89-91`).
- **`/portal/trajectory/*`** — only `/summary` is stubbed (`portal-mindscape.js:234-239`);
  the weekly-step series + milestones endpoints the Vitality page needs are absent.
- **6 pipeline stages:** embed-mindscape, topology-audit, compute-vitality,
  compute-cognitive-fingerprint, compute-frequency, check-milestones.

### 4.4 Drift / dishonesty ⚠️ — code that misdescribed itself (**fixed this pass, §8**)
cluster.py "UMAP+HDBSCAN" docstring · "FAISS+Leiden" comment/labels · growth_state
"stuck" · cofire half-life schema comment · run-clustering.sh header listing
describe-chronicles as unported.

**Drift NOT changed (user-facing or a redesign decision — flagged for the plan):**
- "200–400 territories" in `README.md` + `docs/VISION.md` (actual: capped 300, ~150 typical).
- Modules grid labels Vitality **"Active"** (`portal-app/.../modules/+page.svelte:44-51`)
  while its backend is absent and nav parks it under "Coming later."
- cofire half-life **values** (7/14/30/90d) themselves.
- §4.24 cross-scale coupling deferred; `low_confidence` hardwired; "7+ modes /
  pre-conscious regime detection" aspirational (spec itself flags §4.23 as
  "experimental, no published precedent").

---

## 5. The headline asymmetry

The portal UI for measurement shipped **byte-identical to `reference/`**
(`portal-app/.../vitality/+page.svelte`, `/modules`, the whole
`portal-app/src/lib/cognitive-metrics/` tab) — **but the REST routes that feed it were
never ported.** Net result:

> **An AI agent over MCP can read your harmonics; you (the human) cannot see any of it
> in the app.** The Vitality page would render "Era unavailable" / empty states, the
> freshness badge fails quiet, and the page is parked under "Coming later" anyway.

Closing this is the single highest-leverage "already built, just invisible" win.

---

## 6. Gap inventory (the work surface)

Stable IDs used by the buildout plan. Grouped by the truth-table buckets.

| ID | Gap | Bucket | Rough size |
|----|-----|--------|-----------|
| **G1** | Port the measurement REST bridge (metrics/vitality/freshness) into `src/` so the shipped UI renders real data | un-ported | M |
| **G2** | Port `/portal/trajectory/*` (weekly-step series + milestones), beyond the `/summary` stub | un-ported | S–M |
| **G3** | Build the Fisher/trajectory compute stage → write `fisher_trajectory` + `fisher_milestones` (fills the movement pillar) | empty | L |
| **G4** | ✅ **DONE (2026-06-04)** — `pipeline/compute-territory-neighbors.js` populates `territory_neighbors`; `getGaps` live (verify GO) | fixed | S |
| **G5** | Build topology-audit stage → `topology_audit_snapshots`/`findings` (M2 entropy / Gini / orphan/bridge counts) | empty | M |
| **G6** | Build vitality stage → `territory_vitality` + write `current_vitality`/`current_phase` (kill the 0.50/'gift' defaults) | empty | M |
| **G7** | Calibration: populate `*_baseline_90d`, define the rule that flips `low_confidence` off | empty | L (research) |
| **G8** | §4.24 cross-scale coupling as a stored metric family (PAC/PLV/coherence) | roadmap | L (research) |
| **G9** | Resolve the dormant parallel tables (`cognitive_metrics_{window,trajectory,per_territory}`) — adopt or drop | redesign | S (decision) + M |
| **G10** | Reachability + honesty of the human surface (nav out of "Coming later"; Modules "Active" badge) | drift | S |
| **G11** | Regime / "7+ cognitive modes" detection on top of the metric stack | aspirational | XL (research) |
| **G12** | Decide the fate of dead Leiden code + unused tables (keep/remove) after redesign | cleanup | S |

Sizes are gut-feel pre-research and will firm up with your canonical export + synthesis.

---

## 7. Open design questions (for the redesign)

These are the fork points where your canonical implementation + research synthesis
should land. Numbered for the plan.

- **Q1 — Movement pillar shape.** Do we port the canonical Fisher/trajectory compute
  as-is, or redesign it? The canonical surface had milestones + phases + z-scores; the
  design docs flag the old z-scores as "43–62σ physically impossible" (sample-size
  variance). What's the right estimator?
- **Q2 — Clustering algorithm.** Keep spherical k-means + Ward HAC (current, balanced,
  deterministic) or revisit? If we keep it, remove the dead Leiden/HDBSCAN code and the
  "Leiden" framing entirely (G12). Is the 300-territory cap right?
- **Q3 — Co-firing time model.** Are 7/14/30/90-day decay half-lives intended, or should
  decay match the bucket scale (the old 1h/4h/24h/7d intent)? What's co-firing *for*
  downstream (gaps? bridges? movement?) — that should drive the choice.
- **Q4 — Calibration & honesty.** What baseline (median+MAD? rolling 90d?) flips
  `low_confidence` off, and what's the minimum data before any metric is shown? This is
  the moat; it needs the research synthesis.
- **Q5 — Human vs agent surface.** Is the Vitality page the destination, or do we
  redesign the human-facing measurement UX from scratch? (UI components exist; the
  question is whether they're the right ones.)
- **Q6 — Metric taxonomy.** Keep the §4.x spec sections (and the un-ported §4.24), or
  re-derive the metric set from the research synthesis? Which metrics actually map to
  the aspirational claims (regime shifts, 7+ modes)?
- **Q7 — Schema convergence.** `cognitive_metrics_harmonic` (live, `clustering_run_id`)
  vs the dormant `cognitive_metrics_window` (`era_id`) and the two trajectory tables —
  converge on one model (G9).

---

## 8. Honesty edits applied in this pass (truth-telling only, no behavior change)

These corrected code that misdescribed what it does. **No algorithms, no deletions, no
schema DDL changed** — comments/docstrings/labels/strings only. (Deletions of dead
code/tables are deferred to the redesign — G12.)

| File | What | From → To |
|---|---|---|
| `pipeline/cluster.py:5-15` | module docstring | "UMAP + HDBSCAN" → spherical k-means + Ward HAC; UMAP viz-only; Leiden unused |
| `pipeline/cluster.py:74` | algo constant comment | "FAISS + Leiden" → k-means + Ward; FAISS=noise; Leiden unused |
| `pipeline/cluster.py:~1432` | dynamics docstring | growth_state "(growing/steady/stuck)" → notes 'stuck' is reserved/unassigned |
| `pipeline/run-clustering.sh:11-12,~85` | header + Step-2 label | "Leiden + Ward" → k-means + Ward; FAISS=noise only |
| `pipeline/run-clustering.sh:4-8` | header | "7 unported incl describe-chronicles" → 6 unported (describe-chronicles WAS ported) + lists the empty tables |
| `src/jobs.js:27` | user-facing Generate stage label | "Clustering (FAISS + Leiden + Ward)…" → "Clustering (k-means + Ward HAC)…" |
| `migrations/0001_init.sql:1322-1325` | cofire column comments | "half-life 1h/4h/24h/7d" → bucket vs. decay-half-life clarified (7/14/30/90d) |

Verified: `python3 -m py_compile pipeline/cluster.py`, `node --check src/jobs.js`,
`bash -n pipeline/run-clustering.sh` all pass.

---

## 9. Evidence index (key file:line)

- Invocation: `src/jobs.js:41,58-80,97` · `src/portal-mindscape.js:284` · `pipeline/run-clustering.sh`
- Clustering: `pipeline/cluster.py:88,540-561,646,674-708,759,805-819,821-854,913-1095,1418-1541`
- Co-firing: `pipeline/compute-cofire.js:35-55,113-197` · schema `migrations/0001_init.sql:1317-1330`
- Harmonics: `pipeline/compute_information_harmonics.py:106-183,244-262,633` · `pipeline/harmonics.py:28-99,201-252`
- Era: `src/db/metrics.js:90-112` · `pipeline/stage_base.py:56-92`
- Data layer: `src/db/{metrics,topology,fisher,mindscape}.js` · `src/db/index.js:42-77` · `src/topology/helpers.js` · `src/topology.js`
- MCP surface: `src/mcp.js:115,135-160` · `src/tools/cognition.js` · `src/tools/{fisher-tools,metrics,topology-tools}.js`
- Schema: `migrations/0001_init.sql` (cognitive_metrics_harmonic :275-371, fisher_trajectory :705-773, territory_profiles :1372-1406, territory_cofire :1317-1330)
- Un-ported bridge: `src/server-rest.js:89-91` (only 3 routers) · `reference/server-routes/{portal-metrics,portal-vitality,internal-metrics,portal-metric-freshness}.js`
- Human surface: `portal-app/src/routes/(app)/vitality/+page.svelte` · `portal-app/src/lib/cognitive-metrics/*` · `portal-app/.../modules/+page.svelte:44-51`
- Design intent: `docs/VISION.md:96,110-115` · `docs/reference/MEASUREMENT-PLANE-PR0.1/0.2/1.5-B3-DESIGN-2026-05-07/08.md`
