"""Fisher information geometry for cognitive trajectory tracking (V1 port).

Ported VERBATIM from the canonical scripts/fisher.py (Curious-Life/mycelium)
with ONE behavioral fix flagged inline:

  * clamp-inf-z (K1 audit fix): null_model_z returned float('inf') when the
    pooled-null had zero variance. An infinite z-score is poison downstream —
    JSON.stringify(Infinity) === 'null', SQLite stores it as a non-finite REAL,
    and the encrypted-at-rest path (K1b) String()-coerces it to the literal
    'Infinity'. We clamp every returned z to ±Z_MAX so a real-but-degenerate
    window reads as "very significant" without an unbounded value.

Pure math + numpy. No I/O, no auth, no master-key access — safe to import from
anywhere. The orchestration (D1 reads/writes, windowing, milestone rules) lives
in compute-fisher.py.

What this module covers (see docs/MEASUREMENT-LAYER-BUILDOUT-PLAN §Fisher):
  - Activation vectors from message counts (Laplace-smoothed)
  - Fisher geodesic distance (Bhattacharyya/Hellinger on the categorical simplex)
  - Trajectory length, displacement, exploration ratio
  - Phase classification (stable / cycling / exploring / transforming)
  - Per-territory contribution (squared chord decomposition — geodesic-consistent)
  - Null-model z-scores via pooled multinomial resampling
  - Activation entropy (Shannon)
  - Velocity spectrum + dominant period (FFT periodogram on weekly_step series)
  - compute_step: bundles everything into a FisherStep dataclass
"""

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


# ── Constants ────────────────────────────────────────────────────────────────

EPSILON = 0.01          # Laplace smoothing pseudocount
N_MIN = 15              # Minimum messages for confident computation
R_CYCLING = 0.3         # R < this → cycling
R_EXPLORING_MAX = 0.7   # R < this → exploring; R ≥ this → transforming
Z_MAX = 1e6             # K1 fix: clamp z-scores to ±this (no infinities at rest)


# ── Activation vectors ──────────────────────────────────────────────────────

def activation_vector(
    counts: dict[str, int],
    all_territory_ids: list[str],
    epsilon: float = EPSILON,
) -> dict[str, float]:
    """Smoothed probability distribution from message counts.

    Args:
        counts: {territory_id: message_count} for the window.
        all_territory_ids: Full list of territory IDs (including zero-count).
        epsilon: Laplace pseudocount.

    Returns:
        {territory_id: probability} summing to 1.0.
    """
    smoothed = {tid: counts.get(tid, 0) + epsilon for tid in all_territory_ids}
    total = sum(smoothed.values())
    return {tid: v / total for tid, v in smoothed.items()}


def activation_vector_from_array(
    counts: np.ndarray,
    epsilon: float = EPSILON,
) -> np.ndarray:
    """Array form: counts → smoothed probability vector."""
    smoothed = counts.astype(np.float64) + epsilon
    return smoothed / smoothed.sum()


# ── Fisher geodesic distance ────────────────────────────────────────────────

def fisher_distance(p: np.ndarray, q: np.ndarray) -> float:
    """Geodesic distance on the categorical simplex under the Fisher metric.

    d(p, q) = 2 · arccos(Σ √(pᵢ · qᵢ))

    The Bhattacharyya/Hellinger geodesic on the √p sphere. Exact, bounded
    by π, symmetric, satisfies the triangle inequality.
    """
    bhatt = np.sum(np.sqrt(p * q))
    bhatt = np.clip(bhatt, -1.0, 1.0)
    return 2.0 * np.arccos(bhatt)


def fisher_distance_dicts(
    p: dict[str, float],
    q: dict[str, float],
) -> float:
    """Fisher distance from two activation-vector dicts (must share keys)."""
    keys = sorted(p.keys())
    p_arr = np.array([p[k] for k in keys])
    q_arr = np.array([q[k] for k in keys])
    return fisher_distance(p_arr, q_arr)


# ── Trajectory metrics ──────────────────────────────────────────────────────

def trajectory_length(activations: list[np.ndarray]) -> float:
    """Sum of consecutive Fisher distances."""
    total = 0.0
    for i in range(1, len(activations)):
        total += fisher_distance(activations[i - 1], activations[i])
    return total


def displacement(p_start: np.ndarray, p_end: np.ndarray) -> float:
    """Geodesic from start to end, ignoring path."""
    return fisher_distance(p_start, p_end)


def exploration_ratio(
    D: float,
    L: float,
    L_stable_threshold: float = 0.0,
) -> Optional[float]:
    """R = D / L. Returns None when L < threshold (stable phase) or L == 0."""
    if L < L_stable_threshold or L == 0:
        return None
    return D / L


# ── Phase classification ────────────────────────────────────────────────────

def classify_phase(
    L: float,
    R: Optional[float],
    L_stable_threshold: float = 0.0,
) -> str:
    """Classify phase from trajectory length and exploration ratio.

    Returns one of: 'stable', 'cycling', 'exploring', 'transforming'.
    """
    if L < L_stable_threshold:
        return "stable"
    if R is None:
        return "stable"
    if R < R_CYCLING:
        return "cycling"
    if R < R_EXPLORING_MAX:
        return "exploring"
    return "transforming"


# ── Per-territory contribution ──────────────────────────────────────────────

def territory_contributions(
    p: np.ndarray,
    q: np.ndarray,
) -> np.ndarray:
    """Squared chord decomposition: contribution of each territory to the
    Fisher step.

        contribution_i = (√p_i − √q_i)²

    Sum equals the squared chord 2 − 2·Σ√(p·q). Each contribution's fraction
    of the total decomposes the Fisher distance honestly (geodesic-consistent).
    """
    return (np.sqrt(p) - np.sqrt(q)) ** 2


def top_contributors(
    p: np.ndarray,
    q: np.ndarray,
    territory_ids: list[str],
    k: int = 3,
) -> list[dict]:
    """Top-k territories by contribution to the Fisher step.

    Returns list of {id, contribution_sq, pct, direction: '+'/'-'}.
    """
    contribs = territory_contributions(p, q)
    total = contribs.sum()
    if total == 0:
        return []

    deltas = q - p
    indices = np.argsort(-contribs)[:k]
    result = []
    for idx in indices:
        if contribs[idx] == 0:
            break
        result.append({
            "id": territory_ids[idx],
            "contribution_sq": float(contribs[idx]),
            "pct": float(contribs[idx] / total),
            "direction": "+" if deltas[idx] > 0 else "-",
        })
    return result


# ── Null model z-scores ─────────────────────────────────────────────────────

def _clamp_z(z: float) -> float:
    """Clamp a z-score to ±Z_MAX (K1 fix: never emit ±inf or NaN)."""
    if not np.isfinite(z):
        return Z_MAX if z > 0 else -Z_MAX
    return float(max(-Z_MAX, min(Z_MAX, z)))


def null_model_z(
    p: np.ndarray,
    q: np.ndarray,
    message_count: int,
    n_resamples: int = 200,
    rng: Optional[np.random.Generator] = None,
) -> Optional[float]:
    """Z-score of observed Fisher distance vs. sampling noise from a pooled null.

    Null hypothesis: both windows were drawn from the same distribution
    (the pooled distribution (p + q) / 2). Resamples n_resamples pairs
    from the pooled distribution, computes their Fisher distance, returns
    the z-score of the observed distance against that null distribution.

    Symmetric in (p, q) by construction. Returns None when message_count
    falls below N_MIN (signal not trustworthy enough to z-score). The
    returned z is always finite (clamped to ±Z_MAX — K1 audit fix).
    """
    if message_count < N_MIN:
        return None

    if rng is None:
        rng = np.random.default_rng()

    observed_ds = fisher_distance(p, q)
    pooled = (p + q) / 2.0  # symmetric null hypothesis

    null_distances = np.empty(n_resamples)
    for i in range(n_resamples):
        sample1 = rng.multinomial(message_count, pooled)
        sample2 = rng.multinomial(message_count, pooled)
        p1 = activation_vector_from_array(sample1)
        p2 = activation_vector_from_array(sample2)
        null_distances[i] = fisher_distance(p1, p2)

    null_mean = null_distances.mean()
    null_std = null_distances.std()

    if null_std < 1e-12:
        # Degenerate null (no sampling variance). K1 fix: clamp instead of inf.
        return _clamp_z(Z_MAX) if observed_ds > null_mean + 1e-12 else 0.0

    return _clamp_z((observed_ds - null_mean) / null_std)


# ── Activation entropy ──────────────────────────────────────────────────────

def activation_entropy(p: np.ndarray) -> float:
    """Shannon entropy H(t) = −Σ pᵢ log pᵢ (in nats).

    Indicator of convergence (low H = focused) vs. divergence (high H = spread).
    """
    mask = p > 0
    return -np.sum(p[mask] * np.log(p[mask]))


# ── Spectral analysis ───────────────────────────────────────────────────────

def velocity_spectrum(
    velocities: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Power spectral density of the weekly_step velocity series (FFT periodogram).

    Returns (frequencies, power) arrays. Frequencies are in cycles per week.
    Useful for detecting rhythmic patterns in cognitive movement.
    Returns empty arrays when the series is shorter than 4 weeks.
    """
    if len(velocities) < 4:
        return np.array([]), np.array([])

    v = velocities - velocities.mean()  # detrend
    n = len(v)
    fft_vals = np.fft.rfft(v)
    power = np.abs(fft_vals) ** 2 / n
    freqs = np.fft.rfftfreq(n, d=1.0)  # d=1 week → cycles per week
    return freqs[1:], power[1:]  # drop DC


def dominant_period(velocities: np.ndarray) -> Optional[float]:
    """Dominant period (in weeks) from the velocity spectrum.

    Returns None if the series is too short or no periodic structure is detected.
    """
    freqs, power = velocity_spectrum(velocities)
    if len(freqs) == 0:
        return None
    peak_idx = np.argmax(power)
    if freqs[peak_idx] == 0:
        return None
    return 1.0 / freqs[peak_idx]


# ── Convenience: full step computation ──────────────────────────────────────

@dataclass
class FisherStep:
    """Result of computing one trajectory step."""
    fisher_velocity: float = 0.0
    fisher_velocity_z: Optional[float] = None
    fisher_displacement: float = 0.0
    fisher_trajectory_length: float = 0.0
    exploration_ratio: Optional[float] = None
    phase: str = "stable"
    top_contributors: list[dict] = field(default_factory=list)
    activation_entropy: float = 0.0
    low_confidence: bool = False
    message_count: int = 0

    def to_dict(self) -> dict:
        return {
            "fisher_velocity": self.fisher_velocity,
            "fisher_velocity_z": self.fisher_velocity_z,
            "fisher_displacement": self.fisher_displacement,
            "fisher_trajectory_length": self.fisher_trajectory_length,
            "exploration_ratio": self.exploration_ratio,
            "phase": self.phase,
            "top_contributors": self.top_contributors,
            "activation_entropy": self.activation_entropy,
            "low_confidence": self.low_confidence,
            "message_count": self.message_count,
        }


def compute_step(
    p_prev: np.ndarray,
    p_curr: np.ndarray,
    p_anchor: np.ndarray,
    cumulative_L: float,
    dt_days: float,
    message_count: int,
    territory_ids: list[str],
    L_stable_threshold: float = 0.0,
    k_contributors: int = 3,
    rng: Optional[np.random.Generator] = None,
) -> FisherStep:
    """Compute all metrics for one trajectory step.

    Low-confidence semantics: when message_count < N_MIN, returns a step with
    low_confidence=True and fisher_trajectory_length forward-filled to
    cumulative_L (the previous step's total). This keeps stored L monotone
    across the trajectory — a quiet window doesn't reset the chart to zero.
    """
    step = FisherStep(message_count=message_count)
    step.activation_entropy = activation_entropy(p_curr)

    if message_count < N_MIN:
        step.low_confidence = True
        step.fisher_trajectory_length = cumulative_L  # forward-fill
        return step

    ds = fisher_distance(p_prev, p_curr)
    L = cumulative_L + ds
    D = fisher_distance(p_anchor, p_curr)
    R = exploration_ratio(D, L, L_stable_threshold)

    step.fisher_velocity = ds / dt_days if dt_days > 0 else ds
    step.fisher_velocity_z = null_model_z(p_prev, p_curr, message_count, rng=rng)
    step.fisher_trajectory_length = L
    step.fisher_displacement = D
    step.exploration_ratio = R
    step.phase = classify_phase(L, R, L_stable_threshold)
    step.top_contributors = top_contributors(p_prev, p_curr, territory_ids, k=k_contributors)

    return step


if __name__ == "__main__":
    # Smoke self-test (pure, no DB): distance bounds, phase, clamp, step shape.
    import sys
    ok = True

    def _c(name, cond):
        global ok
        ok = ok and cond
        print(f"{'PASS' if cond else 'FAIL'}  {name}")

    cats = ["a", "b", "c", "d"]
    p = np.array([0.25, 0.25, 0.25, 0.25])
    q = np.array([0.97, 0.01, 0.01, 0.01])
    _c("fisher_distance(p,p)==0", abs(fisher_distance(p, p)) < 1e-9)
    _c("fisher_distance bounded by pi", 0 < fisher_distance(p, q) <= np.pi + 1e-9)
    _c("classify_phase stable when R None", classify_phase(0.0, None) == "stable")
    _c("clamp_z(inf) finite", np.isfinite(_clamp_z(float("inf"))) and _clamp_z(float("inf")) == Z_MAX)
    rng = np.random.default_rng(seed=42)
    z = null_model_z(p, q, message_count=50, rng=rng)
    _c("null_model_z finite for confident window", z is not None and np.isfinite(z))
    _c("null_model_z None below N_MIN", null_model_z(p, q, message_count=1) is None)
    step = compute_step(p, q, p, 0.0, 7.0, 50, cats, rng=np.random.default_rng(seed=1))
    _c("compute_step populates velocity+phase", step.fisher_velocity > 0 and step.phase in
       ("stable", "cycling", "exploring", "transforming"))
    tc = top_contributors(p, q, cats)
    _c("top_contributors returns dicts with pct", len(tc) > 0 and "pct" in tc[0])
    print("=" * 56)
    print(f"VERDICT: {'GO — fisher math self-test clean' if ok else 'NO-GO'}")
    sys.exit(0 if ok else 1)
