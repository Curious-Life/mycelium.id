"""Jaccard cluster-id stabilization — extracted from cluster.py so it can be gated.

PURE stdlib (json + collections) by design: `verify:stabilize-reserved` imports this
module directly, with no numpy / faiss / dotenv / vault / keys in the way. cluster.py
imports stabilize_ids from here; there is exactly one implementation.

The `reserved_ids` parameter is the ghost-territory fix — see the docstring below.
"""
import json
from collections import defaultdict

JACCARD_THRESHOLD = 0.3   # minimum overlap to consider a match (mirrors cluster.py)


def stabilize_ids(
    old_assignments: dict[str, int],
    new_assignments: dict[str, int],
    level: str,
    anchored_ids: set = None,
    old_centroids: dict = None,
    new_centroids: dict = None,
    reserved_ids: set = None,
) -> tuple[dict[int, int], list[dict], list[dict]]:
    """
    Match new cluster IDs to old ones by Jaccard membership overlap.
    Anchored territories get extra protection: lower Jaccard threshold + centroid backup.

    reserved_ids: ids that already exist in a PROFILE table (territory_profiles /
        realms) even though they hold no live clustering_points — i.e. ghosts. A
        freshly-formed cluster must NEVER be handed one of these: `next_id` is
        derived from clustering_points alone, so a ghost's id was invisible here and
        the new cluster's stats got upserted INTO the ghost's row
        (ON CONFLICT(territory_id,user_id) DO UPDATE, :1770) — silently inheriting
        its name, essence, chronicle and centroid. That is the "every re-import
        inherits corrupted state" mechanism. Skipping them makes the upsert a real
        INSERT with a clean identity.

    Returns:
        id_mapping: {new_id: stable_id} for relabeling
        events: list of growth event dicts
        lineage: list of {old_id, new_id, message_count, transfer_strength, is_dominant}
                 for dissolved territories
    """
    anchored_ids = anchored_ids or set()
    reserved_ids = set(reserved_ids or ())

    # Allocator that never hands out an id already held by a ghost profile row.
    def _alloc(start: int, taken: set):
        n = start
        while n in reserved_ids or n in taken:
            n += 1
        taken.add(n)
        return n

    if not old_assignments:
        # First run — all clusters are newly formed. NOTE: "first run" is ALSO what a
        # run looks like after a delete emptied clustering_points, which is exactly
        # when reserved_ids matters most: without it every label collides head-on
        # with a surviving ghost profile.
        unique_new = sorted(set(new_assignments.values()) - {-1})
        events = []
        mapping = {}
        taken: set = set()
        for cid in unique_new:
            stable = _alloc(int(cid), taken)
            mapping[cid] = stable
            members = [k for k, v in new_assignments.items() if v == cid]
            events.append({
                'event_type': 'formed',
                'cluster_id': int(stable),
                'point_count': len(members),
                'point_delta': len(members),
            })
        return mapping, events, []

    # Build membership sets
    old_clusters = defaultdict(set)
    for pid, cid in old_assignments.items():
        if cid is not None and cid >= 0:
            old_clusters[cid].add(pid)

    new_clusters = defaultdict(set)
    for pid, cid in new_assignments.items():
        if cid >= 0:
            new_clusters[cid].add(pid)

    # Compute Jaccard similarity matrix
    id_mapping = {}
    matched_old = set()
    matched_new = set()
    events = []

    # Find best matches by Jaccard score
    # Anchored territories get a lower threshold (0.15 instead of 0.3)
    ANCHORED_THRESHOLD = 0.15
    matches = []
    for new_id, new_members in new_clusters.items():
        for old_id, old_members in old_clusters.items():
            intersection = len(new_members & old_members)
            union = len(new_members | old_members)
            jaccard = intersection / union if union > 0 else 0
            threshold = ANCHORED_THRESHOLD if old_id in anchored_ids else JACCARD_THRESHOLD
            if jaccard >= threshold:
                matches.append((jaccard, new_id, old_id))

    # Greedy matching: best Jaccard first
    matches.sort(reverse=True)
    for jaccard, new_id, old_id in matches:
        if new_id in matched_new or old_id in matched_old:
            continue

        id_mapping[new_id] = old_id
        matched_new.add(new_id)
        matched_old.add(old_id)

        old_count = len(old_clusters[old_id])
        new_count = len(new_clusters[new_id])
        delta = new_count - old_count

        if delta > 0:
            event_type = 'grew'
        elif delta == 0:
            event_type = 'stable'
        else:
            event_type = 'stable'  # Shrunk slightly, still stable

        events.append({
            'event_type': event_type,
            'cluster_id': int(old_id),
            'old_cluster_ids': json.dumps([int(old_id)]),
            'jaccard_score': round(jaccard, 3),
            'point_count': new_count,
            'point_delta': delta,
        })

    # New clusters (no match to any old). The high-water mark now also accounts for
    # RESERVED ids (ghost profile rows with no live points) — otherwise a fresh
    # cluster is handed an id that already has a profile row and the upsert merges
    # into it, inheriting name/essence/chronicle. See `reserved_ids` in the docstring.
    known = list(old_clusters.keys()) + list(new_clusters.keys()) + list(reserved_ids)
    next_id = max(known) + 1 if known else 0
    allocated: set = set()
    for new_id in new_clusters:
        if new_id not in matched_new:
            stable = _alloc(next_id, allocated)
            next_id = stable + 1
            id_mapping[new_id] = stable
            events.append({
                'event_type': 'formed',
                'cluster_id': int(stable),
                'point_count': len(new_clusters[new_id]),
                'point_delta': len(new_clusters[new_id]),
            })

    # Centroid-similarity backup for unmatched anchored territories
    # If an anchored territory failed Jaccard, try matching by embedding centroid
    if old_centroids and new_centroids:
        unmatched_anchored = [oid for oid in anchored_ids if oid in old_clusters and oid not in matched_old]
        for old_id in unmatched_anchored:
            old_c = old_centroids.get(old_id)
            if old_c is None:
                continue
            best_sim, best_new = 0, None
            for new_id in new_clusters:
                if new_id in matched_new:
                    continue
                new_c = new_centroids.get(new_id)
                if new_c is None:
                    continue
                # Cosine similarity
                dot = sum(a * b for a, b in zip(old_c, new_c))
                na = sum(a * a for a in old_c) ** 0.5
                nb = sum(b * b for b in new_c) ** 0.5
                sim = dot / (na * nb) if na * nb > 0 else 0
                if sim > best_sim:
                    best_sim, best_new = sim, new_id
            if best_new is not None and best_sim >= 0.85:
                id_mapping[best_new] = old_id
                matched_new.add(best_new)
                matched_old.add(old_id)
                old_count = len(old_clusters[old_id])
                new_count = len(new_clusters[best_new])
                events.append({
                    'event_type': 'stable',
                    'cluster_id': int(old_id),
                    'old_cluster_ids': json.dumps([int(old_id)]),
                    'jaccard_score': 0.0,
                    'centroid_similarity': round(best_sim, 3),
                    'point_count': new_count,
                    'point_delta': new_count - old_count,
                    'matched_via': 'centroid',
                })

    # Dissolved clusters (old with no match to any new) — compute lineage
    lineage = []
    for old_id in old_clusters:
        if old_id in matched_old:
            continue
        old_members = old_clusters[old_id]
        events.append({
            'event_type': 'dissolved',
            'cluster_id': int(old_id),
            'old_cluster_ids': json.dumps([int(old_id)]),
            'point_count': 0,
            'point_delta': -len(old_members),
        })

        # Compute lineage: where did old_members go?
        successor_counts = defaultdict(int)
        for pid in old_members:
            new_cid = new_assignments.get(pid)
            if new_cid is not None and new_cid >= 0:
                # Map raw new_cid → stable_id (via id_mapping)
                stable_id = id_mapping.get(new_cid, new_cid)
                successor_counts[stable_id] += 1

        # Top 3 successors by count
        top_successors = sorted(successor_counts.items(), key=lambda x: -x[1])[:3]
        if top_successors:
            dominant_id = top_successors[0][0]
            for new_id, count in top_successors:
                lineage.append({
                    'old_territory_id': int(old_id),
                    'new_territory_id': int(new_id),
                    'message_count': count,
                    'transfer_strength': round(count / len(old_members), 3),
                    'is_dominant': 1 if new_id == dominant_id else 0,
                })

    return id_mapping, events, lineage
