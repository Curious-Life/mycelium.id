# Clustering rebalance — design (data-science pass)

**Date:** 2026-06-10 · **Status:** locked, implementing
**Inputs:** 3 Explore sweeps (algorithm map · data-flow/consumers · prior art), live-vault measurement, research brief answers (`research/hierarchical-clustering-technical-brief-2026-06-10.md`, Ada), offline eval harness (`pipeline/lab/cluster_lab.py`) with experiments on the real vault (N=152) + upsampled scale tests (N=1.5k/15k).

## Revision history

- **v1 (handoff sketch, 2026-06-09/10):** "centroids_to_groups is variance-blind → one realm balloons 81 pts vs 3; add balance constraint."
- **v2 (this doc):** measurement falsified two parts of the sketch. (a) The "81-point realm" is the **noise bucket**: 57% of the vault is flagged liminal by a membership rule that is unsatisfiable at small N, and the 81-pt territory is 100% liminal points. (b) The realm skew is real but **not small-N specific** — baseline puts 89.6% of points in one realm at N=15k. Fix is therefore three-part: noise rule (size-gated + capped), target schedule (sqrt, floors of 2), and mass-weighted Ward + silhouette-selected realm count.

## Measured pathologies (live vault, N=152, single clean run)

| Pathology | Evidence |
|---|---|
| 57% of points flagged noise | `SUM(is_liminal)=87/152`; territory 1050 = 81 pts, all liminal |
| Membership rule unsatisfiable | needs ≥ `0.3×k=6` same-territory neighbors; avg territory ≈ 5 pts (`detect_noise`, territory labels) |
| Forced realm floor → singletons | `max(5, min(10, elbow))` at cluster.py:939; live realms: 146/2/2/1/1 pts |
| Mass-blind centroid HAC | cluster.py:822-853 — every child centroid weighs 1 regardless of member count |
| Skew at ALL scales | lab baseline realm max-share: 1.0 (N=152, post-noise) · 0.835 (N=1.5k) · 0.896 (N=15k) |
| Anisotropic embeddings | mean random-pair cosine = **0.59** (Ada §3 threshold: >0.1) — noted; centering deferred (below) |

## Experiment results (harness; metrics content-free)

Variants over real vault embeddings; sizes after excluding noise. Stability = bootstrap ARI (B=10, 85% subsamples).

| Variant | noise | realms (sizes) | realm max-share | realm ARI | terr silhouette |
|---|---|---|---|---|---|
| baseline (prod) | **57%** | 1 effective | 1.0 | — | 0.189 |
| noise fix only (σ+cap) | 3% | 143/1/1/1 | 0.97 | — | 0.078 |
| weighted ward only | 68% | 31/16/2 | 0.63 | — | 0.241 |
| **combo** (ships) | **3%** | 105/42 | **0.71→0.24 at 15k** | **0.47** | 0.167 → **0.52 at 15k** |
| combo_centered | 0% | 62/59/31 | 0.41 | 0.38 | 0.133 |

At N=15k (upsampled): baseline realm max-share **0.896** vs combo **0.24**; combo territory silhouette 0.519 vs baseline 0.344; identical runtime (~10s). No single intervention suffices — noise fix alone *exposes* the realm skew; weighted ward alone leaves the noise pathology.

## The shipped change (4 deltas in `pipeline/cluster.py`, output contract unchanged)

1. **Target schedule** (`scale_targets`): territories `max(2, min(300, round(1.4·√n)))`, themes `max(2, min(50, round(0.35·√n)))`. Bridges smoothly: N=152→17/4 · N=600→34/9 (≈ old floors) · N=45k→297/50 (≈ old targets). Structural warning logged when `n < 600` (Ada §7). Atoms unchanged.
2. **Mass-weighted Ward** (`centroids_to_groups`): exact weighted Ward via the closed form `d(A,B) = (W_A·W_B/(W_A+W_B))·‖c_A−c_B‖²` over (centroid, mass) pairs — no scipy support exists (sklearn #27557); custom agglomeration, O(k²) incremental updates, k ≤ 2000. Signature unchanged.
3. **Realm count by silhouette** (Stage 5): k = argmax cosine silhouette over k ∈ [2, min(10, n_themes)] (sampled ≤4000 pts at scale), replacing elbow clamped to [5,10]. Conservative-stable in the lab (ARI 0.47, best of finalists; the elbow's apparent B=3 win was bootstrap noise).
4. **Noise rule** (`detect_noise`): σ-outlier rule always; membership rule **only when median territory size ≥ KNN_K** (auto-true at old scale: 45k/300=150≥20; auto-false at small N); total noise **capped at 15%** keeping the weakest by mean kNN similarity (Ada §1: percentile-bounding is standard practice).

**Deliberately NOT shipped:** corpus-mean centering (best small-N balance but mixed at scale, and the corpus mean drifts as the vault grows → cross-run ID-stability risk + stored-centroid compatibility risk). Stays a lab `prep` option pending more vaults' data. No new Python deps in production.

## Threat model / security

No new attack surface: no new deps, no network, no plaintext at rest. Lab harness (`pipeline/lab/`) runs only against a backup **copy** of the vault, keys travel env-only (run-lab.sh), and every lab output is numeric (counts/scores — §1/§7 compliant).

## Edge cases — explicit decisions

- **n_themes < 2** → single realm (existing branch retained).
- **All points noise-capped:** cap is 15% so ≥85% always cluster; membership rule can no longer flag majorities.
- **Re-run over the operator's named realms:** partitions shift → Jaccard stabilization marks dissolved territories + dominant-successor inheritance carries names where flow dominates (cluster.py:1881-1927); realm names re-describe via Illuminate. Accepted: one-time churn at upgrade.
- **k-means atom cap** `n//4` still bounds atoms at tiny N (37 atoms at N=152) — unchanged.
- **Liminal routing** unchanged (per-realm liminal territories, offset ids).

## Test strategy

1. **Lab parity:** after patch, production functions reproduce the combo metrics on the vault copy (same numbers as the `combo` row above).
2. **End-to-end on the copy:** run `cluster.py` main against the backup copy with writes ON (copy only) → inspect `clustering_points`/`territory_profiles` distributions; assert noise ≤15%, no realm >75% (at this N), ≥2 realms.
3. **Hermetic gate:** `verify:generate` stays green (job protocol unaffected).
4. **Live validation:** operator re-runs Generate + Illuminate; eyeball realm legibility.

## Decision criteria for "done"

Noise rate ≤15% on the live vault; no single realm >80% of non-noise points; ≥2 realms; describe names all realms; `verify:generate` GO.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Silhouette k-selection unstable run-to-run | M | M | bounded [2,10]; Jaccard + anchoring absorb churn; revisit with prediction-strength (Ada §5) if churn observed |
| Weighted-ward O(k²) slow at atoms=2000 | L | L | measured ~10s total at N=15k; nn-chain optimization available if needed |
| Upsampled scale tests ≠ real large vaults | M | M | metrics re-checked on first real >5k vault; harness is permanent |
| Named-realm churn on upgrade | H | L | expected; Illuminate re-names in one click |

## Verification table

| Assumption | Verified at |
|---|---|
| Noise membership rule tests territory labels with k=20, thr 0.3 | pipeline/cluster.py:856-871, 953 (read) |
| Realm floor forces ≥5 realms | pipeline/cluster.py:939 (read) |
| centroids_to_groups is mass-blind (centroid = 1 pt) | pipeline/cluster.py:840-851 (read) |
| Live vault: 87/152 liminal; 81-pt territory all-liminal | sqlite counts on app DB (2026-06-10) |
| Only callers of centroids_to_groups: stages 3+4 | pipeline/cluster.py:912,919 (grep) |
| fetch_all_embeddings(dry_run=True) is DB-read-only | pipeline/cluster.py:663,682 (read) |
| Names survive re-cluster via dominant-successor inheritance | pipeline/cluster.py:1881-1927 (sweep, spot-read) |
| scipy/sklearn have no weighted Ward | Ada §4 + sklearn issue #27557 |
| Weighted-Ward closed form (no Lance-Williams needed) | Ada §4 formula; lab implementation reproduces balanced merges |
| run-clustering.sh step protocol independent of cluster.py internals | src/jobs.js:130-134 + run-clustering.sh (sweep) |

## Open questions deferred

- Corpus-mean centering / ABTT (isotropy 0.59) — revisit with multi-vault evidence.
- Prediction-strength k-selection (needs B≥30 runs — slow inline; candidate for a quality pass).
- GLOSH noise via hdbscan dep; hubness correction at >5k points (Ada §2 says minor at small N).
- True large-vault validation (first real >5k-point vault).
