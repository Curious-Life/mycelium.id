#!/usr/bin/env python3
"""
Mycelium Semantic Clustering Pipeline

Generates Nomic v1.5 256D embeddings (optimized for clustering),
then builds the hierarchy (realms → themes → territories → atoms) with
spherical k-means (atoms) + Ward agglomerative HAC on child centroids
(territories/themes/realms). A FAISS k-NN graph is built for NOISE
DETECTION only; UMAP produces the 3D landscape coords for the render and
is decoupled from clustering. NOTE: Leiden/leidenalg is imported and
parameterized (leiden_for_k) but is NOT used in the live hierarchy — it
was rejected for pathologically imbalanced CPM output (see the Stage 2/3
comments below). The "UMAP + HDBSCAN" of the original design is gone.
Stabilizes IDs across rebuilds via Jaccard matching, detects growth
events, and writes results back to the local encrypted SQLite vault.

Nomic 256D embeddings cached locally for fast incremental runs — the on-disk
cache is ENCRYPTED at rest (wrapped-DEK envelope via crypto_local, SEC-4), so no
plaintext embedding bytes ever touch the disk.
Search-side 768D embeddings (also Nomic v1.5, derived from the same source)
live in D1 `embedding_768` columns and are served by mind-search in-process —
no Vectorize, no Cloudflare AI dependency.

Usage:
    python3 scripts/cluster.py
    python3 scripts/cluster.py --dry-run
    python3 scripts/cluster.py --min-points 100

Env vars:
    MYCELIUM_DB        — path to the local encrypted SQLite vault (required)
    USER_MASTER, SYSTEM_KEY — 64-char hex vault keys (for encrypted writes)
    MYCELIUM_USER_ID   — owner id (default 'local-user')
"""

import os
import sys
import gc
import io
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter, defaultdict

import numpy as np
from dotenv import dotenv_values

import local_db  # V1 local vault data layer (replaces the Worker proxy)

# Load env from all .env files (same as ecosystem.config.cjs)
root = Path(__file__).resolve().parent.parent
for f in ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']:
    p = root / f
    if p.exists():
        for k, v in dotenv_values(p).items():
            if v is not None:
                os.environ.setdefault(k, v)

# Owner user_id scoping every clustering_points SELECT (single-user → local-user).
USER_ID = os.environ.get('MINDSCAPE_OWNER_ID') or os.environ.get('MYA_USER_ID') or os.environ.get('MYCELIUM_USER_ID') or 'local-user'

# V1 single-user: all reads/writes go straight to the local encrypted SQLite
# vault via local_db — there is NO Cloudflare Worker proxy. MYCELIUM_DB must
# point at the vault file.
if not os.environ.get('MYCELIUM_DB'):
    print("Missing MYCELIUM_DB (path to the local vault)")
    sys.exit(1)

# ── Clustering Parameters ──────────────────────────────────────────

# Nomic embedding
NOMIC_MODEL = "nomic-ai/nomic-embed-text-v1.5"
NOMIC_DIM = 256         # Matryoshka truncation (768 → 256)
NOMIC_TASK_PREFIX = "clustering: "  # Nomic task-specific prefix
NOMIC_MAX_CHARS = 2000  # Max input chars per text (keeps token count manageable)
NOMIC_BATCH_SIZE = int(os.environ.get('NOMIC_BATCH_SIZE', '8'))   # Texts per ONNX inference batch

# Cache paths
CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_EMBEDDINGS = CACHE_DIR / "nomic_embeddings.npy"
CACHE_POINT_IDS = CACHE_DIR / "nomic_point_ids.json"

# Clustering algo (replaced UMAP→HDBSCAN — Ada research 2026-04-02):
# spherical k-means (atoms) + Ward HAC (territories/themes/realms).
# The FAISS k-NN graph below feeds NOISE DETECTION only. Leiden/leidenalg
# is imported + parameterized (leiden_for_k) but NOT called in the live
# hierarchy (rejected: imbalanced CPM output) — kept for reference/noise.
KNN_K = 20                       # k-NN graph neighbors (noise detection)
LEIDEN_SEED = 42                  # fixed seed for determinism
# Default targets (for ~45K points). Auto-scaled by dataset size in main().
TARGET_ATOMS = 1500
TARGET_TERRITORIES = 300
TARGET_THEMES = 35
TARGET_REALMS_MIN = 2
TARGET_REALMS_MAX = 10

def scale_targets(n_points):
    """Scale clustering targets to dataset size (sqrt schedule).

    The old linear-with-floors schedule (territories = max(30, n//300),
    themes = max(8, n//1000)) was calibrated for ~45K points and is degenerate
    below N≈600: at N=152 the floors forced 30 territories over 152 points
    (~5 pts each). The sqrt schedule bridges smoothly — N=152 → 17/4,
    N=600 → 34/9 (≈ the old floors), N=45k → 297/50 (≈ the old targets).
    See docs/CLUSTERING-REBALANCE-DESIGN-2026-06-10.md.
    """
    global TARGET_ATOMS, TARGET_TERRITORIES, TARGET_THEMES
    TARGET_ATOMS = max(300, min(2000, n_points // 15))
    TARGET_TERRITORIES = int(max(2, min(300, round(1.4 * (n_points ** 0.5)))))
    TARGET_THEMES = int(max(2, min(50, round(0.35 * (n_points ** 0.5)))))
    if n_points < 600:
        print(f"  NOTE: {n_points} points is small for the 4-level hierarchy — targets auto-shrunk")
    print(f"  Scaled targets for {n_points} points: atoms={TARGET_ATOMS}, territories={TARGET_TERRITORIES}, themes={TARGET_THEMES}")
NOISE_MEMBERSHIP_THRESHOLD = 0.3
NOISE_KNN_SIGMA = 2.0
NOISE_MAX_SHARE = 0.15  # hard cap on the liminal share (percentile-bounding, research brief §1)

# UMAP (visualization ONLY — decoupled from clustering)
UMAP_N_COMPONENTS_VIZ = 3
UMAP_N_NEIGHBORS_VIZ = 15
UMAP_MIN_DIST_VIZ = 0.1

# Jaccard stabilization
JACCARD_THRESHOLD = 0.3  # minimum overlap to consider a match

# ── API Helpers ────────────────────────────────────────────────────

# ── Data layer (V1 single-user) ───────────────────────────────────
# Thin wrappers over local_db so the existing d1_* call-sites stay unchanged.
# There is NO Cloudflare Worker proxy: every read/write hits the local vault.

def d1_query(sql: str, params: list = None) -> list:
    """SELECT → list[dict]; a write issued via query (UPDATE/DELETE) → []."""
    return local_db.query(sql, params)


def d1_batch(statements: list) -> list:
    """Batch of PLAINTEXT statements (columns NOT in ENCRYPTED_FIELDS)."""
    local_db.batch(statements)
    return [{"ok": True, "count": len(statements or [])}]


def d1_batch_encrypted(statements: list) -> dict:
    """Batch write for ENCRYPTED_FIELDS columns (e.g. activity_timeline) — routed
    through the local Node encryption bridge so the values are encrypted at rest
    (the canonical autoEncryptParams chokepoint), never written as plaintext."""
    return local_db.batch_encrypted(statements)


# ── Nomic Embedding (local, cached) ───────────────────────────────

def _clear_cache() -> None:
    """Remove the on-disk cache files (best-effort; never raises)."""
    for p in (CACHE_EMBEDDINGS, CACHE_POINT_IDS):
        try:
            p.unlink()
        except (FileNotFoundError, OSError):
            pass


def _load_cache() -> tuple[list[str], np.ndarray | None]:
    """Decrypt-on-read the local Nomic embedding cache from disk.

    SEC-4 residual: the cache is ENCRYPTED at rest (wrapped-DEK envelope via
    crypto_local, same ``_NOMIC_SCOPE`` as the clustering_points.nomic_embedding
    column) — embeddings are sensitive, so no plaintext float bytes touch disk.
    Both files hold base64(JSON) envelope TEXT, not raw .npy / JSON. A legacy
    plaintext cache (pre-encryption) or one written under a different key fails to
    decrypt; we treat that as a miss AND delete the files so stale plaintext never
    lingers — the run then rebuilds and re-writes them encrypted via _save_cache.
    """
    if not (CACHE_EMBEDDINGS.exists() and CACHE_POINT_IDS.exists()):
        return [], None
    try:
        from crypto_local import decrypt_bytes, decrypt_str
        master_key = _get_master_key()
        ids = json.loads(decrypt_str(CACHE_POINT_IDS.read_text(), master_key))
        embs = np.load(io.BytesIO(decrypt_bytes(CACHE_EMBEDDINGS.read_text(), master_key)))
        if len(ids) == len(embs):
            return ids, embs
        print("  Warning: cache ID/embedding count mismatch — rebuilding")
    except Exception as e:
        print(f"  Warning: cache load failed ({e}) — rebuilding")
    # Decrypt/parse failure or mismatch → drop the files (never leave plaintext or
    # a stale envelope around) and rebuild from the encrypted DB column.
    _clear_cache()
    return [], None


def _save_cache(ids: list[str], embs: np.ndarray) -> None:
    """Encrypt-on-write the local Nomic embedding cache to disk (see _load_cache).

    The float32 matrix is serialized with np.save *into memory*, then the raw .npy
    buffer is wrapped in a crypto_local envelope before it touches the disk; the
    point-id list is likewise encrypted. If the master key is unavailable we skip
    caching entirely rather than fall back to writing plaintext.
    """
    try:
        from crypto_local import encrypt_bytes, encrypt_str
        master_key = _get_master_key()
    except Exception as e:
        print(f"  Warning: cache save skipped (master key unavailable: {e})")
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    np.save(buf, embs)
    CACHE_EMBEDDINGS.write_text(encrypt_bytes(buf.getvalue(), _NOMIC_SCOPE, master_key))
    CACHE_POINT_IDS.write_text(encrypt_str(json.dumps(ids), _NOMIC_SCOPE, master_key))


_MASTER_KEY_CACHE = None

# Scope tag for clustering_points.nomic_embedding envelopes. Must match the JS
# writer (pipeline/sync-clustering-points.js NOMIC_SCOPE). decrypt is
# scope-agnostic, so this only affects key derivation symmetry between the two
# writers (JS sync + this ONNX-fallback path).
_NOMIC_SCOPE = "personal"

def _get_master_key():
    """Lazy-load master key from tmpfs (avoids loading when not embedding)."""
    global _MASTER_KEY_CACHE
    if _MASTER_KEY_CACHE is None:
        from crypto_local import load_master_key
        _MASTER_KEY_CACHE = load_master_key()
    return _MASTER_KEY_CACHE


def _decode_nomic_embedding(value, master_key):
    """clustering_points.nomic_embedding → np.float32[NOMIC_DIM] or None.

    SEC-4: new rows store an ENCRYPTED wrapped-DEK envelope (base64 str, written
    by sync-clustering-points.js / _write_embeddings_to_d1 via encrypt_vector).
    Legacy rows stored a raw float32 BLOB (native bytes / JSON int list / hex
    str). Both are handled so a re-cluster across the migration boundary doesn't
    drop pre-existing points.
    """
    if value is None:
        return None
    # Encrypted-envelope path (str that parses as our base64(JSON) envelope).
    if isinstance(value, str):
        from crypto_local import is_encrypted, decrypt_vector
        if is_encrypted(value):
            try:
                return decrypt_vector(value, master_key, dim=NOMIC_DIM)
            except Exception:
                return None
    # Legacy raw float32 blob (pre-SEC-4). D1/sqlite can hand it back as bytes,
    # a JSON list of byte ints, or a hex string.
    blob = value
    if isinstance(blob, list):
        blob = bytes(blob)
    elif isinstance(blob, str):
        import binascii
        try:
            blob = binascii.unhexlify(blob)
        except Exception:
            blob = bytes(blob, "latin-1")
    if isinstance(blob, (bytes, bytearray)) and len(blob) >= NOMIC_DIM * 4:
        return np.frombuffer(bytes(blob)[:NOMIC_DIM * 4], dtype=np.float32)
    return None


def _fetch_content_for_points(point_ids: list[str], batch_size: int = 50) -> dict[str, str]:
    """Fetch + locally decrypt text content for clustering points (Swiss Vault)."""
    from crypto_local import decrypt_safe
    master_key = _get_master_key()
    content_map = {}
    skipped = 0

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
            WHERE cp.id IN ({placeholders}) AND cp.user_id = ?
        """, batch + [USER_ID])

        for r in rows:
            ciphertext = r.get('content')
            if not ciphertext:
                continue
            plaintext = decrypt_safe(ciphertext, master_key)
            if plaintext is None:
                skipped += 1
                continue
            content_map[r['id']] = plaintext

        pct = min(100, int((i + len(batch)) / len(point_ids) * 100))
        print(f"\r  Fetching content: {pct}% ({len(content_map)} decrypted, {skipped} skipped)", end="", flush=True)

    print()
    if skipped > 0:
        print(f"  ⚠ {skipped} points had undecryptable content (likely encrypted with rotated key) — skipped")
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
    # tokenizers (Rust) — avoids the transformers → torch import chain that
    # blows up on ARM64 VPSes where torch wheels break the install.
    from tokenizers import Tokenizer
    from huggingface_hub import hf_hub_download

    EMBED_CHUNK = int(os.environ.get('NOMIC_EMBED_CHUNK', '100'))
    ONNX_FILE = "onnx/model_quantized.onnx"  # int8 quantized (~170MB)

    print("  Loading Nomic v1.5 tokenizer + ONNX model (quantized int8)...")

    # Download ONNX model file if not cached
    model_path = hf_hub_download(NOMIC_MODEL, ONNX_FILE)

    # Memory-tuned for low-RAM VPSes (3-4GB): no arena, no mem pattern, single-threaded.
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    sess_options.inter_op_num_threads = 1
    sess_options.intra_op_num_threads = 1
    sess_options.enable_cpu_mem_arena = False
    sess_options.enable_mem_pattern = False
    session = ort.InferenceSession(model_path, sess_options, providers=['CPUExecutionProvider'])

    # Download tokenizer.json directly and load via the Rust tokenizers lib.
    tokenizer_path = hf_hub_download(NOMIC_MODEL, "tokenizer.json")
    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding()  # pad to longest-in-batch (dynamic)

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
            encodings = tokenizer.encode_batch(batch_texts)
            input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
            attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            token_type_ids = np.array([e.type_ids for e in encodings], dtype=np.int64)

            feed = {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "token_type_ids": token_type_ids,
            }

            outputs = session.run(None, feed)

            # Mean pooling: average token embeddings (masked)
            token_embs = outputs[0]  # (batch, seq_len, 768)
            mask = attention_mask[:, :, np.newaxis].astype(np.float32)
            pooled = (token_embs * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)

            # Truncate 768→256D
            chunk_embs_list.append(pooled[:, :NOMIC_DIM].astype(np.float32))

            del encodings, input_ids, attention_mask, token_type_ids, outputs, token_embs, mask, pooled
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
    """Write Nomic 256D embeddings back to D1 as ENCRYPTED wrapped-DEK envelopes.

    SEC-4: each vector is encrypted via crypto_local.encrypt_vector (byte-compatible
    with the JS encryptVector) and bound as a TEXT param — NOT the old raw X'<hex>'
    BLOB. Decrypted on read by _decode_nomic_embedding. Encryption is mandatory
    (master key is required); there is no plaintext-vector fallback.
    """
    if dry_run:
        print(f"  (dry run) Would write {len(point_ids)} embeddings to D1")
        return

    from crypto_local import encrypt_vector
    master_key = _get_master_key()

    BATCH = 50
    written = 0
    for i in range(0, len(point_ids), BATCH):
        batch_ids = point_ids[i:i+BATCH]
        statements = []
        for j, pid in enumerate(batch_ids):
            idx = i + j
            envelope = encrypt_vector(
                embeddings[idx].astype(np.float32), _NOMIC_SCOPE, master_key)
            # user_id required by the SQL guardian (USER_DATA_TABLES rule):
            # writes to clustering_points must filter by user_id even when
            # the row's `id` is globally unique. Defense in depth against
            # cross-tenant writes; the agent token used by pipeline-health
            # is non-admin so the guardian's admin-bypass doesn't apply.
            statements.append({
                "sql": "UPDATE clustering_points SET nomic_embedding = ?, "
                       "embedding_model = 'nomic-v1.5-256d' WHERE id = ? AND user_id = ?",
                "params": [envelope, pid, USER_ID],
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

    if not USER_ID:
        raise RuntimeError("USER_ID is required (MINDSCAPE_OWNER_ID or MYA_USER_ID env var)")

    rows = d1_query("""
        SELECT id, source_id, source_type,
               nomic_embedding IS NOT NULL as has_embedding
        FROM clustering_points
        WHERE user_id = ?
        ORDER BY created_at
    """, [USER_ID])

    if not rows:
        return [], np.array([])

    current_ids = [r['id'] for r in rows]
    has_emb = {r['id'] for r in rows if r.get('has_embedding')}
    need_emb = [r['id'] for r in rows if not r.get('has_embedding')]
    # Map clustering_point.id → (source_type, source_id) for the derive-from-768 phase below.
    point_source = {r['id']: (r['source_type'], r['source_id']) for r in rows}
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
        master_key = _get_master_key()  # SEC-4: needed to decrypt nomic envelopes
        emb_ids = list(d1_load)
        # D1 caps bound variables per statement at ~100. Keep the batch under
        # that ceiling — 200 used to work on older D1 but now returns 500
        # "too many SQL variables".
        for i in range(0, len(emb_ids), 100):
            batch = emb_ids[i:i+100]
            placeholders = ','.join(['?'] * len(batch))
            blob_rows = d1_query(
                f"SELECT id, nomic_embedding FROM clustering_points WHERE id IN ({placeholders})",
                batch,
            )
            for r in blob_rows:
                # SEC-4: nomic_embedding is now an encrypted envelope (str) for
                # new rows, or a legacy raw float32 BLOB for pre-migration rows.
                # _decode_nomic_embedding handles both and returns float32 or None.
                vec = _decode_nomic_embedding(r.get('nomic_embedding'), master_key)
                if vec is not None:
                    emb_map[r['id']] = vec
            pct = min(100, int((i + len(batch)) / len(emb_ids) * 100))
            print(f"\r  Loading embeddings from D1: {pct}%", end="", flush=True)
        print(f"\r  Loaded {len(emb_map)} embeddings from D1        ")

    # ── DERIVE PHASE — single-pass embedding consolidation ───────────
    # For points whose source is a message or document, the corresponding
    # row already holds an encrypted 768D Nomic vector (written by
    # enrichment-service / backfill-embedding-768.js with task='document').
    # Decrypt the envelope, slice [:256] (matryoshka), and skip the local
    # ONNX forward pass entirely. This eliminates the duplicate Nomic
    # encode that used to happen with the 'clustering:' prefix.
    #
    # Attachments (transcript, image_description) have no embedding_768
    # column on the source table — those still go through the ONNX path
    # below. Volume is small (~hundreds vs 22k+ messages).
    truly_new = [pid for pid in need_emb if pid not in emb_map]
    derived_map = {}
    if truly_new:
        derivable = [pid for pid in truly_new
                     if point_source.get(pid, (None, None))[0] in ('message', 'document')]
        if derivable:
            try:
                from crypto_local import decrypt_bytes
            except ImportError:
                decrypt_bytes = None

            if decrypt_bytes is not None:
                master_key = _get_master_key()
                # Group by source_type so we can issue one SELECT per corpus per batch.
                by_type: dict[str, list[str]] = {}
                for pid in derivable:
                    st, sid = point_source[pid]
                    if not sid:
                        continue
                    by_type.setdefault(st, []).append(pid)

                derived = 0
                decrypt_failed = 0
                missing_768 = 0
                for src_type, pids in by_type.items():
                    table = 'messages' if src_type == 'message' else 'documents'
                    # source_id is unique per pid; build a reverse map for response handling.
                    src_to_pid = {point_source[pid][1]: pid for pid in pids}
                    sids = list(src_to_pid.keys())
                    # D1 caps params per statement at ~100. We have IN(?,...,?)
                    # plus an extra user_id placeholder — keep batch ≤ 90 to leave
                    # room and survive future D1 tightening.
                    for i in range(0, len(sids), 90):
                        batch = sids[i:i+90]
                        placeholders = ','.join(['?'] * len(batch))
                        src_rows = d1_query(
                            f"SELECT id, embedding_768 FROM {table} "
                            f"WHERE id IN ({placeholders}) AND user_id = ?",
                            batch + [USER_ID],
                        )
                        for sr in src_rows:
                            envelope = sr.get('embedding_768')
                            pid = src_to_pid.get(sr['id'])
                            if not pid:
                                continue
                            if not envelope:
                                missing_768 += 1
                                continue
                            try:
                                # encryptVector (decode.js:152) calls
                                # encodeVector first → base64 string of the
                                # float32 bytes → THAT is what gets encrypted.
                                # So the plaintext from decrypt() is base64
                                # ASCII, not raw float bytes. We decode_bytes
                                # for binary-safety but then base64-decode to
                                # get the actual float32 buffer.
                                import base64 as _b64
                                pt = decrypt_bytes(envelope, master_key)
                                raw = _b64.b64decode(pt)
                            except Exception:
                                decrypt_failed += 1
                                continue
                            # 768D × 4B = 3072 expected. Be strict to catch
                            # mismatched-dim envelopes early.
                            if len(raw) == 768 * 4:
                                vec_768 = np.frombuffer(raw, dtype=np.float32)
                                # L2-normalize after slicing — matryoshka
                                # truncation breaks the unit-norm property of
                                # the source 768D vector. Both embed-service
                                # and cluster.py's local ONNX path produce
                                # L2-normalized vectors, so HDBSCAN + the rest
                                # of the pipeline assume unit vectors.
                                vec_256 = vec_768[:NOMIC_DIM].astype(np.float32, copy=True)
                                n = float(np.linalg.norm(vec_256))
                                if n > 1e-8 and np.isfinite(n):
                                    vec_256 = vec_256 / n
                                    derived_map[pid] = vec_256
                                    derived += 1
                                else:
                                    decrypt_failed += 1
                            else:
                                decrypt_failed += 1
                print(f"  Derived {derived} embeddings from source 768D "
                      f"(missing_768={missing_768}, decrypt_failed={decrypt_failed})")
                if derived > 0:
                    # Write 256D back to clustering_points so future runs hit
                    # the file/D1 cache instead of re-deriving.
                    if not dry_run:
                        derived_ids = list(derived_map.keys())
                        derived_vecs = np.stack([derived_map[pid] for pid in derived_ids])
                        _write_embeddings_to_d1(derived_ids, derived_vecs, dry_run=False)
                    emb_map.update(derived_map)

        # Anything still un-embedded falls through to ONNX (attachments + any
        # message/document where derive failed for some reason).
        truly_new = [pid for pid in truly_new if pid not in emb_map]

    new_embs_map = {}
    if truly_new:
        print(f"\n  Embedding {len(truly_new)} new points with Nomic v1.5 (ONNX fallback)...")
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
    """Binary search for Leiden resolution producing ~target_k clusters.

    NOTE: Leiden CPM can produce pathologically imbalanced clusters on
    densely-connected graphs (one giant + many singletons). Use
    spherical_kmeans_atoms() for the atom level instead, which guarantees
    balanced output. Leiden retained for cases where natural community
    structure is preferred over balance.
    """
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


def spherical_kmeans_atoms(embeddings: np.ndarray, target_k: int) -> np.ndarray:
    """Spherical k-means (k-means on L2-normalized vectors) → balanced atoms.

    Equivalent to k-means with cosine distance. Produces exactly target_k
    clusters with naturally balanced sizes (k-means optimization criterion).
    Used instead of Leiden for the atom level because Leiden CPM produces
    pathologically imbalanced output on densely-connected graphs.

    Args:
        embeddings: (N, D) array of point embeddings.
        target_k: number of atoms to produce.

    Returns:
        labels: (N,) int array of atom assignments in [0, target_k).
    """
    from sklearn.cluster import MiniBatchKMeans

    n = len(embeddings)
    k = min(target_k, max(2, n // 4))  # don't ask for more atoms than data supports

    # L2-normalize for spherical k-means (cosine == euclidean on unit sphere)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normed = (embeddings / norms).astype(np.float32)

    km = MiniBatchKMeans(
        n_clusters=k,
        batch_size=min(2048, n // 2),
        n_init=3,
        max_iter=200,
        random_state=42,
        reassignment_ratio=0.01,  # reassign empty/tiny centroids aggressively
    )
    labels = km.fit_predict(normed)
    return labels.astype(int)


def enforce_nesting(child_labels, parent_labels):
    """Reassign parent labels so every child cluster maps to exactly one parent.

    WARNING: This collapses parent cardinality when child is FINER than parent.
    Each child cluster's points all get reassigned to the majority parent, so
    parents that don't dominate any child cluster get erased.

    Only safe when child is COARSER than parent (rare). For the proper nesting
    direction (parent coarser than child), use centroids_to_groups() which
    aggregates parent centroids hierarchically.
    """
    child_to_parent = {}
    for cid in set(child_labels):
        if cid < 0: continue
        mask = child_labels == cid
        counts = Counter(parent_labels[mask])
        child_to_parent[cid] = counts.most_common(1)[0][0]
    return np.array([child_to_parent.get(child_labels[i], parent_labels[i]) for i in range(len(child_labels))])


def _weighted_ward_groups(centroids, masses, n_groups):
    """Exact mass-weighted Ward agglomeration over (centroid, mass) pairs.

    Ward's between-cluster distance has the closed form
        d(A,B) = (W_A·W_B / (W_A+W_B)) · ||c_A − c_B||²
    so maintaining merged centroids + masses and recomputing distances IS
    weighted Ward — no Lance-Williams bookkeeping needed. scipy/sklearn have
    no weighted Ward (sklearn #27557), hence this custom O(k²) agglomeration
    (k ≤ TARGET_ATOMS=2000; measured ~seconds).

    Returns: group label per input centroid, in [0, n_groups).
    """
    cents = centroids.astype(np.float64).copy()
    w = masses.astype(np.float64).copy()
    k = len(cents)
    alive = np.ones(k, dtype=bool)
    groups = {i: [i] for i in range(k)}

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

    out = np.zeros(k, dtype=int)
    for gid, (_, members) in enumerate(sorted(groups.items())):
        for m in members:
            out[m] = gid
    return out


def centroids_to_groups(child_labels, embeddings, n_groups, embed_dim=None):
    """Hierarchically group child clusters via MASS-WEIGHTED Ward HAC on centroids.

    Guarantees nesting by construction: each child cluster is one (centroid,
    mass) pair; weighted Ward merges them into n_groups parent clusters. Every
    child belongs to exactly one parent.

    Mass-weighting is the 2026-06-10 rebalance: the old unweighted variant let
    a 27-point child and a 1-point child weigh the same, which produced
    one-giant-parent output at every scale (89.6% of points in one realm at
    N=15k in the lab). See docs/CLUSTERING-REBALANCE-DESIGN-2026-06-10.md.

    Returns: parent_labels array of same length as child_labels, where each point's
    parent = the group of its child cluster's centroid.
    """
    unique_children = sorted(set(int(c) for c in child_labels) - {-1})
    if len(unique_children) <= 1:
        return np.zeros(len(child_labels), dtype=int)
    if len(unique_children) <= n_groups:
        # Already few enough — each child is its own group
        child_to_group = {c: i for i, c in enumerate(unique_children)}
        return np.array([child_to_group.get(int(child_labels[i]), 0) for i in range(len(child_labels))])

    # Centroid + mass per child cluster
    centroids = np.array([
        embeddings[child_labels == c].mean(axis=0) for c in unique_children
    ])
    norms = np.linalg.norm(centroids, axis=1, keepdims=True)
    norms[norms == 0] = 1
    centroids = centroids / norms
    masses = np.array([(child_labels == c).sum() for c in unique_children], dtype=np.float64)

    group_of_child = _weighted_ward_groups(centroids, masses, min(n_groups, len(unique_children)))
    child_to_group = {unique_children[i]: int(group_of_child[i]) for i in range(len(unique_children))}
    return np.array([child_to_group.get(int(child_labels[i]), 0) for i in range(len(child_labels))])


def detect_noise(graph, labels, knn_sims):
    """Noise detection: k-NN distance outliers always; the weak-membership rule
    only when clusters are large enough to satisfy it; total capped at 15%.

    The membership rule requires ≥ NOISE_MEMBERSHIP_THRESHOLD·k same-cluster
    neighbors — mathematically unsatisfiable when the median cluster is smaller
    than that (it flagged 57% of a real 152-point vault as noise, and the
    resulting liminal bucket rendered as the user's biggest "territory"). Gate
    it on median cluster size ≥ k_nn; at the calibrated scale (45k pts,
    ~150-pt territories) the gate is always open, so legacy behavior is kept.
    Percentile-bounding the noise share is standard practice (research brief
    §1); the cap keeps the weakest points by mean k-NN similarity.
    """
    n = len(labels)
    noise = np.zeros(n, dtype=bool)
    mean_sims = knn_sims[:, 1:].mean(axis=1)
    k_nn = max(1, knn_sims.shape[1] - 1)
    sizes = Counter(int(v) for v in labels)
    median_size = float(np.median([sizes[int(v)] for v in labels])) if n else 0.0

    if median_size >= k_nn:
        for node in range(graph.vcount()):
            nbs = graph.neighbors(node)
            if not nbs:
                noise[node] = True
                continue
            same = sum(1 for nb in nbs if labels[nb] == labels[node])
            if same / len(nbs) < NOISE_MEMBERSHIP_THRESHOLD:
                noise[node] = True
    else:
        print(f"    (membership noise rule skipped: median cluster size {median_size:.0f} < k={k_nn})")

    threshold = mean_sims.mean() - NOISE_KNN_SIGMA * mean_sims.std()
    noise |= (mean_sims < threshold)

    if n > 0 and noise.mean() > NOISE_MAX_SHARE:
        budget = max(1, int(n * NOISE_MAX_SHARE))
        capped = np.zeros(n, dtype=bool)
        for idx in np.argsort(mean_sims):          # weakest first
            if noise[idx]:
                capped[idx] = True
                budget -= 1
                if budget <= 0:
                    break
        print(f"    (noise capped: {int(noise.sum())} flagged → {int(capped.sum())} kept, ≤{NOISE_MAX_SHARE:.0%})")
        noise = capped
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

    # ── Stage 2: Atoms via spherical k-means (guaranteed balanced) ──
    # Leiden CPM produces pathologically imbalanced output (one giant cluster +
    # many singletons) on densely-connected graphs with skewed structure.
    # Spherical k-means guarantees exactly target_k clusters with balanced sizes.
    print(f"  Spherical k-means → atoms (target {TARGET_ATOMS})...")
    atom_labels = spherical_kmeans_atoms(embeddings, TARGET_ATOMS)
    n_atoms = len(set(int(a) for a in atom_labels))
    atom_sizes = sorted(Counter(int(a) for a in atom_labels).values(), reverse=True)
    print(f"    → {n_atoms} atoms (sizes: max={atom_sizes[0]}, median={atom_sizes[len(atom_sizes)//2]}, min={atom_sizes[-1]})")

    # ── Stage 3: Territories via Ward HAC on atom centroids (guaranteed balanced nesting) ──
    # Direct Leiden at target_k ~= territories can produce pathologically imbalanced
    # clusters (one giant + many singletons) for data with clear dominant modes +
    # scattered outliers. Ward HAC on atom centroids guarantees balanced merges
    # and strict hierarchical nesting (every atom → exactly one territory).
    print(f"  HAC: atoms → territories (target ~{TARGET_TERRITORIES})...")
    territory_labels = centroids_to_groups(atom_labels, embeddings, TARGET_TERRITORIES)
    n_territories = len(set(int(t) for t in territory_labels) - {-1})
    terr_sizes = sorted(Counter(int(t) for t in territory_labels).values(), reverse=True)
    print(f"    → {n_territories} territories (sizes: max={terr_sizes[0]}, median={terr_sizes[len(terr_sizes)//2]}, min={terr_sizes[-1]})")

    # ── Stage 4: Themes via Ward HAC on territory centroids (guaranteed nesting) ──
    print(f"  HAC: territories → themes (target ~{TARGET_THEMES})...")
    theme_labels = centroids_to_groups(territory_labels, embeddings, TARGET_THEMES)
    n_themes = len(set(int(t) for t in theme_labels) - {-1})
    print(f"    → {n_themes} themes")

    # ── Stage 5: Realms via mass-weighted Ward + silhouette-selected k ──
    # The old elbow heuristic (largest gap in Ward merge distances) was clamped
    # to [5, 10]: the floor of 5 forced singleton realms whenever the data had
    # fewer natural groups (live vault: realms of 146/2/2/1/1 points). Now k is
    # chosen in [TARGET_REALMS_MIN=2, TARGET_REALMS_MAX] by maximizing the
    # point-level cosine silhouette (sampled at scale) — the most stable
    # selector in the lab (design doc 2026-06-10).
    print(f"  HAC: themes → realms (k by silhouette, {TARGET_REALMS_MIN}..{TARGET_REALMS_MAX})...")
    unique_themes = sorted(set(int(t) for t in theme_labels))
    if len(unique_themes) > 1:
        from sklearn.metrics import silhouette_score
        best_k, best_s, best_labels = 1, -2.0, np.zeros(n_points, dtype=int)
        sil_kwargs = {'sample_size': 4000, 'random_state': 42} if n_points > 4000 else {}
        for k in range(max(2, TARGET_REALMS_MIN), min(TARGET_REALMS_MAX, len(unique_themes)) + 1):
            cand = centroids_to_groups(theme_labels, embeddings, k)
            if len(set(int(v) for v in cand)) < 2:
                continue
            try:
                s = float(silhouette_score(embeddings, cand, metric='cosine', **sil_kwargs))
            except Exception:
                continue
            if s > best_s:
                best_k, best_s, best_labels = k, s, cand
        realm_labels, n_realms = best_labels, best_k
        print(f"    silhouette-selected k={n_realms} (score={best_s:.3f})")
    else:
        realm_labels = np.zeros(n_points, dtype=int)
        n_realms = 1
    print(f"    → {n_realms} realms")

    # ── Stage 6: Noise detection (dual strategy) ──
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

    # ── Stage 7: UMAP 3D (visualization only — decoupled from clustering) ──
    print("  UMAP 256D → 3D (visualization only)...")
    reducer_3d = umap.UMAP(
        n_components=UMAP_N_COMPONENTS_VIZ,
        n_neighbors=UMAP_N_NEIGHBORS_VIZ,
        min_dist=UMAP_MIN_DIST_VIZ,
        metric='cosine',
        random_state=42,
    )
    coords_3d = reducer_3d.fit_transform(embeddings)

    # Final unique-count sanity check (post-noise reassignment may add liminals)
    final_realms = len(set(int(r) for r in realm_labels))
    final_themes = len(set(int(t) for t in theme_labels))
    final_territories = len(set(int(t) for t in territory_labels))
    final_atoms = len(set(int(a) for a in atom_labels))
    print(f"\n  Clustering complete: {final_realms} realms, {final_themes} themes, "
          f"{final_territories} territories, {final_atoms} atoms")

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
    anchored_ids: set = None,
    old_centroids: dict = None,
    new_centroids: dict = None,
) -> tuple[dict[int, int], list[dict], list[dict]]:
    """
    Match new cluster IDs to old ones by Jaccard membership overlap.
    Anchored territories get extra protection: lower Jaccard threshold + centroid backup.

    Returns:
        id_mapping: {new_id: stable_id} for relabeling
        events: list of growth event dicts
        lineage: list of {old_id, new_id, message_count, transfer_strength, is_dominant}
                 for dissolved territories
    """
    anchored_ids = anchored_ids or set()

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
        return {cid: cid for cid in unique_new}, events, []

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
            # user_id required by the SQL guardian on user-data table writes
            # (see _write_embeddings_to_d1 for rationale). `id` is globally
            # unique but the guardian enforces user_id presence regardless.
            statements.append({
                "sql": """UPDATE clustering_points SET
                    realm_id = ?, theme_id = ?, territory_id = ?, atom_id = ?,
                    is_liminal = ?,
                    landscape_x = ?, landscape_y = ?, landscape_z = ?,
                    cluster_version = ?,
                    updated_at = datetime('now')
                WHERE id = ? AND user_id = ?""",
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
                    USER_ID,
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
        WHERE cp.territory_id IS NOT NULL AND cp.user_id = ?
    """, [USER_ID])

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

    # Write territory activity timelines — activity_timeline is in
    # ENCRYPTED_FIELDS (packages/core/crypto-local.js:297), so route through
    # d1_batch_encrypted so the Node bridge encrypts each timeline JSON
    # before D1 write. Pre-D2 commit, this used d1_batch and landed
    # plaintext JSON in D1 — the live-bypass class flagged by PR-A scanner.
    statements = []
    for tid, monthly in terr_monthly.items():
        timeline = sorted([{"month": m, "count": c} for m, c in monthly.items()], key=lambda x: x["month"])
        statements.append({
            "sql": """UPDATE territory_profiles SET activity_timeline = ?
                      WHERE territory_id = ? AND user_id = ?""",
            "params": [json.dumps(timeline), tid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch_encrypted(statements[i:i+50])

    # Write realm activity timelines — realms.activity_timeline is in
    # ENCRYPTED_FIELDS (packages/core/crypto-local.js:314); same bridge.
    statements = []
    for rid, monthly in realm_monthly.items():
        timeline = sorted([{"month": m, "count": c} for m, c in monthly.items()], key=lambda x: x["month"])
        statements.append({
            "sql": """UPDATE realms SET activity_timeline = ?
                      WHERE realm_id = ? AND user_id = ?""",
            "params": [json.dumps(timeline), rid, user_id],
        })

    for i in range(0, len(statements), 50):
        d1_batch_encrypted(statements[i:i+50])

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
        d1_batch_encrypted(statements[i:i+50])  # centroid_3d ∈ ENCRYPTED_FIELDS

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
        d1_batch_encrypted(statements[i:i+50])  # centroid_256 ∈ ENCRYPTED_FIELDS

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
      - coherence: mean pairwise cosine similarity within territory
      - growth_state: from growth events (growing/steady). NOTE: 'stuck'
        is reserved but NOT currently assigned — only formed/grew → growing
        and stable/dissolved → steady are emitted (see below).
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
        coherence = 0.0
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
            coherence = float(upper_sum / pairs) if pairs > 0 else 0.0

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
            "sql": """INSERT INTO territory_profiles (user_id, territory_id, energy, coherence, velocity,
                growth_state, message_count, point_delta, realm_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(territory_id, user_id) DO UPDATE SET
                    energy = excluded.energy, coherence = excluded.coherence,
                    velocity = excluded.velocity, growth_state = excluded.growth_state,
                    message_count = excluded.message_count, point_delta = excluded.point_delta,
                    realm_id = excluded.realm_id, updated_at = datetime('now')""",
            "params": [
                user_id, tid,
                round(energy, 6), round(coherence, 4), round(velocity, 4),
                growth_state, count, point_delta, realm_id,
            ],
        })

    if dry_run:
        print(f"  (dry run) Would write dynamics for {len(statements)} territories")
        for s in statements[:5]:
            p = s['params']
            print(f"    T{p[1]}: energy={p[2]:.4f} coherence={p[3]:.4f} velocity={p[4]:.4f} state={p[5]} pts={p[6]}")
        return

    # Write in batches. energy/coherence/velocity/point_delta ∈ ENCRYPTED_FIELDS
    # (SEC-3) → route through the Node bridge so they're encrypted; growth_state /
    # message_count / realm_id in the same UPSERT stay plaintext (not in the set).
    for i in range(0, len(statements), 50):
        d1_batch_encrypted(statements[i:i+50])

    print(f"  Wrote dynamics for {len(statements)} territories")


def flag_catch_all_territories(
    point_ids: list[str],
    results: dict,
    embeddings: np.ndarray,
    user_id: str,
    dry_run: bool = False,
) -> list[int]:
    """Flag territories that are statistical outliers with low semantic coherence.
    A territory is catch-all if it's a size outlier AND has low coherence or a generic name."""
    print("\n  Flagging catch-all territories...")

    terr_counts = defaultdict(int)
    terr_members = defaultdict(list)
    for i, pid in enumerate(point_ids):
        tid = int(results['territory_ids'][i])
        if tid >= 0:
            terr_counts[tid] += 1
            terr_members[tid].append(i)

    if not terr_counts:
        return []

    counts = np.array(list(terr_counts.values()))
    mean_size = float(counts.mean())
    std_size = float(counts.std())
    size_threshold = mean_size + 2 * std_size

    generic_terms = {'miscellaneous', 'mixed topics', 'overflow', 'accumulation', 'catch-all',
                     'general catch', 'various', 'unresolved', 'without theme',
                     'without thematic', 'boundary messages', 'low-coherence',
                     'encrypted archive', 'unable to analyze', 'unreadable',
                     'scattered reflections'}

    existing_names = {}
    try:
        rows = d1_query(
            "SELECT territory_id, name FROM territory_profiles WHERE user_id = ?",
            [user_id],
        )
        for r in rows:
            existing_names[r['territory_id']] = (r.get('name') or '').lower()
    except Exception:
        pass

    flagged = []
    for tid, count in terr_counts.items():
        name = existing_names.get(tid, '')
        has_generic_name = any(term in name for term in generic_terms)

        # Name signal alone is sufficient — "Miscellaneous Accumulation" is catch-all at any size
        if has_generic_name:
            flagged.append(tid)
            continue

        # Statistical signal requires size threshold + low coherence
        if count <= size_threshold:
            continue

        coherence = 0.0
        indices = terr_members[tid]
        if len(indices) >= 2:
            sample = np.random.choice(indices, min(len(indices), 50), replace=False)
            embs = embeddings[sample]
            norms = np.linalg.norm(embs, axis=1, keepdims=True)
            norms[norms == 0] = 1
            normed = embs / norms
            sim = normed @ normed.T
            n = len(sample)
            upper = (sim.sum() - n) / 2
            pairs = n * (n - 1) / 2
            coherence = float(upper / pairs) if pairs > 0 else 0.0

        if coherence < 0.3:
            flagged.append(tid)

    if dry_run:
        print(f"  (dry run) Would flag {len(flagged)} catch-all territories: {flagged[:10]}")
        return flagged

    d1_query(
        "UPDATE territory_profiles SET is_catchall = 0 WHERE user_id = ?",
        [user_id],
    )

    for tid in flagged:
        d1_query(
            "UPDATE territory_profiles SET is_catchall = 1 WHERE user_id = ? AND territory_id = ?",
            [user_id, tid],
        )

    print(f"  Flagged {len(flagged)} catch-all territories (threshold: {size_threshold:.0f} pts, mean: {mean_size:.0f}, std: {std_size:.0f})")
    for tid in flagged[:10]:
        name = existing_names.get(tid, '?')
        print(f"    T{tid}: {terr_counts[tid]} pts — {name}")

    return flagged


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
    print(f'  Vault: {os.environ.get("MYCELIUM_DB", "(unset)")}')
    print(f'  Dry run: {args.dry_run}')

    version = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    # Canonical owner for territory profiles / realms / themes
    # All points cluster together regardless of source user_id
    global USER_ID
    user_id = args.user_id or os.environ.get('MINDSCAPE_OWNER_ID') or os.environ.get('MYA_USER_ID')
    if not user_id:
        # Fallback: most common user_id in clustering_points (owner DB only — needs admin auth)
        users = d1_query("SELECT user_id, COUNT(*) as c FROM clustering_points WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY c DESC LIMIT 1")
        user_id = users[0]['user_id'] if users else None
    if not user_id:
        print("  ERROR: No user_id found. Set --user-id or MINDSCAPE_OWNER_ID env var.")
        sys.exit(1)
    USER_ID = user_id  # propagate to module-level helpers (fetch_all_embeddings, etc.)
    print(f'  User: {user_id}')

    # Fetch old assignments for Jaccard stabilization
    print("\n  Loading previous cluster assignments...")
    old_rows = d1_query("""
        SELECT id, realm_id, theme_id, territory_id, atom_id
        FROM clustering_points
        WHERE realm_id IS NOT NULL AND user_id = ?
    """, [user_id])
    old_realms = {r['id']: r['realm_id'] for r in old_rows}
    old_territories = {r['id']: r['territory_id'] for r in old_rows}
    print(f"  Previous: {len(old_realms)} points with realm assignments")

    # Fetch embeddings
    point_ids, embeddings = fetch_all_embeddings(dry_run=args.dry_run)

    if len(point_ids) < args.min_points:
        print(f"\n  Only {len(point_ids)} points with embeddings (min: {args.min_points}). Skipping.")
        return

    # Auto-scale clustering targets for dataset size
    scale_targets(len(point_ids))

    # Run clustering
    results = run_clustering(embeddings)

    # Stabilize cluster IDs (Jaccard matching)
    terr_lineage = []
    if args.fresh_start:
        print("\n  Fresh start — skipping Jaccard stabilization (all territories treated as new)")
        # Assign sequential IDs, all events = 'formed'
        realm_events = [{'event_type': 'formed', 'cluster_id': int(rid), 'point_count': int(np.sum(results['realm_ids'] == rid)), 'point_delta': int(np.sum(results['realm_ids'] == rid))} for rid in set(results['realm_ids']) if rid >= 0]
        terr_events = [{'event_type': 'formed', 'cluster_id': int(tid), 'point_count': int(np.sum(results['territory_ids'] == tid)), 'point_delta': int(np.sum(results['territory_ids'] == tid))} for tid in set(results['territory_ids']) if tid >= 0]
    else:
        print("\n  Stabilizing cluster IDs (Jaccard matching)...")

    if not args.fresh_start:
        # Compute anchored set: territories that resist dissolution
        anchored_ids = set()
        try:
            anchor_rows = d1_query(
                """SELECT tp.territory_id, tp.coherence, tp.last_active, tp.is_anchored,
                          COALESCE(tf.engagement_depth_normalized, 0) as eng
                   FROM territory_profiles tp
                   LEFT JOIN territory_vitality tf ON tf.territory_id = tp.territory_id AND tf.user_id = tp.user_id
                   WHERE tp.user_id = ? AND tp.dissolved_at IS NULL""",
                [user_id],
            )
            now = datetime.now(timezone.utc)

            def _dec_num(v):
                """Decrypt-and-coerce a SEC-3 numeric column. coherence /
                engagement_depth_normalized are ENCRYPTED envelopes at rest
                (ENCRYPTED_FIELDS, src/crypto/crypto-local.js) and the Python
                read path returns raw ciphertext — so a bare float() compare
                silently disabled metric anchoring. Mirrors compute-fisher.py
                _dec_float. Legacy plaintext rows fall back to direct float;
                unreadable → None → rule skipped (fail-closed, never anchor
                on data we can't read)."""
                if v is None:
                    return None
                try:
                    from crypto_local import decrypt_bytes
                    return float(decrypt_bytes(v, _get_master_key()).decode())
                except Exception:
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        return None

            for row in anchor_rows:
                tid = row['territory_id']
                if row.get('is_anchored') in (1, '1', True):
                    anchored_ids.add(tid); continue
                coh = _dec_num(row.get('coherence'))
                eng = _dec_num(row.get('eng'))
                if coh is not None and eng is not None and coh > 0.6 and eng > 0.7:
                    anchored_ids.add(tid); continue
                if row.get('last_active'):
                    try:
                        la = datetime.fromisoformat(row['last_active'].replace('Z', '+00:00'))
                        if (now - la).days <= 30:
                            anchored_ids.add(tid)
                    except Exception:
                        pass
            print(f"  Anchored: {len(anchored_ids)} territories protected from dissolution")
        except Exception as e:
            print(f"  (anchoring query failed, proceeding without: {e})")

        new_realms = {pid: int(results['realm_ids'][i]) for i, pid in enumerate(point_ids)}
        realm_mapping, realm_events, _ = stabilize_ids(old_realms, new_realms, 'realm')

        for i, pid in enumerate(point_ids):
            old_label = int(results['realm_ids'][i])
            if old_label in realm_mapping:
                results['realm_ids'][i] = realm_mapping[old_label]

        new_territories = {pid: int(results['territory_ids'][i]) for i, pid in enumerate(point_ids)}
        terr_mapping, terr_events, terr_lineage = stabilize_ids(
            old_territories, new_territories, 'territory',
            anchored_ids=anchored_ids,
        )

        for i, pid in enumerate(point_ids):
            old_label = int(results['territory_ids'][i])
            if old_label in terr_mapping:
                results['territory_ids'][i] = terr_mapping[old_label]
    else:
        terr_lineage = []

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

    # Prune stale realm rows. Territories get dissolved_at because lineage /
    # identity-inheritance reads the dissolved rows; realms have neither, and a
    # ghost row (realm_id with no live clustering_points) leaks into the search
    # corpus, /mindscape/realms, realm_count and the public realm-name list.
    # Same wipe-vs-live-set shape as realm_neighbors above. Fail closed: never
    # prune on a dry run or when this run produced no live realms.
    live_realm_ids = sorted({int(r) for r in results['realm_ids'] if int(r) >= 0})
    if live_realm_ids and not args.dry_run:
        placeholders = ','.join('?' for _ in live_realm_ids)
        stale_rows = d1_query(
            f"SELECT realm_id FROM realms WHERE user_id = ? AND realm_id NOT IN ({placeholders})",
            [user_id, *live_realm_ids],
        )
        if stale_rows:
            print(f"  Pruning {len(stale_rows)} stale realm rows (no live points): "
                  f"{sorted(int(r['realm_id']) for r in stale_rows)}")
            d1_query(
                f"DELETE FROM realms WHERE user_id = ? AND realm_id NOT IN ({placeholders})",
                [user_id, *live_realm_ids],
            )

    # Write lineage and inherit identity to dominant successors
    successor_inherits = {}  # new_id → old_id (dominant only); read again after compute_dynamics
    if terr_lineage and not args.dry_run:
        print(f"  Recording {len(terr_lineage)} lineage relationships...")
        for ln in terr_lineage:
            d1_query(
                """INSERT OR REPLACE INTO territory_lineage
                   (id, user_id, old_territory_id, new_territory_id, message_count,
                    transfer_strength, is_dominant, cluster_version)
                   VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)""",
                [user_id, ln['old_territory_id'], ln['new_territory_id'],
                 ln['message_count'], ln['transfer_strength'], ln['is_dominant'], version],
            )
            if ln['is_dominant']:
                successor_inherits[ln['new_territory_id']] = ln['old_territory_id']

        # Dominant successors inherit predecessor identity
        for new_id, old_id in successor_inherits.items():
            try:
                old_p = d1_query(
                    "SELECT territory_id FROM territory_profiles WHERE territory_id = ? AND user_id = ?",
                    [old_id, user_id],
                )
                if old_p:
                    new_p = d1_query(
                        "SELECT predecessor_ids, evolved_from_count FROM territory_profiles WHERE territory_id = ? AND user_id = ?",
                        [new_id, user_id],
                    )
                    existing = []
                    count = 0
                    if new_p:
                        try:
                            existing = json.loads(new_p[0].get('predecessor_ids') or '[]')
                        except Exception:
                            existing = []
                        count = new_p[0].get('evolved_from_count') or 0
                    if old_id not in existing:
                        existing.append(old_id)
                    d1_query(
                        """UPDATE territory_profiles
                           SET predecessor_ids = ?, evolved_from_count = ?
                           WHERE territory_id = ? AND user_id = ?""",
                        [json.dumps(existing), count + 1, new_id, user_id],
                    )
            except Exception as e:
                print(f"    (inheritance failed for T{old_id} → T{new_id}: {e})")

    # Update is_anchored flags based on this run's anchored set
    if not args.fresh_start and not args.dry_run:
        # Reset all
        d1_query("UPDATE territory_profiles SET is_anchored = 0, anchored_reason = NULL WHERE user_id = ?", [user_id])
        for tid in anchored_ids:
            d1_query(
                "UPDATE territory_profiles SET is_anchored = 1, anchored_reason = 'computed' WHERE territory_id = ? AND user_id = ?",
                [tid, user_id],
            )

    # Refresh last_active from live membership. Plaintext timestamp class
    # (same as created_at/updated_at — recency is already derivable from
    # plaintext clustering_points.created_at). The anchor query above reads
    # the PREVIOUS run's value by design; before 2026-06-10 nothing wrote
    # this column at all, so the 30-day recency anchor rule could never fire.
    if not args.dry_run:
        d1_query(
            """UPDATE territory_profiles SET last_active = (
                 SELECT MAX(cp.created_at) FROM clustering_points cp
                 WHERE cp.territory_id = territory_profiles.territory_id
                   AND cp.user_id = territory_profiles.user_id)
               WHERE user_id = ? AND dissolved_at IS NULL""",
            [user_id],
        )

    # Compute and write territory dynamics (energy, coherence, velocity)
    compute_dynamics(
        point_ids, results, embeddings, terr_events,
        old_territories, user_id, dry_run=args.dry_run,
    )

    # Chronicle inheritance: a dominant successor starts with its dissolved
    # predecessor's chronicle instead of a blank card. MUST run after
    # compute_dynamics (which upserts every live territory row — the successor
    # may not exist before it). The copy is CIPHERTEXT-VERBATIM: d1_query
    # returns the stored AES-GCM envelopes for ENCRYPTED_FIELDS as-is and we
    # write the same values back — never decrypt in Python, never route through
    # the encrypt bridge (that would double-encrypt). Guards: predecessor must
    # HAVE a chronicle, successor must NOT (its own chronicle is never
    # overwritten). The inherited point_count_at_description makes the
    # describe-chronicles drift gate re-narrate naturally once the successor's
    # content meaningfully diverges.
    _CHRONICLE_COLS = [
        'essence', 'archetype_type', 'archetype_character',
        'story_birth', 'story_arc', 'story_current_chapter', 'story_peak_moments',
        'signature_patterns', 'uncertainty_open_questions', 'uncertainty_edges',
        'agent_expertise', 'agent_curious_about', 'agent_can_help_with',
        'agent_would_consult', 'top_entities',
        'description_version', 'point_count_at_description', 'last_described_at',
        'generation_model',
    ]
    if successor_inherits and not args.dry_run:
        inherited = 0
        for new_id, old_id in successor_inherits.items():
            try:
                old_rows = d1_query(
                    f"SELECT {', '.join(_CHRONICLE_COLS)} FROM territory_profiles "
                    "WHERE territory_id = ? AND user_id = ? AND description_version IS NOT NULL",
                    [old_id, user_id],
                )
                if not old_rows:
                    continue  # predecessor was never chronicled — nothing to carry
                vals = [old_rows[0].get(c) for c in _CHRONICLE_COLS]
                sets = ', '.join(f"{c} = ?" for c in _CHRONICLE_COLS)
                d1_query(
                    f"UPDATE territory_profiles SET {sets} "
                    "WHERE territory_id = ? AND user_id = ? AND description_version IS NULL",
                    [*vals, new_id, user_id],
                )
                inherited += 1
            except Exception as e:
                print(f"    (chronicle inheritance failed for T{old_id} → T{new_id}: {e})")
        if inherited:
            print(f"  Inherited chronicles for {inherited} dominant successors")

    # Flag catch-all territories (statistical outliers with low coherence)
    flag_catch_all_territories(
        point_ids, results, embeddings, user_id, dry_run=args.dry_run,
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
