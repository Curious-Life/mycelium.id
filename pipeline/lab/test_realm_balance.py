#!/usr/bin/env python3
"""verify:realm-balance — the clustering-quality gate for the realm level.

Guards the realm-k fix (docs/REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md): on
anisotropic embeddings, the old cosine-silhouette realm selector collapsed to
k=2 with one realm holding ~78% of points. The fix targets a √n number of realms
via mass-weighted Ward (cluster.centroids_to_groups), like themes/territories.

Pure-numpy + cluster.py's module-level (numpy-only) functions — NO faiss/umap/
sklearn (function-level there), so this runs in CI's Tier-1 venv. Synthetic
fixture only; no vault, no keys, no DB. Prints a PASS/FAIL ledger + VERDICT and
exits non-zero on any failure (verify-gate convention).
"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # pipeline/
# cluster.py sys.exit(1)s at import if MYCELIUM_DB is unset (it only CHECKS the
# env — never opens the DB). This gate calls only pure-numpy functions
# (scale_targets / centroids_to_groups) and never touches a vault, so a dummy
# path satisfies the guard without any DB/keys (CI-safe, no secrets).
os.environ.setdefault("MYCELIUM_DB", "/tmp/realm-balance-gate.noop")
import cluster  # noqa: E402  (numpy-only at module level)

FAILS = []
def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILS.append(name)

def mean_pair_cosine(emb, pairs=2000, seed=1):
    rng = np.random.default_rng(seed)
    i = rng.integers(0, len(emb), pairs); j = rng.integers(0, len(emb), pairs)
    return float(np.mean(np.sum(emb[i] * emb[j], axis=1)))

def make_anisotropic(n_realms_true, themes_per_realm, n_per_theme, dim=256, shared=1.0, seed=0):
    """K near-orthogonal realm directions + a dominant SHARED component (anisotropy).

    Offsets are UNIT-scaled (not per-dim Gaussian — in 256-D a 0.3·N(0,1) vector
    has norm ~4.8 and would drown a unit signal). With shared≈1.0 the cross-realm
    cosine ≈ shared²/(1+shared²) ≈ 0.5 (matches the real vault's ~0.58), while
    same-realm cosine ≈ 0.9 — so the K realms stay separable for Ward even though
    the cloud is anisotropic. (Ward differences cancel the shared component, which
    is exactly why the √n-target+Ward fix is robust where cosine-silhouette wasn't.)
    """
    rng = np.random.default_rng(seed)
    unit = lambda x: x / (np.linalg.norm(x) or 1.0)
    shared_vec = unit(rng.standard_normal(dim))
    realm_dirs = [unit(rng.standard_normal(dim)) for _ in range(n_realms_true)]
    embs, theme_labels, truth = [], [], []
    tid = 0
    for r in range(n_realms_true):
        for _ in range(themes_per_realm):
            theme_dir = unit(realm_dirs[r] + 0.15 * unit(rng.standard_normal(dim)))
            for _ in range(n_per_theme):
                v = theme_dir + 0.10 * unit(rng.standard_normal(dim)) + shared * shared_vec
                embs.append(unit(v)); theme_labels.append(tid); truth.append(r)
            tid += 1
    return (np.array(embs, dtype=np.float32),
            np.array(theme_labels, dtype=int),
            np.array(truth, dtype=int))

def max_share(labels):
    _, counts = np.unique(labels, return_counts=True)
    return float(counts.max() / counts.sum())

def realm_purity(realm_labels, truth):
    """Fraction of points whose realm's plurality-truth matches their truth — a
    simple, dependency-free agreement score (avoids importing sklearn ARI)."""
    correct = 0
    for rl in np.unique(realm_labels):
        m = realm_labels == rl
        vals, cnts = np.unique(truth[m], return_counts=True)
        correct += cnts.max()
    return correct / len(truth)

# ── 1. scale_targets sets a sane √n realm target ───────────────────────────
print("== realm-balance gate ==")
cluster.scale_targets(600);   t_small = cluster.TARGET_REALMS
cluster.scale_targets(15000); t_mid   = cluster.TARGET_REALMS
cluster.scale_targets(72000); t_big   = cluster.TARGET_REALMS
check("R1 TARGET_REALMS bounded [3,20] across scales",
      all(3 <= t <= 20 for t in (t_small, t_mid, t_big)),
      f"600→{t_small} 15k→{t_mid} 72k→{t_big}")
check("R2 TARGET_REALMS ~13 at the live 72k scale (10..16)", 10 <= t_big <= 16, f"got {t_big}")
check("R3 monotonic non-decreasing with n", t_small <= t_mid <= t_big,
      f"{t_small}<={t_mid}<={t_big}")

# ── 2. centroids_to_groups stays balanced on ANISOTROPIC data (the bug case) ─
# K latent realms; set the grouping target == K so we can score recovery.
K = 8
emb, theme_labels, truth = make_anisotropic(K, themes_per_realm=5, n_per_theme=120, shared=0.7)
iso = mean_pair_cosine(emb)
check("R4 fixture is anisotropic (mean pair-cosine > 0.3, like the real vault)", iso > 0.3, f"iso={iso:.3f}")

realm_labels = cluster.centroids_to_groups(theme_labels, emb, K)
n_realms = len(set(int(v) for v in realm_labels))
ms = max_share(realm_labels)
purity = realm_purity(realm_labels, truth)
check("R5 does NOT collapse — yields >= 3 realms", n_realms >= 3, f"n_realms={n_realms}")
check("R6 balanced — no realm holds > 60% of points", ms <= 0.6, f"max_share={ms:.3f}")
check("R7 recovers the latent structure (purity >= 0.75)", purity >= 0.75, f"purity={purity:.3f}")

# ── 3. EXTREME anisotropy still doesn't collapse (silhouette would pick k=2) ──
emb2, tl2, _ = make_anisotropic(K, 5, 120, shared=1.2, seed=7)
iso2 = mean_pair_cosine(emb2)
rl2 = cluster.centroids_to_groups(tl2, emb2, cluster.TARGET_REALMS if cluster.TARGET_REALMS <= K else K)
n2 = len(set(int(v) for v in rl2)); ms2 = max_share(rl2)
check("R8 extreme anisotropy (iso high) STILL non-degenerate + balanced",
      n2 >= 3 and ms2 <= 0.6, f"iso={iso2:.3f} n_realms={n2} max_share={ms2:.3f}")

print()
if FAILS:
    print(f"VERDICT: NO-GO — {len(FAILS)} check(s) failed: {', '.join(FAILS)}")
    sys.exit(1)
print("VERDICT: GO — realm clustering is non-degenerate + balanced on anisotropic data")
