#!/usr/bin/env python3
"""Cluster lab — offline evaluation harness for the clustering hierarchy.

Runs the REAL pipeline stages (imported from pipeline/cluster.py) over the real
vault embeddings under parameterized variants, and scores each variant with a
content-free metric suite. Never writes to the vault: point MYCELIUM_DB at a
backup COPY (run-lab.sh does this) and everything DB-side is read-only
(fetch_all_embeddings(dry_run=True)).

SECURITY (CLAUDE.md §1/§7): embeddings are decrypted in memory only; every
output of this tool is numeric (counts, scores) — no message text, no names,
no vectors are ever printed or written.

Usage (via run-lab.sh, which sets MYCELIUM_DB + USER_MASTER):
    python3 pipeline/lab/cluster_lab.py [--variants baseline,combo] [--stability B]
"""

import os
import sys
import json
import argparse
import time
from collections import Counter
from pathlib import Path

import numpy as np

PIPELINE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPELINE_DIR))

for var in ("MYCELIUM_DB", "USER_MASTER"):
    if not os.environ.get(var):
        sys.exit(f"cluster_lab: missing {var} in env (use run-lab.sh)")

import cluster  # noqa: E402  (env-gated import — exits without MYCELIUM_DB)

# Redirect the embedding cache away from the production cache dir so lab runs
# on a DB copy can never poison the app's cache.
LAB_DIR = Path(__file__).resolve().parent
LAB_CACHE = LAB_DIR / "cache"
LAB_CACHE.mkdir(exist_ok=True)
cluster.CACHE_DIR = LAB_CACHE
cluster.CACHE_EMBEDDINGS = LAB_CACHE / "nomic_embeddings.npy"
cluster.CACHE_POINT_IDS = LAB_CACHE / "nomic_point_ids.json"


# ── Metrics (all content-free) ─────────────────────────────────────

def gini(sizes):
    x = np.sort(np.asarray(sizes, dtype=float))
    n = len(x)
    if n == 0 or x.sum() == 0:
        return 0.0
    cum = np.cumsum(x)
    return float((n + 1 - 2 * (cum / cum[-1]).sum()) / n)


def size_metrics(labels, mask=None):
    """Distributional stats for one level. mask=True rows are excluded (noise)."""
    lab = labels if mask is None else labels[~mask]
    sizes = sorted(Counter(int(v) for v in lab).values(), reverse=True)
    if not sizes:
        return {}
    n = sum(sizes)
    k = len(sizes)
    p = np.array(sizes, dtype=float) / n
    entropy = float(-(p * np.log(p)).sum() / np.log(k)) if k > 1 else 1.0
    return {
        "k": k,
        "max": sizes[0],
        "median": sizes[k // 2],
        "min": sizes[-1],
        "max_share": round(sizes[0] / n, 3),
        "norm_entropy": round(entropy, 3),
        "gini": round(gini(sizes), 3),
        "tiny(<=2)": sum(1 for s in sizes if s <= 2),
    }


def silhouette(emb, labels, mask=None, sample=4000):
    from sklearn.metrics import silhouette_score
    if mask is not None:
        emb, labels = emb[~mask], labels[~mask]
    k = len(set(int(v) for v in labels))
    if k < 2 or k >= len(labels):
        return None
    kwargs = {}
    if len(labels) > sample:
        kwargs = {"sample_size": sample, "random_state": 42}
    try:
        return round(float(silhouette_score(emb, labels, metric="cosine", **kwargs)), 3)
    except Exception:
        return None


def isotropy(emb, pairs=2000, seed=42):
    """Mean cosine similarity of random pairs (Ada §3: >0.1 → anisotropic)."""
    rng = np.random.default_rng(seed)
    i = rng.integers(0, len(emb), pairs)
    j = rng.integers(0, len(emb), pairs)
    keep = i != j
    return round(float((emb[i[keep]] * emb[j[keep]]).sum(axis=1).mean()), 4)


# ── Plain (mass-blind) centroid grouping — the PRE-2026-06-10 production
# algorithm, kept here verbatim so the lab "baseline" stays the historical
# baseline now that cluster.centroids_to_groups is mass-weighted. ──

def plain_centroid_groups(child_labels, emb, n_groups):
    from scipy.cluster.hierarchy import linkage, fcluster
    uniq = sorted(set(int(c) for c in child_labels) - {-1})
    if len(uniq) <= 1:
        return np.zeros(len(child_labels), dtype=int)
    if len(uniq) <= n_groups:
        m = {c: i for i, c in enumerate(uniq)}
        return np.array([m.get(int(v), 0) for v in child_labels])
    cents = np.stack([emb[child_labels == c].mean(axis=0) for c in uniq])
    norms = np.linalg.norm(cents, axis=1, keepdims=True)
    norms[norms == 0] = 1
    cents = cents / norms
    Z = linkage(cents, method="ward", metric="euclidean")
    lab = fcluster(Z, t=min(n_groups, len(uniq)), criterion="maxclust") - 1
    m = {uniq[i]: int(lab[i]) for i in range(len(uniq))}
    return np.array([m.get(int(v), 0) for v in child_labels])


# ── Mass-weighted Ward on child centroids (Ada §4, exact closed form) ──
# Ward's between-cluster distance has the closed form
#   d(A,B) = (W_A*W_B / (W_A+W_B)) * ||c_A - c_B||^2
# so agglomeration over (centroid, mass) pairs is exact weighted Ward —
# no Lance-Williams bookkeeping needed if we recompute from merged
# centroids/masses. O(k^2) via incremental row updates.

def weighted_centroid_groups(child_labels, emb, n_groups):
    uniq = sorted(set(int(c) for c in child_labels) - {-1})
    if len(uniq) <= 1:
        return np.zeros(len(child_labels), dtype=int)
    if len(uniq) <= n_groups:
        m = {c: i for i, c in enumerate(uniq)}
        return np.array([m.get(int(v), 0) for v in child_labels])

    cents = np.stack([emb[child_labels == c].mean(axis=0) for c in uniq]).astype(np.float64)
    norms = np.linalg.norm(cents, axis=1, keepdims=True)
    norms[norms == 0] = 1
    cents = cents / norms
    w = np.array([(child_labels == c).sum() for c in uniq], dtype=np.float64)

    k = len(uniq)
    alive = np.ones(k, dtype=bool)
    groups = {i: [uniq[i]] for i in range(k)}

    def ward_row(i):
        d2 = ((cents - cents[i]) ** 2).sum(axis=1)
        coef = (w * w[i]) / (w + w[i])
        row = coef * d2
        row[i] = np.inf
        row[~alive] = np.inf
        return row

    D = np.full((k, k), np.inf)
    for i in range(k):
        D[i] = ward_row(i)

    n_alive = k
    while n_alive > n_groups:
        i, j = np.unravel_index(np.argmin(D), D.shape)
        wi, wj = w[i], w[j]
        cents[i] = (wi * cents[i] + wj * cents[j]) / (wi + wj)
        w[i] = wi + wj
        groups[i].extend(groups.pop(j))
        alive[j] = False
        D[j, :] = np.inf
        D[:, j] = np.inf
        D[i, :] = ward_row(i)
        D[:, i] = D[i, :]
        n_alive -= 1

    child_to_group = {}
    for gid, (root, members) in enumerate(sorted(groups.items())):
        for c in members:
            child_to_group[c] = gid
    return np.array([child_to_group.get(int(v), 0) for v in child_labels])


# ── Noise variants ─────────────────────────────────────────────────

def membership_noise(graph, labels, thr):
    n = graph.vcount()
    noise = np.zeros(n, dtype=bool)
    for node in range(n):
        nbs = graph.neighbors(node)
        if not nbs:
            noise[node] = True
            continue
        same = sum(1 for nb in nbs if labels[nb] == labels[node])
        if same / len(nbs) < thr:
            noise[node] = True
    return noise


def sigma_noise(knn_sims, sigma=2.0):
    ms = knn_sims[:, 1:].mean(axis=1)
    return ms < (ms.mean() - sigma * ms.std())


def capped(noise, knn_sims, cap=0.15):
    """Bound the noise fraction: keep only the weakest `cap` share of flagged points."""
    if noise.mean() <= cap:
        return noise
    ms = knn_sims[:, 1:].mean(axis=1)
    budget = int(len(ms) * cap)
    order = np.argsort(ms)  # weakest first
    out = np.zeros_like(noise)
    taken = 0
    for idx in order:
        if noise[idx]:
            out[idx] = True
            taken += 1
            if taken >= budget:
                break
    return out


def compute_noise(kind, graph, knn_sims, levels):
    if kind == "baseline":  # production: territory membership 0.3 OR 2σ
        return membership_noise(graph, levels["territory"], 0.3) | sigma_noise(knn_sims)
    if kind == "theme":     # membership vs the coarser theme level OR 2σ
        return membership_noise(graph, levels["theme"], 0.3) | sigma_noise(knn_sims)
    if kind == "sigma":     # distance-outlier only
        return sigma_noise(knn_sims)
    if kind == "sigma_cap":  # distance-outlier only, bounded at 15%
        return capped(sigma_noise(knn_sims), knn_sims, 0.15)
    if kind == "adaptive":  # membership threshold scaled by achievable same-territory share
        terr = levels["territory"]
        sizes = Counter(int(v) for v in terr)
        med = float(np.median([sizes[int(v)] for v in terr]))
        kk = knn_sims.shape[1] - 1
        thr = min(0.3, max(0.05, 0.6 * (med - 1) / kk))
        return capped(membership_noise(graph, terr, thr) | sigma_noise(knn_sims), knn_sims, 0.20)
    raise ValueError(kind)


# ── Target schedules ───────────────────────────────────────────────

def targets_prod(n):
    return {
        "atoms": max(300, min(2000, n // 15)),          # k-means caps at n//4 internally
        "territories": max(30, min(300, n // 300)),
        "themes": max(8, min(50, n // 1000)),
    }


def targets_sqrt(n):
    """sqrt-scaled targets that bridge N=100 → N=45k smoothly (no degenerate floors)."""
    return {
        "atoms": max(300, min(2000, n // 15)),
        "territories": int(max(2, min(300, round(1.4 * np.sqrt(n))))),
        "themes": int(max(2, min(50, round(0.35 * np.sqrt(n))))),
    }


# ── Realm-count selection ──────────────────────────────────────────

def realm_level(theme_labels, emb, mode, grouper):
    """Return (realm_labels, n_realms). mode: elbow_5_10 | elbow_2_10 | silhouette_2_10."""
    from scipy.cluster.hierarchy import linkage, fcluster
    uniq = sorted(set(int(t) for t in theme_labels))
    if len(uniq) <= 1:
        return np.zeros(len(theme_labels), dtype=int), 1

    if mode.startswith("elbow"):
        lo, hi = (5, 10) if mode == "elbow_5_10" else (2, 10)
        cents = np.stack([emb[theme_labels == t].mean(axis=0) for t in uniq])
        norms = np.linalg.norm(cents, axis=1, keepdims=True)
        norms[norms == 0] = 1
        cents = cents / norms
        Z = linkage(cents, method="ward", metric="euclidean")
        merge_dists = Z[:, 2]
        if len(merge_dists) > 1:
            gaps = np.diff(merge_dists)
            n_realms = len(cents) - int(np.argmax(gaps)) - 1
            n_realms = max(lo, min(hi, n_realms))
        else:
            n_realms = lo
        n_realms = min(n_realms, len(uniq))
        lab = fcluster(Z, t=n_realms, criterion="maxclust") - 1
        m = {uniq[i]: int(lab[i]) for i in range(len(uniq))}
        return np.array([m.get(int(t), 0) for t in theme_labels]), n_realms

    if mode == "silhouette_2_10":
        best_k, best_s, best_labels = None, -2.0, None
        for k in range(2, min(10, len(uniq)) + 1):
            pl = grouper(theme_labels, emb, k)
            s = silhouette(emb, pl)
            if s is not None and s > best_s:
                best_k, best_s, best_labels = k, s, pl
        if best_labels is None:
            return np.zeros(len(theme_labels), dtype=int), 1
        return best_labels, best_k

    raise ValueError(mode)


# ── Preprocessing (anisotropy correction) ──────────────────────────

def prep_center(emb):
    """Subtract the corpus mean and re-normalize — spreads the narrow cosine
    cone of anisotropic embeddings (measured 0.59 mean rand-pair cosine on the
    real vault). Cheaper/safer than full ABTT (Ada §3)."""
    c = emb - emb.mean(axis=0, keepdims=True)
    n = np.linalg.norm(c, axis=1, keepdims=True)
    n[n == 0] = 1
    return (c / n).astype(np.float32)


PREPS = {"none": lambda e: e, "center": prep_center}


# ── Variant runner (replicates run_clustering's orchestration) ─────

VARIANTS = {
    "baseline":      dict(targets=targets_prod, ward="plain",    realm="elbow_5_10",     noise="baseline"),
    "noise_sigma":   dict(targets=targets_prod, ward="plain",    realm="elbow_5_10",     noise="sigma_cap"),
    "noise_theme":   dict(targets=targets_prod, ward="plain",    realm="elbow_5_10",     noise="theme"),
    "noise_adaptive": dict(targets=targets_prod, ward="plain",   realm="elbow_5_10",     noise="adaptive"),
    "small_n":       dict(targets=targets_sqrt, ward="plain",    realm="silhouette_2_10", noise="sigma_cap"),
    "weighted_ward": dict(targets=targets_prod, ward="weighted", realm="elbow_5_10",     noise="baseline"),
    "combo":         dict(targets=targets_sqrt, ward="weighted", realm="silhouette_2_10", noise="sigma_cap"),
    "combo_centered": dict(targets=targets_sqrt, ward="weighted", realm="silhouette_2_10", noise="sigma_cap", prep="center"),
    "combo_elbow":   dict(targets=targets_sqrt, ward="weighted", realm="elbow_2_10",     noise="sigma_cap"),
    "combo_elbow_centered": dict(targets=targets_sqrt, ward="weighted", realm="elbow_2_10", noise="sigma_cap", prep="center"),
}


def run_variant(emb, cfg):
    emb = PREPS[cfg.get("prep", "none")](emb)
    n = len(emb)
    t = cfg["targets"](n)
    group = weighted_centroid_groups if cfg["ward"] == "weighted" else plain_centroid_groups

    atom = cluster.spherical_kmeans_atoms(emb, t["atoms"])
    territory = group(atom, emb, t["territories"])
    theme = group(territory, emb, t["themes"])
    realm, n_realms = realm_level(theme, emb, cfg["realm"], grouper=group)

    graph, knn_sims = cluster.build_knn_graph(emb, k=min(cluster.KNN_K, max(5, n - 1)))
    levels = {"atom": atom, "territory": territory, "theme": theme, "realm": realm}
    noise = compute_noise(cfg["noise"], graph, knn_sims, levels)
    return levels, noise, n_realms


def score(emb, levels, noise):
    out = {"noise_rate": round(float(noise.mean()), 3)}
    for lvl in ("realm", "theme", "territory"):
        m = size_metrics(levels[lvl], mask=noise)
        m["silhouette"] = silhouette(emb, levels[lvl], mask=noise)
        out[lvl] = m
    return out


def stability(emb, cfg, B=3, frac=0.85, seed=7):
    """Bootstrap ARI at realm + territory level across subsample pairs."""
    from sklearn.metrics import adjusted_rand_score
    rng = np.random.default_rng(seed)
    n = len(emb)
    realm_aris, terr_aris = [], []
    for _ in range(B):
        s1 = np.sort(rng.choice(n, int(n * frac), replace=False))
        s2 = np.sort(rng.choice(n, int(n * frac), replace=False))
        l1, _, _ = run_variant(emb[s1], cfg)
        l2, _, _ = run_variant(emb[s2], cfg)
        common, i1, i2 = np.intersect1d(s1, s2, return_indices=True)
        if len(common) < 10:
            continue
        realm_aris.append(adjusted_rand_score(l1["realm"][i1], l2["realm"][i2]))
        terr_aris.append(adjusted_rand_score(l1["territory"][i1], l2["territory"][i2]))
    return {
        "realm_ari": round(float(np.mean(realm_aris)), 3) if realm_aris else None,
        "territory_ari": round(float(np.mean(terr_aris)), 3) if terr_aris else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="all")
    ap.add_argument("--stability", type=int, default=0, help="bootstrap iterations (0 = skip)")
    ap.add_argument("--out", default=str(LAB_DIR / "results"))
    ap.add_argument("--synth", type=int, default=0,
                    help="upsample the real corpus to N points (resample + jitter) for scale tests")
    args = ap.parse_args()

    names = list(VARIANTS) if args.variants == "all" else args.variants.split(",")

    ids, emb = cluster.fetch_all_embeddings(dry_run=True)
    if args.synth and args.synth > len(ids):
        # Scale test: bootstrap-upsample the REAL corpus (preserves its anisotropy
        # and cluster geometry, unlike gaussian blobs) with small jitter.
        rng = np.random.default_rng(42)
        idx = rng.integers(0, len(emb), args.synth)
        jitter = rng.normal(0, 0.02, (args.synth, emb.shape[1])).astype(np.float32)
        up = emb[idx] + jitter
        up /= np.linalg.norm(up, axis=1, keepdims=True).clip(1e-12)
        emb = up.astype(np.float32)
        ids = [f"synth-{i}" for i in range(args.synth)]
        print(f"  SYNTH: upsampled to {len(ids)} points (resample + σ=0.02 jitter)")
    print(f"\nLAB: {len(ids)} points, dim={emb.shape[1] if len(emb) else 0}, "
          f"isotropy(mean rand cosine)={isotropy(emb)}\n")

    report = {"n": len(ids), "dim": int(emb.shape[1]), "isotropy": isotropy(emb), "variants": {}}
    for name in names:
        cfg = VARIANTS[name]
        t0 = time.time()
        levels, noise, n_realms = run_variant(emb, cfg)
        res = score(emb, levels, noise)
        res["n_realms"] = n_realms
        res["secs"] = round(time.time() - t0, 1)
        if args.stability > 0:
            res["stability"] = stability(emb, cfg, B=args.stability)
        report["variants"][name] = res

        print(f"== {name} ==  noise={res['noise_rate']:.0%}  realms={n_realms}  ({res['secs']}s)")
        for lvl in ("realm", "territory"):
            m = res[lvl]
            print(f"   {lvl:9s} k={m['k']:3d}  sizes max/med/min={m['max']}/{m['median']}/{m['min']}"
                  f"  max_share={m['max_share']}  entropy={m['norm_entropy']}  gini={m['gini']}"
                  f"  tiny={m['tiny(<=2)']}  silhouette={m['silhouette']}")
        if "stability" in res:
            print(f"   stability: realm ARI={res['stability']['realm_ari']}  "
                  f"territory ARI={res['stability']['territory_ari']}")
        print()

    out_dir = Path(args.out)
    out_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_file = out_dir / f"lab-{stamp}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"report → {out_file}")


if __name__ == "__main__":
    main()
