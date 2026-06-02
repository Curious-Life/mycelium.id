"""era_skip.py — idempotency helper for measurement-plane stages (V1 local).

"Era skip" lets a stage avoid recomputing rows that already exist for the
current era (``clustering_run_id``). compute_information_harmonics.py uses it
as a presence check: which (granularity, window_end) keys are already in
``cognitive_metrics_harmonic`` for this (user, run_id)?

Contract (exactly how the script calls it):
    fetch_existing_keys(
        querier,
        table='cognitive_metrics_harmonic',
        user_id=<uid>,
        run_id=<clustering_run_id>,
        key_columns=['granularity', 'window_end'],
        return_columns=[],          # presence-check only
    ) -> dict[tuple, dict]

Return shape: a mapping whose KEYS are tuples of the ``key_columns`` values
(one element → still wrapped in a 1-tuple) and whose VALUES are dicts of the
``return_columns`` (empty dict for a presence-only check). The caller does
``set(result.keys())`` to get the already-computed key set.

V1 behavior: query the local table directly. If the table does not exist
(partial schema), return ``{}`` so the stage recomputes everything — an
acceptable, safe default for a single-user local vault (the stage's writes
are UPSERTs, so recompute is idempotent anyway).
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Sequence

# D1/SQLite both cap bound vars per statement; the run_id + user_id filter
# keeps this to two binds regardless of row count, so no chunking needed.

# Tables we are willing to introspect. The clustering_run_id column name is
# the era anchor across the measurement-plane wide tables.
_RUN_ID_COLUMN = "clustering_run_id"


def fetch_existing_keys(
    querier: Callable[..., list],
    *,
    table: str,
    user_id: str,
    run_id: str,
    key_columns: Sequence[str],
    return_columns: Optional[Sequence[str]] = None,
) -> dict[tuple, dict[str, Any]]:
    """Return existing-row keys for (user_id, run_id) in ``table``.

    See module docstring for the exact shape. Defensive against a missing
    table (returns ``{}`` → recompute everything).
    """
    key_columns = list(key_columns)
    return_columns = list(return_columns or [])

    if not key_columns:
        return {}

    select_cols = list(dict.fromkeys([*key_columns, *return_columns]))
    col_sql = ", ".join(select_cols)

    sql = (
        f"SELECT {col_sql} FROM {table} "
        f"WHERE user_id = ? AND {_RUN_ID_COLUMN} = ?"
    )

    try:
        rows = querier(sql, [user_id, run_id])
    except Exception:
        # Missing table / column on the local schema → treat as "nothing
        # computed yet". The stage's UPSERT makes recompute safe.
        return {}

    out: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        key = tuple(r.get(c) for c in key_columns)
        out[key] = {c: r.get(c) for c in return_columns}
    return out
