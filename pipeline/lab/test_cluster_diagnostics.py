#!/usr/bin/env python3
"""verify:cluster-diagnostics — guards the clustering-validity DIAGNOSTICS (S5).

Proves the cheap read-only diagnostics in pipeline/cluster_diagnostics.py behave
on known fixtures: a CLEAN partition (well-separated blobs, balanced realms) scores
high validity / high bootstrap-ARI / low max-share → NO flag, while a COLLAPSED
partition (one realm holding ~80% of points) and an UNSTABLE partition (labels that
don't reproduce under resampling) each raise the low-confidence flag for the right
reason. Also asserts the flag is NEVER gated on the validity index (the bias the
silhouette-selection bug exploited), and that the bootstrap fails to "not measured"
(None), never to a silent pass.

Pure numpy + sklearn (adjusted_rand_score / KMeans). Synthetic only — no vault, no
keys, no DB, no faiss/umap. Prints a PASS/FAIL ledger + VERDICT, exits non-zero on
any failure (verify-gate convention).
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # pipeline/
import cluster_diagnostics as cd  # noqa: E402  (numpy-only at module level)

FAILS = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILS.append(name)


def make_blobs(centers, n_per, dim=64, spread=0.05, seed=0):
    """Well-separated near-orthogonal blobs on the unit sphere."""
    rng = np.random.default_rng(seed)
    basis = rng.standard_normal((centers, dim))
    basis /= np.linalg.norm(basis, axis=1, keepdims=True)
    pts, labels = [], []
    for c in range(centers):
        pts.append(basis[c] + spread * rng.standard_normal((n_per, dim)))
        labels += [c] * n_per
    X = np.vstack(pts).astype(np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    return X, np.array(labels)


def kmeans_recluster(k, seed=0):
    """Injected re-clustering algo for the bootstrap: spherical k-means → labels."""
    from sklearn.cluster import KMeans

    def fn(emb):
        e = emb / np.clip(np.linalg.norm(emb, axis=1, keepdims=True), 1e-12, None)
        return KMeans(n_clusters=min(k, len(e)), n_init=3, random_state=seed).fit_predict(e)
    return fn


# ── Fixture: 6 clean, balanced realms (≈ a healthy run) ──────────────────────
X, terr = make_blobs(centers=6, n_per=400, seed=1)
realms_balanced = terr.copy()  # realms == territories here, balanced

diag_clean = cd.assess(realms_balanced, terr, X, kmeans_recluster(6),
                       bootstrap_b=8, max_points=5000, seed=3)

check("clean: max-share ≈ balanced (≤0.25)", diag_clean['realm_max_share'] <= 0.25,
      f"max_share={diag_clean['realm_max_share']}")
check("clean: validity high (>0.3)", (diag_clean['territory_validity'] or 0) > 0.3,
      f"validity={diag_clean['territory_validity']}")
check("clean: bootstrap actually ran (runs>0)", diag_clean['bootstrap_ari_runs'] > 0,
      f"runs={diag_clean['bootstrap_ari_runs']}")
check("clean: bootstrap ARI high (≥0.8 reliability gate)",
      (diag_clean['bootstrap_ari_mean'] or 0) >= 0.8,
      f"ari={diag_clean['bootstrap_ari_mean']}")
check("clean: NOT flagged low-confidence", diag_clean['low_confidence'] == 0,
      diag_clean['confidence_note'])

# ── Fixture: collapsed realms (one realm holds ~80% of points) ───────────────
realms_collapsed = np.where(np.isin(terr, [0, 1, 2, 3]), 0, terr)  # 4/6 blobs → realm 0
share_collapsed, _, _ = cd.realm_max_share(realms_collapsed)
diag_collapsed = cd.assess(realms_collapsed, terr, X, kmeans_recluster(6),
                           bootstrap_b=6, max_points=5000, seed=3)

check("collapsed: max-share > 0.5", share_collapsed > 0.5, f"share={share_collapsed:.3f}")
check("collapsed: FLAGGED low-confidence", diag_collapsed['low_confidence'] == 1)
check("collapsed: note cites max-share", "largest realm" in diag_collapsed['confidence_note'],
      diag_collapsed['confidence_note'])

# ── Fixture: unstable partition (reference labels are pure noise) ────────────
# Random reference territory labels do not reproduce under re-clustering → low ARI.
rng = np.random.default_rng(7)
terr_noise = rng.integers(0, 6, size=len(X))
diag_unstable = cd.assess(realms_balanced, terr_noise, X, kmeans_recluster(6),
                          bootstrap_b=8, max_points=5000, seed=3)

check("unstable: bootstrap ARI low (<0.6)", (diag_unstable['bootstrap_ari_mean'] or 1) < 0.6,
      f"ari={diag_unstable['bootstrap_ari_mean']}")
check("unstable: FLAGGED low-confidence", diag_unstable['low_confidence'] == 1)
check("unstable: note cites stability", "stability" in diag_unstable['confidence_note'].lower(),
      diag_unstable['confidence_note'])

# ── Guard: the flag must NEVER be gated on the validity index alone ──────────
# Clean blobs, balanced realms, but force bootstrap OFF: validity is high yet with
# no max-share/ARI trigger the partition must read as NOT low-confidence — and a
# LOW validity must NOT by itself flip the flag.
diag_no_boot = cd.assess(realms_balanced, terr, X, kmeans_recluster(6),
                         run_bootstrap=False, seed=3)
check("no-bootstrap: runs==0 and ari_mean is None (not a silent pass)",
      diag_no_boot['bootstrap_ari_runs'] == 0 and diag_no_boot['bootstrap_ari_mean'] is None)
check("no-bootstrap balanced: NOT flagged (validity does not gate)",
      diag_no_boot['low_confidence'] == 0, diag_no_boot['confidence_note'])

# Overlapping territories → low validity, but balanced realms + bootstrap off →
# still NOT flagged (proves validity index is informational, never a gate).
Xover, terr_over = make_blobs(centers=6, n_per=300, spread=0.9, seed=11)
diag_lowval = cd.assess(terr_over, terr_over, Xover, kmeans_recluster(6),
                        run_bootstrap=False, seed=3)
check("low-validity alone does NOT flag",
      diag_lowval['low_confidence'] == 0,
      f"validity={diag_lowval['territory_validity']} flagged={diag_lowval['low_confidence']}")

# ── Guard: thresholds travel with the row ────────────────────────────────────
check("thresholds recorded on the row",
      diag_clean['threshold_max_share'] == 0.5 and diag_clean['threshold_ari_low'] == 0.6
      and diag_clean['threshold_ari_reliable'] == 0.80)

# ── Guard: below MIN_POINTS bootstrap reports not-measured ───────────────────
Xsmall, terr_small = make_blobs(centers=4, n_per=50, seed=2)  # 200 pts < 600
boot_small = cd.bootstrap_ari(Xsmall, terr_small, kmeans_recluster(4), seed=3)
check("tiny corpus: bootstrap not measured (runs=0, mean None)",
      boot_small['runs'] == 0 and boot_small['mean'] is None)

print()
if FAILS:
    print(f"VERDICT: NO-GO — {len(FAILS)} check(s) failed: {', '.join(FAILS)}")
    sys.exit(1)
print("VERDICT: GO — clustering-validity diagnostics behave on all fixtures")
