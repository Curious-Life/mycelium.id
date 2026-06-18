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


BEHAV_UPSERT_SQL = (
    "INSERT INTO cognitive_metrics_behavioral ("
    "  user_id, window_end, era_id, language,"
    "  diurnal_entropy, diurnal_peak_hour, diurnal_concentration, diurnal_hist,"
    "  session_count, intersession_entropy, intersession_cv,"
    "  message_count, low_confidence, notes"
    ") VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?) "
    "ON CONFLICT(user_id, window_end, language, era_id) "
    "DO UPDATE SET "
    "  diurnal_entropy=excluded.diurnal_entropy,"
    "  diurnal_peak_hour=excluded.diurnal_peak_hour,"
    "  diurnal_concentration=excluded.diurnal_concentration,"
    "  diurnal_hist=excluded.diurnal_hist,"
    "  session_count=excluded.session_count,"
    "  intersession_entropy=excluded.intersession_entropy,"
    "  intersession_cv=excluded.intersession_cv,"
    "  message_count=excluded.message_count,"
    "  low_confidence=excluded.low_confidence,"
    "  notes=excluded.notes,"
    "  computed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
)

NOTE = "Tier-0 behavioral descriptor (timestamps only). Circadian/cadence links are literature, not diagnostic."


def upsert_row(user_id, window_end_iso, run_id, d, c, message_count, querier):
    e = stage_crypto.enc
    params = [
        user_id, window_end_iso, run_id, 'en',
        e(d['diurnal_entropy']), e(d['diurnal_peak_hour']), e(d['diurnal_concentration']),
        e(json.dumps(d['diurnal_hist'])),
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
    last_iso = None
    for r in rows:
        iso = r.get('created_at')
        if not iso:
            continue
        try:
            _s = str(iso).strip().replace(' UTC', '').replace(' utc', '').replace('Z', '+00:00').strip()
            if 'T' not in _s and ' ' in _s:
                _s = _s.replace(' ', 'T', 1)
            dt = datetime.fromisoformat(_s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            continue
        ts_unix.append(dt.timestamp())
        hours.append(dt.hour)
        last_iso = iso
    if len(ts_unix) < MIN_MESSAGES:
        event_emit.emit('behavioral', 'run_end', era_id=run_id, totals={'computed': 0},
                        reason='unparseable-timestamps')
        return

    ts_arr = np.asarray(ts_unix, dtype=np.float64)
    hr_arr = np.asarray(hours, dtype=np.int64)
    d = diurnal_metrics(hr_arr)
    c = session_cadence(ts_arr)

    window_end_iso = datetime.now(timezone.utc).isoformat()
    upsert_row(user_id, window_end_iso, run_id, d, c, len(ts_unix), querier)

    t1 = datetime.now(timezone.utc)
    event_emit.emit('behavioral', 'run_end', era_id=run_id, totals={'computed': 1},
                    rigor='well-grounded-heuristic',
                    duration_ms=int((t1 - t0).total_seconds() * 1000))
    # Log structural counts only — session_count is declared sensitive (reveals
    # cadence) + encrypted at rest, so it must not leak to stage logs.
    print(f"[behavioral] computed 1 row (messages={len(ts_unix)})", flush=True)


if __name__ == '__main__':
    main()
