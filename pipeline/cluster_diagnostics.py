#!/usr/bin/env python3
"""Clustering-validity DIAGNOSTICS (METRICS-AUDIT-vs-LITERATURE finding S5).

The hierarchy's cluster COUNTS are deterministic √n targets (cluster.py
scale_targets) — a deliberate fix for the k=2 realm-collapse the cosine-silhouette
selector produced on anisotropic embeddings (docs/REALM-K-CLUSTERING-FIX-DESIGN-
2026-06-17.md). That fix is correct, but it left the realm/theme/territory counts
as ASSUMPTIONS presented as measurements, with nothing watching whether the
resulting partition is actually well-formed.

This module adds three CHEAP, READ-ONLY diagnostics that are *stored as health
metrics and never used to select k* (re-introducing silhouette/DBCV selection
would re-introduce the original bug — see the decision log,
docs/CLUSTERING-ALGORITHM-DECISION-LOG-2026-06-19.md):

  1. realm_max_share   — largest realm's fraction of points. The collapse's
                         signature was one realm holding 0.78; a healthy run is
                         ~0.17 (lab). Trivial, O(n).
  2. territory_validity — a cheap cohesion/separation index on the territory
                         level (simplified silhouette over centroids, COSINE).
                         This is NOT DBCV: true DBCV is O(n^2) and needs many
                         points per cluster, infeasible at ~300 territories over
                         ~72k points without sampling so sparse the estimate is
                         noise. We ship the honest O(n·k) proxy and SAY SO; it is
                         informational only and does NOT gate the flag (its
                         absolute value is downward-biased on anisotropic cosine
                         data — the same bias that broke silhouette *selection*).
  3. bootstrap_ari      — Ben-Hur-style reproducibility: re-cluster B subsamples
                         with the SAME algorithm and measure mean Adjusted-Rand
                         vs the shipped partition. Research reliability gate is
                         mean ARI > 0.80 (research-agent/research/cluster-validity-
                         indices-density-based-text-embeddings.md:307-334); we
                         flag low-confidence below 0.60. Bounded (capped points,
                         small B) to stay cheap on the live 16GB box.

low_confidence is raised when realm_max_share > 0.5 OR bootstrap_ari_mean < 0.6
— the two well-grounded signals. The validity index travels alongside for trend
watching but never gates (calibration is unknown on this data distribution).

The compute functions are PURE (numpy + sklearn.metrics.adjusted_rand_score only);
the re-clustering algorithm is INJECTED as a callable so this module can be unit-
tested without cluster.py's heavy faiss/umap/DB import surface (verify gate
pipeline/lab/test_cluster_diagnostics.py). cluster.py owns the DB write.
"""
from __future__ import annotations

import numpy as np

# ── Flag thresholds (recorded on the row so they travel with the numbers) ──
MAX_SHARE_FLAG = 0.5     # one realm holding >50% of points → degenerate partition
ARI_LOW_FLAG = 0.6       # mean bootstrap ARI below this → unstable partition
ARI_RELIABLE = 0.80      # research reliability gate (Ben-Hur) — for the note/UI only

# ── Bootstrap cost bounds (env-overridable in cluster.py) ──
DEFAULT_BOOTSTRAP_B = 12         # research suggests ~20; default lower for cost, capped at 20
DEFAULT_SUBSAMPLE_FRAC = 0.8     # Ben-Hur 80% subsamples
DEFAULT_MAX_POINTS = 20000       # cap the working set so each rep stays fast / bounded RAM
MIN_POINTS_FOR_BOOTSTRAP = 600   # below this the 4-level hierarchy is itself degenerate


def realm_max_share(realm_labels) -> tuple[float, int, int]:
    """Largest realm's share of assigned points (noise label -1 excluded).

    Returns (max_share in [0,1], dominant_realm_id, n_realms). On no assigned
    points returns (0.0, -1, 0).
    """
    labels = np.asarray(realm_labels)
    assigned = labels[labels >= 0]
    if assigned.size == 0:
        return 0.0, -1, 0
    vals, counts = np.unique(assigned, return_counts=True)
    top = int(np.argmax(counts))
    return float(counts[top] / assigned.size), int(vals[top]), int(vals.size)


def territory_validity(embeddings, territory_labels, *, sample_cap: int = 8000,
                       seed: int = 42) -> float | None:
    """Cheap cohesion/separation validity on the territory level (COSINE).

    Simplified silhouette: for each point, cohesion = cosine to its OWN territory
    centroid, separation = cosine to the NEAREST OTHER territory centroid; the
    index is mean((coh - sep)) over points. O(n·k), vectorized. Range ~[-1, 1],
    higher = tighter/better-separated territories.

    NOT DBCV (see module docstring): an honest, bounded proxy. Returns None when
    there are <2 territories or no assigned points. Points are sampled to
    sample_cap for the n×k matrix when n is large; centroids use ALL points.
    """
    emb = np.asarray(embeddings, dtype=np.float32)
    labels = np.asarray(territory_labels)
    mask = labels >= 0
    if mask.sum() == 0:
        return None
    uniq = np.unique(labels[mask])
    if uniq.size < 2:
        return None

    # Unit-normalize so dot == cosine; centroids from ALL assigned points.
    normed = emb / np.clip(np.linalg.norm(emb, axis=1, keepdims=True), 1e-12, None)
    label_to_idx = {int(t): i for i, t in enumerate(uniq)}
    cents = np.zeros((uniq.size, normed.shape[1]), dtype=np.float32)
    for t in uniq:
        cents[label_to_idx[int(t)]] = normed[labels == t].mean(axis=0)
    cents /= np.clip(np.linalg.norm(cents, axis=1, keepdims=True), 1e-12, None)

    idx = np.where(mask)[0]
    if idx.size > sample_cap:
        rng = np.random.default_rng(seed)
        idx = rng.choice(idx, size=sample_cap, replace=False)

    pts = normed[idx]                                  # (m, D)
    own = np.array([label_to_idx[int(labels[i])] for i in idx])
    sims = pts @ cents.T                               # (m, k) cosine to every centroid
    coh = sims[np.arange(idx.size), own]               # cosine to own centroid
    sims[np.arange(idx.size), own] = -np.inf           # mask self
    sep = sims.max(axis=1)                             # nearest OTHER centroid
    return float(np.mean(coh - sep))


def bootstrap_ari(embeddings, reference_labels, recluster_fn, *,
                  n_runs: int = DEFAULT_BOOTSTRAP_B,
                  subsample_frac: float = DEFAULT_SUBSAMPLE_FRAC,
                  max_points: int = DEFAULT_MAX_POINTS,
                  seed: int = 42) -> dict:
    """Reference-anchored bootstrap stability (Ben-Hur et al. 2002, cheap variant).

    Cap the working set to max_points (seeded), take the shipped partition's
    labels over that set as the reference, then for each of n_runs: draw an
    80% subsample, RE-CLUSTER it with the same algorithm (recluster_fn maps an
    (m,D) embedding block → territory labels), and score adjusted_rand_score
    against the reference restricted to the subsample. We compare each bootstrap
    to the shipped reference (B comparisons) rather than all B² bootstrap pairs —
    a cheaper, reproducibility-of-the-shipped-partition reading of the same idea.

    Returns {mean, std, runs, raw, capped_n}. runs=0 (mean=None) when below
    MIN_POINTS_FOR_BOOTSTRAP or every rep failed — callers must treat None as
    "not measured", never as a pass.
    """
    from sklearn.metrics import adjusted_rand_score

    emb = np.asarray(embeddings, dtype=np.float32)
    ref = np.asarray(reference_labels)
    n = emb.shape[0]
    if n < MIN_POINTS_FOR_BOOTSTRAP:
        return {'mean': None, 'std': None, 'runs': 0, 'raw': [], 'capped_n': n}

    rng = np.random.default_rng(seed)
    work = np.arange(n)
    if n > max_points:
        work = rng.choice(n, size=max_points, replace=False)
    work_emb = emb[work]
    work_ref = ref[work]
    m = work_emb.shape[0]
    sub_size = max(2, int(round(subsample_frac * m)))

    aris: list[float] = []
    for _ in range(max(1, n_runs)):
        sub = rng.choice(m, size=sub_size, replace=False)
        try:
            new_labels = np.asarray(recluster_fn(work_emb[sub]))
            if new_labels.shape[0] != sub.shape[0]:
                continue
            aris.append(float(adjusted_rand_score(work_ref[sub], new_labels)))
        except Exception:
            continue  # one failed rep must not sink the diagnostic

    if not aris:
        return {'mean': None, 'std': None, 'runs': 0, 'raw': [], 'capped_n': m}
    arr = np.array(aris, dtype=float)
    return {'mean': float(arr.mean()), 'std': float(arr.std()),
            'runs': int(arr.size), 'raw': aris, 'capped_n': m}


def _confidence_note(max_share: float, ari_mean: float | None, ari_runs: int,
                     low: bool) -> str:
    """Generic, content-free caveat string that travels with the row."""
    if not low:
        if ari_runs == 0:
            return (f"Partition looks well-formed (largest realm {max_share:.0%} of "
                    f"points; stability not measured this run).")
        return (f"Partition looks well-formed (largest realm {max_share:.0%}; "
                f"bootstrap stability ARI {ari_mean:.2f}, reliability gate ≥{ARI_RELIABLE:.2f}).")
    reasons = []
    if max_share > MAX_SHARE_FLAG:
        reasons.append(f"largest realm holds {max_share:.0%} of points (>{MAX_SHARE_FLAG:.0%}) — "
                       f"the partition may be collapsing toward one dominant cluster")
    if ari_runs > 0 and ari_mean is not None and ari_mean < ARI_LOW_FLAG:
        reasons.append(f"bootstrap stability ARI {ari_mean:.2f} is below the {ARI_LOW_FLAG:.2f} "
                       f"floor (reliability gate ≥{ARI_RELIABLE:.2f}) — cluster boundaries "
                       f"are not reproducible under resampling")
    return "Low-confidence partition: " + "; ".join(reasons) + "."


def assess(realm_labels, territory_labels, embeddings, recluster_fn, *,
           bootstrap_b: int = DEFAULT_BOOTSTRAP_B,
           max_points: int = DEFAULT_MAX_POINTS,
           run_bootstrap: bool = True,
           seed: int = 42) -> dict:
    """Compute all clustering diagnostics for one run. Pure (given recluster_fn).

    Returns a flat dict ready for the clustering_diagnostics row:
      realm_max_share, realm_count, territory_validity,
      bootstrap_ari_mean, bootstrap_ari_std, bootstrap_ari_runs,
      low_confidence (0/1), confidence_note, and the threshold trio.
    """
    max_share, dom, n_realms = realm_max_share(realm_labels)
    validity = territory_validity(embeddings, territory_labels, seed=seed)

    if run_bootstrap:
        boot = bootstrap_ari(embeddings, territory_labels, recluster_fn,
                             n_runs=min(20, max(1, bootstrap_b)),
                             max_points=max_points, seed=seed)
    else:
        boot = {'mean': None, 'std': None, 'runs': 0, 'raw': [], 'capped_n': 0}

    ari_mean, ari_runs = boot['mean'], boot['runs']
    low = bool(max_share > MAX_SHARE_FLAG or
               (ari_runs > 0 and ari_mean is not None and ari_mean < ARI_LOW_FLAG))
    note = _confidence_note(max_share, ari_mean, ari_runs, low)

    return {
        'realm_max_share': round(max_share, 4),
        'realm_count': n_realms,
        'dominant_realm': dom,
        'territory_validity': None if validity is None else round(validity, 4),
        'bootstrap_ari_mean': None if ari_mean is None else round(ari_mean, 4),
        'bootstrap_ari_std': None if boot['std'] is None else round(boot['std'], 4),
        'bootstrap_ari_runs': ari_runs,
        'bootstrap_capped_n': boot['capped_n'],
        'low_confidence': 1 if low else 0,
        'confidence_note': note,
        'threshold_max_share': MAX_SHARE_FLAG,
        'threshold_ari_low': ARI_LOW_FLAG,
        'threshold_ari_reliable': ARI_RELIABLE,
    }
