#!/usr/bin/env python3
"""
Mycelium Semantic Clustering Pipeline

Generates Nomic v1.5 256D embeddings (optimized for clustering),
runs UMAP + HDBSCAN to assign hierarchical clusters
(realms → themes → territories → atoms), stabilizes IDs across
rebuilds via Jaccard matching, detects growth events,
and writes results back to D1.

BGE-M3 1024D embeddings in Vectorize are untouched (used for search).
Nomic embeddings are cached locally as .npy files for fast incremental runs.

Usage:
    python3 scripts/cluster.py
    python3 scripts/cluster.py --dry-run
    python3 scripts/cluster.py --min-points 100

Env vars (loaded from .env files):
    MYA_WORKER_URL     — Cloudflare Worker URL
    AGENT_TOKEN_MYA    — Auth token (or ADMIN_SECRET)
"""

import os
import sys
import gc
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter, defaultdict

import numpy as np
import httpx
from dotenv import dotenv_values

# Load env from all .env files (same as ecosystem.config.cjs)
root = Path(__file__).resolve().parent.parent
for f in ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']:
    p = root / f
    if p.exists():
        for k, v in dotenv_values(p).items():
            if v is not None:
                os.environ.setdefault(k, v)

WORKER_URL = os.environ.get('MYA_WORKER_URL', '')
TOKEN = os.environ.get('AGENT_TOKEN_MYA') or os.environ.get('ADMIN_SECRET', '')

if not WORKER_URL or not TOKEN:
    print("Missing MYA_WORKER_URL or auth token")
    sys.exit(1)

HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': f'Bearer {TOKEN}',
}

# ── Clustering Parameters ──────────────────────────────────────────

# Nomic embedding
NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5"
NOMIC_DIM = 256         # Matryoshka truncation (768 → 256)
NOMIC_TASK_PREFIX = "clustering: "  # Nomic task-specific prefix
NOMIC_MAX_CHARS = 2000  # Max input chars per text (keeps token count manageable)
NOMIC_BATCH_SIZE = 32   # Texts per ONNX inference batch

# Cache paths
CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_EMBEDDINGS = CACHE_DIR / "nomic_embeddings.npy"
CACHE_POINT_IDS = CACHE_DIR / "nomic_point_ids.json"

# FAISS + Leiden (replaced UMAP→HDBSCAN — Ada research 2026-04-02)
KNN_K = 20                       # k-NN graph neighbors
LEIDEN_SEED = 42                  # fixed seed for determinism
TARGET_ATOMS = 1500
TARGET_TERRITORIES = 300
TARGET_THEMES = 35
TARGET_REALMS_MIN = 5
TARGET_REALMS_MAX = 10
NOISE_MEMBERSHIP_THRESHOLD = 0.3
NOISE_KNN_SIGMA = 2.0

# UMAP (visualization ONLY — decoupled from clustering)
UMAP_N_COMPONENTS_VIZ = 3
UMAP_N_NEIGHBORS_VIZ = 15
UMAP_MIN_DIST_VIZ = 0.1

# Jaccard stabilization
JACCARD_THRESHOLD = 0.3  # minimum overlap to consider a match

# ── API Helpers ────────────────────────────────────────────────────

client = httpx.Client(timeout=60.0, headers=HEADERS)


def d1_query(sql: str, params: list = None) -> list:
    """Execute a D1 SQL query via Worker proxy."""
    r = client.post(f"{WORKER_URL}/api/db/query", json={"sql": sql, "params": params or []})
    r.raise_for_status()
    data = r.json()
    return data.get("results", [])


def d1_batch(statements: list) -> list:
    """Execute a batch of D1 SQL statements."""
    r = client.post(f"{WORKER_URL}/api/db/batch", json={"statements": statements})
    r.raise_for_status()
    return r.json()


def vectorize_query(vector: list, top_k: int = 20, filter_meta: dict = None) -> list:
    """Query Vectorize for nearest neighbors."""
    body = {"index": "search", "vector": vector, "topK": top_k}
    if filter_meta:
        body["filter"] = filter_meta
    r = client.post(f"{WORKER_URL}/api/vectors/query", json=body)
    r.raise_for_status()
    return r.json().get("matches", [])


# ── Nomic Embedding (local, cached) ───────────────────────────────

def _load_cache() -> tuple[list[str], np.ndarray | None]:
    """Load cached Nomic embeddings from disk."""
    if CACHE_EMBEDDINGS.exists() and CACHE_POINT_IDS.exists():
        try:
            ids = json.loads(CACHE_POINT_IDS.read_text())
            embs = np.load(str(CACHE_EMBEDDINGS))
            if len(ids) == len(embs):
                return ids, embs
            print("  Warning: cache ID/embedding count mismatch — rebuilding")
        except Exception as e:
            print(f"  Warning: cache load failed ({e}) — rebuilding")
    return [], None


def _save_cache(ids: list[str], embs: np.ndarray) -> None:
    """Save Nomic embeddings to disk cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.save(str(CACHE_EMBEDDINGS), embs)
    CACHE_POINT_IDS.write_text(json.dumps(ids))


def _fetch_content_for_points(point_ids: list[str], batch_size: int = 50) -> dict[str, str]:
    """Fetch decrypted text content for clustering points via Worker."""
    content_map = {}

    for i in range(0, len(point_ids), batch_size):
        batch = point_ids[i:i+batch_size]
        placeholders = ','.join(['?'] * len(batch))

        rows = d1_query(f"""
            SELECT cp.id,
                CASE
                    WHEN cp.source_type = 'message' THEN m.content
                    WHEN cp.source_type = 'document' THEN d.content
                    WHEN cp.source_type IN ('transcript', 'image_description') THEN
                        COALESCE(a.transcript, a.description)
                END as content
            FROM clustering_points cp
            LEFT JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
            LEFT JOIN documents d ON d.id = cp.source_id AND cp.source_type = 'document'
            LEFT JOIN attachments a ON a.id = cp.source_id
                AND cp.source_type IN ('transcript', 'image_description')
            WHERE cp.id IN ({placeholders})
        """, batch)

        for r in rows:
            if r.get('content'):
                content_map[r['id']] = r['content']

        pct = min(100, int((i + len(batch)) / len(point_ids) * 100))
        print(f"\r  Fetching content: {pct}% ({len(content_map)} with text)", end="", flush=True)

    print()
    return content_map


def _embed_batch(point_ids: list[str], batch_size: int = 50) -> tuple[list[str], np.ndarray]:
    """
    Fetch content and embed in streaming chunks to minimize peak memory.

    Uses ONNX Runtime directly (no torch — saves ~1.5GB RAM).
    Model: Nomic v1.5 quantized int8 ONNX (~170MB vs 550MB float32).

    Flow per chunk:
      1. Fetch decrypted content from D1
      2. Tokenize with HuggingFace tokenizer
      3. Run ONNX session → mean pool → truncate 768→256D → discard text
      4. Append 256D result to output array
    """
    import onnxruntime as ort
    from transformers import AutoTokenizer
    from huggingface_hub import hf_hub_download

    EMBED_CHUNK = 500  # Points per chunk (fetch + embed + discard)
    ONNX_FILE = "onnx/model_quantized.onnx"  # int8 quantized (~170MB)

    print("  Loading Nomic v1.5 tokenizer + ONNX model (quantized int8)...")

    # Download ONNX model file if not cached
    model_path = hf_hub_download(NOMIC_MODEL, ONNX_FILE)

    # Create ONNX session with memory-efficient settings
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.inter_op_num_threads = 2
    sess_options.intra_op_num_threads = 2  # Conservative thread count for VPS
    session = ort.InferenceSession(model_path, sess_options, providers=['CPUExecutionProvider'])

    tokenizer = AutoTokenizer.from_pretrained(NOMIC_MODEL, trust_remote_code=True)

    all_embs = []
    all_ids = []
    n_chunks = (len(point_ids) + EMBED_CHUNK - 1) // EMBED_CHUNK

    for chunk_idx in range(0, len(point_ids), EMBED_CHUNK):
        chunk_pids = point_ids[chunk_idx:chunk_idx + EMBED_CHUNK]
        chunk_num = chunk_idx // EMBED_CHUNK + 1

        # Fetch content for this chunk only
        content_map = _fetch_content_for_points(chunk_pids)

        # Build texts + embeddable IDs
        texts = []
        embeddable_ids = []
        for pid in chunk_pids:
            content = content_map.get(pid)
            if content and len(content.strip()) > 0:
                texts.append(NOMIC_TASK_PREFIX + content[:NOMIC_MAX_CHARS])
                embeddable_ids.append(pid)

        # Free content strings immediately
        del content_map
        gc.collect()

        if not texts:
            print(f"    Chunk {chunk_num}/{n_chunks}: 0 embeddable texts (skipped)")
            continue

        # Tokenize + run ONNX in sub-batches
        chunk_embs_list = []
        for bi in range(0, len(texts), NOMIC_BATCH_SIZE):
            batch_texts = texts[bi:bi + NOMIC_BATCH_SIZE]
            encoded = tokenizer(batch_texts, padding=True, truncation=True,
                                max_length=512, return_tensors="np")

            feed = {
                "input_ids": encoded["input_ids"].astype(np.int64),
                "attention_mask": encoded["attention_mask"].astype(np.int64),
            }
            if "token_type_ids" in encoded:
                feed["token_type_ids"] = encoded["token_type_ids"].astype(np.int64)
            else:
                feed["token_type_ids"] = np.zeros_like(encoded["input_ids"], dtype=np.int64)

            outputs = session.run(None, feed)

            # Mean pooling: average token embeddings (masked)
            token_embs = outputs[0]  # (batch, seq_len, 768)
            mask = encoded["attention_mask"][:, :, np.newaxis].astype(np.float32)
            pooled = (token_embs * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)

            # Truncate 768→256D
            chunk_embs_list.append(pooled[:, :NOMIC_DIM].astype(np.float32))

            del encoded, outputs, token_embs, mask, pooled
            gc.collect()

        chunk_embs = np.vstack(chunk_embs_list)
        del texts, chunk_embs_list
        gc.collect()

        all_embs.append(chunk_embs)
        all_ids.extend(embeddable_ids)
        print(f"    Chunk {chunk_num}/{n_chunks}: {len(embeddable_ids)} texts encoded")

    # ── Free model completely ──
    del session, tokenizer
    gc.collect()
    gc.collect()

    # Unload modules
    for prefix in ('onnxruntime', 'transformers', 'tokenizers', 'huggingface_hub'):
        mods_to_del = [k for k in sys.modules if k.startswith(prefix)]
        for mod in mods_to_del:
            del sys.modules[mod]
    gc.collect()

    try:
        import psutil
        mem_mb = psutil.Process().memory_info().rss / 1024 / 1024
        print(f"  Memory after model cleanup: {mem_mb:.0f} MB")
    except ImportError:
        pass

    if not all_embs:
        return [], np.array([])

    # Stack and L2 normalize
    embs = np.vstack(all_embs)
    del all_embs
    gc.collect()

    norms = np.linalg.norm(embs, axis=1, keepdims=True)
    norms[norms == 0] = 1
    embs = embs / norms

    skipped = len(point_ids) - len(all_ids)
    if skipped > 0:
        print(f"  Skipped {skipped} points with no/empty content")

    return all_ids, embs


def _write_embeddings_to_d1(
    point_ids: list[str], embeddings: np.ndarray, dry_run: bool = False,
) -> None:
    """Write Nomic 256D embeddings back to D1 as hex-encoded BLOBs."""
    if dry_run:
        print(f"  (dry run) Would write {len(point_ids)} embeddings to D1")
        return

    BATCH = 50
    written = 0
    for i in range(0, len(point_ids), BATCH):
        batch_ids = point_ids[i:i+BATCH]
        statements = []
        for j, pid in enumerate(batch_ids):
            idx = i + j
            emb_hex = embeddings[idx].astype(np.float32).tobytes().hex()
            statements.append({
                "sql": f"UPDATE clustering_points SET nomic_embedding = X'{emb_hex}', "
                       f"embedding_model = 'nomic-v1.5-256d' WHERE id = ?",
                "params": [pid],
            })
        d1_batch(statements)
        written += len(batch_ids)
        if written % 500 == 0 or written == len(point_ids):
            print(f"\r  Writing embeddings to D1: {written}/{len(point_ids)}", end="", flush=True)
    print()


def fetch_all_embeddings(batch_size: int = 100, dry_run: bool = False) -> tuple[list[str], np.ndarray]:
    """
    Get Nomic v1.5 256D embeddings for all clustering points.

    Primary store: D1 `nomic_embedding` BLOB column.
    Only embeds points with NULL nomic_embedding (new/un-embedded).
    Also maintains a local .npy file cache for fast startup.
    """
    print("  Fetching clustering points from D1...")

    rows = d1_query("""
        SELECT id, source_id, source_type,
               nomic_embedding IS NOT NULL as has_embedding
        FROM clustering_points
        ORDER BY created_at
    """)

    if not rows:
        return [], np.array([])

    current_ids = [r['id'] for r in rows]
    has_emb = {r['id'] for r in rows if r.get('has_embedding')}
    need_emb = [r['id'] for r in rows if not r.get('has_embedding')]
    print(f"  Found {len(current_ids)} clustering points ({len(has_emb)} with embeddings, {len(need_emb)} need embedding)")

    # Try local file cache first (faster than loading BLOBs from D1)
    cached_ids, cached_embs = _load_cache()
    cached_set = set(cached_ids)

    # Check if file cache covers everything
    uncached = [pid for pid in current_ids if pid not in cached_set]
    if len(uncached) == 0 and cached_embs is not None:
        print(f"  File cache hit: {len(cached_ids)} embeddings loaded from disk")
        id_to_idx = {pid: i for i, pid in enumerate(cached_ids)}
        order = [id_to_idx[pid] for pid in current_ids if pid in id_to_idx]
        valid = [pid for pid in current_ids if pid in id_to_idx]
        return valid, cached_embs[order]

    # Merge file cache into emb_map (for points in cache but not yet in D1)
    emb_map = {}
    if cached_embs is not None and len(cached_ids) > 0:
        id_to_idx = {pid: i for i, pid in enumerate(cached_ids)}
        for pid in current_ids:
            if pid in id_to_idx:
                emb_map[pid] = cached_embs[id_to_idx[pid]]
        print(f"  File cache: {len(emb_map)} embeddings loaded from disk ({len(uncached)} uncached)")

    # Load existing embeddings from D1 (for points that have them but aren't in file cache)
    d1_load = [pid for pid in has_emb if pid not in emb_map]
    if d1_load:
        print(f"  Loading {len(d1_load)} existing embeddings from D1...")
        emb_ids = list(d1_load)
        for i in range(0, len(emb_ids), 200):
            batch = emb_ids[i:i+200]
            placeholders = ','.join(['?'] * len(batch))
            blob_rows = d1_query(
                f"SELECT id, nomic_embedding FROM clustering_points WHERE id IN ({placeholders})",
                batch,
            )
            for r in blob_rows:
                blob = r.get('nomic_embedding')
                if blob and len(blob) >= NOMIC_DIM * 4:
                    if isinstance(blob, str):
                        # Hex-encoded blob from D1
                        import binascii
                        try:
                            blob = binascii.unhexlify(blob)
                        except Exception:
                            blob = bytes(blob, 'latin-1')
                    emb_map[r['id']] = np.frombuffer(blob[:NOMIC_DIM*4], dtype=np.float32)
            pct = min(100, int((i + len(batch)) / len(emb_ids) * 100))
            print(f"\r  Loading embeddings from D1: {pct}%", end="", flush=True)
        print(f"\r  Loaded {len(emb_map)} embeddings from D1        ")

    # Embed points that have no embedding anywhere
    truly_new = [pid for pid in need_emb if pid not in emb_map]
    new_embs_map = {}
    if truly_new:
        print(f"\n  Embedding {len(truly_new)} new points with Nomic v1.5...")
        embeddable_ids, new_embs = _embed_batch(truly_new)
        if new_embs is not None and len(embeddable_ids) > 0:
            for i, pid in enumerate(embeddable_ids):
                new_embs_map[pid] = new_embs[i]
            # Write new embeddings to D1
            print(f"  Saving {len(embeddable_ids)} new embeddings to D1...")
            _write_embeddings_to_d1(embeddable_ids, new_embs, dry_run=dry_run)

    # Assemble final array in temporal order
    all_ids = []
    all_embs_list = []
    for pid in current_ids:
        emb = emb_map.get(pid)
        if emb is None:
            emb = new_embs_map.get(pid)
        if emb is not None:
            all_ids.append(pid)
            all_embs_list.append(emb)

    if not all_embs_list:
        return [], np.array([])

    ordered_embs = np.stack(all_embs_list)

    # Save file cache for fast startup next time
    _save_cache(all_ids, ordered_embs)
    print(f"  Final: {len(all_ids)} points with 256D Nomic embeddings")

    # Free intermediates
    del emb_map, new_embs_map
    gc.collect()

    return all_ids, ordered_embs


# ── Clustering (FAISS k-NN + multi-resolution Leiden) ─────────────

def build_knn_graph(embeddings, k=KNN_K):
    """Build k-NN graph using FAISS (cosine via inner product on L2-normed vectors)."""
    import faiss
    import igraph as ig
    n, d = embeddings.shape
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normed = (embeddings / norms).astype(np.float32)
    index = faiss.IndexFlatIP(d)
    index.add(normed)
    sims, indices = index.search(normed, k + 1)
    edges, weights = [], []
    for i in range(n):
        for j_pos in range(1, k + 1):
            j = int(indices[i, j_pos])
            if 0 <= j != i:
                edges.append((i, j))
                weights.append(max(0.0, float(sims[i, j_pos])))
    G = ig.Graph(n=n, edges=edges, directed=True)
    G.es['weight'] = weights
    G = G.as_undirected(mode='collapse', combine_edges={'weight': 'max'})
    return G, sims


def leiden_for_k(graph, target_k, lo=1e-5, hi=5.0, tol=0.1):
    """Binary search for Leiden resolution producing ~target_k clusters."""
    import leidenalg as la
    best_res, best_k, best_labels = lo, 0, None
    for _ in range(25):
        mid = (lo + hi) / 2
        part = la.find_partition(graph, la.CPMVertexPartition,
                                 resolution_parameter=mid, weights='weight', seed=LEIDEN_SEED)
        labels = np.array(part.membership)
        k = len(set(labels))
        if best_labels is None or abs(k - target_k) < abs(best_k - target_k):
            best_res, best_k, best_labels = mid, k, labels
        if abs(k - target_k) <= max(1, target_k * tol):
            return mid, k, labels
        elif k > target_k:
            hi = mid
        else:
            lo = mid
    return best_res, best_k, best_labels


def enforce_nesting(child_labels, parent_labels):
    """Reassign parent labels so every child cluster maps to exactly one parent."""
    child_to_parent = {}
    for cid in set(child_labels):
        if cid < 0: continue
        mask = child_labels == cid
        counts = Counter(parent_labels[mask])
        child_to_parent[cid] = counts.most_common(1)[0][0]
    return np.array([child_to_parent.get(child_labels[i], parent_labels[i]) for i in range(len(child_labels))])


def detect_noise(graph, labels, knn_sims):
    """Dual noise detection: weak community membership + k-NN distance outlier."""
    n = len(labels)
    noise = np.zeros(n, dtype=bool)
    for node in range(graph.vcount()):
        nbs = graph.neighbors(node)
        if not nbs:
            noise[node] = True
            continue
        same = sum(1 for nb in nbs if labels[nb] == labels[node])
        if same / len(nbs) < NOISE_MEMBERSHIP_THRESHOLD:
            noise[node] = True
    mean_sims = knn_sims[:, 1:].mean(axis=1)
    threshold = mean_sims.mean() - NOISE_KNN_SIGMA * mean_sims.std()
    noise |= (mean_sims < threshold)
    return noise


def run_clustering(embeddings: np.ndarray) -> dict:
    """
    FAISS k-NN + multi-resolution Leiden clustering.
    Clusters in native 256D space — no UMAP distortion.
    UMAP used only for 3D visualization coordinates.

    Returns dict with:
        realm_ids, theme_ids, territory_ids, atom_ids: arrays of cluster assignments
        coords_3d: (N, 3) array of UMAP 3D coordinates
        is_liminal: boolean array (True for noise points)
    """
    from scipy.cluster.hierarchy import linkage, fcluster
    import umap

    n_points = len(embeddings)
    print(f"\n  Running clustering on {n_points} points...")

    # ── Stage 1: Build k-NN graph in native 256D ──
    print(f"  Building k-NN graph (k={KNN_K}, cosine)...")
    graph, knn_sims = build_knn_graph(embeddings, k=KNN_K)
    print(f"    {graph.vcount()} nodes, {graph.ecount()} edges")

    # ── Stage 2: Multi-resolution Leiden ──
    print(f"  Leiden → atoms (target ~{TARGET_ATOMS})...")
    _, n_atoms, atom_labels = leiden_for_k(graph, TARGET_ATOMS)
    print(f"    → {n_atoms} atoms")

    print(f"  Leiden → territories (target ~{TARGET_TERRITORIES})...")
    _, n_territories, territory_labels = leiden_for_k(graph, TARGET_TERRITORIES)
    print(f"    → {n_territories} territories")

    print(f"  Leiden → themes (target ~{TARGET_THEMES})...")
    _, n_themes, theme_labels = leiden_for_k(graph, TARGET_THEMES)
    print(f"    → {n_themes} themes")

    # ── Stage 3: Enforce strict hierarchy (bottom-up majority vote) ──
    print("  Enforcing hierarchy nesting...")
    territory_labels = enforce_nesting(atom_labels, territory_labels)
    theme_labels = enforce_nesting(territory_labels, theme_labels)

    # ── Stage 4: Realms via Ward HAC on theme centroids ──
    print("  Deriving realms (Ward HAC on theme centroids)...")
    unique_themes = sorted(set(theme_labels))
    if len(unique_themes) > 1:
        theme_centroids = np.array([
            embeddings[theme_labels == t].mean(axis=0) for t in unique_themes
        ])
        norms = np.linalg.norm(theme_centroids, axis=1, keepdims=True)
        norms[norms == 0] = 1
        theme_centroids = theme_centroids / norms

        Z = linkage(theme_centroids, method='ward', metric='euclidean')
        merge_dists = Z[:, 2]
        if len(merge_dists) > 1:
            gaps = np.diff(merge_dists)
            n_realms = len(theme_centroids) - np.argmax(gaps) - 1
            n_realms = max(TARGET_REALMS_MIN, min(TARGET_REALMS_MAX, n_realms))
        else:
            n_realms = TARGET_REALMS_MIN

        realm_of_theme = fcluster(Z, t=n_realms, criterion='maxclust') - 1
        theme_to_realm = {unique_themes[i]: int(realm_of_theme[i]) for i in range(len(unique_themes))}
        realm_labels = np.array([theme_to_realm.get(theme_labels[i], 0) for i in range(n_points)])
    else:
        realm_labels = np.zeros(n_points, dtype=int)
        n_realms = 1
    print(f"    → {n_realms} realms")

    # ── Stage 5: Noise detection (dual strategy) ──
    print("  Detecting noise...")
    noise_mask = detect_noise(graph, territory_labels, knn_sims)
    n_noise = np.sum(noise_mask)
    print(f"    → {n_noise} noise points ({n_noise/n_points*100:.1f}%)")

    is_liminal = noise_mask.copy()
    if n_noise > 0:
        liminal_offset = max(0, territory_labels.max()) + 1000
        liminal_count = 0
        for realm_id in sorted(set(realm_labels)):
            if realm_id < 0:
                continue
            realm_noise = noise_mask & (realm_labels == realm_id)
            if np.sum(realm_noise) > 0:
                territory_labels[realm_noise] = liminal_offset + liminal_count
                print(f"    Realm {realm_id}: {np.sum(realm_noise)} noise → liminal territory {liminal_offset + liminal_count}")
                liminal_count += 1
        if liminal_count > 0:
            n_territories += liminal_count
            print(f"    Created {liminal_count} liminal territories")

    # ── Stage 6: UMAP 3D (visualization only — decoupled from clustering) ──
    print("  UMAP 256D → 3D (visualization only)...")
    reducer_3d = umap.UMAP(
        n_components=UMAP_N_COMPONENTS_VIZ,
        n_neighbors=UMAP_N_NEIGHBORS_VIZ,
        min_dist=UMAP_MIN_DIST_VIZ,
        metric='cosine',
        random_state=42,
    )
    coords_3d = reducer_3d.fit_transform(embeddings)

    print(f"\n  Clustering complete: {n_realms} realms, {n_themes} themes, "
          f"{n_territories} territories, {n_atoms} atoms")

    return {
        'realm_ids': realm_labels,
        'theme_ids': theme_labels,
        'territory_ids': territory_labels,
        'atom_ids': atom_labels,
        'coords_3d': coords_3d,
        'is_liminal': is_liminal,
    }


# ── Jaccard Stabilization ──────────────────────────────────────────

def stabilize_ids(
    old_assignments: dict[str, int],
    new_assignments: dict[str, int],
    level: str,
) -> tuple[dict[int, int], list[dict]]:
    """
    Match new cluster IDs to old ones by Jaccard membership overlap.
    Returns:
        id_mapping: {new_id: stable_id} for relabeling
        events: list of growth event dicts
    """
    if not old_assignments:
        # First run — all clusters are newly formed
        unique_new = set(new_assignments.values()) - {-1}
        events = []
        for cid in unique_new:
            members = [k for k, v in new_assignments.items() if v == cid]
            events.append({
                'event_type': 'formed',
                'cluster_id': int(cid),
                'point_count': len(members),
                'point_delta': len(members),
            })
        return {cid: cid for cid in unique_new}, events

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
    matches = []
    for new_id, new_members in new_clusters.items():
        for old_id, old_members in old_clusters.items():
            intersection = len(new_members & old_members)
            union = len(new_members | old_members)
            jaccard = intersection / union if union > 0 else 0
            if jaccard >= JACCARD_THRESHOLD:
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

    # New clusters (no match to any old)
    next_id = max(list(old_clusters.keys()) + list(new_clusters.keys())) + 1 if old_clusters or new_clusters else 0
    for new_id in new_clusters:
        if new_id not in matched_new:
            id_mapping[new_id] = next_id
            events.append({
                'event_type': 'formed',
                'cluster_id': int(next_id),
                'point_count': len(new_clusters[new_id]),
                'point_delta': len(new_clusters[new_id]),
            })
            next_id += 1

    # Dissolved clusters (old with no match to any new)
    for old_id in old_clusters:
        if old_id not in matched_old:
            events.append({
                'event_type': 'dissolved',
                'cluster_id': int(old_id),
                'old_cluster_ids': json.dumps([int(old_id)]),
                'point_count': 0,
                'point_delta': -len(old_clusters[old_id]),
            })

    return id_mapping, events


# ── Write Results ──────────────────────────────────────────────────

def write_results(
    point_ids: list[str],
    results: dict,
    version: str,
    dry_run: bool = False,
) -> None:
    """Write clustering assignments back to D1."""

    n = len(point_ids)
    print(f"\n  Writing {n} clustering assignments to D1...")

    if dry_run:
        print("  (dry run — skipping writes)")
        return

    BATCH = 50  # D1 batch limit is 100 statements

    for i in range(0, n, BATCH):
        batch_ids = point_ids[i:i+BATCH]
        statements = []

        for j, pid in enumerate(batch_ids):
            idx = i + j
            statements.append({
                "sql": """UPDATE clustering_points SET
                    realm_id = ?, theme_id = ?, territory_id = ?, atom_id = ?,
                    is_liminal = ?,
                    landscape_x = ?, landscape_y = ?, landscape_z = ?,
                    cluster_version = ?,
                    updated_at = datetime('now')
                WHERE id = ?""",
                "params": [
                    int(results['realm_ids'][idx]),
                    int(results['theme_ids'][idx]) if results['theme_ids'][idx] >= 0 else None,
                    int(results['territory_ids'][idx]) if results['territory_ids'][idx] >= 0 else None,
                    int(results['atom_ids'][idx]) if results['atom_ids'][idx] >= 0 else None,
                    1 if results['is_liminal'][idx] else 0,
                    float(results['coords_3d'][idx][0]),
                    float(results['coords_3d'][idx][1]),
                    float(results['coords_3d'][idx][2]),
                    version,
                    pid,
                ],
            })

        d1_batch(statements)
        pct = min(100, int((i + len(batch_ids)) / n * 100))
        print(f"\r  Write progress: {pct}%", end="", flush=True)

    print()


def write_events(events: list[dict], level: str, version: str, user_id: str, dry_run: bool = False) -> None:
    """Write growth events to cluster_events table."""
    if not events or dry_run:
        return

    statements = []
    for evt in events:
        statements.append({
            "sql": """INSERT INTO cluster_events
                (user_id, cluster_version, level, event_type, cluster_id,
                 old_cluster_ids, new_cluster_ids, jaccard_score,
                 point_count, point_delta, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            "params": [
                user_id, version, level,
                evt.get('event_type', ''),
                evt.get('cluster_id'),
                evt.get('old_cluster_ids'),
                evt.get('new_cluster_ids'),
                evt.get('jaccard_score'),
                evt.get('point_count', 0),
                evt.get('point_delta', 0),
                evt.get('description'),
            ],
        })

    # Batch in groups of 50
    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote {len(events)} {level} events")


# ── Activity Timelines ─────────────────────────────────────────────

def compute_activity_timelines(
    point_ids: list[str],
    results: dict,
    user_id: str,
    dry_run: bool = False,
) -> None:
    """
    Compute monthly message counts per territory and realm.
    Stores as JSON array [{month: "2025-12", count: 14}, ...] in
    territory_profiles.activity_timeline and realms.activity_timeline.
    """
    print("\n  Computing activity timelines...")

    # Fetch created_at dates for all clustering points
    rows = d1_query("""
        SELECT cp.id, cp.territory_id, cp.realm_id,
               COALESCE(m.created_at, d.created_at, a.created_at) as created_at
        FROM clustering_points cp
        LEFT JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
        LEFT JOIN documents d ON d.id = cp.source_id AND cp.source_type = 'document'
        LEFT JOIN attachments a ON a.id = cp.source_id AND cp.source_type IN ('transcript', 'image_description')
        WHERE cp.territory_id IS NOT NULL
    """)

    # Aggregate monthly counts per territory and realm
    terr_monthly = defaultdict(lambda: defaultdict(int))
    realm_monthly = defaultdict(lambda: defaultdict(int))

    for r in rows:
        month = (r.get('created_at') or '')[:7]
        if not month:
            continue
        tid = r.get('territory_id')
        rid = r.get('realm_id')
        if tid is not None and tid >= 0:
            terr_monthly[tid][month] += 1
        if rid is not None and rid >= 0:
            realm_monthly[rid][month] += 1

    if dry_run:
        print(f"  (dry run) Would write activity for {len(terr_monthly)} territories, {len(realm_monthly)} realms")
        return

    # Write territory activity timelines
    statements = []
    for tid, monthly in terr_monthly.items():
        timeline = sorted([{"month": m, "count": c} for m, c in monthly.items()], key=lambda x: x["month"])
        statements.append({
            "sql": """UPDATE territory_profiles SET activity_timeline = ?
                      WHERE territory_id = ? AND user_id = ?""",
            "params": [json.dumps(timeline), tid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    # Write realm activity timelines
    statements = []
    for rid, monthly in realm_monthly.items():
        timeline = sorted([{"month": m, "count": c} for m, c in monthly.items()], key=lambda x: x["month"])
        statements.append({
            "sql": """UPDATE realms SET activity_timeline = ?
                      WHERE realm_id = ? AND user_id = ?""",
            "params": [json.dumps(timeline), rid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote activity timelines for {len(terr_monthly)} territories, {len(realm_monthly)} realms")


# ── 3D Centroids ──────────────────────────────────────────────────

def compute_and_store_centroids(
    point_ids: list[str],
    results: dict,
    user_id: str,
    dry_run: bool = False,
) -> None:
    """Compute and store 3D centroids for each territory."""
    print("\n  Computing territory 3D centroids...")

    terr_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        tid = int(results['territory_ids'][i])
        if tid >= 0:
            terr_members[tid].append(i)

    if dry_run:
        print(f"  (dry run) Would write centroids for {len(terr_members)} territories")
        return

    statements = []
    for tid, member_indices in terr_members.items():
        coords = results['coords_3d'][member_indices]
        centroid = coords.mean(axis=0).tolist()
        statements.append({
            "sql": """UPDATE territory_profiles SET centroid_3d = ?
                      WHERE territory_id = ? AND user_id = ?""",
            "params": [json.dumps(centroid), tid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote 3D centroids for {len(statements)} territories")


def compute_and_store_centroids_256d(
    point_ids: list[str],
    results: dict,
    embeddings: np.ndarray,
    user_id: str,
    dry_run: bool = False,
) -> None:
    """Compute and store 256D Nomic centroids for each territory (for contact linking)."""
    print("\n  Computing territory 256D centroids...")

    terr_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        tid = int(results['territory_ids'][i])
        if tid >= 0:
            terr_members[tid].append(i)

    if dry_run:
        print(f"  (dry run) Would write 256D centroids for {len(terr_members)} territories")
        return

    statements = []
    for tid, member_indices in terr_members.items():
        centroid = embeddings[member_indices].mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = centroid / norm
        statements.append({
            "sql": """UPDATE territory_profiles SET centroid_256 = ?
                      WHERE territory_id = ? AND user_id = ?""",
            "params": [json.dumps(centroid.tolist()), tid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote 256D centroids for {len(statements)} territories")


# ── Realm Neighbors ───────────────────────────────────────────────

def compute_realm_neighbors(
    point_ids: list[str],
    results: dict,
    embeddings: np.ndarray,
    user_id: str,
    dry_run: bool = False,
) -> None:
    """
    Compute realm-level centroids and find nearest neighbors by cosine similarity.
    Stores top-3 neighbors per realm in realm_neighbors table.
    """
    print("\n  Computing realm neighbors...")

    # Build realm → member indices
    realm_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        rid = int(results['realm_ids'][i])
        if rid >= 0:
            realm_members[rid].append(i)

    if len(realm_members) < 2:
        print("  Fewer than 2 realms — skipping neighbor computation")
        return

    # Compute realm centroids in embedding space
    realm_centroids = {}
    for rid, members in realm_members.items():
        realm_centroids[rid] = embeddings[members].mean(axis=0)

    # Normalize for cosine similarity
    for rid in realm_centroids:
        norm = np.linalg.norm(realm_centroids[rid])
        if norm > 0:
            realm_centroids[rid] = realm_centroids[rid] / norm

    # Find top-3 neighbors per realm
    neighbor_pairs = []
    for rid, centroid in realm_centroids.items():
        sims = []
        for other_rid, other_centroid in realm_centroids.items():
            if other_rid == rid:
                continue
            sim = float(np.dot(centroid, other_centroid))
            sims.append((other_rid, sim))
        sims.sort(key=lambda x: -x[1])
        for rank, (neighbor_rid, sim) in enumerate(sims[:3]):
            neighbor_pairs.append((rid, neighbor_rid, sim, rank + 1))

    if dry_run:
        print(f"  (dry run) Would write {len(neighbor_pairs)} realm neighbor pairs")
        for rid, nid, sim, rank in neighbor_pairs[:10]:
            print(f"    Realm {rid} → Realm {nid}: similarity={sim:.4f} (rank {rank})")
        return

    # Clear existing neighbors and write new ones
    d1_query("DELETE FROM realm_neighbors WHERE user_id = ?", [user_id])

    statements = []
    for rid, neighbor_rid, sim, rank in neighbor_pairs:
        statements.append({
            "sql": """INSERT INTO realm_neighbors (user_id, realm_id, neighbor_id, connection_type, connection_strength)
                      VALUES (?, ?, ?, 'semantic', ?)""",
            "params": [user_id, rid, neighbor_rid, round(sim, 4)],
        })

    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote {len(neighbor_pairs)} realm neighbor pairs")


# ── Territory Dynamics ─────────────────────────────────────────────

def compute_dynamics(
    point_ids: list[str],
    results: dict,
    embeddings: np.ndarray,
    terr_events: list[dict],
    old_territories: dict[str, int],
    user_id: str,
    dry_run: bool = False,
) -> None:
    """
    Compute and write territory dynamics to territory_profiles:
      - energy: attention share (point_count / total)
      - velocity: centroid movement in embedding space vs previous cycle
      - vitality: mean pairwise cosine similarity within territory
      - growth_state: from growth events (growing/steady/stuck)
    """
    print("\n  Computing territory dynamics...")

    total_points = len(point_ids)
    if total_points == 0:
        return

    # Build territory → member indices mapping
    terr_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        tid = int(results['territory_ids'][i])
        if tid >= 0:
            terr_members[tid].append(i)

    # Build old territory → member indices for velocity
    old_terr_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        old_tid = old_territories.get(pid)
        if old_tid is not None and old_tid >= 0:
            old_terr_members[old_tid].append(i)

    # Event type lookup
    event_by_tid = {}
    for evt in terr_events:
        event_by_tid[evt['cluster_id']] = evt['event_type']

    statements = []
    for tid, member_indices in terr_members.items():
        count = len(member_indices)

        # Energy: attention share
        energy = count / total_points

        # Vitality: mean cosine similarity within territory (sample if large)
        vitality = 0.0
        if count >= 2:
            sample_size = min(count, 50)
            if sample_size < count:
                sampled = np.random.choice(member_indices, sample_size, replace=False)
            else:
                sampled = member_indices

            embs = embeddings[sampled]
            # Normalize for cosine similarity
            norms = np.linalg.norm(embs, axis=1, keepdims=True)
            norms[norms == 0] = 1
            normed = embs / norms
            sim_matrix = normed @ normed.T
            # Mean of upper triangle (excluding diagonal)
            n = len(sampled)
            upper_sum = (sim_matrix.sum() - n) / 2  # subtract diagonal
            pairs = n * (n - 1) / 2
            vitality = float(upper_sum / pairs) if pairs > 0 else 0.0

        # Velocity: centroid movement vs old territory
        velocity = 0.0
        if tid in old_terr_members and len(old_terr_members[tid]) >= 2:
            old_centroid = embeddings[old_terr_members[tid]].mean(axis=0)
            new_centroid = embeddings[member_indices].mean(axis=0)
            velocity = float(np.linalg.norm(new_centroid - old_centroid))

        # Growth state from events
        evt_type = event_by_tid.get(tid, 'stable')
        if evt_type in ('formed', 'grew'):
            growth_state = 'growing'
        elif evt_type == 'stable':
            growth_state = 'steady'
        else:
            growth_state = 'steady'

        # Get realm_id for this territory (majority vote from members)
        realm_ids = [int(results['realm_ids'][i]) for i in member_indices]
        realm_counter = Counter(realm_ids)
        realm_id = realm_counter.most_common(1)[0][0] if realm_counter else None

        point_delta = 0
        for evt in terr_events:
            if evt['cluster_id'] == tid:
                point_delta = evt.get('point_delta', 0)
                break

        statements.append({
            "sql": """INSERT INTO territory_profiles (user_id, territory_id, energy, vitality, velocity,
                growth_state, message_count, point_delta, realm_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(territory_id, user_id) DO UPDATE SET
                    energy = excluded.energy, vitality = excluded.vitality,
                    velocity = excluded.velocity, growth_state = excluded.growth_state,
                    message_count = excluded.message_count, point_delta = excluded.point_delta,
                    realm_id = excluded.realm_id, updated_at = datetime('now')""",
            "params": [
                user_id, tid,
                round(energy, 6), round(vitality, 4), round(velocity, 4),
                growth_state, count, point_delta, realm_id,
            ],
        })

    if dry_run:
        print(f"  (dry run) Would write dynamics for {len(statements)} territories")
        for s in statements[:5]:
            p = s['params']
            print(f"    T{p[1]}: energy={p[2]:.4f} vitality={p[3]:.4f} velocity={p[4]:.4f} state={p[5]} pts={p[6]}")
        return

    # Write in batches
    for i in range(0, len(statements), 50):
        d1_batch(statements[i:i+50])

    print(f"  Wrote dynamics for {len(statements)} territories")


# ── Main ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Mycelium Semantic Clustering')
    parser.add_argument('--dry-run', action='store_true', help='Run without writing results')
    parser.add_argument('--min-points', type=int, default=50, help='Minimum points to run clustering')
    parser.add_argument('--user-id', type=str, default=None, help='Canonical owner ID for territory profiles')
    parser.add_argument('--fresh-start', action='store_true', help='Skip Jaccard stabilization (first run with new algorithm)')
    args = parser.parse_args()

    print('╔══════════════════════════════════════════════╗')
    print('║  Mycelium Semantic Clustering Pipeline        ║')
    print('╚══════════════════════════════════════════════╝')
    print(f'  Worker: {WORKER_URL}')
    print(f'  Dry run: {args.dry_run}')

    version = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    # Canonical owner for territory profiles / realms / themes
    # All points cluster together regardless of source user_id
    user_id = args.user_id or os.environ.get('MINDSCAPE_OWNER_ID')
    if not user_id:
        # Fallback: most common user_id in clustering_points
        users = d1_query("SELECT user_id, COUNT(*) as c FROM clustering_points WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY c DESC LIMIT 1")
        user_id = users[0]['user_id'] if users else None
    if not user_id:
        print("  ERROR: No user_id found. Set --user-id or MINDSCAPE_OWNER_ID env var.")
        sys.exit(1)
    print(f'  User: {user_id}')

    # Fetch old assignments for Jaccard stabilization
    print("\n  Loading previous cluster assignments...")
    old_rows = d1_query("""
        SELECT id, realm_id, theme_id, territory_id, atom_id
        FROM clustering_points
        WHERE realm_id IS NOT NULL
    """)
    old_realms = {r['id']: r['realm_id'] for r in old_rows}
    old_territories = {r['id']: r['territory_id'] for r in old_rows}
    print(f"  Previous: {len(old_realms)} points with realm assignments")

    # Fetch embeddings
    point_ids, embeddings = fetch_all_embeddings(dry_run=args.dry_run)

    if len(point_ids) < args.min_points:
        print(f"\n  Only {len(point_ids)} points with embeddings (min: {args.min_points}). Skipping.")
        return

    # Run clustering
    results = run_clustering(embeddings)

    # Stabilize cluster IDs (Jaccard matching)
    if args.fresh_start:
        print("\n  Fresh start — skipping Jaccard stabilization (all territories treated as new)")
        # Assign sequential IDs, all events = 'formed'
        realm_events = [{'event_type': 'formed', 'cluster_id': int(rid), 'point_count': int(np.sum(results['realm_ids'] == rid)), 'point_delta': int(np.sum(results['realm_ids'] == rid))} for rid in set(results['realm_ids']) if rid >= 0]
        terr_events = [{'event_type': 'formed', 'cluster_id': int(tid), 'point_count': int(np.sum(results['territory_ids'] == tid)), 'point_delta': int(np.sum(results['territory_ids'] == tid))} for tid in set(results['territory_ids']) if tid >= 0]
    else:
        print("\n  Stabilizing cluster IDs (Jaccard matching)...")

    if not args.fresh_start:
        new_realms = {pid: int(results['realm_ids'][i]) for i, pid in enumerate(point_ids)}
        realm_mapping, realm_events = stabilize_ids(old_realms, new_realms, 'realm')

        for i, pid in enumerate(point_ids):
            old_label = int(results['realm_ids'][i])
            if old_label in realm_mapping:
                results['realm_ids'][i] = realm_mapping[old_label]

        new_territories = {pid: int(results['territory_ids'][i]) for i, pid in enumerate(point_ids)}
        terr_mapping, terr_events = stabilize_ids(old_territories, new_territories, 'territory')

        for i, pid in enumerate(point_ids):
            old_label = int(results['territory_ids'][i])
            if old_label in terr_mapping:
                results['territory_ids'][i] = terr_mapping[old_label]

    # Summary
    formed_realms = sum(1 for e in realm_events if e['event_type'] == 'formed')
    grew_realms = sum(1 for e in realm_events if e['event_type'] == 'grew')
    dissolved_realms = sum(1 for e in realm_events if e['event_type'] == 'dissolved')

    formed_terr = sum(1 for e in terr_events if e['event_type'] == 'formed')
    grew_terr = sum(1 for e in terr_events if e['event_type'] == 'grew')
    dissolved_terr = sum(1 for e in terr_events if e['event_type'] == 'dissolved')

    print(f"\n  Realm events:     {formed_realms} formed, {grew_realms} grew, {dissolved_realms} dissolved")
    print(f"  Territory events: {formed_terr} formed, {grew_terr} grew, {dissolved_terr} dissolved")

    # Write results
    write_results(point_ids, results, version, dry_run=args.dry_run)
    write_events(realm_events, 'realm', version, user_id, dry_run=args.dry_run)
    write_events(terr_events, 'territory', version, user_id, dry_run=args.dry_run)

    # Mark dissolved territories (preserve history instead of orphaning)
    dissolved = [e for e in terr_events if e['event_type'] == 'dissolved']
    if dissolved and not args.dry_run:
        print(f"  Marking {len(dissolved)} dissolved territories...")
        for e in dissolved:
            d1_query(
                "UPDATE territory_profiles SET dissolved_at = ?, dissolved_version = ? WHERE territory_id = ? AND user_id = ?",
                [version, version, e['cluster_id'], user_id],
            )

    # Compute and write territory dynamics (energy, vitality, velocity)
    compute_dynamics(
        point_ids, results, embeddings, terr_events,
        old_territories, user_id, dry_run=args.dry_run,
    )

    # Compute and store activity timelines (monthly message counts)
    compute_activity_timelines(
        point_ids, results, user_id, dry_run=args.dry_run,
    )

    # Compute and store 3D centroids for territory label placement
    compute_and_store_centroids(
        point_ids, results, user_id, dry_run=args.dry_run,
    )

    # Compute and store 256D centroids for contact linking
    compute_and_store_centroids_256d(
        point_ids, results, embeddings, user_id, dry_run=args.dry_run,
    )

    # Compute realm neighbor similarities
    compute_realm_neighbors(
        point_ids, results, embeddings, user_id, dry_run=args.dry_run,
    )

    print(f"\n  Clustering pipeline complete (version: {version})")


if __name__ == '__main__':
    main()
