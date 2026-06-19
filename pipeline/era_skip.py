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

import re
from typing import Any, Callable, Optional, Sequence

# Column/table identifiers are interpolated into SQL (values are always bound
# params, never interpolated). Callers pass code-literal names, but we hard-gate
# every interpolated identifier against this pattern as defense-in-depth so a
# future careless caller can't introduce SQL injection via a column name.
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_ident(name: str) -> str:
    if not isinstance(name, str) or not _IDENT_RE.match(name):
        raise ValueError(f"era_skip: unsafe SQL identifier {name!r}")
    return name

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
    run_id_column: str = _RUN_ID_COLUMN,
    extra_filters: Optional[dict] = None,
) -> dict[tuple, dict[str, Any]]:
    """Return existing-row keys for (user_id, run_id) in ``table``.

    See module docstring for the exact shape. Defensive against a missing
    table (returns ``{}`` → recompute everything).

    ``run_id_column`` is the era anchor column name. It defaults to
    ``clustering_run_id`` (cognitive_metrics_harmonic, the current caller), but
    the canonical-158 wide tables (cognitive_metrics_window/_trajectory/
    _per_territory, topology_metrics) name it ``era_id`` — those callers pass
    ``run_id_column='era_id'`` so era-skip works against them too.

    ``extra_filters`` adds equality predicates (``AND col = ?`` per entry) on
    PLAINTEXT/structural columns — used by the Fisher port, whose key is just
    ``window_start`` and must additionally scope by ``level`` + ``window_type``
    (otherwise window_start keys collide across the three levels). Keys are NOT
    sanitized, so callers must pass only trusted, code-literal column names.
    """
    key_columns = list(key_columns)
    return_columns = list(return_columns or [])
    extra_filters = dict(extra_filters or {})

    if not key_columns:
        return {}

    select_cols = list(dict.fromkeys([*key_columns, *return_columns]))
    col_sql = ", ".join(_safe_ident(c) for c in select_cols)

    sql = (
        f"SELECT {col_sql} FROM {_safe_ident(table)} "
        f"WHERE user_id = ? AND {_safe_ident(run_id_column)} = ?"
    )
    params = [user_id, run_id]
    for col, val in extra_filters.items():
        sql += f" AND {_safe_ident(col)} = ?"
        params.append(val)

    try:
        rows = querier(sql, params)
    except Exception:
        # Missing table / column on the local schema → treat as "nothing
        # computed yet". The stage's UPSERT makes recompute safe.
        return {}

    out: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        key = tuple(r.get(c) for c in key_columns)
        out[key] = {c: r.get(c) for c in return_columns}
    return out


if __name__ == "__main__":
    # Self-test (pure, no DB): default era column, the era_id parameterization,
    # and missing-table → {}. Run: pipeline/.venv/bin/python3 pipeline/era_skip.py
    import sys

    cap: dict[str, str] = {}

    def _fake(sql, params):
        cap["sql"] = sql
        return [{"window_end": "2026-06-04", "x": 1}]

    r1 = fetch_existing_keys(_fake, table="cognitive_metrics_harmonic", user_id="u",
                             run_id="e", key_columns=["window_end"])
    ok1 = "clustering_run_id = ?" in cap["sql"] and set(r1.keys()) == {("2026-06-04",)}

    fetch_existing_keys(_fake, table="cognitive_metrics_window", user_id="u",
                        run_id="e", key_columns=["window_end"], run_id_column="era_id")
    ok2 = "era_id = ?" in cap["sql"]

    def _boom(sql, params):
        raise RuntimeError("no such table")

    ok3 = fetch_existing_keys(_boom, table="nope", user_id="u", run_id="e",
                              key_columns=["window_end"]) == {}

    ok = ok1 and ok2 and ok3
    print(f"era_skip: default->clustering_run_id={ok1}  era_id-param={ok2}  missing-table->{{}}={ok3}")
    print(f"VERDICT: {'GO' if ok else 'NO-GO'}  EXIT={0 if ok else 1}")
    sys.exit(0 if ok else 1)
