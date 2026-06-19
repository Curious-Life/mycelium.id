#!/usr/bin/env python3
"""pipeline/compute-embedding-novelty.py — Stage: embedding-novelty (spec §4.19, Tier-1).

The embedding-native NOVELTY cross-check on LZ compressibility (§4.18). Where LZ is
degenerate for short sequences (most territories are touched on few days → the
asymptotic normalization saturates at 1.0), nearest-neighbor cosine distance in the
768D embedding space is well-defined for n≥2 and degrades gracefully — so this is the
PRIMARY per-territory novelty signal, LZ the Tier-2 cross-check.

OPERATIONALIZATION — per territory: intra-territory nearest-neighbor cosine-distance
dispersion. For each of the territory's message embeddings, distance = 1 − (max cosine
to any OTHER message in the same territory); embedding_novelty = mean(NN distance).
  high → content is spread out (exploratory / novel)
  low  → content is clustered (repetitive / routine)
low_confidence = 1 when the territory has < MIN_NOVELTY embedded messages.

ARCHITECTURE — runs AFTER compute-complexity in the cycle and UPDATEs the rows that
stage just wrote (the freshest complexity_snapshots row per territory), so there is
NO window-coordination coupling. messages.embedding_768 is envelope-encrypted
(NEVER_AUTO_DECRYPT) → this MUST be a Python stage; it reuses the SAME decrypt path
harmonics / anchors / cluster use (fetch_envelopes_chunked + decrypt_vectors, 768D).

ENCRYPTION: embedding_novelty is a sensitive derived signal → caller-encrypted via
stage_crypto.enc (ENCRYPTED_FIELDS.complexity_snapshots). The low-confidence flag +
ids/window_end stay plaintext. Never logs vectors or values — counts only (§1).

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-embedding-novelty.py
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent

import stage_base
import d1_client
import stage_crypto
import stage_result

# Reuse the EXACT envelope-decrypt path harmonics/anchors/cluster use (768D float32).
from compute_information_harmonics import fetch_envelopes_chunked, decrypt_vectors

stage_base.load_dotenv(_REPO_ROOT)

WINDOW_DAYS = int(os.environ.get("COMPLEXITY_WINDOW_DAYS", "90"))
MIN_NOVELTY = int(os.environ.get("EMBEDDING_NOVELTY_MIN", "4"))   # < this → low_confidence
MAX_NOVELTY_N = int(os.environ.get("EMBEDDING_NOVELTY_MAX_N", "500"))  # subsample cap per territory


def _territory_novelty(vecs: np.ndarray) -> float:
    """Mean nearest-neighbor cosine DISTANCE among a territory's (n,768) embeddings.

    Returns a float in ~[0,1]. Requires n >= 2 (a neighbor must exist)."""
    n = vecs.shape[0]
    # L2-normalize rows → cosine = dot. Guard zero-norm rows.
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    unit = vecs / norms
    sims = unit @ unit.T          # (n,n) cosine similarity
    np.fill_diagonal(sims, -np.inf)  # exclude self
    nn_sim = sims.max(axis=1)     # nearest neighbor per message
    nn_dist = 1.0 - nn_sim
    return float(np.clip(np.mean(nn_dist), 0.0, 2.0))


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    t0 = time.monotonic()
    acc = stage_result.Accumulator("embedding-novelty")

    window_start = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()
    # territory → [message ids] over the window (source_type='message' carries embeddings).
    rows = querier(
        "SELECT territory_id, source_id FROM clustering_points "
        "WHERE user_id = ? AND territory_id IS NOT NULL AND source_type = 'message' "
        "AND created_at >= ?",
        [user_id, window_start],
    )
    by_territory: dict[int, list[str]] = {}
    all_ids: list[str] = []
    for r in rows:
        tid = r.get("territory_id")
        sid = r.get("source_id")
        if tid is None or not sid:
            continue
        by_territory.setdefault(tid, []).append(sid)
        all_ids.append(sid)

    if not all_ids:
        print("[novelty] no embedded territory messages in window", flush=True)
        stage_result.record_success(querier, user_id, "embedding-novelty", int((time.monotonic() - t0) * 1000), {"territories": 0})
        return

    # Decrypt every needed embedding ONCE (reuse the chunked envelope path).
    envelopes = fetch_envelopes_chunked(all_ids, querier=querier)
    vectors = decrypt_vectors(envelopes)  # {message_id: np.ndarray(768) float32}
    print(f"[novelty] {len(by_territory)} territories, {len(vectors)}/{len(all_ids)} embeddings decrypted", flush=True)

    rng = np.random.default_rng(0)  # deterministic subsample for very large territories
    for tid, ids in by_territory.items():
        vecs = [vectors[i] for i in ids if i in vectors]
        n = len(vecs)
        if n < 2:
            acc.skip()
            continue
        if n > MAX_NOVELTY_N:
            idx = rng.choice(n, MAX_NOVELTY_N, replace=False)
            mat = np.stack([vecs[i] for i in idx]).astype(np.float64)
        else:
            mat = np.stack(vecs).astype(np.float64)
        try:
            novelty = _territory_novelty(mat)
            low_conf = 1 if n < MIN_NOVELTY else 0
            # UPDATE the freshest complexity row this territory has (compute-complexity
            # wrote it moments ago). embedding_novelty is SEC-encrypted; flag plaintext.
            querier(
                "UPDATE complexity_snapshots SET embedding_novelty = ?, embedding_novelty_low_conf = ? "
                "WHERE user_id = ? AND level = 'territory' AND level_id = ? AND window_end = ("
                "  SELECT MAX(window_end) FROM complexity_snapshots "
                "  WHERE user_id = ? AND level = 'territory' AND level_id = ?)",
                [stage_crypto.enc(novelty), low_conf, user_id, tid, user_id, tid],
            )
            acc.ok()
        except Exception as e:  # noqa: BLE001 — count + continue (fail-loud at finalize)
            acc.fail(e)

    stage_result.finalize(querier, user_id, acc, t0)
    print(f"[novelty] {acc.written} territories scored ({acc.failed} failed)", flush=True)


if __name__ == "__main__":
    import stage_result
    stage_result.run_main("embedding-novelty", main)
