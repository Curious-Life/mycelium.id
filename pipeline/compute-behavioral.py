#!/usr/bin/env python3
"""pipeline/compute-behavioral.py — Stage: behavioral-temporal (Tier-0).

Cheapest family in the battery: computes from messages.created_at timestamps
ONLY — NO content, NO embeddings, NO decryption, NO embedder, NO LLM, NO new
dependency. Implements (spec §3.4 #12/#13, lines ~700-710):

  diurnal_pattern_metrics — time-of-day writing volume distribution. A 24-bin
        histogram of message counts by local-hour-of-day (UTC; per-user TZ is a
        future refinement), plus its Shannon entropy (normalized), peak hour, and
        concentration (1 - normalized entropy = peakiness). Clinically informative
        (circadian disruption ↔ mood episodes) but NOT diagnostic here.
        RIGOR: well-grounded-heuristic (descriptive statistic; the clinical link
        is literature, not validated in this context).

  session_cadence_regularity — entropy of inter-session intervals. Sessions are
        derived by splitting the timestamp stream on gaps > SESSION_GAP_MIN. The
        Shannon entropy of the inter-session-interval distribution (and its
        coefficient of variation) measures cadence regularity: low entropy =
        routine/stability; high = disruption. RIGOR: well-grounded-heuristic.

One row per era summarizing the whole history → cognitive_metrics_behavioral
(migration 0009). (Diurnal + cadence are whole-history descriptors; no per-window
grain needed for Tier-0.)

ENCRYPTION: every scalar + the 24-bin histogram JSON + notes are caller-encrypted
(stage_crypto.enc) — they reveal the user's circadian rhythm / routine, which is
sensitive. Structural columns (user_id, window_end, era_id, language, counts,
low_confidence) stay plaintext.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      USER_MASTER=<hex> SYSTEM_KEY=<hex> \
      pipeline/.venv/bin/python3 pipeline/compute-behavioral.py

Security: counts only in logs — never the histogram or the entropy values.
"""

import json
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
import stage_time

stage_base.load_dotenv(_REPO_ROOT)

# Inter-session gap threshold (minutes). A gap longer than this starts a new
# "session". 30 min is a common journaling/behavioral default.
SESSION_GAP_MIN = int(os.environ.get('SESSION_GAP_MIN', '30'))
MIN_MESSAGES = 4


def _shannon_entropy_normalized(counts: np.ndarray) -> float:
    """Shannon entropy of a count vector, normalized to [0,1] by log(k) where k
    is the number of non-empty bins. 0 = fully concentrated, 1 = uniform."""
    total = float(counts.sum())
    if total <= 0:
        return 0.0
    p = counts[counts > 0] / total
    if p.size <= 1:
        return 0.0
    h = -float(np.sum(p * np.log(p)))
    return float(h / math.log(p.size)) if p.size > 1 else 0.0


def diurnal_metrics(hours: np.ndarray) -> dict:
    """24-bin volume histogram + entropy/peak/concentration from hour-of-day ints."""
    hist = np.zeros(24, dtype=np.float64)
    for h in hours:
        hist[int(h) % 24] += 1.0
    entropy = _shannon_entropy_normalized(hist)
    peak_hour = float(int(np.argmax(hist)))
    concentration = 1.0 - entropy
    return {
        'diurnal_hist': hist.astype(int).tolist(),
        'diurnal_entropy': entropy,
        'diurnal_peak_hour': peak_hour,
        'diurnal_concentration': concentration,
    }


def session_cadence(timestamps_unix: np.ndarray) -> dict:
    """Split into sessions on gaps > SESSION_GAP_MIN; entropy + CV of the
    inter-session interval distribution."""
    ts = np.sort(timestamps_unix)
    gap_s = SESSION_GAP_MIN * 60.0
    # Session boundaries: a new session starts whenever the gap exceeds the threshold.
    diffs = np.diff(ts)
    session_starts = [ts[0]]
    for i, d in enumerate(diffs):
        if d > gap_s:
            session_starts.append(ts[i + 1])
    session_starts = np.asarray(session_starts, dtype=np.float64)
    n_sessions = int(session_starts.size)
    if n_sessions < 2:
        return {'session_count': float(n_sessions), 'intersession_entropy': None, 'intersession_cv': None}
    intervals = np.diff(session_starts)  # seconds between session starts
    intervals = intervals[intervals > 0]
    if intervals.size < 2:
        return {'session_count': float(n_sessions), 'intersession_entropy': None, 'intersession_cv': None}
    # Entropy over a log-spaced histogram of intervals (cadence regularity).
    log_iv = np.log(intervals)
    bins = max(2, min(12, intervals.size))
    counts, _ = np.histogram(log_iv, bins=bins)
    entropy = _shannon_entropy_normalized(counts.astype(np.float64))
    mean = float(intervals.mean())
    std = float(intervals.std())
    cv = float(std / mean) if mean > 0 else None
    return {'session_count': float(n_sessions), 'intersession_entropy': entropy, 'intersession_cv': cv}


def weekday_metrics(weekdays: np.ndarray, hours: np.ndarray) -> dict:
    """7-bin weekday volume histogram (0=Mon..6=Sun), a 7×24 weekday×hour matrix
    (the heat-map), the modal weekday, and weekday concentration (1 - entropy)."""
    whist = np.zeros(7, dtype=np.float64)
    matrix = np.zeros((7, 24), dtype=np.float64)
    for wd, h in zip(weekdays, hours):
        wd_i = int(wd) % 7
        whist[wd_i] += 1.0
        matrix[wd_i, int(h) % 24] += 1.0
    entropy = _shannon_entropy_normalized(whist)
    peak_weekday = float(int(np.argmax(whist)))
    concentration = 1.0 - entropy
    return {
        'weekday_hist': whist.astype(int).tolist(),
        'weekday_hour_hist': matrix.astype(int).tolist(),
        'peak_weekday': peak_weekday,
        'weekday_concentration': concentration,
    }


def activity_cycles(timestamps_unix: np.ndarray) -> dict:
    """Find repeating rhythms in WHEN the user writes. Bins timestamps into a daily
    volume series spanning the whole history, then takes the (biased) autocorrelation
    at each lag; the lag with the largest positive autocorrelation is the dominant
    cycle, its value the strength [0..1]. Also reports the 7-day (weekly) strength
    specifically — the most interpretable rhythm. Descriptive, never diagnostic."""
    none = {'dominant_cycle_days': None, 'dominant_cycle_strength': None, 'weekly_cycle_strength': None}
    if timestamps_unix.size < MIN_MESSAGES:
        return none
    ts = np.sort(timestamps_unix)
    day0 = math.floor(ts[0] / 86400.0)
    day_idx = (np.floor(ts / 86400.0) - day0).astype(int)
    span_days = int(day_idx[-1]) + 1
    # Need at least ~2 weeks of span for any cycle to be meaningful.
    if span_days < 14:
        return none
    series = np.zeros(span_days, dtype=np.float64)
    for d in day_idx:
        series[d] += 1.0
    y = series - series.mean()
    denom = float(np.sum(y * y))
    if denom <= 0:
        return none

    def acf(lag: int) -> float:
        if lag <= 0 or lag >= y.size:
            return 0.0
        return float(np.sum(y[lag:] * y[:-lag]) / denom)

    # Search lags from 2 days up to half the span (cap 60d) for the strongest peak.
    max_lag = min(span_days // 2, 60)
    best_lag, best_val = None, 0.0
    for lag in range(2, max_lag + 1):
        v = acf(lag)
        if v > best_val:
            best_val, best_lag = v, lag
    weekly = acf(7) if span_days > 7 else None
    return {
        'dominant_cycle_days': float(best_lag) if best_lag else None,
        'dominant_cycle_strength': max(0.0, min(1.0, best_val)) if best_lag else None,
        'weekly_cycle_strength': (max(0.0, min(1.0, weekly)) if weekly is not None else None),
    }


BEHAV_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_behavioral ("
    "  user_id, window_end, era_id, language,"
    "  diurnal_entropy, diurnal_peak_hour, diurnal_concentration, diurnal_hist,"
    "  weekday_hist, weekday_hour_hist, peak_weekday, weekday_concentration,"
    "  dominant_cycle_days, dominant_cycle_strength, weekly_cycle_strength,"
    "  session_count, intersession_entropy, intersession_cv,"
    "  message_count, low_confidence, notes"
    ") VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?) "
    "ON CONFLICT(user_id, window_end, language, era_id) "
    "DO UPDATE SET "
    "  diurnal_entropy=excluded.diurnal_entropy,"
    "  diurnal_peak_hour=excluded.diurnal_peak_hour,"
    "  diurnal_concentration=excluded.diurnal_concentration,"
    "  diurnal_hist=excluded.diurnal_hist,"
    "  weekday_hist=excluded.weekday_hist,"
    "  weekday_hour_hist=excluded.weekday_hour_hist,"
    "  peak_weekday=excluded.peak_weekday,"
    "  weekday_concentration=excluded.weekday_concentration,"
    "  dominant_cycle_days=excluded.dominant_cycle_days,"
    "  dominant_cycle_strength=excluded.dominant_cycle_strength,"
    "  weekly_cycle_strength=excluded.weekly_cycle_strength,"
    "  session_count=excluded.session_count,"
    "  intersession_entropy=excluded.intersession_entropy,"
    "  intersession_cv=excluded.intersession_cv,"
    "  message_count=excluded.message_count,"
    "  low_confidence=excluded.low_confidence,"
    "  notes=excluded.notes,"
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)

NOTE = "Tier-0 behavioral descriptor (timestamps only). Circadian/cadence links are literature, not diagnostic."


def upsert_row(user_id, window_end_iso, run_id, d, w, cyc, c, message_count, querier):
    e = stage_crypto.enc
    params = [
        user_id, window_end_iso, run_id, 'en',
        e(d['diurnal_entropy']), e(d['diurnal_peak_hour']), e(d['diurnal_concentration']),
        e(json.dumps(d['diurnal_hist'])),
        e(json.dumps(w['weekday_hist'])), e(json.dumps(w['weekday_hour_hist'])),
        e(w['peak_weekday']), e(w['weekday_concentration']),
        e(cyc['dominant_cycle_days']), e(cyc['dominant_cycle_strength']), e(cyc['weekly_cycle_strength']),
        e(c['session_count']), e(c['intersession_entropy']), e(c['intersession_cv']),
        message_count, 1, e(NOTE),
    ]
    querier(BEHAV_UPSERT_SQL, params)


def fetch_timestamps(user_id, querier):
    """All message created_at (any message; no embedding requirement — Tier-0)."""
    return querier(
        "SELECT created_at FROM messages WHERE user_id=? AND created_at IS NOT NULL "
        "ORDER BY created_at ASC",
        [user_id],
    )


def main(querier=None):
    querier = querier or d1_client.query
    user_id = stage_base.get_user_id()
    run_id = os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(user_id, querier=querier)

    t0 = datetime.now(timezone.utc)
    event_emit.emit('behavioral', 'run_start', user=user_id[:8], era_id=run_id, ts=t0.isoformat())

    rows = fetch_timestamps(user_id, querier)
    if len(rows) < MIN_MESSAGES:
        event_emit.emit('behavioral', 'run_end', era_id=run_id, totals={'computed': 0},
                        reason='insufficient-data')
        print(f"[behavioral] insufficient messages ({len(rows)})", flush=True)
        return

    ts_unix = []
    hours = []
    weekdays = []
    candidates = 0  # rows that carried a non-empty created_at (parseable or not)
    for r in rows:
        iso = r.get('created_at')
        if iso is None or iso == '':
            continue
        candidates += 1
        # Shared, format-tolerant parse (ISO/naive/epoch-s/epoch-ms). The old inline
        # fromisoformat parse silently dropped epoch-millis timestamps ("1756…000"),
        # which some import sources store — a whole vault in that format produced zero
        # rows and a blank Routine surface. stage_time.parse_utc handles them all.
        dt = stage_time.parse_utc(iso)
        if dt is None:
            continue
        ts_unix.append(dt.timestamp())
        hours.append(dt.hour)
        weekdays.append(dt.weekday())  # 0=Mon .. 6=Sun
    if len(ts_unix) < MIN_MESSAGES:
        # Fail-loud, never silent: distinguish "genuinely little activity" from "we HAD
        # timestamps but couldn't parse them" (a format regression) so the latter is a
        # countable, visible signal instead of a silently empty Routine surface.
        low_parse = candidates >= MIN_MESSAGES and not stage_time.parse_rate_ok(len(ts_unix), candidates)
        if low_parse:
            print(f"[behavioral] WARNING: only {len(ts_unix)}/{candidates} created_at parsed "
                  f"(<50%) — created_at format not recognised; wrote no row", file=sys.stderr, flush=True)
        event_emit.emit('behavioral', 'run_end', era_id=run_id, totals={'computed': 0},
                        reason=('unparseable-timestamps' if candidates >= MIN_MESSAGES else 'insufficient-data'),
                        parsed=len(ts_unix), candidates=candidates)
        return

    ts_arr = np.asarray(ts_unix, dtype=np.float64)
    hr_arr = np.asarray(hours, dtype=np.int64)
    wd_arr = np.asarray(weekdays, dtype=np.int64)
    d = diurnal_metrics(hr_arr)
    w = weekday_metrics(wd_arr, hr_arr)
    cyc = activity_cycles(ts_arr)
    c = session_cadence(ts_arr)

    window_end_iso = datetime.now(timezone.utc).isoformat()
    upsert_row(user_id, window_end_iso, run_id, d, w, cyc, c, len(ts_unix), querier)

    t1 = datetime.now(timezone.utc)
    event_emit.emit('behavioral', 'run_end', era_id=run_id, totals={'computed': 1},
                    rigor='well-grounded-heuristic',
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    # Log structural counts only — session_count is declared sensitive (reveals
    # cadence) + encrypted at rest, so it must not leak to stage logs.
    print(f"[behavioral] computed 1 row (messages={len(ts_unix)})", flush=True)


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('compute-behavioral', main)
