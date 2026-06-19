#!/usr/bin/env python3
"""pipeline/compute-embedding-trajectory.py — Stage: compute-embedding-trajectory (Fisher P3a).

The BASIS-FREE movement cross-check. Fisher velocity measures how the territory/realm
DISTRIBUTION moved — a clustering construct. This measures movement that routes around
the clustering entirely: the angular drift of the GLOBAL embedding centroid (the mean
direction of ALL the week's message embeddings, 768D unit vectors), week to week.

WHY GLOBAL-ONLY (one series, no per-scope): a per-realm centroid would re-import the
clustering through scope membership and so could NOT detect a basis artifact (the
contamination cancels). The only truly clustering-independent comparator is the global
centroid, and — because Fisher's "level" is the granularity of the whole distribution,
not a per-entity breakdown — one global series is the correct comparator at every
granularity. P3b reads this as a baseline-z beside Fisher's velocity baseline-z and
renders the 2x2 honesty quadrant (basis-suspect / corroborated / settled / hidden-drift).

METRIC — per ISO weekly_step window (the SAME grid as Fisher, so rows align 1:1):
  centroid = normalize(mean(unit embeddings)) ; drift = arccos(<c_prev, c_curr>) (radians)
  dispersion = 1 - R̄ where R̄ = ||mean(unit embeddings)|| (spherical variance).
CONFIDENCE — reliability of a mean DIRECTION is governed by R̄, not the message count
(von Mises-Fisher; a diffuse week is directionless at any n). Under uniform directions
E[R̄] ≈ 1/√n, so a meaningful direction needs R̄·√n to beat a Rayleigh-style floor.
low_confidence when R̄·√n < RAYLEIGH_MIN, n < N_MIN, or there is no adjacent previous
centroid to drift from (gap / first window).

SECURITY — messages.embedding_768 is envelope-encrypted (NEVER_AUTO_DECRYPT) → this MUST
be Python; it reuses the same decrypt path harmonics/novelty use (decrypt ONCE, bucket in
memory). The CENTROID (a 768D fingerprint) is NEVER persisted — only the two derived
scalars, caller-encrypted via stage_crypto.enc (ENCRYPTED_FIELDS.embedding_trajectory).
Never logs vectors or values — counts only.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-embedding-trajectory.py
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

# Reuse the EXACT envelope-decrypt path harmonics/novelty/cluster use (768D float32).
from compute_information_harmonics import fetch_envelopes_chunked, decrypt_vectors

stage_base.load_dotenv(_REPO_ROOT)

N_MIN = int(os.environ.get("EMBTRAJ_MIN_MESSAGES", "5"))       # secondary floor
RAYLEIGH_MIN = float(os.environ.get("EMBTRAJ_RAYLEIGH_MIN", "2.0"))  # primary: R̄·√n must beat this


def _parse_iso(s):
    if not s:
        return None
    t = str(s).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        try:
            dt = datetime.fromisoformat(t.split(".")[0] + "+00:00")
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _weekly_step_windows(now, horizon):
    """ISO-Monday-aligned 7-day non-overlapping windows — the SAME grid as Fisher
    weekly_step (compute-fisher.py windows_for) so the two series align by window_start."""
    start = (horizon - timedelta(days=horizon.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    end_horizon = now - timedelta(days=7)
    out = []
    while start <= end_horizon:
        out.append((start, start + timedelta(days=7)))
        start += timedelta(days=7)
    return out


def _make_run_id(user_id, querier):
    """Align to the Fisher era (CLUSTERING_RUN_ID when run via Generate, else the
    derived era) so the cross-check rows key to the same run as fisher_trajectory."""
    return os.environ.get("CLUSTERING_RUN_ID") or stage_base.derive_era_id(user_id, querier=querier)


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    t0 = time.monotonic()
    acc = stage_result.Accumulator("compute-embedding-trajectory")
    run_id = _make_run_id(user_id, querier)

    # GLOBAL: every embedded message, no clustering filter → truly basis-free.
    rows = querier(
        "SELECT id, created_at FROM messages "
        "WHERE user_id = ? AND embedding_768 IS NOT NULL AND created_at IS NOT NULL",
        [user_id],
    )
    pairs = []
    for r in rows:
        dt = _parse_iso(r.get("created_at"))
        if dt is not None and r.get("id"):
            pairs.append((dt, r["id"]))

    def _noop_success(note):
        print(f"[emb-traj] {note}", flush=True)
        stage_result.record_success(querier, user_id, "compute-embedding-trajectory",
                                    int((time.monotonic() - t0) * 1000), {"windows": 0})

    if len(pairs) < N_MIN:
        return _noop_success(f"only {len(pairs)} embedded messages — nothing to do")

    pairs.sort(key=lambda p: p[0])
    all_ids = [pid for _, pid in pairs]

    # Decrypt ONCE (the expensive step) — then bucket in memory across all windows.
    envelopes = fetch_envelopes_chunked(all_ids, querier=querier)
    vectors = decrypt_vectors(envelopes)  # {id: np.ndarray(768) float32}

    ts, mats = [], []
    for dt, pid in pairs:
        v = vectors.get(pid)
        if v is None:
            continue
        nrm = float(np.linalg.norm(v))
        if nrm == 0.0:
            continue
        ts.append(dt.timestamp())
        mats.append((v / nrm).astype(np.float32))  # defensive re-normalize → unit
    if len(mats) < N_MIN:
        return _noop_success(f"only {len(mats)} decrypted unit vectors — nothing to do")

    ts = np.asarray(ts, dtype=np.float64)
    emb = np.stack(mats)  # (N, 768) unit float32
    print(f"[emb-traj] {len(mats)}/{len(all_ids)} embeddings decrypted", flush=True)

    now = datetime.now(timezone.utc)
    windows = _weekly_step_windows(now, pairs[0][0])

    # Era-skip: windows already computed for THIS run (idempotent measure-only re-runs).
    existing = {
        r["window_start"]
        for r in querier(
            "SELECT window_start FROM embedding_trajectory "
            "WHERE user_id = ? AND window_type = 'weekly_step' AND clustering_run_id = ?",
            [user_id, run_id],
        )
        if r.get("window_start")
    }

    prev_centroid = None   # last NON-EMPTY adjacent window's centroid direction
    prev_low_dir = True    # was that window's own direction unreliable
    for ws, we in windows:
        mask = (ts >= ws.timestamp()) & (ts < we.timestamp())
        n = int(mask.sum())
        if n == 0:
            prev_centroid, prev_low_dir = None, True  # a gap breaks adjacency
            continue

        sub = emb[mask].astype(np.float64)
        mean_vec = sub.mean(axis=0)
        R = float(np.linalg.norm(mean_vec))                 # mean resultant length ∈ [0,1]
        dispersion = float(np.clip(1.0 - R, 0.0, 1.0))
        low_dir = (n < N_MIN) or (R * np.sqrt(n) < RAYLEIGH_MIN) or (R < 1e-9)
        centroid = (mean_vec / R) if R > 1e-9 else None

        drift = None
        if prev_centroid is not None and centroid is not None:
            drift = float(np.arccos(np.clip(float(np.dot(prev_centroid, centroid)), -1.0, 1.0)))
        # Drift is trustworthy only if BOTH endpoints are reliable AND adjacent.
        low_conf = 0 if (drift is not None and not low_dir and not prev_low_dir) else 1

        if ws.isoformat() not in existing:
            try:
                querier(
                    "INSERT INTO embedding_trajectory "
                    "(user_id, window_type, window_start, window_end, centroid_drift, dispersion, "
                    " message_count, low_confidence, clustering_run_id) "
                    "VALUES (?, 'weekly_step', ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(user_id, window_type, window_start, clustering_run_id) DO UPDATE SET "
                    "centroid_drift=excluded.centroid_drift, dispersion=excluded.dispersion, "
                    "message_count=excluded.message_count, low_confidence=excluded.low_confidence, "
                    "computed_at=datetime('now')",
                    [user_id, ws.isoformat(), we.isoformat(),
                     stage_crypto.enc(drift), stage_crypto.enc(dispersion), n, low_conf, run_id],
                )
                acc.ok()
            except Exception as e:  # noqa: BLE001 — count + continue (fail-loud at finalize)
                acc.fail(e)

        prev_centroid, prev_low_dir = centroid, low_dir

    stage_result.finalize(querier, user_id, acc, t0)
    print(f"[emb-traj] {acc.written} weekly windows written ({acc.failed} failed)", flush=True)


if __name__ == "__main__":
    import stage_result
    stage_result.run_main("compute-embedding-trajectory", main)
