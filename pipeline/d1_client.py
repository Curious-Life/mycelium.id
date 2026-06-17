"""d1_client.py — local query shim for the V1 single-user vault.

This REPLACES the Cloudflare Worker D1 proxy used by the cloud app. Every "D1"
query runs against the local vault — by one of two transports:

  * BRIDGE MODE (at-rest blindness, A′): when ``MYCELIUM_DB_BRIDGE_URL`` is set,
    the vault is whole-file SQLCipher and only Node may open the cipher, so we
    POST each query to the long-running loopback ``vault-bridge.js`` over
    127.0.0.1 (it opens the keyed vault and runs the SQL on the raw handle).
    See docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md.
  * LEGACY MODE: when the bridge URL is unset, open the plaintext vault directly
    via stock ``sqlite3`` (the pre-A′ behavior — used for plaintext vaults / dev).

Contract (unchanged — what cluster.py / compute_information_harmonics.py call):
  - ``query(sql, params=None) -> list[dict]`` — SELECT → list of dict rows;
    write statements commit and return ``[]``. ``params`` is a positional
    list/tuple bound to '?' placeholders.
  - ``d1_query`` / ``execute`` are aliases.

Both transports preserve RAW semantics: encrypted columns (e.g.
messages.embedding_768) come back as the raw envelope string; decryption is the
caller's job via crypto_local. Plaintext writes stay plaintext at the column
level (the whole file is still encrypted at rest in bridge mode).
"""

from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
from typing import Any, Optional, Sequence

_BRIDGE_URL: Optional[str] = os.environ.get("MYCELIUM_DB_BRIDGE_URL") or None

# ── legacy direct-sqlite3 transport (plaintext vault) ────────────────────────
_CONN: Optional[sqlite3.Connection] = None
_CONN_PATH: Optional[str] = None


def _db_path() -> str:
    path = os.environ.get('MYCELIUM_DB')
    if not path:
        raise RuntimeError(
            "MYCELIUM_DB is not set; point it at the local SQLite vault "
            "(e.g. export MYCELIUM_DB=\"$(pwd)/data/mycelium.db\")."
        )
    return path


def get_connection() -> sqlite3.Connection:
    """Return a process-cached sqlite3 connection (LEGACY/plaintext mode only)."""
    global _CONN, _CONN_PATH
    path = _db_path()
    if _CONN is None or _CONN_PATH != path:
        if _CONN is not None:
            try:
                _CONN.close()
            except Exception:
                pass
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        _CONN = conn
        _CONN_PATH = path
    return _CONN


def _query_legacy(sql: str, params: Optional[Sequence[Any]]) -> list[dict]:
    conn = get_connection()
    cur = conn.execute(sql, tuple(params) if params else ())
    if cur.description is None:
        conn.commit()
        return []
    return [dict(r) for r in cur.fetchall()]


# ── bridge transport (whole-file SQLCipher vault) ────────────────────────────
def _post(route: str, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        _BRIDGE_URL + route,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read().decode("utf-8"))
    if not out.get("ok"):
        raise RuntimeError(f"vault-bridge error: {out.get('error', 'unknown')}")
    return out


def _query_bridge(sql: str, params: Optional[Sequence[Any]]) -> list[dict]:
    return _post("/query", {"sql": sql, "params": list(params) if params else []}).get("rows", [])


def query(sql: str, params: Optional[Sequence[Any]] = None) -> list[dict]:
    """Execute ``sql`` against the local vault. Read → ``list[dict]``; write →
    commits and returns ``[]``. Routes to the bridge or legacy sqlite3."""
    if _BRIDGE_URL:
        return _query_bridge(sql, params)
    return _query_legacy(sql, params)


# cluster.py and some reference scripts import the query helper as ``d1_query``.
d1_query = query


def execute(sql: str, params: Optional[Sequence[Any]] = None) -> list[dict]:
    """Alias for :func:`query` (some callers prefer an ``execute`` name)."""
    return query(sql, params)


def close() -> None:
    """Close the cached legacy connection (no-op in bridge mode)."""
    global _CONN, _CONN_PATH
    if _CONN is not None:
        try:
            _CONN.commit()
        finally:
            _CONN.close()
        _CONN = None
        _CONN_PATH = None
