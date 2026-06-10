# Technical Brief: Hierarchical Clustering of High-Dimensional Embeddings

**2026-06-10 | Ada (Research Agent)** · answers to `docs/CLUSTERING-RESEARCH-BRIEF-2026-06-10.md`

**Executive summary:** Seven topics answered below for nomic-embed-text v1.5, matryoshka-truncated 768→256D, L2-normalized, cosine similarity, N≈152. Key findings: GLOSH is in `hdbscan` via `outlier_scores_`; hubness correction via `scikit-hubness` (Mutual Proximity or NICDM); ABTT has limited applicability to contrastive embeddings; weighted Ward is not natively supported in scipy/sklearn and requires a custom implementation; prediction strength (threshold 0.8) preferred over gap statistic for embeddings; DBCV not in sklearn (use FelSiq/DBCV); at N=152 the territories level (N/300 ≈ 0.5) is degenerate and must be collapsed.

## §1 — GLOSH (Graph-based Local Outlier Score using Hierarchy)

How it works: uses the HDBSCAN* hierarchy. For each point x:

- `GLOSH(x) = (λ_max(C) - λ(x)) / λ_max(C)` — score in [0,1)
- Near 0 = dense cluster core; near 1 = outlier
- Advantage over LOF: uses the global hierarchy, detects local + global outliers in one pass

Package: built into `hdbscan` (scikit-learn-contrib).

```python
import hdbscan
clusterer = hdbscan.HDBSCAN(min_cluster_size=15, metric='cosine').fit(X)
outlier_scores = clusterer.outlier_scores_  # auto-computed, shape (n_samples,)
```

Thresholds for 768D cosine:

- 90th/95th percentile: `score > np.quantile(outlier_scores_, 0.90)` (hdbscan docs recommendation)
- Fixed 0.5–0.7: practitioner convention, not paper-validated
- POLAR method (arXiv:2411.08867): linear regression on sorted scores to find transition — most principled unsupervised approach

Warning: HDBSCAN degrades above 50–100D. In 768D, distances compress → scores cluster near 0 with less discrimination. Run UMAP to ~50D before GLOSH.

Ref: Campello, Moulavi, Zimek, Sander (2015). ACM TKDD 10(1). GitHub issue #628: possible edge-case computation bug — cross-check against R `dbscan` if results seem wrong.

## §2 — Hubness Correction in High-Dimensional Spaces

Hubness: in high-D, a few "hub" points appear in kNN lists of many others. Severe in 768D cosine. Degrades kNN retrieval, HDBSCAN, and biases clustering toward hubs.

Ranked methods for CPU + cosine similarity:

1. **Mutual Proximity (empiric)** — best quality. Replaces raw distance with P(d(x,X)>d(x,y), d(y,Y)>d(y,x)). Hubs get inflated distances; genuine pairs stay close.
2. **NICDM** — best speed/quality tradeoff. Local scaling: `d'(x,y) = d(x,y) / sqrt(r_k(x)*r_k(y))`. Use when N>5000 and MP is too slow.
3. **CSLS** — designed for cross-lingual alignment. Underperforms MP/NICDM in single-domain settings per Feldbauer et al. 2019 comprehensive comparison.
4. **DisSimLocal** — Euclidean-only. Not for cosine embeddings.

Package: `scikit-hubness` — the only production Python package for this.

```python
from skhubness.reduction import MutualProximity, LocalScaling
mp = MutualProximity(method='empiric')
transformed_dist, transformed_ind = mp.fit_transform(neigh_dist, neigh_ind)
# Or NICDM:
nicdm = LocalScaling(method='nicdm')
transformed_dist, transformed_ind = nicdm.fit_transform(neigh_dist, neigh_ind)
```

Note for N=152: hubness scales with N and D — at this scale the effect is smaller. Still worth applying if using cosine kNN for clustering. MP (empiric) is O(N²) memory — not an issue at N=152.

## §3 — ABTT (All-But-The-Top) Isotropy Correction

Paper: Mu & Viswanath, ICLR 2018. arXiv:1702.01417

Algorithm:
1. Center: μ = mean(V); ṽ(w) = v(w) - μ
2. PCA on centered vectors; extract top D eigenvectors u_1…u_D
3. Project out: `v'(w) = ṽ(w) - Σᵢ (uᵢᵀ ṽ(w)) uᵢ`

How many PCs to subtract: D ≈ d/100 (paper formula). For 768D → D≈7–8. Starting point, not fixed prescription.

Does it help for nomic-embed / SBERT? **Limited benefit; possibly harmful.** ABTT was designed for static word embeddings (GloVe, Word2Vec) with frequency-artifact anisotropy. Modern contrastive models (SBERT, nomic-embed) are trained with objectives that explicitly maximize isotropy. The dominant directions ABTT removes may encode legitimate semantic variance. Practical finding: ABTT on BERT-style embeddings shows inconsistent results — improvements on some STS benchmarks, degradation on others (arXiv:2104.05274).

Decision flow for nomic-embed:
1. Check isotropy: compute mean cosine similarity between random pairs
2. If mean cosine > 0.1 (anisotropic) → try ABTT with D=5–8
3. If mean cosine < 0.05 (already isotropic) → skip ABTT
4. Always validate on held-out benchmark before applying to production

Known issues: D is sensitive; removing too many PCs destroys semantic content. Batch-size dependence (PCA changes if batch composition changes). Does NOT address hubness — separate problem.

## §4 — Weighted Ward HAC vs. Unweighted

Does scipy/sklearn support sample weights in Ward? **No.** Neither `scipy.cluster.hierarchy.linkage(method='ward')` nor `sklearn.cluster.AgglomerativeClustering(linkage='ward')` has a `sample_weight` parameter. sklearn issue #27557 is open and unimplemented.

Lance-Williams update formula for standard Ward: `d(u∪v, w) = α_u·d(u,w) + α_v·d(v,w) + β·d(u,v) + γ·|d(u,w)-d(v,w)|`

- α_u = (n_u + n_w) / (n_u + n_v + n_w)
- α_v = (n_v + n_w) / (n_u + n_v + n_w)
- β = -n_w / (n_u + n_v + n_w)
- γ = 0

For weighted Ward: replace n_u/n_v/n_w with W_u/W_v/W_w (sum of weights in each cluster). Mathematically well-defined, not implemented.

Workarounds:
1. Pre-duplicate by weight (integer weights only) — ugly but functional at small N
2. Custom Lance-Williams (~50 lines) — substitute weighted cluster sizes into the formula above
3. Pre-weighted distance matrix — weight input distances by sample importance before standard Ward (approximation, not exact)
4. Weighted k-means — sklearn KMeans supports `sample_weight`; loses the hierarchy
5. R WCluster package — has `distw()` for weighted Ward; requires rpy2 bridge

Recommendation: at N=152, Option 1 (duplication) or Option 3 (pre-weighted distances) are simplest. True weighted Ward → custom 50-line Lance-Williams implementation. Note on Wardp (de Amorim 2015): adds feature weights, not sample weights — different problem.

## §5 — Prediction Strength for k Selection

Paper: Tibshirani & Walther (2005). Journal of Computational and Graphical Statistics 14(3):511–528.

Computation:
1. Split data: D_tr / D_te (typically 50/50)
2. Cluster D_tr into k clusters; cluster D_te into k clusters independently
3. Project each test point onto training clustering (nearest training centroid)
4. For each test cluster j: `ps(j)` = fraction of co-member pairs in test cluster j that also share the same training cluster assignment
5. `PS(k) = min_j ps(j)` — minimum, not mean (conservative; sensitive to even one bad cluster)
6. Repeat B times; average PS(k) estimates

Threshold: PS(k) > 0.8 (Tibshirani & Walther). Use 0.9 for high-confidence production use. Select largest k where PS(k) ≥ 0.8.

vs. Gap statistic:
- Prediction strength: stability-based, no null model assumption, conservative (tends to underestimate k)
- Gap statistic: compares to uniform null, can overestimate k with non-uniform distributions
- For semantic embeddings (non-uniform distribution): **use prediction strength**

Python: `pip install prediction-strength` (requires Python ≥ 3.12).

For N=152: use 60/40 split (not 50/50 — too few test points), B≥30 iterations. At N<50, prediction strength becomes unreliable.

## §6 — DBCV (Density-Based Clustering Validation)

Paper: Moulavi, Jaskowiak, Campello, Zimek, Sander (2014). SIAM SDM.

Algorithm:
1. All-Points Core Distance: `aptsCD(x)` = harmonic mean of distances to cluster-mates (captures local density)
2. Mutual Reachability Distance: `MRD(x,y) = max(aptsCD(x), aptsCD(y), d(x,y))`
3. Density Sparseness of Cluster (DSC): max MST edge weight within cluster using MRD
4. Density Separation (DSPC): min MRD between any two inter-cluster points
5. Per-cluster: `V(Cᵢ) = min_{j≠i} [(DSPC(Cᵢ,Cⱼ) - DSC(Cᵢ)) / max(DSPC(Cᵢ,Cⱼ), DSC(Cᵢ))]`
6. `DBCV = Σ (|Cᵢ|/n) * V(Cᵢ)` — weighted mean

Score range: [-1, +1], higher is better. > 0.5 = good density-based separation; 0.3–0.5 = moderate.

Not in sklearn, scipy, or any standard library. Python package: FelSiq/DBCV (recommended): `pip install 'git+https://github.com/FelSiq/DBCV'`; `enable_dynamic_precision=True` is critical in high-D — prevents density underflow (3.88x–8.13x slower but necessary).

For 768D cosine: all pairwise distances compress (concentration) → DSC and DSPC become less discriminative. Reduce to UMAP-50D before computing DBCV for meaningful results. HDBSCAN's `relative_validity_` is a fast DBCV approximation for parameter tuning.

## §7 — Small N=152 with 4-Level Hierarchy

| Level | Formula | At N=152 | Status |
|---|---|---|---|
| Atoms | N/15 | ≈10 clusters | Normal (~15 members each) |
| Territories | N/300 | ≈0.5 → floor | **DEGENERATE** |
| Themes | intermediate | — | Needs explicit count |
| Realms | top level | 2–5 | Achievable |

The territories level is mathematically broken at N=152. Formula calibrated for larger populations. Min N for territories ≥ 2 clusters: N > 600.

Recommended strategies:

- **Option A (recommended): collapse to 3 levels** — Atoms k≈10 (N/15); Themes k=3–5 (N/50 or prediction strength); Realms k=2–3.
- **Option B:** 4-level taxonomy required by architecture → override territories with fixed count — Atoms ~10 | Territories 2–3 fixed | Themes 4–6 fixed | Realms 1–2.
- **Option C:** `k_territories = max(2, int(N/300))` — always ≥ 2, log warning when N < 600.

Clustering strategy at N=152:
- Ward HAC appropriate and fast for all levels
- Use prediction strength (threshold 0.8, 60/40 split, B≥30) for k selection at non-trivial levels
- HDBSCAN `min_cluster_size=10` + flat extraction for atoms
- Hubness: apply Mutual Proximity if using kNN methods; minor effect at N=152
- ABTT: skip unless isotropy score > 0.1
- GLOSH: apply before clustering to find noise; 90th percentile threshold; reduce to UMAP-50D first

General rule: when k_formula < k_min_viable (≥2), collapse the level or clamp to 2 and log a structural warning — it signals the dataset is undersized for the taxonomy.

## Package Summary

| Need | Package | Install |
|---|---|---|
| GLOSH outlier scores | `hdbscan` | `pip install hdbscan` |
| Hubness correction | `scikit-hubness` | `pip install scikit-hubness` |
| ABTT | `numpy` + `sklearn` PCA | no dedicated package |
| Weighted Ward | None native — custom needed | See §4 workarounds |
| Prediction strength | `prediction-strength` | `pip install prediction-strength` |
| DBCV | `FelSiq/DBCV` | `pip install git+https://github.com/FelSiq/DBCV` |

Key sources: hdbscan outlier docs; arXiv:2411.08867 (POLAR); scikit-hubness docs + arXiv:1912.00706; Feldbauer et al. 2019 (KAIS) hubness comparison; arXiv:1702.01417 ABTT ICLR 2018; Ward/Lance-Williams; sklearn issue #27557; Tibshirani & Walther 2005 (JCGS); Moulavi et al. 2014 SIAM SDM DBCV; FelSiq/DBCV GitHub.
