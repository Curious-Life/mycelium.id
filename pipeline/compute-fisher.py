#!/usr/bin/env python3
"""pipeline/compute-fisher.py — Stage: fisher-trajectory (V1 port of the keystone).

Orchestrator for the Fisher Trajectory system. Reads clustering_points +
territory_profiles via the activation-extraction module, computes
information-geometry metrics with the fisher math library, upserts results into
fisher_trajectory and fisher_milestones. This is the writer that lights up the
otherwise-hollow "movement" pillar (cognitiveState movement / milestones).

Ported from canonical scripts/compute-fisher.py with the K1 audit fixes:
  * sha256 seed — canonical seeded the null-model RNG with Python's builtin
    hash(tuple), which is per-process salted (PYTHONHASHSEED) and therefore NOT
    reproducible. That silently breaks the era-skip "bit-identical recompute"
    guarantee. We seed from a stable sha256 of the window key instead.
  * clamp inf-z — handled upstream in fisher.null_model_z (±Z_MAX).
  * era-ISO run-id — make_run_id resolves CLUSTERING_RUN_ID env, else
    stage_base.derive_era_id (V1 harness already returns canonical era-<ts>).
  * V1 harness — talks to the local SQLite vault via d1_client (no Worker, no
    auth); user resolved via stage_base.get_user_id() (MYCELIUM_USER_ID).

K1a (this file): writes PLAINTEXT via d1_client. K1b adds at-rest encryption of
the sensitive fisher columns (activation_vector/top_contributors/detail/headline
+ derived numerics) via the Node bridge + decrypt-on-read in the era-skip path.

Direct invocation:
    MYCELIUM_USER_ID=<owner> MYCELIUM_DB=./data/vault.db \
      pipeline/.venv/bin/python3 pipeline/compute-fisher.py [--full]

Security:
  - All D1 writes parameterised through d1_client; no string-concat SQL.
  - No master-key access in K1a (reads only plaintext IDs + counts).
  - Never logs activation values or territory names — counts and IDs only.
"""

import hashlib
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parent.parent

import stage_base
import era_skip
import event_emit
import d1_client
from extract_activations import fetch_window_counts, list_active_categories

stage_base.load_dotenv(_REPO_ROOT)
from fisher import (
    EPSILON,
    N_MIN,
    activation_vector,
    classify_phase,
    compute_step,
    exploration_ratio,
    fisher_distance,
)

# The canonical phase enum (the only values classify_phase() can return). A row
# whose phase_recent is NULL (insufficient rolling window or a low-confidence
# step) has NO defined recent phase — it is a data gap, never a transition
# endpoint. Milestone rules below fire ONLY between two real phases so a gap can
# never surface as a phantom "cycling → indeterminate" shift.
REAL_PHASES = frozenset({"stable", "cycling", "exploring", "transforming"})


# ── Configuration ────────────────────────────────────────────────────────

MAX_HISTORY_DAYS = 10 * 365 + 10
FALLBACK_HISTORY_DAYS = 365            # used when MIN(created_at) is unavailable
HISTORY_DAYS = FALLBACK_HISTORY_DAYS   # legacy default; main() recomputes per-user

# All three hierarchy levels: Realm > Semantic Theme > Territory.
LEVELS = ('realm', 'theme', 'territory')
WINDOW_TYPES = ('daily', 'weekly_rolling', 'weekly_step', 'monthly')

# Velocity Δt is the *stride* between consecutive samples, not the window size.
DT_DAYS = {
    'daily':          1.0,
    'weekly_rolling': 1.0,
    'weekly_step':    7.0,
    'monthly':        7.0,  # 30-day window, stride 7
}

# Stride per window_type — used by k_recent() to convert R_RECENT_DAYS into a
# window count. Mirrors the strides in windows_for().
R_RECENT_STRIDES = {
    'daily':          1,
    'weekly_rolling': 1,
    'weekly_step':    7,
    'monthly':        7,
}

# Rolling-K-window R_recent replaces the degenerate cumulative R = D/L. Default
# 90 days ("last quarter"; statistically reliable for weekly_step's K=13).
R_RECENT_DAYS = int(os.environ.get('R_RECENT_DAYS', '90'))

MILESTONE_VELOCITY_Z = 3.0
MILESTONE_REPEAT_BLACKOUT_WEEKS = 2

# ── K1b: at-rest encryption of the sensitive fisher columns ───────────────
# Caller-encrypt pattern (same as nomic_embedding / SEC-4): this Python writer
# encrypts the sensitive columns via crypto_local (byte-compatible wrapped-DEK
# envelopes), the JS adapter AUTO-DECRYPTS them on read (they're NOT in
# NEVER_AUTO_DECRYPT), and Python reads here decrypt explicitly. The fisher
# tables are written ONLY by this stage, so there is no JS write that would
# double-encrypt. Structural columns (keys/time/level/window_type/phase/
# phase_recent/rule_type/phase_from/to/counts/low_confidence/scope) stay
# plaintext — fisher.js filters/sorts only on those.
_FISHER_SCOPE = 'personal'
_MASTER_KEY = None


def _master_key():
    """Lazy-load + cache the user master key (fail-closed: raises if absent)."""
    global _MASTER_KEY
    if _MASTER_KEY is None:
        from crypto_local import load_master_key
        _MASTER_KEY = load_master_key()
    return _MASTER_KEY


def _enc(value):
    """Encrypt a scalar/string sensitive value → envelope TEXT. None → None
    (NULL stays NULL).

    Numbers are serialized as a PLAIN-python-float repr. Critical: numpy 2.x
    ``repr(np.float64(x))`` is the string ``'np.float64(x)'`` (NOT ``'x'``), so a
    naive repr would poison the value — store ``float(value)`` repr, which JS
    ``Number()`` and Python ``float()`` both round-trip cleanly.
    """
    if value is None:
        return None
    from crypto_local import encrypt_str
    if isinstance(value, str):
        s = value
    else:
        try:
            s = repr(float(value))   # np.float64 / Decimal / int → plain float repr
        except (TypeError, ValueError):
            s = str(value)
    return encrypt_str(s, _FISHER_SCOPE, _master_key())


def _dec(value):
    """Decrypt an envelope → plaintext str; pass through non-envelopes (legacy
    plaintext rows written by K1a). None → None."""
    if value is None or not isinstance(value, str):
        return value
    from crypto_local import is_encrypted, decrypt_safe
    if is_encrypted(value):
        return decrypt_safe(value, _master_key())
    return value


def _dec_float(value):
    """Decrypt + coerce to float; None / unparseable → None."""
    d = _dec(value)
    if d is None:
        return None
    try:
        return float(d)
    except (TypeError, ValueError):
        return None


def k_recent(window_type: str, r_recent_days: int = R_RECENT_DAYS) -> int:
    """K most-recent windows that span ~r_recent_days of stride space (floor 2)."""
    stride = R_RECENT_STRIDES[window_type]
    return max(2, math.ceil(r_recent_days / stride))


def _window_seed(user_id: str, level: str, window_type: str, window_start: str) -> int:
    """Deterministic 32-bit RNG seed for one window (K1 sha256-seed fix).

    Replaces Python's per-process-salted ``hash(tuple)``. A stable seed is what
    makes era-skip's "a skipped row's z-score is exactly what we'd have
    computed" guarantee actually hold across processes/runs.
    """
    h = hashlib.sha256(
        f"{user_id}|{level}|{window_type}|{window_start}".encode("utf-8")
    ).digest()
    return int.from_bytes(h[:4], "big")


# ── Pure: window generation ──────────────────────────────────────────────

def windows_for(window_type: str, *, now: datetime, history_days: int = HISTORY_DAYS):
    """Yield (start, end) datetime tuples in chronological order. Pure/testable."""
    horizon = now - timedelta(days=history_days)

    if window_type == 'daily':
        d = horizon.replace(hour=0, minute=0, second=0, microsecond=0)
        while d < now:
            yield d, d + timedelta(days=1)
            d += timedelta(days=1)
        return

    if window_type == 'weekly_rolling':
        d = horizon.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=7)
        while d <= end_horizon:
            yield d, d + timedelta(days=7)
            d += timedelta(days=1)
        return

    if window_type == 'weekly_step':
        # Align to ISO week start (Monday).
        start = horizon - timedelta(days=horizon.weekday())
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=7)
        while start <= end_horizon:
            yield start, start + timedelta(days=7)
            start += timedelta(days=7)
        return

    if window_type == 'monthly':
        d = horizon.replace(hour=0, minute=0, second=0, microsecond=0)
        end_horizon = now - timedelta(days=30)
        while d <= end_horizon:
            yield d, d + timedelta(days=30)
            d += timedelta(days=7)
        return

    raise ValueError(f"unknown window_type: {window_type!r}; expected one of {WINDOW_TYPES}")


# ── Pure: milestone rules ────────────────────────────────────────────────

def count_consecutive_phase(rows: list[dict], end_idx: int, phase: str) -> int:
    """Count consecutive rows ending at end_idx with the given phase."""
    n = 0
    for j in range(end_idx, -1, -1):
        if rows[j].get('phase') == phase:
            n += 1
        else:
            break
    return n


def _recent_velocity_outlier(prev_milestones: list[dict], row: dict) -> bool:
    """Has a velocity_outlier fired within the blackout window? (anti-flap)."""
    if not prev_milestones:
        return False
    cutoff = datetime.fromisoformat(row['window_end'].replace('Z', '+00:00')) \
        - timedelta(weeks=MILESTONE_REPEAT_BLACKOUT_WEEKS)
    cutoff_iso = cutoff.isoformat()
    for m in prev_milestones:
        if m.get('rule_type') != 'velocity_outlier':
            continue
        if m.get('window_end', '') >= cutoff_iso:
            return True
    return False


def render_milestone_headline(rule_type: str, row: dict, ctx: dict) -> str:
    """Server-rendered banner copy. UI never has to know rule semantics. Pure."""
    if rule_type == 'sustained_cycling':
        n = ctx.get('weeks_in_cycling', 2)
        return f"Cycling pattern starting — {n} consecutive weeks of high movement, low net displacement."
    if rule_type == 'phase_shift':
        return f"You've moved from {ctx.get('phase_from')} into {ctx.get('phase_to')}."
    if rule_type == 'velocity_outlier':
        v = ctx.get('velocity')
        baseline = ctx.get('baseline_mean')
        if v and baseline and baseline > 0:
            ratio = v / baseline
            return f"Your movement this week is {ratio:.1f}× your typical weekly distance — major shift."
        return "Major movement this week — well above your typical weekly pace."
    if rule_type == 'displacement_crossing':
        return "You've covered exceptional ground this period — major transformation territory."
    return f"Milestone: {rule_type}"


def make_detection(rule_type: str, row: dict, context: Optional[dict] = None) -> dict:
    """Compose a detection dict from rule_type and the triggering row."""
    ctx = context or {}
    return {
        'rule_type':         rule_type,
        'level':             row.get('level', 'realm'),
        'window_start':      row['window_start'],
        'window_end':        row['window_end'],
        'phase_from':        ctx.get('phase_from'),
        'phase_to':          ctx.get('phase_to'),
        'velocity_z':        ctx.get('velocity_z'),
        'displacement':      ctx.get('displacement'),
        'detail':            ctx,
        'headline':          render_milestone_headline(rule_type, row, ctx),
        'clustering_run_id': row.get('clustering_run_id'),
    }


def apply_milestone_rules(
    rows: list[dict],
    previous_milestones: Optional[list[dict]] = None,
) -> list[dict]:
    """Apply the milestone rules to a series of weekly_step rows. Pure/testable.

    Args:
        rows: weekly_step trajectory rows for one (user, level), sorted by
            window_start ascending.
        previous_milestones: existing milestones for this user (anti-flap).
    """
    detections = []
    prev_milestones = previous_milestones or []

    # Per-user velocity baseline for velocity_outlier — pure-multinomial null
    # underestimates real-data variance. Fire when current velocity > mean +
    # 2σ of confident windows (~95th percentile).
    confident_velocities = [
        r.get('fisher_velocity') for r in rows
        if r.get('fisher_velocity') is not None and not r.get('low_confidence')
    ]
    velocity_threshold = None
    velocity_mean = None
    velocity_std = None
    if len(confident_velocities) >= 4:
        v_arr = np.array(confident_velocities, dtype=np.float64)
        velocity_mean = float(v_arr.mean())
        velocity_std = float(v_arr.std())
        velocity_threshold = velocity_mean + 2.0 * velocity_std

    for i, row in enumerate(rows):
        prev = rows[i - 1] if i >= 1 else None

        # Rule 1: sustained_cycling — fires ONCE per cycling streak, on the
        # week the streak first crosses 2 consecutive.
        if (
            prev is not None
            and row.get('phase') == 'cycling'
            and prev.get('phase') == 'cycling'
        ):
            streak = count_consecutive_phase(rows, i, 'cycling')
            if streak == 2:
                detections.append(make_detection('sustained_cycling', row, {
                    'weeks_in_cycling': streak,
                }))

        # Rule 2: phase_shift — phase changed AND prev was not low_confidence.
        # Both endpoints must be REAL phases: a transition into/out of a NULL
        # recent-phase gap (insufficient window or low_confidence) is a data
        # gap, not a cognitive shift, so it never becomes a milestone.
        if (
            prev is not None
            and row.get('phase') in REAL_PHASES
            and prev.get('phase') in REAL_PHASES
            and row.get('phase') != prev.get('phase')
            and not prev.get('low_confidence')
        ):
            detections.append(make_detection('phase_shift', row, {
                'phase_from': prev.get('phase'),
                'phase_to':   row.get('phase'),
            }))

        # Rule 3: velocity_outlier — current velocity > user's historical
        # mean + 2σ. Anti-flap: don't repeat within 2 weeks.
        v = row.get('fisher_velocity')
        if (
            velocity_threshold is not None
            and v is not None
            and not row.get('low_confidence')
            and v > velocity_threshold
            and not _recent_velocity_outlier(prev_milestones, row)
        ):
            detections.append(make_detection('velocity_outlier', row, {
                'velocity':       v,
                'velocity_z':     row.get('fisher_velocity_z'),  # kept for context
                'baseline_mean':  velocity_mean,
                'baseline_std':   velocity_std,
            }))

        # Rule 4: displacement_crossing — deferred (needs historical 90th-pct).

    return detections


# ── Side-effecting: D1 writes ────────────────────────────────────────────

TRAJECTORY_UPSERT_SQL = (
    "INSERT INTO fisher_trajectory ("
    "  user_id, level, window_type, window_start, window_end,"
    "  activation_vector, fisher_velocity, fisher_velocity_z,"
    "  fisher_displacement, fisher_trajectory_length, exploration_ratio,"
    "  phase, activation_entropy, top_contributors,"
    "  message_count, active_territory_count, clustering_run_id, low_confidence,"
    "  R_recent, phase_recent"
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(user_id, level, window_type, window_start, clustering_run_id) "
    "DO UPDATE SET "
    "  window_end = excluded.window_end, "
    "  activation_vector = excluded.activation_vector, "
    "  fisher_velocity = excluded.fisher_velocity, "
    "  fisher_velocity_z = excluded.fisher_velocity_z, "
    "  fisher_displacement = excluded.fisher_displacement, "
    "  fisher_trajectory_length = excluded.fisher_trajectory_length, "
    "  exploration_ratio = excluded.exploration_ratio, "
    "  phase = excluded.phase, "
    "  activation_entropy = excluded.activation_entropy, "
    "  top_contributors = excluded.top_contributors, "
    "  message_count = excluded.message_count, "
    "  active_territory_count = excluded.active_territory_count, "
    "  low_confidence = excluded.low_confidence, "
    "  R_recent = excluded.R_recent, "
    "  phase_recent = excluded.phase_recent, "
    "  computed_at = datetime('now')"
)

# Milestones are write-once (idempotent dedup). DO NOTHING on conflict.
MILESTONE_UPSERT_SQL = (
    "INSERT INTO fisher_milestones ("
    "  user_id, rule_type, level, window_start, window_end, "
    "  phase_from, phase_to, velocity_z, displacement, "
    "  detail, headline, clustering_run_id"
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(user_id, rule_type, level, window_start, clustering_run_id) "
    "DO NOTHING"
)


def upsert_trajectory_row(user_id: str, row: dict, querier) -> None:
    # K1b: encrypt the sensitive columns (cognitive distribution + derived
    # metrics). Structural columns (level/window_type/window_start/window_end/
    # phase/phase_recent/counts/low_confidence/run_id) stay plaintext.
    params = [
        user_id, row['level'], row['window_type'],
        row['window_start'], row['window_end'],
        _enc(json.dumps(row['activation_vector'])),
        _enc(row.get('fisher_velocity')), _enc(row.get('fisher_velocity_z')),
        _enc(row.get('fisher_displacement')), _enc(row.get('fisher_trajectory_length')),
        _enc(row.get('exploration_ratio')), row.get('phase'),
        _enc(row.get('activation_entropy')),
        _enc(json.dumps(row.get('top_contributors') or [])),
        row['message_count'], row['active_territory_count'],
        row['clustering_run_id'],
        1 if row.get('low_confidence') else 0,
        _enc(row.get('R_recent')), row.get('phase_recent'),
    ]
    querier(TRAJECTORY_UPSERT_SQL, params)


def upsert_milestone_row(user_id: str, detection: dict, querier) -> None:
    # K1b: encrypt detail/headline (content) + velocity_z/displacement (metrics).
    # rule_type/level/phase_from/phase_to/windows/run_id stay plaintext.
    params = [
        user_id, detection['rule_type'], detection['level'],
        detection['window_start'], detection['window_end'],
        detection.get('phase_from'), detection.get('phase_to'),
        _enc(detection.get('velocity_z')), _enc(detection.get('displacement')),
        _enc(json.dumps(detection.get('detail') or {})),
        _enc(detection['headline']),
        detection['clustering_run_id'],
    ]
    querier(MILESTONE_UPSERT_SQL, params)


def fetch_existing_milestones(user_id: str, run_id: str, querier) -> list[dict]:
    """Existing milestones for this run (anti-flap source)."""
    rows = querier(
        "SELECT rule_type, level, window_start, window_end, detail "
        "FROM fisher_milestones WHERE user_id = ? AND clustering_run_id = ?",
        [user_id, run_id],
    )
    for r in rows:
        if r.get('detail'):
            try:
                r['detail'] = json.loads(_dec(r['detail']))  # K1b: decrypt then parse
            except (json.JSONDecodeError, TypeError):
                r['detail'] = {}
    return rows


def fetch_existing_window_states(
    user_id: str,
    level: str,
    window_type: str,
    run_id: str,
    querier,
) -> dict:
    """Map window_start_iso → stored state for windows already computed in this era.

    Powers the skip-existing optimization: within an era (= one cluster run),
    Fisher rows are immutable because cluster.py rewrites all clustering_points
    atomically per run. The per-window sha256 seed makes any recompute
    bit-identical, so skipping is purely a cost optimization.

    Adapter over era_skip.fetch_existing_keys (with extra_filters for
    level+window_type — window_start alone collides across levels). Parses
    activation_vector JSON → p_dict, coerces low_confidence to bool, drops
    unparseable rows (→ recompute).

    NOTE (K1b): once fisher_trajectory's activation_vector + fisher_trajectory_length
    are encrypted at rest, this adapter must decrypt them before json.loads /
    float() (they come back as envelope strings). K1a reads plaintext.
    """
    raw = era_skip.fetch_existing_keys(
        querier,
        table='fisher_trajectory',
        user_id=user_id,
        run_id=run_id,
        key_columns=['window_start'],
        return_columns=['activation_vector', 'fisher_trajectory_length',
                        'message_count', 'active_territory_count', 'low_confidence'],
        extra_filters={'level': level, 'window_type': window_type},
    )
    out: dict = {}
    for (window_start,), values in raw.items():
        try:
            # K1b: activation_vector + fisher_trajectory_length are encrypted at
            # rest — decrypt before parse/float (_dec passes through legacy
            # plaintext rows, so a mixed K1a/K1b table still loads).
            p_dict = json.loads(_dec(values['activation_vector']))
        except (json.JSONDecodeError, TypeError, KeyError):
            continue
        out[window_start] = {
            'p_dict':                 p_dict,
            'fisher_trajectory_length': _dec_float(values.get('fisher_trajectory_length')),
            'message_count':          values.get('message_count') or 0,
            'active_territory_count': values.get('active_territory_count') or 0,
            'low_confidence':         bool(values.get('low_confidence')),
        }
    return out


# ── Orchestration ────────────────────────────────────────────────────────

def run_level_window(
    user_id: str,
    level: str,
    window_type: str,
    run_id: str,
    *,
    now: Optional[datetime] = None,
    history_days: int = HISTORY_DAYS,
    querier=None,
    force_full: bool = False,
) -> dict:
    """Compute and upsert trajectory for one (level, window_type).

    Era-mode (default): skip windows that already have a row for
    (user_id, level, window_type, run_id). force_full=True overrides it.
    Returns: {'written': int, 'skipped': int}.
    """
    now = now or datetime.now(timezone.utc).replace(microsecond=0)
    querier = querier or d1_client.query

    categories = list_active_categories(user_id, level, querier=querier)
    if not categories:
        print(f"[fisher] {level}/{window_type}: no active categories, skipping", flush=True)
        return {'written': 0, 'skipped': 0}

    existing = (
        {} if force_full
        else fetch_existing_window_states(user_id, level, window_type, run_id, querier)
    )

    # Build the activation series. Stored windows reuse their activation_vector;
    # new windows fetch counts from clustering_points.
    series: list[dict] = []
    for ws, we in windows_for(window_type, now=now, history_days=history_days):
        ws_iso, we_iso = ws.isoformat(), we.isoformat()
        stored = existing.get(ws_iso)
        if stored is not None:
            series.append({
                'window_start':           ws_iso,
                'window_end':             we_iso,
                'p_dict':                 stored['p_dict'],
                'message_count':          stored['message_count'],
                'active_territory_count': stored['active_territory_count'],
                'is_skipped':             True,
                'stored_L':               stored['fisher_trajectory_length'],
            })
        else:
            counts = fetch_window_counts(user_id, level, ws_iso, we_iso, querier=querier)
            msg_count = sum(counts.values())
            active_count = sum(1 for v in counts.values() if v > 0)
            p_dict = activation_vector(counts, categories, EPSILON)
            series.append({
                'window_start':           ws_iso,
                'window_end':             we_iso,
                'p_dict':                 p_dict,
                'message_count':          msg_count,
                'active_territory_count': active_count,
                'is_skipped':             False,
            })

    if len(series) < 2:
        print(f"[fisher] {level}/{window_type}: insufficient windows ({len(series)})", flush=True)
        return {'written': 0, 'skipped': 0}

    # Anchor: first window with sufficient messages, else first window.
    anchor_idx = next(
        (i for i, w in enumerate(series) if w['message_count'] >= N_MIN),
        0,
    )
    anchor = np.array([series[anchor_idx]['p_dict'][c] for c in categories])

    cumulative_L = 0.0
    written = 0
    skipped = 0
    dt_days = DT_DAYS[window_type]

    for i, window in enumerate(series):
        if window['is_skipped']:
            # Stored fisher_trajectory_length already reflects cumulative L AS OF
            # this window (compute_step forward-fills low_confidence windows).
            stored_L = window['stored_L']
            if stored_L is not None:
                cumulative_L = float(stored_L)
            skipped += 1
            continue

        p_curr = np.array([window['p_dict'][c] for c in categories])
        p_prev = (
            np.array([series[i - 1]['p_dict'][c] for c in categories])
            if i > 0
            else p_curr
        )

        # Per-window deterministic RNG seed (K1 sha256-seed fix).
        rng = np.random.default_rng(
            seed=_window_seed(user_id, level, window_type, window['window_start'])
        )

        step = compute_step(
            p_prev=p_prev,
            p_curr=p_curr,
            p_anchor=anchor,
            cumulative_L=cumulative_L,
            dt_days=dt_days,
            message_count=window['message_count'],
            territory_ids=categories,
            rng=rng,
        )
        if not step.low_confidence:
            cumulative_L = step.fisher_trajectory_length

        # Rolling-K-window R_recent + phase_recent (replaces degenerate
        # cumulative R = D/L). Only the CURRENT window's low_confidence forces
        # R_recent=None.
        K_recent = k_recent(window_type, R_RECENT_DAYS)
        if i + 1 < K_recent or step.low_confidence:
            # Insufficient rolling window OR low-confidence step → there is no
            # confident recent classification. Store NULL (mirrors R_recent),
            # NOT a sentinel string: phase_recent's enum stays exactly
            # {stable,cycling,exploring,transforming}. A prior bug wrote the
            # phantom 'indeterminate' here, which then leaked into milestones
            # as "cycling → indeterminate" phase-shifts (METRICS-AUDIT
            # 2026-06-19 live-probe #1).
            r_recent_val = None
            phase_recent_val = None
        else:
            k_slice = series[i - K_recent + 1 : i + 1]
            p_first_K = np.array([k_slice[0]['p_dict'][c] for c in categories])
            p_last_K  = np.array([k_slice[-1]['p_dict'][c] for c in categories])
            D_K = fisher_distance(p_first_K, p_last_K)
            L_K = 0.0
            for j in range(1, len(k_slice)):
                p_prev_j = np.array([k_slice[j - 1]['p_dict'][c] for c in categories])
                p_curr_j = np.array([k_slice[j]    ['p_dict'][c] for c in categories])
                L_K += fisher_distance(p_prev_j, p_curr_j)
            r_recent_val = exploration_ratio(D_K, L_K)
            phase_recent_val = classify_phase(L_K, r_recent_val)

        upsert_trajectory_row(user_id, {
            'level':                  level,
            'window_type':            window_type,
            'window_start':           window['window_start'],
            'window_end':             window['window_end'],
            'activation_vector':      window['p_dict'],
            'fisher_velocity':        step.fisher_velocity,
            'fisher_velocity_z':      step.fisher_velocity_z,
            'fisher_displacement':    step.fisher_displacement,
            'fisher_trajectory_length': step.fisher_trajectory_length,
            'exploration_ratio':      step.exploration_ratio,
            'phase':                  step.phase,
            'activation_entropy':     step.activation_entropy,
            'top_contributors':       step.top_contributors,
            'message_count':          step.message_count,
            'active_territory_count': window['active_territory_count'],
            'clustering_run_id':      run_id,
            'low_confidence':         step.low_confidence,
            'R_recent':               r_recent_val,
            'phase_recent':           phase_recent_val,
        }, querier)
        written += 1

    print(f"[fisher] {level}/{window_type}: wrote {written}, skipped {skipped}", flush=True)
    return {'written': written, 'skipped': skipped}


def detect_milestones(user_id: str, run_id: str, querier=None) -> int:
    """Scan weekly_step realm rows for this run; upsert new milestones.

    Uses phase_recent (rolling 90-day) as the authoritative phase signal —
    NOT COALESCE(phase_recent, phase). detect_milestones only ever sees rows
    from the CURRENT run, which always writes phase_recent (a real phase, or
    NULL when there is no confident recent classification). Reviving the
    degenerate cumulative `phase` for a NULL row would resurrect spurious
    transitions; a NULL phase_recent must stay a gap (see REAL_PHASES gate).
    """
    querier = querier or d1_client.query

    rows = querier(
        "SELECT level, window_start, window_end, "
        "       phase_recent AS phase, "
        "       fisher_velocity_z, low_confidence, clustering_run_id "
        "FROM fisher_trajectory "
        "WHERE user_id = ? AND level = 'realm' AND window_type = 'weekly_step' "
        "  AND clustering_run_id = ? "
        "ORDER BY window_start",
        [user_id, run_id],
    )
    if not rows:
        return 0

    # SQLite stores boolean as integer; hydrate. K1b: fisher_velocity_z is
    # encrypted at rest — decrypt + coerce to float (used as milestone context).
    for r in rows:
        r['low_confidence'] = bool(r.get('low_confidence'))
        r['fisher_velocity_z'] = _dec_float(r.get('fisher_velocity_z'))

    existing = fetch_existing_milestones(user_id, run_id, querier)
    detections = apply_milestone_rules(rows, previous_milestones=existing)

    for d in detections:
        upsert_milestone_row(user_id, d, querier)

    print(f"[fisher] milestones: detected {len(detections)}", flush=True)
    return len(detections)


# ── CLI entry point ──────────────────────────────────────────────────────

def make_run_id(user_id: str, *, querier=None) -> str:
    """Stable per-run identifier.

    Resolution: CLUSTERING_RUN_ID env (canonical, injected by run-clustering.sh)
    → stage_base.derive_era_id(user_id) (V1 harness; always returns era-<ts> or
    era-bootstrap-<date> — satisfies the era-ISO run-id requirement).
    """
    return os.environ.get('CLUSTERING_RUN_ID') or stage_base.derive_era_id(
        user_id, querier=querier,
    )


def detect_history_days(user_id: str, querier=None) -> int:
    """Days from the user's earliest clustering_point to now, capped at MAX."""
    querier = querier or d1_client.query
    try:
        rows = querier(
            "SELECT MIN(created_at) AS first FROM clustering_points "
            "WHERE user_id = ? AND created_at IS NOT NULL",
            [user_id],
        )
    except Exception:
        return FALLBACK_HISTORY_DAYS

    first_str = (rows[0] or {}).get('first') if rows else None
    if not first_str:
        return FALLBACK_HISTORY_DAYS

    # clustering_points.created_at appears in several historical formats:
    #   "2018-06-26 21:33:13 UTC" | "2026-04-20T00:00:00+00:00" | "...Z"
    iso = first_str.strip()
    if iso.endswith(' UTC'):
        iso = iso[:-4]
    elif iso.endswith('UTC'):
        iso = iso[:-3]
    iso = iso.strip().replace(' ', 'T')
    if iso.endswith('Z'):
        iso = iso[:-1] + '+00:00'
    has_offset = (
        iso.endswith('+00:00')
        or (len(iso) >= 6 and iso[-6] in ('+', '-') and iso[-3] == ':')
    )
    if not has_offset:
        iso = iso + '+00:00'

    try:
        first = datetime.fromisoformat(iso)
    except ValueError:
        return FALLBACK_HISTORY_DAYS

    delta = datetime.now(timezone.utc) - first
    days = max(int(delta.days) + 7, FALLBACK_HISTORY_DAYS)  # 7-day buffer for window edges
    return min(days, MAX_HISTORY_DAYS)


def main() -> None:
    # V1 single-user: resolve owner via the shared harness (MYCELIUM_USER_ID →
    # MYA_USER_ID → 'local-user'). Mirrors compute_information_harmonics.py.
    user_id = stage_base.get_user_id()
    if not user_id:
        print("[fisher] FATAL: could not resolve user id (fail-closed)", file=sys.stderr)
        sys.exit(1)

    force_full = (
        '--full' in sys.argv[1:]
        or os.environ.get('FISHER_FORCE_FULL') == '1'
    )

    run_id = make_run_id(user_id)
    history_days = detect_history_days(user_id)
    mode_label = 'FULL recompute' if force_full else 'era-mode (skip existing)'

    print(f"[fisher] user={user_id[:8]} run={run_id} history={history_days}d mode={mode_label}",
          flush=True)

    t0 = datetime.now(timezone.utc)
    event_emit.emit(
        'fisher', 'run_start',
        user=user_id[:8],
        era_id=run_id,
        history_days=history_days,
        force_full=force_full,
        ts=t0.isoformat(),
    )

    total_written = 0
    total_skipped = 0
    by_window_type: dict = {}
    for level in LEVELS:
        for window_type in WINDOW_TYPES:
            try:
                result = run_level_window(
                    user_id, level, window_type, run_id,
                    history_days=history_days,
                    force_full=force_full,
                )
            except Exception as e:
                msg = str(e).split('\n', 1)[0][:200]
                print(f"[fisher] ERROR in {level}/{window_type}: {msg}", file=sys.stderr)
                raise  # fail-closed
            total_written += result['written']
            total_skipped += result['skipped']
            by_window_type.setdefault(window_type, {'written': 0, 'skipped': 0})
            by_window_type[window_type]['written'] += result['written']
            by_window_type[window_type]['skipped'] += result['skipped']

    milestones_detected = detect_milestones(user_id, run_id)

    t1 = datetime.now(timezone.utc)
    event_emit.emit(
        'fisher', 'run_end',
        era_id=run_id,
        force_full=force_full,
        totals={'written': total_written, 'skipped': total_skipped},
        by_window_type=by_window_type,
        milestones_detected=milestones_detected,
        duration_ms=int((t1 - t0).total_seconds() * 1000),
    )
    print(f"[fisher] total: wrote {total_written}, skipped {total_skipped}", flush=True)


if __name__ == '__main__':
    import stage_result
    stage_result.run_main('fisher-trajectory', main)
