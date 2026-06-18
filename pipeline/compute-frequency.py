#!/usr/bin/env python3
"""
Frequency Metrics — V1 single-user port of scripts/compute-frequency.py.

Computes 5 core windowed cognitive metrics per granularity (month/week/day):
  1. Coherence:      Mean pairwise cosine similarity of territory centroids
  2. Entropy:        Normalized Shannon entropy of territory distribution
  3. Compression:    gzip text compression ratio (TCR) of message content
  4. Learning Rate:  JSD² between consecutive window distributions
  5. Gradient Signal: JSD² from the initial window distribution

Stores results in frequency_snapshots. Runs after the clustering pipeline.

V1 single-user port: talks to the LOCAL encrypted SQLite vault via d1_client
(no Worker, no auth); user resolved via stage_base.get_user_id()
(MYCELIUM_USER_ID). Mirrors pipeline/compute_information_harmonics.py /
compute-fisher.py.

── T1 FIX: DECRYPT messages.content before gzip ──
In V1 messages.content is an AES-GCM envelope AT REST. The canonical gzipped
the raw column — in V1 that would compress ciphertext (high-entropy → a
meaningless ~1.0 ratio, AND it would leak nothing useful while silently
breaking the metric). Here every content value is decrypted via
crypto_local.decrypt_safe (per-row best-effort; un-decryptable rows skipped)
BEFORE join + gzip. d1_client does NOT auto-decrypt, so this is the caller's
job (same contract as cluster.py / harmonics reading embeddings).

AT-REST ENCRYPTION (caller-encrypt, like compute-fisher.py): the 5 metrics +
3 context counts are ENCRYPTED via crypto_local.encrypt_str before binding.
The JS adapter AUTO-DECRYPTS them on any JS read (they're in
ENCRYPTED_FIELDS.frequency_snapshots, not NEVER_AUTO_DECRYPT). Structural
columns (user_id / window_* / granularity / language / computed_at) stay
plaintext — the UPSERT conflict target (user_id, window_end, granularity) is
all-plaintext.

  numpy-2.x gotcha: repr(np.float64(x)) == 'np.float64(x)', which would poison
  the stored value. _enc() coerces float()/int() before repr so JS Number() /
  Python float() round-trip cleanly (same fix as compute-fisher.py._enc).

Security: never prints decrypted content or metric values — counts + window
labels only.

Usage:
  pipeline/.venv/bin/python3 pipeline/compute-frequency.py [--window N] [--dry-run]
"""

import argparse
import gzip
import math
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from scipy.spatial.distance import jensenshannon
from scipy.stats import entropy as shannon_entropy

import stage_base
import d1_client
import crypto_local

# ── Environment ──────────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).resolve().parent.parent
stage_base.load_dotenv(_REPO_ROOT)

_FREQ_SCOPE = 'personal'
_MASTER_KEY = None


def _master_key():
    """Lazy-load + cache the user master key (fail-closed: raises if absent)."""
    global _MASTER_KEY
    if _MASTER_KEY is None:
        _MASTER_KEY = crypto_local.load_master_key()
    return _MASTER_KEY


def _enc(value):
    """Encrypt a scalar/string sensitive value → envelope TEXT. None → None.

    numpy 2.x repr(np.float64(x)) == 'np.float64(x)' poisons the value, so
    coerce float()/int() before repr (mirrors compute-fisher.py._enc).
    """
    if value is None:
        return None
    if isinstance(value, str):
        s = value
    else:
        try:
            s = repr(float(value))
        except (TypeError, ValueError):
            s = str(value)
    return crypto_local.encrypt_str(s, _FREQ_SCOPE, _master_key())


def _decrypt_content(value):
    """Decrypt an encrypted messages.content envelope → str, else pass through.

    d1_client returns the raw column. If it's one of our envelopes, decrypt it
    best-effort (None on failure → caller skips). Legacy/plaintext rows pass
    through unchanged so a mixed vault still compresses.
    """
    if value is None or not isinstance(value, str):
        return None
    if crypto_local.is_encrypted(value):
        return crypto_local.decrypt_safe(value, _master_key())
    return value


# ── Metric computations ──────────────────────────────────────────────
EPS = 1e-10


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    dot = np.dot(a, b)
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    return float(dot / (na * nb)) if na > 0 and nb > 0 else 0.0


def compute_coherence(centroids: list) -> float:
    if len(centroids) < 2:
        return 1.0
    sims = []
    for i in range(len(centroids)):
        for j in range(i + 1, len(centroids)):
            sims.append(cosine_similarity(centroids[i], centroids[j]))
    return float(np.mean(sims)) if sims else 0.0


def compute_entropy(territory_counts: dict) -> float:
    counts = np.array(list(territory_counts.values()), dtype=float)
    n = len(counts)
    if n <= 1:
        return 0.0
    probs = counts / counts.sum()
    h = float(shannon_entropy(probs, base=2))
    max_h = math.log2(n)
    return h / max_h if max_h > 0 else 0.0


def compute_compression(texts: list) -> float:
    """gzip text compression ratio (TCR) over DECRYPTED message content."""
    combined = "\n".join(texts)
    if len(combined) < 100:
        return 0.0
    raw = combined.encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    return len(compressed) / len(raw)


def compute_jsd_squared(dist_a: np.ndarray, dist_b: np.ndarray) -> float:
    a = np.clip(dist_a, EPS, None)
    b = np.clip(dist_b, EPS, None)
    a = a / a.sum()
    b = b / b.sum()
    return float(jensenshannon(a, b, base=2) ** 2)


def territory_distribution(counts: dict, all_territories: list) -> np.ndarray:
    dist = np.array([counts.get(t, 0) for t in all_territories], dtype=float)
    total = dist.sum()
    return dist / total if total > 0 else np.ones(len(all_territories)) / len(all_territories)


# ── Main pipeline ────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Compute frequency metrics (V1 local)")
    parser.add_argument('--window', type=int, default=180, help='Window in days (default: 180)')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    # V1 single-user: resolve owner via the shared harness (fail-closed).
    user_id = stage_base.get_user_id()
    if not user_id:
        print("[frequency] FATAL: could not resolve user id (fail-closed)", file=sys.stderr)
        sys.exit(1)

    print(f"[frequency] user={user_id[:8]} window={args.window}d", flush=True)

    window_start = (datetime.utcnow() - timedelta(days=args.window)).strftime('%Y-%m-%d')

    # 1. Clustering points (territory_id / created_at PLAINTEXT → SQL filter valid).
    points = d1_client.query(
        """SELECT id, territory_id, created_at
           FROM clustering_points
           WHERE user_id = ? AND territory_id IS NOT NULL AND created_at >= ?
           ORDER BY created_at""",
        [user_id, window_start],
    )
    print(f"[frequency] {len(points)} points in window", flush=True)
    if len(points) < 20:
        print("[frequency] Not enough data for meaningful metrics", flush=True)
        return

    # 2. Territory centroids. centroid_256 is ENCRYPTED (JSON-string envelope, not
    #    a vector envelope) → decrypt the string then json.loads. d1_client does
    #    not auto-decrypt, so this is the caller's job.
    profiles = d1_client.query(
        """SELECT territory_id, centroid_256
           FROM territory_profiles
           WHERE user_id = ? AND centroid_256 IS NOT NULL AND dissolved_at IS NULL""",
        [user_id],
    )
    centroids = {}
    for p in profiles:
        env = p.get("centroid_256")
        try:
            raw = crypto_local.decrypt_safe(env, _master_key()) if (env and crypto_local.is_encrypted(env)) else env
            if raw is None:
                continue
            import json as _json
            centroids[p["territory_id"]] = np.array(_json.loads(raw), dtype=np.float32)
        except Exception:
            pass
    print(f"[frequency] {len(centroids)} territory centroids loaded", flush=True)

    # 3. Granularity configs.
    granularities = [
        ("month", lambda d: d[:7], args.window),
        ("week", lambda d: datetime.strptime(d, '%Y-%m-%d').strftime('%G-W%V'), min(args.window, 180)),
        ("day", lambda d: d, min(args.window, 90)),
    ]

    def cutoff_date(days_ago):
        return (datetime.now() - timedelta(days=days_ago)).strftime('%Y-%m-%d')

    all_results = []

    for granularity, key_fn, max_days in granularities:
        cutoff = cutoff_date(max_days)
        filtered = [p for p in points if (p.get("created_at", "") or "")[:10] >= cutoff]
        if len(filtered) < 10:
            print(f"[frequency]   [{granularity}] skipping — only {len(filtered)} points", flush=True)
            continue

        windows = {}
        for p in filtered:
            d = (p.get("created_at", "") or "")[:10]
            if not d:
                continue
            wk = key_fn(d)
            if wk not in windows:
                windows[wk] = {"points": [], "territories": {}, "dates": []}
            windows[wk]["points"].append(p)
            windows[wk]["dates"].append(d)
            tid = p["territory_id"]
            windows[wk]["territories"][tid] = windows[wk]["territories"].get(tid, 0) + 1

        sorted_keys = sorted(windows.keys())
        if len(sorted_keys) < 2:
            print(f"[frequency]   [{granularity}] skipping — only {len(sorted_keys)} windows", flush=True)
            continue

        all_tids = sorted(set(tid for w in windows.values() for tid in w["territories"]))
        distributions = [territory_distribution(windows[k]["territories"], all_tids) for k in sorted_keys]

        # Fetch + DECRYPT message content for compression (batch per window).
        window_texts = {}
        for wk in sorted_keys:
            ds = windows[wk]["dates"]
            if not ds:
                window_texts[wk] = []
                continue
            d_start, d_end = min(ds), max(ds)
            try:
                msgs = d1_client.query(
                    """SELECT content FROM messages
                       WHERE user_id = ? AND created_at >= ? AND created_at < date(?, '+1 day')
                       ORDER BY created_at LIMIT 200""",
                    [user_id, d_start, d_end],
                )
                # T1 FIX: decrypt each content envelope BEFORE gzip; skip rows that
                # don't decrypt (None) so we never gzip ciphertext.
                texts = []
                for m in msgs:
                    pt = _decrypt_content(m.get("content"))
                    if pt:
                        texts.append(pt)
                window_texts[wk] = texts
            except Exception:
                window_texts[wk] = []

        print(f"[frequency]   [{granularity}] {len(sorted_keys)} windows, computing...", flush=True)
        for i, wk in enumerate(sorted_keys):
            w = windows[wk]
            ds = w["dates"]
            w_start = min(ds) if ds else wk
            w_end = max(ds) if ds else wk

            active_cents = [centroids[tid] for tid in w["territories"] if tid in centroids]
            coherence = compute_coherence(active_cents) if len(active_cents) >= 2 else None
            entropy_val = compute_entropy(w["territories"])
            texts = window_texts.get(wk, [])
            compression = compute_compression(texts) if texts else None
            lr = compute_jsd_squared(distributions[i - 1], distributions[i]) if i > 0 else 0.0
            gs = compute_jsd_squared(distributions[0], distributions[i]) if i > 0 else 0.0

            all_results.append({
                "window_start": w_start, "window_end": w_end, "granularity": granularity,
                "coherence": round(coherence, 4) if coherence is not None else None,
                "entropy": round(entropy_val, 4),
                "compression": round(compression, 4) if compression is not None else None,
                "learning_rate": round(lr, 4), "gradient_signal": round(gs, 4),
                "point_count": len(w["points"]), "territory_count": len(w["territories"]),
                "message_count": len(texts),
            })

    # Counts only — never log metric values.
    print(f"[frequency] total: {len(all_results)} snapshots across all granularities", flush=True)

    if args.dry_run:
        print("[frequency] DRY RUN — not writing", flush=True)
        return

    written = 0
    for r in all_results:
        try:
            # Caller-encrypt the 5 metrics + 3 counts. _enc(None) → None (NULL
            # stays NULL). Structural columns bound plaintext.
            d1_client.query(
                """INSERT INTO frequency_snapshots
                     (user_id, window_start, window_end, granularity,
                      coherence, entropy, compression, learning_rate, gradient_signal,
                      point_count, territory_count, message_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (user_id, window_end, granularity) DO UPDATE SET
                     coherence = excluded.coherence, entropy = excluded.entropy,
                     compression = excluded.compression, learning_rate = excluded.learning_rate,
                     gradient_signal = excluded.gradient_signal, point_count = excluded.point_count,
                     territory_count = excluded.territory_count, message_count = excluded.message_count,
                     computed_at = datetime('now')""",
                [user_id, r["window_start"], r["window_end"], r["granularity"],
                 _enc(r["coherence"]), _enc(r["entropy"]), _enc(r["compression"]),
                 _enc(r["learning_rate"]), _enc(r["gradient_signal"]),
                 _enc(r["point_count"]), _enc(r["territory_count"]), _enc(r["message_count"])],
            )
            written += 1
        except Exception as e:
            msg = str(e).split('\n', 1)[0][:200]
            print(f"[frequency]   write failed for {r['granularity']} {r['window_end']}: {msg}", flush=True)

    print(f"[frequency] Done — {written}/{len(all_results)} snapshots written", flush=True)


if __name__ == "__main__":
    import stage_result
    stage_result.run_main('frequency', main)
