# Clustering Algorithm — Decision Log

**Date:** 2026-06-19
**Trigger:** `docs/METRICS-AUDIT-vs-LITERATURE-2026-06-19.md` finding **S5** — "the clustering substrate's k is unvalidated," and the corpus is "self-contradictory (Feb: keep HDBSCAN; Apr: drop it for Leiden) and the code matches *neither*."
**Scope:** record *why* the as-built hierarchy uses spherical k-means + mass-weighted Ward at deterministic √n targets when the two research docs recommend different things; document the spherical-Ward approximation; pin the validity-diagnostics decision. **This log reconciles the rationale that previously lived only in `pipeline/cluster.py` code comments.**

---

## TL;DR

- The as-built pipeline matches **neither** research doc by design, and that is **defensible**. The Feb doc optimizes for *Lumensis's* product (per-conversation HDBSCAN with a noise label); the Apr doc proposes Leiden but was **empirically refuted on this vault** (CPM produces one giant cluster + singletons). The shipped choice — spherical k-means atoms + mass-weighted Ward on centroids to **deterministic √n counts** — is the survivor of two measured failures (silhouette k-collapse, Leiden imbalance).
- **The √n counts are an assumption, not a measurement.** That was the correct fix for the k=2 collapse but it must stop being *presented* as discovered. As of this change we ship **read-only validity diagnostics** (`pipeline/cluster_diagnostics.py`) that flag a degenerate/unstable partition rather than silently shipping it — **stored, never used to select k.**
- **Ward runs on L2-renormalized cosine centroids fed a Euclidean variance objective** ("spherical-Ward approximation"). This is now documented in code (`centroids_to_groups`) and reconciled below; we **keep the renormalization** (cosine-consistency with the rest of the pipeline) rather than dropping it to match the research's raw-centroid Ward.

---

## 1. The three contradictory sources

| Source | Recommends | For what / why | Status here |
|---|---|---|---|
| `research-agent/research/clustering-redesign-assessment.md` (Feb) | **KEEP HDBSCAN**; add a c-TF-IDF Ward *merge* layer | *Lumensis* product: per-conversation clustering where a noise label (-1) is a feature and topic count varies per conversation. DBCV-guided `min_cluster_size` sweep with plateau detection. | **Not adopted** (different product; see §2) |
| `research-agent/research/mycelium-clustering-dimensionality-reduction-strategy-2026-04-02.md` (Apr) | **DROP HDBSCAN → FAISS k-NN + multi-resolution Leiden**; Ward only for the realm level on theme centroids | Mycelium's 5-level hierarchy; criticizes HDBSCAN's *uncontrollable, non-monotonic* cluster count; Leiden's resolution γ gives smooth monotonic k-control. | **Partially adopted, then pivoted** (Leiden refuted empirically; see §3) |
| `docs/CLUSTERING-REBALANCE-DESIGN-2026-06-10.md` + `docs/REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md` (as-built) | **Spherical k-means atoms + mass-weighted Ward (territories/themes/realms) at deterministic √n targets** | This vault, measured. | **Shipped** |

The Feb and Apr docs disagree on the *primary algorithm*; the as-built code uses a *third* approach. S5 is right that this needs a written rationale. Here it is.

---

## 2. Why not HDBSCAN (the Feb recommendation)

The Feb assessment is sound **for the product it was written about** (Lumensis per-conversation clustering), but two of its load-bearing premises don't hold for Mycelium's mindscape:

1. **"Noise is a feature."** True for short conversations; for a single user's whole corpus the UX requires *every* point placed in the 4-level hierarchy (realm→theme→territory→atom). We retain a *bounded* noise/liminal concept (`detect_noise`, capped at 15%) but cannot leave the bulk of points unassigned.
2. **"Automatic cluster discovery."** HDBSCAN's cluster count is **emergent and non-monotonic in `min_cluster_size`** — the Apr doc's Problem 3, and the Feb doc concedes "getting exactly 200–400 territories is fighting HDBSCAN's design." Mycelium needs a *tunable, stable* number of territories per UX and per the stabilization/lineage machinery (Jaccard ID matching across rebuilds), which a count that jumps run-to-run actively breaks.

DBCV-guided plateau detection (the Feb doc's selection method) is also **O(n²)** and, at ~300 territories over ~72k points, sparse per cluster — exactly the regime where it is both expensive and noisy (see §5 on why we did **not** adopt DBCV as a *selector*, only consider it as a diagnostic).

**Verdict:** HDBSCAN's strengths (density-shaped clusters, explicit noise) are real but optimize a different objective than "a stable, fully-covering, tunable 4-level hierarchy." Not adopted.

## 3. Why not Leiden (the Apr recommendation)

The Apr doc's critique of HDBSCAN is correct and motivated dropping it. Its *replacement* — multi-resolution Leiden with γ-tuned k — was **tried and empirically refuted on this vault**:

- **Leiden CPM produces pathologically imbalanced output** on densely-connected graphs with skewed structure: one giant cluster + many singletons (`pipeline/cluster.py:51-93`, `1052-1054`). `leidenalg` + `leiden_for_k` remain *imported and parameterized* but are **not called in the live hierarchy** — kept only for the noise-detection k-NN graph and reference.
- The Apr doc's own claim that "γ gives smooth monotonic control" did not survive contact with the anisotropic embedding distribution here (mean random-pair cosine ~0.58). Smoothness in γ does not imply *balance* in the resulting partition.

So we kept the Apr doc's **best ideas** — cluster in native 256D (no UMAP-for-clustering distortion; UMAP is viz-only), and **Ward on centroids** — but replaced Leiden-at-each-level with **spherical k-means (atoms)** + **mass-weighted Ward (territories/themes/realms)**, which *guarantee* exactly target-k balanced, strictly-nested clusters.

## 4. Why √n target counts (and why not silhouette)

Counts are set by `scale_targets()` (`cluster.py:104-126`): atoms `n//15`, territories `round(1.4·√n)`, themes `round(0.35·√n)`, realms `round(0.05·√n)`.

The realm level was the last to use an **index selector** (cosine silhouette argmax over k∈[2,10]). On anisotropic cosine embeddings **silhouette is biased toward low k**, and at full scale it **collapsed to k=2 with one realm holding 78% of points** (`REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md`; lab on a 72k copy). Replacing it with a √n target (≈13 realms) gave max-share 0.17 and run-to-run determinism.

**This is the crux of S5:** the fix is correct (the collapse cannot recur), but it converts the counts from *measured* to *assumed*. The √n coefficients are tuned to "match the recovered active count," i.e. a prior, not a discovery. **We do not walk this back** — index-driven k-selection is the original bug. Instead we make the assumption *honest* (§5).

> **Hard rule for future work:** do **not** reintroduce silhouette/DBCV/elbow as a *k-selector* at any level. They may only be computed as stored diagnostics. Re-introducing index-driven selection re-introduces the k=2 collapse.

## 5. Validity diagnostics — stored, never gating k (this change)

New: `pipeline/cluster_diagnostics.py`, written at the end of every run into `clustering_diagnostics` (migration `0028`), surfaced at `GET /mindscape` → `meta.partitionConfidence`.

| Diagnostic | What | Cost | Role |
|---|---|---|---|
| `realm_max_share` | largest realm's fraction of points | O(n) | **gates the flag** (>0.5 → low-confidence; the collapse's signature) |
| `bootstrap_ari_mean` | reference-anchored Adjusted-Rand over B 80%-subsample re-clusterings (Ben-Hur 2002, cheap variant) | bounded: capped points (default 20k), B≤20, fail-soft | **gates the flag** (<0.6 → low-confidence; research reliability gate is ≥0.80 — `research-agent/.../cluster-validity-indices-density-based-text-embeddings.md:307-334`) |
| `territory_validity` | simplified cosine cohesion/separation index on territory centroids | O(n·k) | **informational only — never gates** |

**Why a "simplified silhouette" instead of literal DBCV / `relative_validity_`:**
- `hdbscan` is **not a pipeline dependency** (and we don't fit an HDBSCAN model), so `relative_validity_` is unavailable.
- True **DBCV is O(n²)** and needs enough points per cluster for stable density estimates; at ~300 territories over ~72k points a cheap subsample is too sparse per cluster to be anything but noise. Shipping a hand-rolled DBCV at that granularity would be *unvalidated math dressed as rigor* — exactly what the audit warns against.
- So we ship an **honest O(n·k) proxy and label it as one.** Crucially its **absolute value is downward-biased on anisotropic cosine data** (the same bias that broke silhouette *selection*), so it must **never gate**. The flag rests only on the two well-calibrated signals (max-share, bootstrap-ARI). The diagnostics test (`verify:cluster-diagnostics`) asserts a low validity value alone does **not** raise the flag.

**Flag semantics:** `low_confidence = (realm_max_share > 0.5) OR (bootstrap_ari_runs > 0 AND bootstrap_ari_mean < 0.6)`. Bootstrap that did not run reports `runs=0 / mean=null` and is **never read as a pass** (honesty-fails-closed, mirroring the CVP harness).

**Storage class — plaintext, by decision.** These are *global partition-geometry* scalars (how balanced/reproducible the math is), in the same disclosure class as the noise percentages and realm/territory **counts** already surfaced plaintext in `meta`, and far below the per-territory cognitive scalars (energy/coherence/velocity) that *are* encrypted. They reveal nothing about content. If a later multi-vault threat model disagrees, promotion to an AES-GCM envelope is a one-line `ENCRYPTED_FIELDS` addition + a decrypt in `db/mindscape.js` (mirrors territory scalars). Recorded here so the choice is auditable.

## 6. Spherical-Ward approximation (secondary S5 item)

`centroids_to_groups` (`cluster.py:966-984`) computes child centroids, **L2-renormalizes them to the unit sphere**, then feeds them to `_weighted_ward_groups`, whose objective is the **Euclidean** mass-weighted Ward variance `(W_A·W_B/(W_A+W_B))·‖c_A−c_B‖²`.

- **What this is:** on the unit sphere, squared-Euclidean `= 2(1 − cosine)`, so Ward here merges by **cosine proximity** — consistent with the cosine metric used everywhere else (spherical k-means atoms, FAISS k-NN graph, `UMAP metric='cosine'`). This is a deliberate **spherical-Ward approximation**.
- **How it deviates from the research's Ward:** the Apr doc applies Ward to **raw** theme centroids (Euclidean on un-normalized means). Renormalizing **discards centroid magnitude** (≈ a child's internal compactness/spread) and the Lance-Williams merged mean is taken **in the chart** (the renormalized space), not re-projected — neither is exactly Ward's variance-minimization in the original space.
- **Decision: keep the renormalization.** Cosine-consistency with the rest of the pipeline matters more than matching the paper's Euclidean Ward, and dropping it re-introduces corpus-mean-magnitude drift that the `2026-06-17` doc rejected for ID-stability reasons (marginal balance gain 0.17→0.14 did not justify the stored-centroid-compatibility risk). The deviation is now **documented in code** (per S5's "document … or drop") and bounded (merges stay cosine-consistent). Revisit only with multi-vault evidence.

---

## 7. What would change this decision

- **Multi-vault evidence** that √n counts are systematically wrong for some users (watch `realm_max_share` / `bootstrap_ari_mean` trends across vaults via the new diagnostics).
- A **cheap, calibrated** density-validity at territory granularity (would upgrade `territory_validity` from informational to a candidate signal — still never a *selector*).
- A measured case where raw-centroid Ward beats spherical-Ward on balance **and** ID-stability simultaneously.

Until then: **spherical k-means + mass-weighted spherical-Ward at √n targets, with honest stored diagnostics.** Counts are presented as *targets*, partition quality is *measured and surfaced*.

---

*Related: `docs/METRICS-AUDIT-vs-LITERATURE-2026-06-19.md` (S5), `docs/CLUSTERING-REBALANCE-DESIGN-2026-06-10.md`, `docs/REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md`. Code: `pipeline/cluster.py`, `pipeline/cluster_diagnostics.py`, `migrations/0028_clustering_diagnostics.sql`. Gate: `verify:cluster-diagnostics`, `verify:portal-mindscape` (M1b/M1c).*
