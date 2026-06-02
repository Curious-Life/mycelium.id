"""stage_base.py — local stage scaffolding for the V1 single-user pipeline.

Tiny helpers shared by the measurement-plane stages (here: the harmonics
stage). In the cloud app these lived in a shared ``stage_base`` package that
wrapped dotenv loading, user-id resolution, and era-id derivation around the
Worker proxy. The V1 port keeps the same surface but talks to the local
SQLite vault via :mod:`d1_client`.

Surface accessed by compute_information_harmonics.py:
    - load_dotenv(repo_root)                 → best-effort .env loading
    - get_user_id()                          → the vault owner id
    - derive_era_id(user_id, querier=None)   → canonical clustering_run_id
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import d1_client


def load_dotenv(repo_root) -> None:
    """Best-effort load of ``<repo_root>/.env`` into ``os.environ``.

    Mirrors the canonical scripts' use of python-dotenv. Absent file is a
    no-op (the local harness usually injects env vars directly). Existing
    environment values are never overwritten (``override=False``).
    """
    env_path = Path(repo_root) / ".env"
    try:
        from dotenv import load_dotenv as _load
        _load(dotenv_path=str(env_path), override=False)
    except Exception:
        # python-dotenv missing or unreadable .env — env vars may already be
        # set by the caller; do not fail the stage on this.
        pass


def get_user_id() -> str:
    """Resolve the vault owner id.

    V1 is single-user. Honor MYCELIUM_USER_ID (the local convention) first,
    then MYA_USER_ID (the cloud env var the script's docstring references),
    then fall back to the canonical local default 'local-user'.
    """
    return (
        os.environ.get("MYCELIUM_USER_ID")
        or os.environ.get("MYA_USER_ID")
        or "local-user"
    )


def derive_era_id(user_id: str, querier: Optional[Callable] = None) -> str:
    """Resolve the canonical era / clustering_run_id for ``user_id``.

    Python mirror of ``src/db/metrics.js::getCurrentEra`` (a.k.a.
    deriveFisherEraId):
      1. pipeline_state(stage_name='cluster').last_success_at → era-<ts>
      2. else MAX(territory_profiles.updated_at where not dissolved) → era-<ts>
      3. else era-bootstrap-YYYY-MM-DD
    Each rung is wrapped in try/except so a missing table (partial local
    schema) degrades to the next rung rather than crashing the stage.
    """
    querier = querier or d1_client.query

    try:
        rows = querier(
            "SELECT last_success_at FROM pipeline_state "
            "WHERE user_id = ? AND stage_name = ?",
            [user_id, "cluster"],
        )
        if rows and rows[0].get("last_success_at"):
            return f"era-{rows[0]['last_success_at']}"
    except Exception:
        pass

    try:
        rows = querier(
            "SELECT MAX(updated_at) AS last_updated FROM territory_profiles "
            "WHERE user_id = ? AND dissolved_at IS NULL",
            [user_id],
        )
        if rows and rows[0].get("last_updated"):
            return f"era-{rows[0]['last_updated']}"
    except Exception:
        pass

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"era-bootstrap-{today}"
