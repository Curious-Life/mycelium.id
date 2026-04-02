#!/usr/bin/env python3
"""
Experiment: HDBSCAN on raw 256D Nomic embeddings vs current UMAP-based clusters.

Compares territory assignments from direct 256D clustering against
the current UMAP→3D→HDBSCAN pipeline. Reports Jaccard overlap per territory.

Usage: python scripts/experiment-256d-clustering.py
"""

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

# Local imports
sys.path.insert(0, str(Path(__file__).parent))

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_EMBEDDINGS = CACHE_DIR / "nomic_embeddings.npy"
CACHE_POINT_IDS = CACHE_DIR / "nomic_point_ids.json"

WORKER_URL = os.environ.get("MYA_WORKER_URL", "")
WORKER_SECRET = os.environ.get("ADMIN_SECRET", os.environ.get("MYA_WORKER_SECRET", ""))


def d1_query(sql, params=None):
    import httpx
    r = httpx.post(
        f"{WORKER_URL}/api/db/query",
        json={"sql": sql, "params": params or []},
        headers={"Authorization": f"Bearer {WORKER_SECRET}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("results", [])


def main():
    print("=" * 60)
    print("  256D Clustering Experiment")
    print("=" * 60)

    # Load cached embeddings
    if not CACHE_EMBEDDINGS.exists():
        print("No cached embeddings. Run cluster.py first.")
        sys.exit(1)

    embeddings = np.load(CACHE_EMBEDDINGS)
    point_ids = json.loads(CACHE_POINT_IDS.read_text())
    print(f"\nLoaded {len(point_ids)} embeddings ({embeddings.shape})")

    # Get current territory assignments from D1 (small batches)
    print("Fetching current territory assignments...")
    current_assignments = {}
    BATCH = 90  # D1 param limit ~100
    for offset in range(0, len(point_ids), BATCH):
        batch = point_ids[offset:offset + BATCH]
        placeholders = ",".join(["?" for _ in batch])
        try:
            rows = d1_query(
                f"SELECT id, territory_id FROM clustering_points WHERE id IN ({placeholders})",
                batch,
            )
            for r in rows:
                if r.get("territory_id") is not None:
                    current_assignments[r["id"]] = r["territory_id"]
        except Exception as e:
            sys.stdout.write(f"  batch error at {offset}: {e}\n")
        if offset % 5000 == 0:
            sys.stdout.write(f"  {min(offset + BATCH, len(point_ids))}/{len(point_ids)}\r")

    print(f"\n  {len(current_assignments)} points with current territory assignments")

    # Build index: point_id → embedding index
    id_to_idx = {pid: i for i, pid in enumerate(point_ids)}

    # Filter to points that have both embeddings and current assignments
    valid_ids = [pid for pid in point_ids if pid in current_assignments]
    valid_indices = [id_to_idx[pid] for pid in valid_ids]
    valid_embeddings = embeddings[valid_indices]
    valid_current = [current_assignments[pid] for pid in valid_ids]

    print(f"  {len(valid_ids)} points with both embeddings and assignments")

    # ── Run HDBSCAN on raw 256D ──
    print("\nRunning HDBSCAN on raw 256D (cosine metric)...")

    try:
        import hdbscan
    except ImportError:
        print("Installing hdbscan...")
        os.system(f"{sys.executable} -m pip install hdbscan")
        import hdbscan

    # Normalize for cosine (HDBSCAN euclidean on L2-normalized = cosine)
    norms = np.linalg.norm(valid_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normalized = valid_embeddings / norms

    # Grid search for best params
    best_score = -1
    best_labels = None
    best_params = None

    param_grid = [
        {"min_cluster_size": mcs, "min_samples": ms, "cluster_selection_method": csm}
        for mcs in [10, 25, 50, 100]
        for ms in [3, 5]
        for csm in ["eom", "leaf"]
    ]

    print(f"  Grid search: {len(param_grid)} parameter combinations")

    for i, params in enumerate(param_grid):
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=params["min_cluster_size"],
            min_samples=params["min_samples"],
            cluster_selection_method=params["cluster_selection_method"],
            metric="euclidean",  # on normalized vectors = cosine
            core_dist_n_jobs=2,
        )
        labels = clusterer.fit_predict(normalized)

        n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
        noise_pct = (labels == -1).sum() / len(labels) * 100

        # Score: prefer 50-500 territories, <25% noise
        if n_clusters < 20 or n_clusters > 1000 or noise_pct > 40:
            continue

        # Favor more clusters with less noise
        score = n_clusters * (1 - noise_pct / 100)
        if score > best_score:
            best_score = score
            best_labels = labels
            best_params = params
            print(f"  [{i+1}/{len(param_grid)}] {n_clusters} clusters, {noise_pct:.1f}% noise — NEW BEST (mcs={params['min_cluster_size']}, ms={params['min_samples']}, {params['cluster_selection_method']})")

    if best_labels is None:
        print("  No valid clustering found. Try different parameters.")
        sys.exit(1)

    n_new = len(set(best_labels)) - (1 if -1 in best_labels else 0)
    n_current = len(set(valid_current))
    noise_pct = (best_labels == -1).sum() / len(best_labels) * 100

    print(f"\n  Best 256D clustering: {n_new} territories ({noise_pct:.1f}% noise)")
    print(f"  Current clustering:   {n_current} territories")
    print(f"  Best params: {best_params}")

    # ── Compute Jaccard overlap ──
    print("\nComputing Jaccard overlap...")

    # Build membership sets: territory_id → set of point indices
    current_members = defaultdict(set)
    new_members = defaultdict(set)

    for i, (pid, cur_tid) in enumerate(zip(valid_ids, valid_current)):
        current_members[cur_tid].add(i)
        new_tid = best_labels[i]
        if new_tid >= 0:
            new_members[new_tid].add(i)

    # For each current territory, find best matching new territory
    overlaps = []
    for cur_tid, cur_set in sorted(current_members.items(), key=lambda x: -len(x[1])):
        best_jaccard = 0
        best_match = -1
        for new_tid, new_set in new_members.items():
            intersection = len(cur_set & new_set)
            union = len(cur_set | new_set)
            if union > 0:
                jaccard = intersection / union
                if jaccard > best_jaccard:
                    best_jaccard = jaccard
                    best_match = new_tid

        overlaps.append({
            "current_territory": cur_tid,
            "best_match_new": best_match,
            "jaccard": best_jaccard,
            "current_size": len(cur_set),
            "match_size": len(new_members[best_match]) if best_match >= 0 else 0,
        })

    # Sort by jaccard
    overlaps.sort(key=lambda x: -x["jaccard"])

    # Stats
    jaccards = [o["jaccard"] for o in overlaps]
    high_overlap = sum(1 for j in jaccards if j >= 0.5)
    medium_overlap = sum(1 for j in jaccards if 0.3 <= j < 0.5)
    low_overlap = sum(1 for j in jaccards if j < 0.3)

    print(f"\n  ── Overlap Summary ──")
    print(f"  High overlap (≥50%):   {high_overlap} territories ({high_overlap/len(overlaps)*100:.0f}%)")
    print(f"  Medium overlap (30-50%): {medium_overlap} territories ({medium_overlap/len(overlaps)*100:.0f}%)")
    print(f"  Low overlap (<30%):    {low_overlap} territories ({low_overlap/len(overlaps)*100:.0f}%)")
    print(f"  Mean Jaccard: {np.mean(jaccards):.3f}")
    print(f"  Median Jaccard: {np.median(jaccards):.3f}")

    print(f"\n  Top 10 best-preserved territories:")
    for o in overlaps[:10]:
        print(f"    Territory {o['current_territory']} ({o['current_size']} pts) → New {o['best_match_new']} ({o['match_size']} pts): {o['jaccard']:.3f}")

    print(f"\n  Bottom 10 (most disrupted):")
    for o in overlaps[-10:]:
        print(f"    Territory {o['current_territory']} ({o['current_size']} pts) → New {o['best_match_new']} ({o['match_size']} pts): {o['jaccard']:.3f}")

    # Save results
    results_path = CACHE_DIR / "experiment_256d_results.json"
    json.dump({
        "params": best_params,
        "n_current_territories": n_current,
        "n_new_territories": n_new,
        "noise_pct": noise_pct,
        "mean_jaccard": float(np.mean(jaccards)),
        "median_jaccard": float(np.median(jaccards)),
        "high_overlap_count": high_overlap,
        "medium_overlap_count": medium_overlap,
        "low_overlap_count": low_overlap,
        "overlaps": overlaps,
    }, results_path.open("w"), indent=2)
    print(f"\n  Results saved to {results_path}")


if __name__ == "__main__":
    main()
