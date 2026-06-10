# Research brief — hierarchical clustering of personal-knowledge embeddings

**For:** external research agent · **Date:** 2026-06-10
**Consumer:** the clustering-rebalance effort (`pipeline/cluster.py`); findings feed the candidate-intervention list and the eval-harness metric suite.

## Our system (so answers can be specific)

We hierarchically cluster text embeddings of one person's private notes/messages:

- **Vectors:** Nomic-embed-text v1.5, matryoshka-truncated 768→256D, L2-normalized, cosine similarity.
- **Scale:** N ranges from ~100 (new user, day one) to ~50,000 (power user). The SAME pipeline must behave at both ends. Runs locally on consumer CPU (minutes, not hours).
- **Hierarchy (4 levels):** spherical mini-batch k-means → ~N/15 "atoms"; then Ward HAC on *atom centroids* (each centroid = one unweighted point) → territories (~N/300, floor 30); same again → themes (floor 8); same again → realms, count picked by largest-gap "elbow" on Ward merge distances, clamped to [5, 10].
- **Noise:** a point is flagged noise if <30% of its k=20 cosine kNN share its territory, OR its mean kNN similarity is >2σ below the corpus mean. Noise points are routed to per-realm "liminal" buckets.
- **Constraints:** cluster IDs/names must stay stable as data grows (currently Jaccard-overlap matching across re-runs); top level must stay human-legible (roughly 3–10 realms); downstream consumers need a strict tree (every point → atom → territory → theme → realm).

**Measured pathologies on a real 152-point vault:** 57% of points flagged noise (avg territory size ≈ 5 < the 6 same-territory neighbors needed to pass the membership test); realm floor of 5 forces four 1–2-point realms next to one 146-point realm; centroid-HAC is blind to cluster mass at every level above atoms.

## What we want, per question

For each question: (a) the canonical/current-best methods, (b) **how the research community / practitioners actually use them** — default parameters, calibration recipes, rules of thumb, (c) fundamental limitations and known failure modes, (d) citations + CPU-friendly implementations (sklearn/scipy/faiss-class; permissive licenses).

## Questions

### A. Noise / outlier detection on embedding kNN graphs
1. Principled outlier detection when clusters are small relative to k: GLOSH (HDBSCAN), LOF, kNN-distance methods, graph-degree methods. How is k chosen as a function of N (log N? √N?) and how are thresholds calibrated against *expected cluster size*?
2. The **hubness problem** in high-dim kNN (some points become neighbors of everyone) — how badly does it distort kNN-based noise flags at 256D cosine, and what corrections are standard (mutual kNN, local scaling, hubness reduction)?
3. Is bounding the noise fraction (e.g., flag at most the bottom q%) considered legitimate practice, or a smell?

### B. Choosing the number of clusters — especially the top level
4. What do practitioners actually trust for k-selection on embedding data: elbow/largest-gap on linkage distances, gap statistic, silhouette sweep, stability-based selection (bootstrap + ARI consensus), Bayesian/DP nonparametrics? Specifically: known unreliability of the elbow on Ward merge distances, and better drop-in replacements.
5. How should a *bounded* k (we need 3–10 realms for human legibility) interact with natural-k estimation — pick within bounds by quality score, or let the bound only bind when violated? Any literature on legibility/cardinality-constrained summarization clustering?

### C. Balance vs. fidelity
6. Capacity-constrained and balanced clustering: balanced k-means, same-size heuristics, Sinkhorn/optimal-transport k-means, size-regularized objectives, cardinality-constrained HAC. What's used in production systems (sharding, topic maps, card-sorting UIs)? When does forcing balance destroy semantic coherence — what imbalance is *natural* for topical text data (power-law topic sizes)?
7. Soft alternatives: instead of hard balance, penalize only degenerate outcomes (singleton parents, one-parent-takes-90%). Any principled "minimum mass per parent" merge rules?

### D. Hierarchies over vector-quantized atoms
8. The "k-means atoms then agglomerate centroids" pattern (vector quantization → HAC; BIRCH; bisecting k-means): what is the CORRECT way to make centroid-level Ward respect cluster mass (weighted Ward / Lance–Williams updates with cluster sizes; scipy support)? How much does unweighted-centroid HAC distort merges in practice?
9. How do modern hierarchical topic systems (BERTopic hierarchy, top2vec, RAPTOR-style recursive clustering) decide per-level granularity and depth — and do they adapt depth to corpus size? What granularities do humans find legible at each level?

### E. Embedding-space fundamentals
10. Clustering in native 256D vs reducing first (UMAP→HDBSCAN à la BERTopic): current consensus, what UMAP distorts (density, distances), when native-space is preferred. Matryoshka truncation: any measured effect on cluster structure at 256 vs 768?
11. Anisotropy / narrow-cone geometry of sentence embeddings — does it bias Ward/euclidean-on-normalized-vectors, and are corrections (whitening, ABTT) worth it before clustering?

### F. Small-N regime (N = 100–1,000)
12. What actually works at N≈150: should hierarchy depth collapse (e.g., 2 levels instead of 4)? Minimum-points-per-cluster guidance? Methods that degrade gracefully from 50k to 100 points without re-parameterization?

### G. Stability and incremental growth
13. Measuring partition stability across re-runs / growing data: bootstrap ARI/AMI, prediction strength, consensus clustering. What thresholds count as "stable" in practice?
14. Evolutionary / temporally-smoothed clustering (cluster the new snapshot while penalizing drift from the previous one) and incremental methods that preserve cluster identity — best current approaches and their failure modes vs our Jaccard-matching.

### H. Evaluation
15. Which internal validity metrics are trusted for high-dim embedding clusters — silhouette's known weaknesses there, DBCV, density-based validity — and what the topic-modeling community uses for cluster *quality* (embedding coherence vs human eval). What metric SUITE would a careful practitioner assemble to compare clustering configs offline?

## Anti-goals
- No GPU-only or training-required methods (must run on a user's laptop CPU).
- No methods that abandon the strict tree (soft/overlapping clusters can inform, but output must be a hierarchy).
- We don't need streaming/online updates yet — batch re-runs with ID stability are fine.
