"""d1_client.py — local SQLite query shim for the V1 single-user vault.

This REPLACES the Cloudflare Worker D1 proxy used by the cloud app. In V1
there is no Worker and no httpx round-trip: every "D1" query runs directly
against the local SQLite vault at ``os.environ['MYCELIUM_DB']``.

Contract (matches what cluster.py / compute_information_harmonics.py call):
  - ``query(sql, params=None) -> list[dict]``
      Runs ``sql`` with positional ``params`` (a list/tuple, mapped to
      sqlite3 '?' placeholders). SELECT-style statements return a list of
      dict rows (``row_factory = sqlite3.Row`` → ``dict(row)``). Write
      statements (INSERT/UPDATE/DELETE/UPSERT/DDL) are committed and return
      ``[]``.
  - ``d1_query`` is provided as an alias (cluster.py uses that name).

Notes:
  - The cloud schema encrypts certain columns at write time via the Worker
    proxy's autoEncryptParams. In the V1 local path that envelope encryption
    is NOT reproduced here: callers that write plaintext scalars (e.g. the
    harmonics UPSERT) get plaintext rows, which is correct for a local vault.
    Reads of already-encrypted columns (e.g. messages.embedding_768) return
    the raw envelope string unchanged; decryption is the caller's job via
    crypto_local.
"""

from __future__ import annotations

import os
import sqlite3
from typing import Any, Optional, Sequence

# Cache the connection per process. SQLite connections are cheap, but the
# harmonics + clustering stages issue many small queries; one shared
# connection avoids repeated open/close and keeps WAL readers consistent.
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
    """Return a process-cached sqlite3 connection with Row factory."""
    global _CONN, _CONN_PATH
    path = _db_path()
    if _CONN is None or _CONN_PATH != path:
        if _CONN is not None:
            try:
                _CONN.close()
            except Exception:
                pass
        # check_same_thread=False: the pipeline is single-threaded today, but
        # this keeps the shim usable from helper threads without surprises.
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Match the app's pragmas closely enough for correctness: the vault
        # ships in WAL mode and busy_timeout avoids spurious "database is
        # locked" errors when the JS side is mid-write.
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        _CONN = conn
        _CONN_PATH = path
    return _CONN


def _is_write(sql: str) -> bool:
    head = sql.lstrip().split(None, 1)
    if not head:
        return False
    verb = head[0].upper()
    return verb in {
        'INSERT', 'UPDATE', 'DELETE', 'REPLACE',
        'CREATE', 'DROP', 'ALTER', 'PRAGMA', 'VACUUM', 'BEGIN',
        'COMMIT', 'ATTACH', 'DETACH',
    }


def query(sql: str, params: Optional[Sequence[Any]] = None) -> list[dict]:
    """Execute ``sql`` against the local vault.

    Read statements return ``list[dict]``; write statements commit and
    return ``[]``. ``params`` is a positional list/tuple bound to '?'
    placeholders (None → no params).
    """
    conn = get_connection()
    cur = conn.execute(sql, tuple(params) if params else ())
    if cur.description is None:
        # No result set → it was a write (or a statement that yields nothing).
        conn.commit()
        return []
    rows = cur.fetchall()
    return [dict(r) for r in rows]


# cluster.py and some reference scripts import the query helper under the
# name ``d1_query``. Provide it as an alias so a single module satisfies both.
d1_query = query


def execute(sql: str, params: Optional[Sequence[Any]] = None) -> list[dict]:
    """Alias for :func:`query` (some callers prefer an ``execute`` name)."""
    return query(sql, params)


def close() -> None:
    """Close the cached connection (used by tests / clean shutdown)."""
    global _CONN, _CONN_PATH
    if _CONN is not None:
        try:
            _CONN.commit()
        finally:
            _CONN.close()
        _CONN = None
        _CONN_PATH = None
