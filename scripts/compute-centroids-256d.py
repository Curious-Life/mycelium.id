#!/usr/bin/env python3
"""
One-off: compute 256D Nomic centroids for territories from cached embeddings.
Uses the local nomic_embeddings.npy cache (same as cluster.py) + territory
assignments from D1.

Usage: python scripts/compute-centroids-256d.py [--dry-run]
"""

import json
import os
import sys
from pathlib import Path

import httpx
import numpy as np

WORKER_URL = os.environ.get("MYA_WORKER_URL", "")
WORKER_SECRET = os.environ.get("MYA_WORKER_SECRET", "")
OWNER_ID = os.environ.get("MINDSCAPE_OWNER_ID", os.environ.get("DEFAULT_USER_ID", ""))

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_EMBEDDINGS = CACHE_DIR / "nomic_embeddings.npy"
CACHE_POINT_IDS = CACHE_DIR / "nomic_point_ids.json"


def d1_query(sql, params=None):
    r = httpx.post(
        f"{WORKER_URL}/api/db/query",
        json={"sql": sql, "params": params or []},
        headers={"Authorization": f"Bearer {WORKER_SECRET}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("results", [])


def d1_batch(statements):
    r = httpx.post(
        f"{WORKER_URL}/api/db/batch",
        json={"statements": statements},
        headers={"Authorization": f"Bearer {WORKER_SECRET}"},
        timeout=60,
    )
    r.raise_for_status()


def main():
    dry_run = "--dry-run" in sys.argv

    if not WORKER_URL or not WORKER_SECRET:
        print("Set MYA_WORKER_URL and MYA_WORKER_SECRET")
        sys.exit(1)

    # Load cached embeddings
    if not CACHE_EMBEDDINGS.exists() or not CACHE_POINT_IDS.exists():
        print("Cache files not found. Run cluster.py first.")
        sys.exit(1)

    embeddings = np.load(CACHE_EMBEDDINGS)
    point_ids = json.loads(CACHE_POINT_IDS.read_text())
    print(f"Loaded {len(point_ids)} cached embeddings ({embeddings.shape})")

    # Build point_id → index lookup
    id_to_idx = {pid: i for i, pid in enumerate(point_ids)}

    # Get territory assignments from D1 (no user_id filter — use all points with territories)
    print("Fetching territory assignments...")
    BATCH = 1000
    count = d1_query(
        "SELECT COUNT(*) as c FROM clustering_points WHERE territory_id IS NOT NULL",
    )[0]["c"]

    territory_members = {}  # tid → [embedding indices]
    matched = 0

    for offset in range(0, count, BATCH):
        rows = d1_query(
            "SELECT id, territory_id FROM clustering_points "
            "WHERE territory_id IS NOT NULL LIMIT ? OFFSET ?",
            [BATCH, offset],
        )
        for row in rows:
            idx = id_to_idx.get(row["id"])
            if idx is not None:
                tid = row["territory_id"]
                territory_members.setdefault(tid, []).append(idx)
                matched += 1

        sys.stdout.write(f"  Fetched {min(offset + BATCH, count)}/{count} ({matched} matched)\r")

    print(f"\n  {len(territory_members)} territories, {matched} points matched to cache")

    # Compute L2-normalized centroids
    statements = []
    for tid, indices in territory_members.items():
        vecs = embeddings[indices]
        centroid = vecs.mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = centroid / norm
        # Update territory profile for canonical owner
        statements.append({
            "sql": "UPDATE territory_profiles SET centroid_256 = ? WHERE territory_id = ? AND user_id = ?",
            "params": [json.dumps(centroid.tolist()), tid, OWNER_ID],
        })

    if dry_run:
        print(f"  (dry run) Would write 256D centroids for {len(statements)} territories")
        return

    print(f"Writing centroids for {len(statements)} territories...")
    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i + 50])

    print(f"Done. {len(statements)} territory centroids stored.")


if __name__ == "__main__":
    main()
