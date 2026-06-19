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

import math
import sys
from typing import Optional

import numpy as np
from scipy.signal import coherence as scipy_coherence
from scipy.signal import hilbert as scipy_hilbert

EPS = 1e-12


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


# ── §4.24 cross_scale_coupling — Hilbert / PAC / PLV / coherence / wavelets ──
# Library primitives for the cross-scale-coupling family (wired by H1). Pure
# functions, no I/O. scipy.signal is a hard dep; PyWavelets (haar_decompose) is
# lazy-imported so this module stays importable on hosts without it (the §4.24
# wavelet path degrades, mirroring ripser in persistence_entropy_h0). Ported
# from the canonical scripts/harmonics.py: Tort 2010 PAC, PLV, Welch coherence,
# Haar DWT. Bands here are temporal aggregation scales, NOT EEG Hz.

def _safe_hilbert(signal) -> np.ndarray:
    """Analytic signal via Hilbert transform; zeros on empty/constant input.

    scipy.signal.hilbert raises on empty input and is numerically unreliable on
    zero-variance signals; both are normalized to explicit zeros here.

    The signal is DEMEANED first. The cross-scale-coupling bands are built from
    cosine-DISTANCE (1 − cos) values, which carry a large positive DC offset; the
    Hilbert transform of a signal with a DC pedestal yields an analytic signal
    whose phase winds around the offset and whose envelope is dominated by the
    constant, distorting both instantaneous phase and amplitude. Removing the
    mean isolates the oscillatory component, matching the reference PAC/PLV
    implementations (research/multi-scale-surprisal-harmonic-coherence-research-
    2026-05-07.md). Demeaning leaves the std unchanged, so the constant-signal
    guard below still fires for a flat input (→ explicit zeros).
    """
    arr = np.asarray(signal, dtype=np.float64).ravel()
    if arr.size == 0:
        return np.zeros(0, dtype=np.complex128)
    arr = arr - arr.mean()
    if float(np.std(arr)) < EPS:
        return np.zeros_like(arr, dtype=np.complex128)
    return scipy_hilbert(arr)


def hilbert_phase(signal) -> np.ndarray:
    """Instantaneous phase (radians in (-pi, pi]); zeros for constant signals."""
    analytic = _safe_hilbert(signal)
    if analytic.size == 0:
        return np.zeros(0, dtype=np.float64)
    return np.angle(analytic).astype(np.float64)


def hilbert_amplitude(signal) -> np.ndarray:
    """Instantaneous amplitude (envelope); nonnegative; zeros for constant signals."""
    analytic = _safe_hilbert(signal)
    if analytic.size == 0:
        return np.zeros(0, dtype=np.float64)
    return np.abs(analytic).astype(np.float64)


def pac_tort_2010(low, high, n_bins: int = 18) -> float:
    """Tort 2010 modulation index for phase-amplitude coupling, in [0, 1].

    phi_low = hilbert_phase(low); A_high = hilbert_amplitude(high); bin A_high by
    phi_low into n_bins equal-width phase bins; normalize to P; MI = D_KL(P||U) /
    log(n_bins). 0 = no coupling, 1 = perfect (Tort et al. 2010 J Neurophysiol).

    Length mismatch -> ValueError; n < 2*n_bins -> 0.0 (+stderr note);
    constant low -> 0.0.
    """
    if low is None or high is None:
        raise ValueError("low and high must not be None")
    low = np.asarray(low, dtype=np.float64).ravel()
    high = np.asarray(high, dtype=np.float64).ravel()
    if low.shape[0] != high.shape[0]:
        raise ValueError(f"low and high length mismatch: {low.shape[0]} vs {high.shape[0]}")
    if not isinstance(n_bins, int) or n_bins < 2:
        raise ValueError(f"n_bins must be int >= 2, got {n_bins!r}")
    n = low.shape[0]
    if n < 2 * n_bins:
        print(f"[harmonics] pac_tort_2010: n={n} < 2*n_bins={2 * n_bins}; returning 0.0", file=sys.stderr)
        return 0.0
    if float(np.std(low)) < EPS:
        return 0.0

    phase = hilbert_phase(low)
    amp = hilbert_amplitude(high)
    edges = np.linspace(-math.pi, math.pi, n_bins + 1)
    bin_idx = np.clip(np.digitize(phase, edges), 1, n_bins) - 1

    mean_amp = np.zeros(n_bins, dtype=np.float64)
    for b in range(n_bins):
        mask = bin_idx == b
        if mask.any():
            mean_amp[b] = float(amp[mask].mean())
    total = float(mean_amp.sum())
    if total < EPS:
        return 0.0
    P = mean_amp / total
    P_clipped = np.where(P > 0, P, EPS)
    kl = float(np.sum(P * (np.log(P_clipped) - math.log(1.0 / n_bins))))
    mi = kl / math.log(n_bins)
    return float(max(0.0, min(1.0, mi)))


def phase_locking_value(low, high) -> float:
    """PLV = |<exp(i*delta_phi)>|, delta_phi = phi_high - phi_low. In [0, 1].

    Length mismatch -> ValueError; empty or constant -> 0.0.
    """
    if low is None or high is None:
        raise ValueError("low and high must not be None")
    low = np.asarray(low, dtype=np.float64).ravel()
    high = np.asarray(high, dtype=np.float64).ravel()
    if low.shape[0] != high.shape[0]:
        raise ValueError(f"low and high length mismatch: {low.shape[0]} vs {high.shape[0]}")
    if low.size == 0:
        return 0.0
    if float(np.std(low)) < EPS or float(np.std(high)) < EPS:
        return 0.0
    delta = hilbert_phase(high) - hilbert_phase(low)
    return float(max(0.0, min(1.0, float(np.abs(np.mean(np.exp(1j * delta)))))))


def phase_locking_value_debiased(low, high, *, n_surrogates: int = 200, seed: int = 0) -> dict:
    """Chance-corrected PLV via a circular-shift surrogate null.

    Raw PLV is biased upward at small N: its expectation under ZERO coupling is
    ≈ √(π/4N) (≈0.31 at N=8), so a short slow-band pair produces a large
    "coupling" value that is pure finite-sample noise. The analytic √(π/4N) null
    assumes i.i.d. uniform phases, but these band signals are SMOOTH (calendar-bin
    means, 10-msg rolling means, then linear-interpolated onto a common grid), so
    their phases are strongly autocorrelated and the i.i.d. null UNDER-estimates
    the bias. We therefore estimate the null EMPIRICALLY with circular time-shift
    surrogates: shifting one band's phase by a random offset preserves that band's
    own autocorrelation while destroying any genuine cross-band timing, giving the
    correct chance level for THESE signals.

    Returns ``{'plv': observed, 'null_mean':, 'null_std':, 'z':, 'debiased':}``
    where ``debiased = max(0, (plv − null_mean) / (1 − null_mean))`` — the
    fraction of the available phase-locking range exceeded over chance, in [0, 1].
    Length mismatch -> ValueError; empty / constant -> all-zero dict (no coupling).
    The surrogate RNG is seeded (``seed``) so a row recomputes identically.
    """
    if low is None or high is None:
        raise ValueError("low and high must not be None")
    low = np.asarray(low, dtype=np.float64).ravel()
    high = np.asarray(high, dtype=np.float64).ravel()
    if low.shape[0] != high.shape[0]:
        raise ValueError(f"low and high length mismatch: {low.shape[0]} vs {high.shape[0]}")
    zero = {'plv': 0.0, 'null_mean': 0.0, 'null_std': 0.0, 'z': 0.0, 'debiased': 0.0}
    n = low.size
    if n == 0 or float(np.std(low)) < EPS or float(np.std(high)) < EPS:
        return dict(zero)
    if not isinstance(n_surrogates, int) or n_surrogates < 1:
        raise ValueError(f"n_surrogates must be int >= 1, got {n_surrogates!r}")

    phi_low = hilbert_phase(low)
    phi_high = hilbert_phase(high)
    obs = float(np.abs(np.mean(np.exp(1j * (phi_high - phi_low)))))

    rng = np.random.default_rng(seed)
    # Random non-zero circular shifts of phi_high (a shift of 0 would reproduce
    # the observed value and bias the null toward it).
    shifts = rng.integers(1, n, size=n_surrogates) if n > 1 else np.ones(n_surrogates, dtype=int)
    t = np.arange(n)
    idx = (t[None, :] - shifts[:, None]) % n          # (S, N) rolled indices
    delta_s = phi_high[idx] - phi_low[None, :]        # (S, N)
    null = np.abs(np.mean(np.exp(1j * delta_s), axis=1))  # (S,)
    null_mean = float(null.mean())
    null_std = float(null.std())

    denom = 1.0 - null_mean
    debiased = max(0.0, (obs - null_mean) / denom) if denom > EPS else 0.0
    z = (obs - null_mean) / null_std if null_std > EPS else 0.0
    return {
        'plv': obs,
        'null_mean': null_mean,
        'null_std': null_std,
        'z': float(z),
        'debiased': float(min(1.0, debiased)),
    }


def spectral_coherence(x, y, fs: float, nperseg: Optional[int] = None):
    """Magnitude-squared coherence C_xy(f) via Welch's method.

    Returns (frequencies, coherence). Thin wrapper over scipy.signal.coherence.
    Length mismatch -> ValueError; fs <= 0 -> ValueError.
    """
    if x is None or y is None:
        raise ValueError("x and y must not be None")
    x = np.asarray(x, dtype=np.float64).ravel()
    y = np.asarray(y, dtype=np.float64).ravel()
    if x.shape[0] != y.shape[0]:
        raise ValueError(f"x and y length mismatch: {x.shape[0]} vs {y.shape[0]}")
    if fs <= 0:
        raise ValueError(f"fs must be positive, got {fs}")
    f, cxy = scipy_coherence(x, y, fs=fs, nperseg=nperseg)
    return f.astype(np.float64), cxy.astype(np.float64)


def haar_decompose(signal, levels: int) -> list:
    """Multilevel Haar wavelet decomposition (DWT) via PyWavelets.

    Returns [cA_n, cD_n, ..., cD_1] (pywt.wavedec convention). Used for §4.24
    non-stationarity mitigation. PyWavelets is imported lazily so this module
    stays importable without it (mirrors ripser in persistence_entropy_h0); the
    wavelet path then degrades on hosts lacking the wheel.

    levels < 1 -> ValueError; signal too short for the level -> pywt's error.
    """
    if signal is None:
        raise ValueError("signal must not be None")
    signal = np.asarray(signal, dtype=np.float64).ravel()
    if not isinstance(levels, int) or levels < 1:
        raise ValueError(f"levels must be int >= 1, got {levels!r}")
    try:
        import pywt
    except ImportError as e:
        raise ImportError(
            "haar_decompose requires PyWavelets (pip install PyWavelets); see pipeline/requirements.txt"
        ) from e
    coeffs = pywt.wavedec(signal, "haar", level=levels)
    return [np.asarray(c, dtype=np.float64) for c in coeffs]
