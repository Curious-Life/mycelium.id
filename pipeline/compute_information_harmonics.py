#!/usr/bin/env python3
"""scripts/compute_information_harmonics.py — Stage: cognitive-harmonics.

Phase 6 / PR1 of the cognitive-metrics measurement plane.

Reads `messages.embedding_768` (envelope-encrypted Nomic v1.5 vectors,
L2-normalized at ingest per embed-service.py:187-188), decrypts via
crypto_local.decrypt_bytes, builds a chronological cosine-distance signal
`info_value(t) = 1 - dot(e_t, e_{t+1})`, aggregates to 5 temporal-scale
bands (gamma/beta/alpha/theta/delta), and computes 3 metric families per
window per granularity:

  §4.23 information_harmonic_amplitude — A_k = √(β₁,k² + β₂,k²) per band per
        harmonic order (Tsipidi 2025; OLS on Fourier basis; signal-agnostic).
  §4.33 bigram_flow_features — mean_crossing_rate, slope_sign_change_rate,
        autocorrelation_lag1, variance, total_spectral_energy per band
        (Palominos 2024; clinically validated for embedding-distance signals).
  §4.34 topology_h0_persistence_entropy (H0 only) — VR-H0 persistence entropy
        on 256D matryoshka projection of the embedding cloud (Pivot F:
        N_MIN_VR=20 hard floor; sub-threshold returns NULL).

§4.24 cross_scale_coupling (PAC/PLV/coherence) is DEFERRED to PR1.5
per design v3 Pivot E (cross-band signal alignment is structurally
broken; needs proper alignment + validation study).

Spec: docs/architecture/COGNITIVE-METRICS-SPEC.md §4.23 + §4.33 + §4.34
Plan: docs/MEASUREMENT-PLANE-PLAN.md
Design: docs/MEASUREMENT-PLANE-PR1-DESIGN-2026-05-07.md (v3)

Run by pipeline-health.js (PM2 hourly cron via the coordinator).
Direct invocation:
    MYA_USER_ID=<owner> python3 scripts/compute_information_harmonics.py

Security:
  - Fail-closed env validation (MYA_USER_ID required, raise if missing).
  - Master key loaded once from /run/mycelium/master.key (tmpfs, VPS-only).
  - All D1 writes parameterised through d1_client; no string-concat SQL.
  - Vector envelopes decrypted to raw bytes in process heap; NEVER logged,
    NEVER serialized to disk, NEVER exposed via HTTP. Decrypted vectors
    live only as np.float32 arrays in the compute path.
  - Audit emits counts only — no PII, no embedding values, no message ids.
"""

import base64
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent

import stage_base
import era_skip
import event_emit
import d1_client
import crypto_local
import stage_crypto

stage_base.load_dotenv(_REPO_ROOT)

from harmonics import (
    harmonic_regression,
    mean_crossing_rate,
    slope_sign_change_rate,
    autocorrelation_lag1,
    total_spectral_energy,
    persistence_entropy_h0,
)


# ── Configuration ────────────────────────────────────────────────────────

# Harmonic order count (§4.23). PR1 v1 default; expandable to 5 in v1.4
# without recompile via env var (pattern from compute-fisher.py:101).
K_HARMONIC_ORDERS = int(os.environ.get('HARMONICS_K', '3'))

# §4.34 stability guards (Pivot F).
N_MIN_VR = 20                   # below this, persistence diagram is noise
NOMIC_DIM_VR = 256              # matryoshka projection dim (matches cluster.py:75)
PERSISTENCE_MAX_N = 2000        # subsample above this (primitive guard at 5000)

# Temporal-aggregation bands. Per spec §4.23 line 482 + Pivot G disclaimer:
# these are TEMPORAL aggregation scales, NOT EEG frequency bands in Hz.
# Valid only as relative-within-user energy; cross-user comparison invalid.
BANDS = ('gamma', 'beta', 'alpha', 'theta', 'delta')

# Window granularities: PR1 ships {alpha, theta, delta} = {daily, weekly, monthly}
# per spec §9 I4 wide-table grain. Each granularity yields one row per window.
GRANULARITIES = ('alpha', 'theta', 'delta')

# History horizon for window enumeration. Cap at 10 years (matches
# compute-fisher.py:63 MAX_HISTORY_DAYS reasoning).
MAX_HISTORY_DAYS = 10 * 365 + 10
FALLBACK_HISTORY_DAYS = 365

# D1 batched fetch chunk size. D1 limits ~100 bound variables per query
# (per cluster.py:458-460); use 100.
D1_BATCH = 100


# ── D1 SQL constants (module scope per compute-fisher.py:339 precedent) ──

HARMONIC_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_harmonic ("
    "  user_id, window_end, granularity, language, clustering_run_id,"
    "  harmonic_amplitude_gamma_k1, harmonic_amplitude_gamma_k2, harmonic_amplitude_gamma_k3,"
    "  harmonic_amplitude_beta_k1,  harmonic_amplitude_beta_k2,  harmonic_amplitude_beta_k3,"
    "  harmonic_amplitude_alpha_k1, harmonic_amplitude_alpha_k2, harmonic_amplitude_alpha_k3,"
    "  harmonic_amplitude_theta_k1, harmonic_amplitude_theta_k2, harmonic_amplitude_theta_k3,"
    "  harmonic_amplitude_delta_k1, harmonic_amplitude_delta_k2, harmonic_amplitude_delta_k3,"
    "  mean_crossing_rate_gamma, mean_crossing_rate_beta, mean_crossing_rate_alpha,"
    "  mean_crossing_rate_theta, mean_crossing_rate_delta,"
    "  slope_sign_change_rate_gamma, slope_sign_change_rate_beta, slope_sign_change_rate_alpha,"
    "  slope_sign_change_rate_theta, slope_sign_change_rate_delta,"
    "  autocorrelation_lag1_gamma, autocorrelation_lag1_beta, autocorrelation_lag1_alpha,"
    "  autocorrelation_lag1_theta, autocorrelation_lag1_delta,"
    "  variance_gamma, variance_beta, variance_alpha, variance_theta, variance_delta,"
    "  total_spectral_energy_gamma, total_spectral_energy_beta, total_spectral_energy_alpha,"
    "  total_spectral_energy_theta, total_spectral_energy_delta,"
    "  topology_h0_persistence_entropy,"
    "  message_count, low_confidence, notes"
    ") VALUES ("
    "  ?, ?, ?, ?, ?,"     # grain (5)
    "  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"  # §4.23 (15)
    "  ?, ?, ?, ?, ?,"     # mean_crossing (5)
    "  ?, ?, ?, ?, ?,"     # slope_sign (5)
    "  ?, ?, ?, ?, ?,"     # autocorr (5)
    "  ?, ?, ?, ?, ?,"     # variance (5)
    "  ?, ?, ?, ?, ?,"     # total_spectral_energy (5)
    "  ?,"                 # §4.34 (1)
    "  ?, ?, ?"            # honesty (3)
    ") "
    "ON CONFLICT(user_id, window_end, granularity, language, clustering_run_id) "
    "DO UPDATE SET "
    "  harmonic_amplitude_gamma_k1 = excluded.harmonic_amplitude_gamma_k1,"
    "  harmonic_amplitude_gamma_k2 = excluded.harmonic_amplitude_gamma_k2,"
    "  harmonic_amplitude_gamma_k3 = excluded.harmonic_amplitude_gamma_k3,"
    "  harmonic_amplitude_beta_k1  = excluded.harmonic_amplitude_beta_k1,"
    "  harmonic_amplitude_beta_k2  = excluded.harmonic_amplitude_beta_k2,"
    "  harmonic_amplitude_beta_k3  = excluded.harmonic_amplitude_beta_k3,"
    "  harmonic_amplitude_alpha_k1 = excluded.harmonic_amplitude_alpha_k1,"
    "  harmonic_amplitude_alpha_k2 = excluded.harmonic_amplitude_alpha_k2,"
    "  harmonic_amplitude_alpha_k3 = excluded.harmonic_amplitude_alpha_k3,"
    "  harmonic_amplitude_theta_k1 = excluded.harmonic_amplitude_theta_k1,"
    "  harmonic_amplitude_theta_k2 = excluded.harmonic_amplitude_theta_k2,"
    "  harmonic_amplitude_theta_k3 = excluded.harmonic_amplitude_theta_k3,"
    "  harmonic_amplitude_delta_k1 = excluded.harmonic_amplitude_delta_k1,"
    "  harmonic_amplitude_delta_k2 = excluded.harmonic_amplitude_delta_k2,"
    "  harmonic_amplitude_delta_k3 = excluded.harmonic_amplitude_delta_k3,"
    "  mean_crossing_rate_gamma = excluded.mean_crossing_rate_gamma,"
    "  mean_crossing_rate_beta  = excluded.mean_crossing_rate_beta,"
    "  mean_crossing_rate_alpha = excluded.mean_crossing_rate_alpha,"
    "  mean_crossing_rate_theta = excluded.mean_crossing_rate_theta,"
    "  mean_crossing_rate_delta = excluded.mean_crossing_rate_delta,"
    "  slope_sign_change_rate_gamma = excluded.slope_sign_change_rate_gamma,"
    "  slope_sign_change_rate_beta  = excluded.slope_sign_change_rate_beta,"
    "  slope_sign_change_rate_alpha = excluded.slope_sign_change_rate_alpha,"
    "  slope_sign_change_rate_theta = excluded.slope_sign_change_rate_theta,"
    "  slope_sign_change_rate_delta = excluded.slope_sign_change_rate_delta,"
    "  autocorrelation_lag1_gamma = excluded.autocorrelation_lag1_gamma,"
    "  autocorrelation_lag1_beta  = excluded.autocorrelation_lag1_beta,"
    "  autocorrelation_lag1_alpha = excluded.autocorrelation_lag1_alpha,"
    "  autocorrelation_lag1_theta = excluded.autocorrelation_lag1_theta,"
    "  autocorrelation_lag1_delta = excluded.autocorrelation_lag1_delta,"
    "  variance_gamma = excluded.variance_gamma,"
    "  variance_beta  = excluded.variance_beta,"
    "  variance_alpha = excluded.variance_alpha,"
    "  variance_theta = excluded.variance_theta,"
    "  variance_delta = excluded.variance_delta,"
    "  total_spectral_energy_gamma = excluded.total_spectral_energy_gamma,"
    "  total_spectral_energy_beta  = excluded.total_spectral_energy_beta,"
    "  total_spectral_energy_alpha = excluded.total_spectral_energy_alpha,"
    "  total_spectral_energy_theta = excluded.total_spectral_energy_theta,"
    "  total_spectral_energy_delta = excluded.total_spectral_energy_delta,"
    "  topology_h0_persistence_entropy = excluded.topology_h0_persistence_entropy,"
    "  message_count   = excluded.message_count,"
    "  low_confidence  = excluded.low_confidence,"
    "  notes           = excluded.notes,"
    "  computed_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
)


# ── Master key (cached per process; pattern from cluster.py:166-174) ────

_MASTER_KEY_CACHE: Optional[bytes] = None


def _get_master_key() -> bytes:
    global _MASTER_KEY_CACHE
    if _MASTER_KEY_CACHE is None:
        _MASTER_KEY_CACHE = crypto_local.load_master_key()
    return _MASTER_KEY_CACHE


# ── Pure: window enumeration ─────────────────────────────────────────────

def windows_for(granularity: str, *, now: datetime, history_days: int) -> Iterator[tuple[datetime, datetime]]:
    """Yield (start, end) datetime tuples in chronological order.

    Calendar-aligned bins (per design v2 Pivot D). Pure / testable.
    `now` is injected so tests can pin time.

    Granularities (PR1 v3):
      alpha = daily   (24h non-overlapping bins from history horizon to now-24h)
      theta = weekly  (7d non-overlapping ISO-week-aligned bins)
      delta = monthly (30d non-overlapping bins, sliding by 7d)
    """
    horizon = now - timedelta(days=history_days)

    if granularity == 'alpha':
        d = horizon.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=1)
        while d <= end_horizon:
            yield d, d + timedelta(days=1)
            d += timedelta(days=1)
        return

    if granularity == 'theta':
        # Align to ISO week start (Monday).
        start = horizon - timedelta(days=horizon.weekday())
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=7)
        while start <= end_horizon:
            yield start, start + timedelta(days=7)
            start += timedelta(days=7)
        return

    if granularity == 'delta':
        d = horizon.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=30)
        while d <= end_horizon:
            yield d, d + timedelta(days=30)
            d += timedelta(days=7)
        return

    raise ValueError(f"unknown granularity: {granularity!r}; expected one of {GRANULARITIES}")


# ── Pure: signal construction + band aggregation ─────────────────────────

def cosine_distance_signal(
    timestamps_unix: np.ndarray, embeddings: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Build info_value(t) = 1 - dot(e_t, e_{t+1}) on L2-normalized vectors.

    Per spec §4.23 line 471 ("~3 lines numpy; YAGNI"). Returns
    (timestamps, distances) of length N-1; signal at index i corresponds
    to the transition from message i to i+1 at timestamp i.

    Embeddings must be L2-normalized at ingest (embed-service.py:187-188).
    """
    n = embeddings.shape[0]
    if n < 2:
        return np.array([], dtype=np.float64), np.array([], dtype=np.float64)
    # dot products of consecutive pairs
    dots = np.einsum('ij,ij->i', embeddings[:-1], embeddings[1:]).astype(np.float64)
    distances = 1.0 - dots
    # Signal at index i takes timestamps[i] (start of the transition).
    return timestamps_unix[:-1].astype(np.float64), distances


def aggregate_to_band(
    timestamps_unix: np.ndarray, signal: np.ndarray, band: str,
    window_start_unix: float, window_end_unix: float,
) -> np.ndarray:
    """Aggregate the cosine-distance signal at the given band scale within
    [window_start_unix, window_end_unix). Returns the band signal (1D).

      gamma = raw signal (per-message)
      beta  = 10-msg rolling mean (output length n-9 if n>=10, else n)
      alpha = daily-bin mean (calendar bins)
      theta = weekly-bin mean (calendar bins)
      delta = monthly-bin mean (calendar bins; ~30d)
    """
    mask = (timestamps_unix >= window_start_unix) & (timestamps_unix < window_end_unix)
    win_ts = timestamps_unix[mask]
    win_sig = signal[mask]
    if win_sig.size == 0:
        return np.array([], dtype=np.float64)

    if band == 'gamma':
        return win_sig

    if band == 'beta':
        if win_sig.size < 10:
            # Below kernel size: return raw to preserve any signal at all.
            return win_sig
        kernel = np.ones(10, dtype=np.float64) / 10.0
        return np.convolve(win_sig, kernel, mode='valid')

    # Calendar-bin bands
    bin_seconds = {'alpha': 86400, 'theta': 604800, 'delta': 2629800}.get(band)
    if bin_seconds is None:
        raise ValueError(f"unknown band: {band!r}")
    bin_starts = np.arange(window_start_unix, window_end_unix, bin_seconds)
    out = []
    for s in bin_starts:
        e = s + bin_seconds
        bm = (win_ts >= s) & (win_ts < e)
        if bm.any():
            out.append(float(win_sig[bm].mean()))
    return np.asarray(out, dtype=np.float64)


# ── Pure: per-window metric compute ──────────────────────────────────────

def compute_window(
    timestamps_unix: np.ndarray, signal: np.ndarray,
    embeddings_in_window: list[np.ndarray],
    window_start_unix: float, window_end_unix: float,
) -> dict:
    """Compute all PR1 metrics for one (granularity, window) pair.
    Returns a dict mapping column-name → value (float or None).
    """
    row: dict = {}

    # Per-band signals for this window
    band_signals = {
        b: aggregate_to_band(timestamps_unix, signal, b, window_start_unix, window_end_unix)
        for b in BANDS
    }

    # ── §4.23 information_harmonic_amplitude (per band, K=3) ────────────
    period = float(window_end_unix - window_start_unix)
    for band in BANDS:
        sig_b = band_signals[band]
        n = sig_b.size
        if n < 2 * K_HARMONIC_ORDERS + 1 or period <= 0.0:
            for k in range(1, K_HARMONIC_ORDERS + 1):
                row[f'harmonic_amplitude_{band}_k{k}'] = None
            continue
        # Build per-band timestamp grid spanning [window_start, window_end).
        # For gamma/beta we have explicit timestamps in the original signal,
        # but the band signal (after aggregation) loses 1:1 correspondence.
        # Use uniform grid over the period — appropriate for OLS Fourier
        # basis since harmonic_regression needs t values within period.
        ts_b = np.linspace(0.0, period, n, endpoint=False, dtype=np.float64)
        try:
            amps = harmonic_regression(sig_b, ts_b, K=K_HARMONIC_ORDERS, period=period)
        except (ValueError, np.linalg.LinAlgError):
            for k in range(1, K_HARMONIC_ORDERS + 1):
                row[f'harmonic_amplitude_{band}_k{k}'] = None
            continue
        for k in range(1, K_HARMONIC_ORDERS + 1):
            row[f'harmonic_amplitude_{band}_k{k}'] = amps.get(k)

    # ── §4.24 cross_scale_coupling — DEFERRED to PR1.5 per Pivot E ──────

    # ── §4.33 bigram_flow_features (per band) ───────────────────────────
    for band in BANDS:
        sig_b = band_signals[band]
        n = sig_b.size
        row[f'mean_crossing_rate_{band}'] = mean_crossing_rate(sig_b) if n > 1 else None
        row[f'slope_sign_change_rate_{band}'] = slope_sign_change_rate(sig_b) if n > 2 else None
        row[f'autocorrelation_lag1_{band}'] = autocorrelation_lag1(sig_b) if n > 1 else None
        row[f'variance_{band}'] = float(np.var(sig_b)) if n > 0 else None
        row[f'total_spectral_energy_{band}'] = total_spectral_energy(sig_b) if n > 0 else None

    # ── §4.34 topology_h0_persistence_entropy (256D-projected, N_MIN_VR=20) ─
    # Per Pivot F: project to 256D matryoshka, re-L2-normalize, then
    # compute VR-H0 entropy. Below N_MIN_VR the diagram is noise.
    N = len(embeddings_in_window)
    if N >= N_MIN_VR:
        if N <= PERSISTENCE_MAX_N:
            pts_768 = np.stack(embeddings_in_window)
        else:
            idx = np.random.default_rng(0).choice(N, PERSISTENCE_MAX_N, replace=False)
            pts_768 = np.stack([embeddings_in_window[i] for i in idx])
        pts_256 = pts_768[:, :NOMIC_DIM_VR].astype(np.float32, copy=True)
        norms = np.linalg.norm(pts_256, axis=1, keepdims=True).clip(min=1e-8)
        pts_256 = pts_256 / norms
        try:
            row['topology_h0_persistence_entropy'] = persistence_entropy_h0(pts_256)
        except (ValueError, np.linalg.LinAlgError):
            row['topology_h0_persistence_entropy'] = None
    else:
        row['topology_h0_persistence_entropy'] = None

    return row


# ── Side-effecting: D1 IO ────────────────────────────────────────────────

def fetch_message_metadata(user_id: str, querier=None) -> list[dict]:
    """Fetch (id, created_at) for every message with a non-NULL embedding_768.

    Lightweight — does NOT fetch the encrypted envelope. Result drives the
    ID-batched envelope fetch + chronological ordering.
    """
    querier = querier or d1_client.query
    rows = querier(
        "SELECT id, created_at FROM messages "
        "WHERE user_id = ? AND embedding_768 IS NOT NULL "
        "ORDER BY created_at ASC",
        [user_id],
    )
    return rows


def fetch_envelopes_chunked(
    ids: list[str], querier=None,
) -> dict[str, str]:
    """Fetch envelope-encrypted vectors for the given message IDs.

    Returns {message_id: envelope_str}. D1 caps bound vars at ~100;
    chunk accordingly (matches cluster.py:458-460).
    """
    querier = querier or d1_client.query
    out: dict[str, str] = {}
    for i in range(0, len(ids), D1_BATCH):
        batch = ids[i:i + D1_BATCH]
        placeholders = ','.join(['?'] * len(batch))
        rows = querier(
            f"SELECT id, embedding_768 FROM messages WHERE id IN ({placeholders})",
            batch,
        )
        for r in rows:
            env = r.get('embedding_768')
            if env:
                out[r['id']] = env
    return out


def decrypt_vectors(envelopes: dict[str, str]) -> dict[str, np.ndarray]:
    """Decrypt envelopes to (768,) np.float32 arrays.

    Per Sweep A pattern (cluster.py:559-578): strict 3072-byte length
    check; per-vector failures increment a counter and are skipped.
    Master key loaded once via _get_master_key().
    """
    master_key = _get_master_key()
    out: dict[str, np.ndarray] = {}
    for mid, env in envelopes.items():
        try:
            pt = crypto_local.decrypt_bytes(env, master_key)
            raw = base64.b64decode(pt)
        except Exception:
            continue
        if len(raw) != 768 * 4:
            continue
        out[mid] = np.frombuffer(raw, dtype=np.float32)
    return out


def fetch_existing_keys(
    user_id: str, run_id: str, querier=None,
) -> set[tuple[str, str]]:
    """Era-skip presence check: return the set of (granularity, window_end)
    keys already computed for this (user, run_id).

    Adapter over era_skip.fetch_existing_keys (PR0.1 helper).
    """
    querier = querier or d1_client.query
    raw = era_skip.fetch_existing_keys(
        querier,
        table='cognitive_metrics_harmonic',
        user_id=user_id,
        run_id=run_id,
        key_columns=['granularity', 'window_end'],
        return_columns=[],  # presence-check only
    )
    return set(raw.keys())


def upsert_row(user_id: str, row: dict, querier=None) -> None:
    """Side-effecting: UPSERT one cognitive_metrics_harmonic row.

    Querier-injection per compute-fisher.py:380, 411 precedent for testability.

    ENCRYPTION (SEC, 2026-06-04): the §4.23 harmonic-amplitude scalars, the
    §4.33 bigram-flow scalars, the §4.34 persistence-entropy scalar, and the
    `notes` string are SENSITIVE → caller-encrypted via stage_crypto.enc (scope
    'personal', wrapped-DEK envelope; numpy repr(float()) poison-proof). This is
    the exact pattern compute-cross-scale-coupling.py already uses for the §4.24
    columns on this same table — a mixed envelope/legacy-plaintext row still
    loads because the JS read path (autoDecryptResults) passes plaintext through
    and decrypts envelopes. STRUCTURAL columns stay PLAINTEXT for indexed
    lookups / WHERE / ORDER BY: user_id, window_end, granularity, language,
    clustering_run_id, message_count, low_confidence. None → None (NULL stays
    NULL — no envelope for missing values).
    """
    querier = querier or d1_client.query
    e = stage_crypto.enc
    params = [
        user_id, row['window_end'], row['granularity'], row['language'], row['clustering_run_id'],
        # §4.23 (15) — ENCRYPTED
        e(row.get('harmonic_amplitude_gamma_k1')), e(row.get('harmonic_amplitude_gamma_k2')), e(row.get('harmonic_amplitude_gamma_k3')),
        e(row.get('harmonic_amplitude_beta_k1')),  e(row.get('harmonic_amplitude_beta_k2')),  e(row.get('harmonic_amplitude_beta_k3')),
        e(row.get('harmonic_amplitude_alpha_k1')), e(row.get('harmonic_amplitude_alpha_k2')), e(row.get('harmonic_amplitude_alpha_k3')),
        e(row.get('harmonic_amplitude_theta_k1')), e(row.get('harmonic_amplitude_theta_k2')), e(row.get('harmonic_amplitude_theta_k3')),
        e(row.get('harmonic_amplitude_delta_k1')), e(row.get('harmonic_amplitude_delta_k2')), e(row.get('harmonic_amplitude_delta_k3')),
        # §4.33 (25) — ENCRYPTED
        e(row.get('mean_crossing_rate_gamma')), e(row.get('mean_crossing_rate_beta')), e(row.get('mean_crossing_rate_alpha')),
        e(row.get('mean_crossing_rate_theta')), e(row.get('mean_crossing_rate_delta')),
        e(row.get('slope_sign_change_rate_gamma')), e(row.get('slope_sign_change_rate_beta')), e(row.get('slope_sign_change_rate_alpha')),
        e(row.get('slope_sign_change_rate_theta')), e(row.get('slope_sign_change_rate_delta')),
        e(row.get('autocorrelation_lag1_gamma')), e(row.get('autocorrelation_lag1_beta')), e(row.get('autocorrelation_lag1_alpha')),
        e(row.get('autocorrelation_lag1_theta')), e(row.get('autocorrelation_lag1_delta')),
        e(row.get('variance_gamma')), e(row.get('variance_beta')), e(row.get('variance_alpha')),
        e(row.get('variance_theta')), e(row.get('variance_delta')),
        e(row.get('total_spectral_energy_gamma')), e(row.get('total_spectral_energy_beta')), e(row.get('total_spectral_energy_alpha')),
        e(row.get('total_spectral_energy_theta')), e(row.get('total_spectral_energy_delta')),
        # §4.34 (1) — ENCRYPTED
        e(row.get('topology_h0_persistence_entropy')),
        # honesty: message_count / low_confidence stay PLAINTEXT; notes ENCRYPTED
        row.get('message_count', 0),
        1 if row.get('low_confidence') else 0,
        e(row.get('notes')),
    ]
    querier(HARMONIC_UPSERT_SQL, params)


# ── Main ─────────────────────────────────────────────────────────────────

def _iso_to_unix(ts_iso: str) -> float:
    """Parse a timestamp → unix seconds. Tolerant of the legacy/import variants in
    the vault: trailing 'Z' or ' UTC', and space-separated 'YYYY-MM-DD HH:MM:SS'
    (e.g. '2018-06-26 21:33:13 UTC') which bare fromisoformat rejects."""
    s = str(ts_iso).strip()
    s = s.replace(' UTC', '').replace(' utc', '').replace('Z', '+00:00').strip()
    if 'T' not in s and ' ' in s:  # 'YYYY-MM-DD HH:MM:SS[+tz]' → ISO 'T' separator
        s = s.replace(' ', 'T', 1)
    return datetime.fromisoformat(s).timestamp()


def _detect_history_days(metadata: list[dict]) -> int:
    """Cap window enumeration at oldest-message → MAX_HISTORY_DAYS."""
    if not metadata:
        return FALLBACK_HISTORY_DAYS
    earliest_iso = metadata[0].get('created_at')
    if not earliest_iso:
        return FALLBACK_HISTORY_DAYS
    earliest = _iso_to_unix(earliest_iso)
    days = math.ceil((datetime.now(timezone.utc).timestamp() - earliest) / 86400.0)
    return max(7, min(int(days), MAX_HISTORY_DAYS))


def main(querier=None) -> None:
    user_id = stage_base.get_user_id()
    # Era anchor: pipeline-health.js injects CLUSTERING_RUN_ID via runEraStage
    # (packages/metrics/stage-template.js:163) so the canonical path is env-driven.
    # For manual / ad-hoc invocations (operator-triggered SSH runs during VPS
    # bring-up, debugging) the env is unset — derive the same value Python-side
    # so rows still anchor to the canonical era and remain visible to consumers.
    # See packages/metrics/era.js::deriveFisherEraId for the JS-side mirror.
    run_id = os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(
        user_id, querier=querier,
    )

    t0 = datetime.now(timezone.utc)
    event_emit.emit(
        'harmonics', 'run_start',
        user=user_id[:8], era_id=run_id, ts=t0.isoformat(),
        K=K_HARMONIC_ORDERS, n_min_vr=N_MIN_VR,
    )

    # ── Phase 1: fetch metadata; detect history span ─────────────────
    metadata = fetch_message_metadata(user_id, querier=querier)
    if len(metadata) < 2:
        # Insufficient data — emit run_end and exit clean.
        t1 = datetime.now(timezone.utc)
        event_emit.emit(
            'harmonics', 'run_end',
            era_id=run_id, totals={'computed': 0, 'skipped': 0},
            reason='insufficient-data',
            duration_ms=int((t1 - t0).total_seconds() * 1000),
        )
        return

    history_days = _detect_history_days(metadata)

    # ── Phase 2: era-skip presence check ─────────────────────────────
    existing_keys = fetch_existing_keys(user_id, run_id, querier=querier)

    # ── Phase 3: fetch + decrypt vectors (chunked) ───────────────────
    ids_in_order = [m['id'] for m in metadata]
    envelopes = fetch_envelopes_chunked(ids_in_order, querier=querier)
    vectors = decrypt_vectors(envelopes)

    # Build aligned (timestamps_unix, embeddings) arrays in chronological
    # order. Drop messages whose envelope failed to decrypt.
    ordered_pairs = [(m['created_at'], vectors[m['id']]) for m in metadata if m['id'] in vectors]
    if len(ordered_pairs) < 2:
        t1 = datetime.now(timezone.utc)
        event_emit.emit(
            'harmonics', 'run_end',
            era_id=run_id, totals={'computed': 0, 'skipped': 0},
            reason='decrypt-failed-or-insufficient',
            duration_ms=int((t1 - t0).total_seconds() * 1000),
        )
        return

    timestamps_unix = np.array([_iso_to_unix(ts) for ts, _ in ordered_pairs], dtype=np.float64)
    embeddings = np.stack([v for _, v in ordered_pairs])

    # ── Phase 4: build cosine-distance signal once ───────────────────
    sig_ts, sig_vals = cosine_distance_signal(timestamps_unix, embeddings)
    if sig_vals.size < 1:
        t1 = datetime.now(timezone.utc)
        event_emit.emit(
            'harmonics', 'run_end',
            era_id=run_id, totals={'computed': 0, 'skipped': 0},
            reason='signal-too-short',
            duration_ms=int((t1 - t0).total_seconds() * 1000),
        )
        return

    # ── Phase 5: enumerate windows × granularities; compute + UPSERT ─
    now = datetime.now(timezone.utc)
    computed = 0
    skipped = 0
    by_granularity: dict = {}

    for granularity in GRANULARITIES:
        per_g = {'computed': 0, 'skipped': 0}
        for w_start, w_end in windows_for(granularity, now=now, history_days=history_days):
            w_end_iso = w_end.isoformat()
            key = (granularity, w_end_iso)
            if key in existing_keys:
                per_g['skipped'] += 1
                skipped += 1
                continue
            w_start_unix = w_start.timestamp()
            w_end_unix = w_end.timestamp()
            # Embeddings whose timestamps fall in the window — used for §4.34.
            mask = (timestamps_unix >= w_start_unix) & (timestamps_unix < w_end_unix)
            embs_in_window = [embeddings[i] for i in np.flatnonzero(mask)]
            try:
                row = compute_window(
                    sig_ts, sig_vals, embs_in_window, w_start_unix, w_end_unix,
                )
            except Exception as e:
                # Truncate exception message — D1 errors can carry SQL
                # fragments via httpx.HTTPStatusError; stay conservative.
                msg = str(e).split('\n', 1)[0][:200]
                print(
                    f"[harmonics] ERROR in {granularity}/{w_end_iso}: {msg}",
                    file=sys.stderr, flush=True,
                )
                raise  # fail-closed; coordinator quarantines after 3 strikes

            row.update({
                'window_end': w_end_iso,
                'granularity': granularity,
                'language': 'en',                # PR1 default per Sweep E
                'clustering_run_id': run_id,
                'message_count': int(mask.sum()),
                'low_confidence': True,          # global until Phase 6.2 calibrates
                'notes': None,
            })
            upsert_row(user_id, row, querier=querier)
            per_g['computed'] += 1
            computed += 1
        by_granularity[granularity] = per_g

    # ── Phase 6: emit run_end LAST (per refinement #5: stage-template's
    # last-16-KiB stdout scan must reliably find this event). ───────────
    t1 = datetime.now(timezone.utc)
    event_emit.emit(
        'harmonics', 'run_end',
        era_id=run_id,
        totals={'computed': computed, 'skipped': skipped},
        by_granularity=by_granularity,
        history_days=history_days,
        n_messages=len(metadata),
        n_decrypted=len(vectors),
        duration_ms=int((t1 - t0).total_seconds() * 1000),
    )


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('cognitive-harmonics', main)
