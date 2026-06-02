"""harmonics.py — signal-processing + TDA metrics for the harmonics stage.

Implements the six functions compute_information_harmonics.py imports:

    harmonic_regression(values, t, *, K, period) -> dict[int, float]
    mean_crossing_rate(values)                   -> float
    slope_sign_change_rate(values)               -> float
    autocorrelation_lag1(values)                 -> float
    total_spectral_energy(values)                -> float
    persistence_entropy_h0(points)               -> float | None

Each is a standard, literature-grounded estimator; see per-function notes for
the exact mathematical definition and any edge-case conventions. The call
sites already gate on minimum length (e.g. harmonic_regression only runs when
n >= 2K+1, the others when n > 1/2), but every function is independently
defensive so it is safe to call directly in tests.
"""

from __future__ import annotations

from typing import Optional

import numpy as np


# ── §4.23 information_harmonic_amplitude ──────────────────────────────────

def harmonic_regression(values, t, *, K: int, period: float) -> dict[int, float]:
    """Fourier harmonic regression amplitudes A_k (Tsipidi 2025, §4.23).

    Fits, by ordinary least squares, the model

        y(t) ≈ β0 + Σ_{k=1..K} [ β1_k·cos(2π k t / period)
                                + β2_k·sin(2π k t / period) ]

    and returns ``{k: A_k}`` where ``A_k = sqrt(β1_k² + β2_k²)`` — the
    amplitude of the k-th harmonic, invariant to phase. This is the standard
    amplitude read-out of a harmonic / Fourier regression.

    Parameters
    ----------
    values : array-like, shape (n,)
        Signal samples.
    t : array-like, shape (n,)
        Sample positions (same units as ``period``). The caller passes a
        uniform grid over ``[0, period)``; arbitrary spacing is supported
        because this is a genuine least-squares fit, not an FFT.
    K : int
        Number of harmonic orders.
    period : float
        Fundamental period (window length) for the Fourier basis.

    Returns
    -------
    dict[int, float]
        ``{1: A_1, ..., K: A_K}``. ``.get(k)`` is how the caller reads it.

    Raises
    ------
    ValueError / numpy.linalg.LinAlgError
        On degenerate input (too few samples, non-finite values, singular
        design). The caller catches these and writes NULLs.
    """
    y = np.asarray(values, dtype=np.float64).ravel()
    tt = np.asarray(t, dtype=np.float64).ravel()
    n = y.size

    if n != tt.size:
        raise ValueError("values and t must have the same length")
    if K < 1:
        raise ValueError("K must be >= 1")
    if not (period > 0.0):
        raise ValueError("period must be positive")
    # Need at least as many samples as parameters (1 + 2K) for an OLS fit.
    if n < 2 * K + 1:
        raise ValueError(f"need >= {2 * K + 1} samples for K={K}, got {n}")
    if not np.all(np.isfinite(y)) or not np.all(np.isfinite(tt)):
        raise ValueError("non-finite values in signal or time grid")

    # Design matrix: [1, cos(ω t), sin(ω t), cos(2ω t), sin(2ω t), ...]
    omega = 2.0 * np.pi / period
    cols = [np.ones(n, dtype=np.float64)]
    for k in range(1, K + 1):
        ang = omega * k * tt
        cols.append(np.cos(ang))
        cols.append(np.sin(ang))
    X = np.column_stack(cols)

    # Least squares (rcond=None → use machine-precision cutoff). lstsq is
    # robust to rank deficiency; if the design is pathological it raises
    # LinAlgError which the caller treats as NULL.
    beta, _res, _rank, _sv = np.linalg.lstsq(X, y, rcond=None)

    amps: dict[int, float] = {}
    for k in range(1, K + 1):
        b1 = beta[2 * k - 1]  # cosine coefficient for order k
        b2 = beta[2 * k]      # sine coefficient for order k
        amps[k] = float(np.hypot(b1, b2))
    return amps


# ── §4.33 bigram_flow_features ────────────────────────────────────────────

def mean_crossing_rate(values) -> float:
    """Fraction of consecutive sample pairs that cross the signal mean.

    A crossing occurs between samples i and i+1 when the mean-centered signal
    changes sign across them. Returned value is in [0, 1]:
    ``crossings / (n - 1)``. Samples exactly equal to the mean are treated as
    sign 0, so a pair (+, 0) is not a crossing but (+, 0, -) yields a crossing
    on the (0, -) ... here computed pairwise via sign changes of the centered
    series with zeros carried forward.
    """
    x = np.asarray(values, dtype=np.float64).ravel()
    n = x.size
    if n < 2:
        return 0.0
    centered = x - x.mean()
    s = np.sign(centered)
    # Carry the last non-zero sign forward so a value sitting exactly on the
    # mean doesn't spuriously create two half-crossings.
    nz = s != 0
    if nz.any():
        idx = np.where(nz, np.arange(n), 0)
        np.maximum.accumulate(idx, out=idx)
        s = s[idx]
    crossings = int(np.count_nonzero(np.diff(s) != 0))
    return crossings / (n - 1)


def slope_sign_change_rate(values) -> float:
    """Fraction of interior points where the first-difference sign flips.

    Computes the first difference d = diff(values), then counts how often
    consecutive differences have opposite sign (a local max/min / "slope sign
    change", a standard EMG/bigram-flow feature, Palominos 2024). Normalized
    by the number of difference-pairs ``len(d) - 1 == n - 2`` → value in
    [0, 1]. Flat segments (zero difference) carry the previous sign forward so
    a plateau is not counted as a change.
    """
    x = np.asarray(values, dtype=np.float64).ravel()
    n = x.size
    if n < 3:
        return 0.0
    d = np.diff(x)
    s = np.sign(d)
    nz = s != 0
    if nz.any():
        idx = np.where(nz, np.arange(d.size), 0)
        np.maximum.accumulate(idx, out=idx)
        s = s[idx]
    changes = int(np.count_nonzero(np.diff(s) != 0))
    return changes / (d.size - 1)


def autocorrelation_lag1(values) -> float:
    """Pearson autocorrelation of the signal at lag 1.

    r1 = corr(x[:-1], x[1:]) using the biased/normalized form

        r1 = Σ (x_t - x̄)(x_{t+1} - x̄) / Σ (x_t - x̄)²

    which is the conventional lag-1 sample autocorrelation (bounded in
    [-1, 1]). Returns 0.0 for a constant signal (zero variance) — the
    correlation is undefined there and 0 is the neutral, finite convention
    used by the wide-table consumers.
    """
    x = np.asarray(values, dtype=np.float64).ravel()
    n = x.size
    if n < 2:
        return 0.0
    xc = x - x.mean()
    denom = float(np.dot(xc, xc))
    if denom <= 0.0:
        return 0.0
    num = float(np.dot(xc[:-1], xc[1:]))
    r = num / denom
    # Clamp tiny floating overshoot beyond ±1.
    return float(np.clip(r, -1.0, 1.0))


def total_spectral_energy(values) -> float:
    """Total spectral energy = Σ |X_f|² of the (real) FFT, per Parseval.

    Uses the full DFT (np.fft.fft) and sums squared magnitudes over all
    bins. By Parseval's theorem this equals n · Σ x_t² ; computing it in the
    frequency domain matches the spec's framing ("total_spectral_energy")
    and the bigram-flow feature family that reads other FFT-derived stats.
    Returns a non-negative float; 0.0 for an empty signal.
    """
    x = np.asarray(values, dtype=np.float64).ravel()
    if x.size == 0:
        return 0.0
    spectrum = np.fft.fft(x)
    energy = float(np.sum(np.abs(spectrum) ** 2))
    return energy


# ── §4.34 topology_h0_persistence_entropy ────────────────────────────────

def persistence_entropy_h0(points) -> Optional[float]:
    """H0 (connected-components) persistence entropy of a Vietoris–Rips
    filtration over the point cloud ``points`` (shape (N, D)).

    Pipeline (per §4.34 / Pivot F — H0 only):
      1. Build the VR H0 persistence diagram with ripser (maxdim=0). For H0
         this is equivalent to single-linkage clustering: every point is born
         at filtration value 0 and dies when it merges into a larger
         component; exactly one component persists to +∞.
      2. Take the FINITE bars (drop the single infinite-death bar), with
         lifetimes ℓ_i = death_i - birth_i (> 0).
      3. Normalize to a probability distribution p_i = ℓ_i / Σ ℓ_j and return
         the Shannon entropy H = -Σ p_i ln p_i (persistence entropy;
         Rucco et al. 2016).

    Returns the entropy as a float, or ``None`` if no finite bars with
    positive lifetime exist (degenerate cloud). Raises ValueError /
    LinAlgError on malformed input, which the caller turns into NULL.
    """
    pts = np.asarray(points, dtype=np.float32)
    if pts.ndim != 2:
        raise ValueError("points must be a 2D array of shape (N, D)")
    n = pts.shape[0]
    if n < 2:
        return None
    if not np.all(np.isfinite(pts)):
        raise ValueError("non-finite coordinates in point cloud")

    # Imported lazily so the module stays importable even if ripser is absent
    # on a constrained host (the stage degrades to NULL per requirements.txt).
    from ripser import ripser

    result = ripser(pts, maxdim=0)
    dgm0 = result["dgms"][0]
    if dgm0 is None or len(dgm0) == 0:
        return None

    births = dgm0[:, 0]
    deaths = dgm0[:, 1]
    finite = np.isfinite(deaths)
    lifetimes = (deaths[finite] - births[finite]).astype(np.float64)
    lifetimes = lifetimes[lifetimes > 0.0]
    if lifetimes.size == 0:
        return None

    total = float(lifetimes.sum())
    if total <= 0.0:
        return None
    p = lifetimes / total
    # p > 0 guaranteed by the lifetimes>0 filter, so log is finite.
    entropy = float(-np.sum(p * np.log(p)))
    return entropy
