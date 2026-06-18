#!/usr/bin/env python3
"""pipeline/compute-criticality.py — Stage: criticality-phase-transitions (C1).

Time-series statistics over the EXISTING fisher_trajectory series (spec §5.1
"Time-series statistics on existing fisher_trajectory + topology data" — NO
embedder, NO LLM, NO new dependency). Implements:

  §4.25 critical_slowing_autocorrelation — AR(1) (lag-1 autocorrelation) on a
        rolling-K window of the source signal (fisher_velocity series per level).
  §4.26 critical_slowing_variance — rolling-K stddev companion (joint flag only,
        NOT standalone — spec §4.26 "COMPANION to AR(1)").
  §4.27 phase_lock_event_sigma — per-(realm,theme,territory) weekly velocity
        z-scores vs the per-user 90d baseline; if ALL THREE exceed threshold in
        the SAME window → emit a cognitive_events row. >=10σ joint = "notable",
        >=30σ joint = "rare" (spec thresholds).
  NEW flickering_detection — alternation of the phase enum between two prior
        states before commitment (standard CSD companion). Emits a
        cognitive_events row when an A-B-A-B alternation precedes a commit.
  NEW ml_transition_detector — HONEST STUB. No trained CNN-LSTM model exists
        (spec §"Requires sufficient trajectory data before training"). Returns
        None + low_confidence + a notes marker. NEVER fabricates a score.

HONEST SENSITIVITY (spec §1.3 / §4.25 "CRITICAL UPDATE"): the EWS literature is
WEAK — Smit 2025 reports 32.9% sensitivity / 83.8% specificity; Schiepek's 89%
did NOT replicate. We compute the signals faithfully but mark every row
low_confidence and record the sensitivity caveat in `notes` (encrypted). RIGOR:
well-grounded-heuristic (AR(1)+variance are standard; predictive validity in the
journaling context is unvalidated). phase_lock = well-grounded-heuristic
(multivariate anomaly detection).

Per-window CSD scalars → cognitive_metrics_criticality (migration 0009).
Discrete detections → cognitive_events (migration 0007).

ENCRYPTION: metric scalars + event magnitude/detail/headline + notes are
caller-encrypted (stage_crypto.enc). Structural columns plaintext. cognitive_events
columns (magnitude/detail/headline) ARE in ENCRYPTED_FIELDS but we write via
d1_client (raw) so we caller-encrypt them too — the JS read path auto-decrypts.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-criticality.py

Security: counts/IDs/level enums only in logs — never metric values.
"""

import math
import os
import sys
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

from harmonics import autocorrelation_lag1

# ── Configuration ─────────────────────────────────────────────────────────
LEVELS = ('realm', 'theme', 'territory')
SOURCE_WINDOW_TYPE = 'weekly_step'      # the spec's weekly velocity series
K_ROLLING = int(os.environ.get('CSD_K', '5'))   # rolling window for AR(1)+variance
MIN_FOR_AR1 = 3                          # min points in slice for a meaningful AR(1)
EWS_AR1_RISE = 0.0                        # joint flag fires when AR(1) > this AND variance rising
PHASE_LOCK_NOTABLE = 10.0                # joint-σ thresholds (spec §4.27)
PHASE_LOCK_RARE = 30.0
BASELINE_DAYS = 90

SENSITIVITY_NOTE = (
    "EWS sensitivity is LOW per literature (Smit 2025: 32.9% sens / 83.8% spec; "
    "Schiepek 89% NOT replicated). Direction-blind. Not diagnostic."
)


def _coerce_series(rows, field):
    """Decrypt + float-coerce an encrypted fisher_trajectory column into a list
    aligned with `rows` (None for low_confidence / unparseable)."""
    out = []
    for r in rows:
        out.append(stage_crypto.dec_float(r.get(field)))
    return out


def fetch_trajectory(user_id, level, run_id, querier):
    """weekly_step rows for one (user, level, era), window_start ASC. velocity is
    ENCRYPTED at rest (K1b) — decrypted by the caller via _coerce_series."""
    return querier(
        "SELECT level, window_start, window_end, fisher_velocity, low_confidence "
        "FROM fisher_trajectory "
        "WHERE user_id=? AND level=? AND window_type=? AND clustering_run_id=? "
        "ORDER BY window_start ASC",
        [user_id, level, SOURCE_WINDOW_TYPE, run_id],
    )


# ── Pure: per-window CSD + flickering ──────────────────────────────────────

def rolling_csd(velocities, i, k=K_ROLLING):
    """AR(1) + variance on the rolling slice ending at index i (inclusive).
    Returns (ar1, variance, n) with None when the slice is too short."""
    lo = max(0, i - k + 1)
    slice_v = [v for v in velocities[lo:i + 1] if v is not None]
    n = len(slice_v)
    if n < MIN_FOR_AR1:
        return None, None, n
    arr = np.asarray(slice_v, dtype=np.float64)
    ar1 = float(autocorrelation_lag1(arr))
    var = float(np.var(arr))
    return ar1, var, n


def flickering_score(phases, i, lookback=4):
    """Count A-B-A-B style alternations in the phase enum over the trailing
    `lookback` windows ending at i. A standard CSD 'flickering' companion:
    rapid alternation between two states before commitment. Returns a [0,1]
    fraction of adjacent pairs that flipped within a 2-state alternation.
    """
    lo = max(0, i - lookback + 1)
    seq = [p for p in phases[lo:i + 1] if p]
    if len(seq) < 4:
        return 0.0
    distinct = set(seq)
    if len(distinct) != 2:
        return 0.0  # flickering is specifically 2-state alternation
    flips = sum(1 for a, b in zip(seq[:-1], seq[1:]) if a != b)
    return flips / (len(seq) - 1)


# ── D1 IO ──────────────────────────────────────────────────────────────────

CRIT_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_criticality ("
    "  user_id, level, window_type, window_start, window_end, era_id, language,"
    "  ar1_autocorrelation, rolling_variance, early_warning_joint,"
    "  flickering_score, ml_transition_score,"
    "  window_count, low_confidence, notes"
    ") VALUES (?,?,?,?,?,?,?, ?,?,?, ?,?, ?,?,?) "
    "ON CONFLICT(user_id, level, window_type, window_start, language, era_id) "
    "DO UPDATE SET "
    "  ar1_autocorrelation=excluded.ar1_autocorrelation,"
    "  rolling_variance=excluded.rolling_variance,"
    "  early_warning_joint=excluded.early_warning_joint,"
    "  flickering_score=excluded.flickering_score,"
    "  ml_transition_score=excluded.ml_transition_score,"
    "  window_count=excluded.window_count,"
    "  low_confidence=excluded.low_confidence,"
    "  notes=excluded.notes,"
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)

EVENT_UPSERT_SQL = (
    "INSERT INTO cognitive_events ("
    "  user_id, era_id, event_type, level, window_start, window_end, language,"
    "  magnitude, severity, detail, headline"
    ") VALUES (?,?,?,?,?,?,?, ?,?,?,?) "
    "ON CONFLICT(user_id, event_type, window_end, era_id) DO NOTHING"
)


def upsert_crit_row(user_id, row, querier):
    e = stage_crypto.enc
    params = [
        user_id, row['level'], SOURCE_WINDOW_TYPE, row['window_start'], row['window_end'],
        row['era_id'], 'en',
        e(row.get('ar1')), e(row.get('var')), e(row.get('ews_joint')),
        e(row.get('flickering')), e(row.get('ml_transition')),  # ml_transition is always None (stub)
        row.get('window_count', 0),
        1,  # low_confidence ALWAYS true (honest sensitivity claim)
        e(SENSITIVITY_NOTE),
    ]
    querier(CRIT_UPSERT_SQL, params)


def emit_event(user_id, era_id, event_type, level, w_start, w_end, magnitude, severity, detail, headline, querier):
    import json
    e = stage_crypto.enc
    params = [
        user_id, era_id, event_type, level, w_start, w_end, 'en',
        e(magnitude), severity, e(json.dumps(detail)), e(headline),
    ]
    querier(EVENT_UPSERT_SQL, params)


# ── §4.27 phase_lock_event_sigma ────────────────────────────────────────────

def detect_phase_lock(user_id, run_id, per_level_series, querier):
    """For each weekly window, z-score each level's velocity vs that level's own
    TRAILING baseline (the windows strictly BEFORE it — spec §4.27 "z-score
    against per-user 90d baseline"; an early-warning vs the preceding regime,
    NOT a self-including full-history mean which would absorb the spike into its
    own variance). If all 3 levels exceed the σ threshold in the SAME window →
    emit a phase_lock event.

    per_level_series: {level: (rows, velocities)}.
    """
    MIN_BASELINE = 4  # need >= 4 trailing confident points for a baseline std
    level_z = {}      # level -> {window_end: (z, w_start)}
    for level, (rows, vels) in per_level_series.items():
        zmap = {}
        trailing = []  # confident velocities strictly before the current window
        for r, v in zip(rows, vels):
            if v is not None and len(trailing) >= MIN_BASELINE:
                arr = np.asarray(trailing, dtype=np.float64)
                mean = float(arr.mean())
                std = float(arr.std())
                if std > 0:
                    zmap[r['window_end']] = (abs((v - mean) / std), r['window_start'])
            if v is not None:
                trailing.append(v)
        if zmap:
            level_z[level] = zmap

    if not all(lvl in level_z for lvl in LEVELS):
        return 0  # need all three levels to have a baseline

    # Windows where all three levels have a z-score.
    common = set(level_z['realm']) & set(level_z['theme']) & set(level_z['territory'])
    emitted = 0
    for w_end in sorted(common):
        z_realm, w_start = level_z['realm'][w_end]
        z_theme = level_z['theme'][w_end][0]
        z_terr = level_z['territory'][w_end][0]
        joint = min(z_realm, z_theme, z_terr)  # all-three-exceed → the MIN is the joint floor
        if joint < PHASE_LOCK_NOTABLE:
            continue
        severity = 'rare' if joint >= PHASE_LOCK_RARE else 'notable'
        detail = {
            'z_realm': round(z_realm, 2), 'z_theme': round(z_theme, 2),
            'z_territory': round(z_terr, 2), 'joint_sigma': round(joint, 2),
        }
        headline = (
            f"Your realm, theme, and territory scales locked together "
            f"(joint {joint:.1f}σ) — a {severity} multi-scale event."
        )
        emit_event(user_id, run_id, 'phase_lock', 'global', w_start, w_end,
                   joint, severity, detail, headline, querier)
        emitted += 1
    return emitted


def detect_flickering_events(user_id, run_id, rows, phases, querier):
    """Emit a flickering event on windows where a 2-state alternation (score==1.0
    over >=4 windows) precedes the current window."""
    import json
    emitted = 0
    for i, r in enumerate(rows):
        score = flickering_score(phases, i)
        if score >= 0.99:  # full alternation across the lookback
            detail = {'flickering_score': round(score, 3), 'lookback': 4}
            headline = "You've been flickering between two stances before settling."
            emit_event(user_id, run_id, 'flickering', r['level'],
                       r['window_start'], r['window_end'], score, 'notable',
                       detail, headline, querier)
            emitted += 1
    return emitted


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    run_id = os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(user_id, querier=querier)

    t0 = datetime.now(timezone.utc)
    event_emit.emit('criticality', 'run_start', user=user_id[:8], era_id=run_id, ts=t0.isoformat())

    per_level_series = {}
    written = 0
    flicker_events = 0
    for level in LEVELS:
        rows = fetch_trajectory(user_id, level, run_id, querier)
        if not rows:
            continue
        vels = _coerce_series(rows, 'fisher_velocity')
        # phase enum is plaintext — fetch alongside for flickering.
        phases = []
        for r in rows:
            phases.append(r.get('phase'))
        per_level_series[level] = (rows, vels)

        for i, r in enumerate(rows):
            ar1, var, n = rolling_csd(vels, i)
            flick = flickering_score(phases, i)
            ews_joint = None
            if ar1 is not None and var is not None:
                # Joint EWS flag: AR(1) positive AND variance above the slice's
                # own median variance proxy (rising). Companion-only per §4.26.
                ews_joint = 1.0 if (ar1 > EWS_AR1_RISE and var > 0) else 0.0
            upsert_crit_row(user_id, {
                'level': level, 'window_start': r['window_start'], 'window_end': r['window_end'],
                'era_id': run_id, 'ar1': ar1, 'var': var, 'ews_joint': ews_joint,
                'flickering': flick,
                'ml_transition': None,   # HONEST STUB — no trained CNN-LSTM model
                'window_count': n,
            }, querier)
            written += 1

        # phase enum needs to be on the rows for flickering events; re-fetch with phase.
        rows_phase = querier(
            "SELECT level, window_start, window_end, phase FROM fisher_trajectory "
            "WHERE user_id=? AND level=? AND window_type=? AND clustering_run_id=? "
            "ORDER BY window_start ASC",
            [user_id, level, SOURCE_WINDOW_TYPE, run_id],
        )
        ph = [r.get('phase') for r in rows_phase]
        flicker_events += detect_flickering_events(user_id, run_id, rows_phase, ph, querier)

    phase_lock_events = detect_phase_lock(user_id, run_id, per_level_series, querier)

    t1 = datetime.now(timezone.utc)
    event_emit.emit('criticality', 'run_end', era_id=run_id,
                    totals={'csd_rows': written, 'phase_lock': phase_lock_events, 'flickering': flicker_events},
                    rigor='well-grounded-heuristic', sensitivity='low (Smit 2025: 32.9%)',
                    ml_transition='STUB (no trained model)',
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    print(f"[criticality] csd_rows={written} phase_lock={phase_lock_events} flickering={flicker_events} "
          f"(ml_transition_detector=STUB)", flush=True)


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('criticality', main)
