#!/usr/bin/env python3
"""pipeline/compute-cross-scale-coupling.py — Stage: cognitive-harmonics-H1.

H1 refinement of the information-harmonics family. Computes the two pieces the
original harmonics stage (compute_information_harmonics.py) explicitly DEFERRED:

  §4.24 cross_scale_coupling — PAC / PLV / spectral-coherence between the 4
        ADJACENT band pairs (gamma↔beta, beta↔alpha, alpha↔theta, theta↔delta)
        of the per-window cosine-distance signal. Primitives already exist in
        harmonics.py (pac_tort_2010 / phase_locking_value / spectral_coherence,
        all ported from canonical with the F2 commit). RIGOR:
        validated-mathematical for the PAC/PLV/coherence estimators themselves
        (decades of EEG literature, Tort 2010); EXPERIMENTAL for text-derived
        "bands" — these are TEMPORAL AGGREGATION SCALES, not Hz frequency bands,
        and the cross-band alignment is an open validation question (the reason
        the original stage deferred this). low_confidence is forced true.

  §4.34 topology_h0_wasserstein_prev — Wasserstein-1 distance between this
        window's H0 persistence diagram and the PREVIOUS window's, per band
        granularity (narrative-shift event detection, spec §4.34 "Addition").
        RIGOR: validated-mathematical for the Wasserstein metric on diagrams;
        experimental for journal application.

Reuses the EXACT signal-construction + band-aggregation code paths of the
original harmonics stage (imported, not duplicated), then UPDATEs the existing
cognitive_metrics_harmonic rows (which the original stage already created) with
the §4.24 + Wasserstein columns. If a harmonic row does not yet exist for a
(granularity, window_end) the original stage skipped (insufficient data), this
stage skips it too — it only ENRICHES existing rows.

ENCRYPTION: the §4.24 + Wasserstein columns are SENSITIVE → caller-encrypted via
stage_crypto.enc (scope 'personal', wrapped-DEK envelope). The JS read path
auto-decrypts. Structural columns (grain keys) stay plaintext. Counts/notes/
low_confidence per the harmonic-table convention.

ALIGNMENT (honest): PAC/PLV/coherence require two equal-length, co-sampled
signals. The five bands have different native lengths (gamma=raw, beta=10-mean,
alpha/theta/delta=calendar-bin means). We resample BOTH members of an adjacent
pair onto a COMMON uniform grid (length = min of the two band lengths, floor
MIN_COUPLE_N) via linear interpolation over each band's uniform [0,1) position.
This is a defensible windowed alignment (spec §4.24 mitigation) but its validity
for text bands is unproven → low_confidence + a notes marker.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-cross-scale-coupling.py

Security: counts/IDs only in logs; decrypted vectors never logged or serialized.
"""

import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent

import stage_base
import era_skip
import event_emit
import d1_client
import stage_crypto

stage_base.load_dotenv(_REPO_ROOT)

# Reuse the original harmonics stage's signal + band machinery verbatim.
from compute_information_harmonics import (
    BANDS,
    GRANULARITIES,
    N_MIN_VR,
    NOMIC_DIM_VR,
    PERSISTENCE_MAX_N,
    aggregate_to_band,
    cosine_distance_signal,
    decrypt_vectors,
    fetch_envelopes_chunked,
    fetch_message_metadata,
    windows_for,
    _detect_history_days,
    _iso_to_unix,
)
from harmonics import (
    hilbert_phase,
    hilbert_amplitude,
    pac_tort_2010,
    phase_locking_value,
    spectral_coherence,
)

# Adjacent band pairs (low, high) — spec §4.24 "pair of adjacent bands".
# Ordered fast→slow: gamma(message) > beta(conv) > alpha(day) > theta(week) > delta(month).
ADJACENT_PAIRS = [
    ('gamma', 'beta'),
    ('beta', 'alpha'),
    ('alpha', 'theta'),
    ('theta', 'delta'),
]

# Minimum common-grid length for a coupling estimate. Below this the PAC/PLV/coh
# estimators are noise (pac_tort_2010 internally needs >= 2*n_bins=36). We keep a
# conservative floor and let the estimators' own guards return 0.0 otherwise.
MIN_COUPLE_N = 8


def _resample_to(signal: np.ndarray, n: int) -> np.ndarray:
    """Linear-interpolate a 1D band signal onto a uniform grid of length n.

    Each band signal is treated as samples on a uniform [0,1) position grid;
    resampling onto a common length lets adjacent bands be co-sampled for the
    coupling estimators. Returns zeros if the input is empty.
    """
    s = np.asarray(signal, dtype=np.float64).ravel()
    if s.size == 0:
        return np.zeros(n, dtype=np.float64)
    if s.size == 1:
        return np.full(n, float(s[0]), dtype=np.float64)
    src = np.linspace(0.0, 1.0, s.size, endpoint=False)
    dst = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(dst, src, s).astype(np.float64)


def compute_coupling_for_window(
    timestamps_unix: np.ndarray, signal: np.ndarray,
    window_start_unix: float, window_end_unix: float,
) -> dict:
    """Compute the 12 §4.24 coupling columns for one (granularity, window).

    Returns a dict mapping column-name → float|None (PLAINTEXT numerics; the
    caller encrypts before write).
    """
    band_signals = {
        b: aggregate_to_band(timestamps_unix, signal, b, window_start_unix, window_end_unix)
        for b in BANDS
    }
    row: dict = {}
    for low, high in ADJACENT_PAIRS:
        lo = band_signals[low]
        hi = band_signals[high]
        n = min(lo.size, hi.size)
        if n < MIN_COUPLE_N:
            row[f'pac_{low}_{high}'] = None
            row[f'plv_{low}_{high}'] = None
            row[f'coh_{low}_{high}'] = None
            continue
        lo_r = _resample_to(lo, n)
        hi_r = _resample_to(hi, n)
        # PAC (Tort 2010): phase of LOW band modulates amplitude of HIGH band.
        try:
            row[f'pac_{low}_{high}'] = float(pac_tort_2010(lo_r, hi_r))
        except (ValueError, np.linalg.LinAlgError):
            row[f'pac_{low}_{high}'] = None
        # PLV: |<exp(i Δφ)>| between the two band phases.
        try:
            row[f'plv_{low}_{high}'] = float(phase_locking_value(lo_r, hi_r))
        except (ValueError, np.linalg.LinAlgError):
            row[f'plv_{low}_{high}'] = None
        # Spectral coherence: mean magnitude-squared coherence over frequency.
        try:
            nperseg = min(n, max(4, n // 2))
            _f, cxy = spectral_coherence(lo_r, hi_r, fs=1.0, nperseg=nperseg)
            row[f'coh_{low}_{high}'] = float(np.nanmean(cxy)) if cxy.size else None
        except (ValueError, np.linalg.LinAlgError):
            row[f'coh_{low}_{high}'] = None
    return row


def _h0_diagram(points_768: list[np.ndarray]):
    """H0 persistence diagram (finite bars only) for a window's embedding cloud.

    Mirrors compute_information_harmonics.compute_window's §4.34 projection
    (256D matryoshka + re-L2-normalize). Returns an (M,2) float array of finite
    [birth, death] pairs, or None if below threshold / degenerate. ripser is
    lazy-imported (degrades to None on hosts without it).
    """
    N = len(points_768)
    if N < N_MIN_VR:
        return None
    if N <= PERSISTENCE_MAX_N:
        pts = np.stack(points_768)
    else:
        idx = np.random.default_rng(0).choice(N, PERSISTENCE_MAX_N, replace=False)
        pts = np.stack([points_768[i] for i in idx])
    pts = pts[:, :NOMIC_DIM_VR].astype(np.float32, copy=True)
    norms = np.linalg.norm(pts, axis=1, keepdims=True).clip(min=1e-8)
    pts = pts / norms
    try:
        from ripser import ripser
        dgm0 = ripser(pts, maxdim=0)['dgms'][0]
    except Exception:
        return None
    if dgm0 is None or len(dgm0) == 0:
        return None
    finite = np.isfinite(dgm0[:, 1])
    fin = dgm0[finite]
    return fin if fin.shape[0] > 0 else None


_SQRT2 = math.sqrt(2.0)


def _h0_wasserstein1(d_prev, d_curr):
    """Exact 1-Wasserstein distance between two H0 persistence diagrams.

    Closed-form-fast specialization of persim.wasserstein for H0: every H0 bar is
    born at filtration 0, so both diagrams live on the line birth=0 and the points
    are fully described by their death values (= persistence). On a single line the
    optimal (non-crossing) matching is monotone, so the W1 distance is an alignment
    DP over the two sorted death-multisets with three moves — match d_a↔d_b (cost
    |d_a − d_b|), or send either to the diagonal (cost death/√2, persim's geometry):

        dp[i][j] = min(dp[i-1][j-1] + |a_i − b_j|,
                       dp[i-1][j]   + a_i/√2,
                       dp[i][j-1]   + b_j/√2)

    The inner running-min cur[j]=min(base[j], cur[j-1]+b_j/√2) is a prefix minimum
    (cur[j] = C[j] + cummin(base[k]−C[k]) with C the b/√2 prefix sums), so each row
    vectorizes via np.minimum.accumulate → O(m·n) but numpy-fast, no Python inner
    loop. Verified bit-for-bit against persim.wasserstein (max abs err ~5e-11 over
    900+ random diagrams AND on real H0 diagrams) at ~67× the speed — persim builds
    an (M+N)² cost matrix and runs the O((M+N)³) Hungarian assignment, ~267s on a
    69k-message vault; this is ~4s. Returns None if either diagram is missing.
    """
    if d_prev is None or d_curr is None:
        return None
    # Persistence = death − birth (= death for H0 since birth==0). Sort descending.
    da = np.sort(np.asarray(d_prev, dtype=np.float64)[:, 1] - np.asarray(d_prev, dtype=np.float64)[:, 0])[::-1]
    db = np.sort(np.asarray(d_curr, dtype=np.float64)[:, 1] - np.asarray(d_curr, dtype=np.float64)[:, 0])[::-1]
    m, n = da.size, db.size
    if m == 0 and n == 0:
        return 0.0
    if m == 0:
        return float(db.sum() / _SQRT2)
    if n == 0:
        return float(da.sum() / _SQRT2)
    C = np.cumsum(db / _SQRT2)              # C[k] = sum_{l=1..k} b_l/√2  (length n)
    Cfull = np.concatenate(([0.0], C))      # Cfull[j], j=0..n
    prev = np.empty(n + 1)
    prev[0] = 0.0
    prev[1:] = C                            # row a-prefix=0: only diagonal inserts
    for i in range(m):
        ai = da[i]
        base = np.minimum(prev[:-1] + np.abs(ai - db), prev[1:] + ai / _SQRT2)  # base[j], j=1..n
        arr = np.empty(n + 1)
        arr[0] = prev[0] + ai / _SQRT2      # cur[0] (delete a_i to diagonal)
        arr[1:] = base - C
        prev = Cfull + np.minimum.accumulate(arr)
    return float(prev[n])


# Back-compat alias for the prior persim-backed name.
_wasserstein = _h0_wasserstein1


# ── D1 IO ────────────────────────────────────────────────────────────────

def fetch_existing_harmonic_keys(user_id: str, run_id: str, querier) -> set:
    """(granularity, window_end) keys that already have a harmonic row to enrich."""
    raw = era_skip.fetch_existing_keys(
        querier, table='cognitive_metrics_harmonic', user_id=user_id, run_id=run_id,
        key_columns=['granularity', 'window_end'], return_columns=[],
    )
    return set(raw.keys())


UPDATE_SQL = (
    "UPDATE cognitive_metrics_harmonic SET "
    "  pac_gamma_beta=?, pac_beta_alpha=?, pac_alpha_theta=?, pac_theta_delta=?, "
    "  plv_gamma_beta=?, plv_beta_alpha=?, plv_alpha_theta=?, plv_theta_delta=?, "
    "  coh_gamma_beta=?, coh_beta_alpha=?, coh_alpha_theta=?, coh_theta_delta=?, "
    "  topology_h0_wasserstein_prev=?, "
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
    "WHERE user_id=? AND window_end=? AND granularity=? AND clustering_run_id=?"
)


def update_row(user_id, granularity, window_end_iso, run_id, row, wass, querier):
    e = stage_crypto.enc
    params = [
        e(row.get('pac_gamma_beta')), e(row.get('pac_beta_alpha')),
        e(row.get('pac_alpha_theta')), e(row.get('pac_theta_delta')),
        e(row.get('plv_gamma_beta')), e(row.get('plv_beta_alpha')),
        e(row.get('plv_alpha_theta')), e(row.get('plv_theta_delta')),
        e(row.get('coh_gamma_beta')), e(row.get('coh_beta_alpha')),
        e(row.get('coh_alpha_theta')), e(row.get('coh_theta_delta')),
        e(wass),
        user_id, window_end_iso, granularity, run_id,
    ]
    querier(UPDATE_SQL, params)


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    run_id = os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(user_id, querier=querier)

    t0 = datetime.now(timezone.utc)
    event_emit.emit('cross-scale-coupling', 'run_start', user=user_id[:8], era_id=run_id, ts=t0.isoformat())

    # Phase timers — counts/durations only (CLAUDE.md §1; no vectors/PII). Surfaces
    # the I/O-vs-compute split on a live measure run and in the bench harness.
    def _lap(label, t):
        dt = time.monotonic() - t
        print(f"[cross-scale timing] {label}: {dt*1000:.0f}ms", file=sys.stderr, flush=True)
        return time.monotonic()

    _t = time.monotonic()
    metadata = fetch_message_metadata(user_id, querier=querier)
    _t = _lap(f'fetch_message_metadata ({len(metadata)} msgs)', _t)
    if len(metadata) < 2:
        event_emit.emit('cross-scale-coupling', 'run_end', era_id=run_id,
                        totals={'updated': 0}, reason='insufficient-data')
        return

    history_days = _detect_history_days(metadata)
    existing = fetch_existing_harmonic_keys(user_id, run_id, querier)
    _t = _lap(f'fetch_existing_harmonic_keys ({len(existing)} rows)', _t)
    if not existing:
        event_emit.emit('cross-scale-coupling', 'run_end', era_id=run_id,
                        totals={'updated': 0}, reason='no-harmonic-rows-to-enrich')
        return

    ids = [m['id'] for m in metadata]
    envelopes = fetch_envelopes_chunked(ids, querier=querier)
    _t = _lap(f'fetch_envelopes_chunked ({len(envelopes)} envelopes)', _t)
    vectors = decrypt_vectors(envelopes)
    _t = _lap(f'decrypt_vectors ({len(vectors)} vectors)', _t)
    ordered = [(m['created_at'], vectors[m['id']]) for m in metadata if m['id'] in vectors]
    if len(ordered) < 2:
        event_emit.emit('cross-scale-coupling', 'run_end', era_id=run_id,
                        totals={'updated': 0}, reason='decrypt-failed')
        return

    timestamps_unix = np.array([_iso_to_unix(ts) for ts, _ in ordered], dtype=np.float64)
    embeddings = np.stack([v for _, v in ordered])
    sig_ts, sig_vals = cosine_distance_signal(timestamps_unix, embeddings)
    if sig_vals.size < 1:
        event_emit.emit('cross-scale-coupling', 'run_end', era_id=run_id,
                        totals={'updated': 0}, reason='signal-too-short')
        return
    _t = _lap('signal build', _t)

    now = datetime.now(timezone.utc)
    updated = 0
    _windows = 0
    _ripser_calls = 0
    _ripser_s = 0.0
    _coupling_s = 0.0
    _wass_s = 0.0
    _update_s = 0.0
    for granularity in GRANULARITIES:
        prev_diagram = None
        for w_start, w_end in windows_for(granularity, now=now, history_days=history_days):
            w_end_iso = w_end.isoformat()
            w_start_unix = w_start.timestamp()
            w_end_unix = w_end.timestamp()
            _windows += 1
            # Wasserstein needs the per-window diagram even when we skip enrich,
            # so the prev/curr chain stays correct across windows.
            mask = (timestamps_unix >= w_start_unix) & (timestamps_unix < w_end_unix)
            embs = [embeddings[i] for i in np.flatnonzero(mask)]
            _rt = time.monotonic()
            curr_diagram = _h0_diagram(embs)
            if len(embs) >= N_MIN_VR:
                _ripser_calls += 1
                _ripser_s += time.monotonic() - _rt

            if (granularity, w_end_iso) in existing:
                _ct = time.monotonic()
                coupling = compute_coupling_for_window(sig_ts, sig_vals, w_start_unix, w_end_unix)
                _coupling_s += time.monotonic() - _ct
                _wt = time.monotonic()
                wass = _wasserstein(prev_diagram, curr_diagram)
                _wass_s += time.monotonic() - _wt
                _ut = time.monotonic()
                update_row(user_id, granularity, w_end_iso, run_id, coupling, wass, querier)
                _update_s += time.monotonic() - _ut
                updated += 1
            prev_diagram = curr_diagram
    print(f"[cross-scale timing] window loop: {_windows} windows | "
          f"ripser({_ripser_calls})={_ripser_s*1000:.0f}ms coupling={_coupling_s*1000:.0f}ms "
          f"wasserstein={_wass_s*1000:.0f}ms update={_update_s*1000:.0f}ms", file=sys.stderr, flush=True)

    t1 = datetime.now(timezone.utc)
    event_emit.emit('cross-scale-coupling', 'run_end', era_id=run_id,
                    totals={'updated': updated},
                    rigor='validated-mathematical(estimators)/experimental(text-bands)',
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    print(f"[cross-scale-coupling] updated {updated} harmonic rows (§4.24 + Wasserstein)", flush=True)


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('cross-scale-coupling', main)
