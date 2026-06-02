# pipeline/local_db.py — V1 single-user LOCAL data layer.
#
# Replaces the Cloudflare Worker proxy (the old httpx `/api/db/*` calls + the
# d1_client module). Every pipeline stage reads/writes the local encrypted
# SQLite vault directly. There is NO worker, NO MYA_WORKER_URL, NO auth token.
#
#   query(sql, params)           → list[dict]   (SELECT) or [] (write via query)
#   batch(statements)            → run PLAINTEXT writes (columns NOT encrypted)
#   batch_encrypted(statements)  → run writes that touch ENCRYPTED_FIELDS columns
#                                  through the canonical JS adapter (local Node
#                                  bridge) so the values are encrypted at rest.
#
# A "statement" is {"sql": str, "params": list} (also accepts [sql, params]).
import json
import os
import sqlite3
import subprocess
from pathlib import Path

DB_PATH = os.environ.get("MYCELIUM_DB", "")
_conn = None


def _conn_get():
    global _conn
    if _conn is None:
        if not DB_PATH:
            raise RuntimeError("local_db: MYCELIUM_DB is not set")
        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA busy_timeout = 5000")  # tolerate the server holding a write lock
    return _conn


def _parts(s):
    if isinstance(s, dict):
        return s.get("sql", ""), s.get("params") or []
    if isinstance(s, (list, tuple)):
        return s[0], (s[1] if len(s) > 1 else []) or []
    return str(s), []


def query(sql, params=None):
    """Run a query against the local vault. SELECT → list[dict]; a write issued
    through query() (UPDATE/DELETE) commits and returns []."""
    conn = _conn_get()
    cur = conn.execute(sql, params or [])
    if cur.description is None:
        conn.commit()
        return []
    return [dict(r) for r in cur.fetchall()]


def batch(statements):
    """Run a batch of PLAINTEXT statements in one transaction. Only for columns
    NOT in ENCRYPTED_FIELDS (centroids, energy, coherence, …)."""
    conn = _conn_get()
    n = 0
    for s in (statements or []):
        sql, params = _parts(s)
        if sql and sql.strip():
            conn.execute(sql, params)
            n += 1
    conn.commit()
    return {"ok": True, "count": n}


_BRIDGE = Path(__file__).parent / "local-write-bridge.js"


def batch_encrypted(statements):
    """Run a batch of statements that write ENCRYPTED_FIELDS columns through the
    canonical JS encryption adapter (a local Node bridge), so the values land
    encrypted at rest — NOT plaintext. Mirrors the old worker d1_batch_encrypted
    contract, but local + in-vault. Raises RuntimeError on bridge failure."""
    if not statements:
        return {"ok": True, "written": 0}
    payload = json.dumps({"statements": statements})
    try:
        proc = subprocess.run(
            ["node", str(_BRIDGE)],
            input=payload.encode("utf-8"),
            capture_output=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"local-write-bridge timed out after {e.timeout}s") from e
    except FileNotFoundError as e:
        raise RuntimeError(f"local-write-bridge: node not on PATH ({e})") from e
    stderr = proc.stderr.decode("utf-8", errors="replace").strip()
    stdout = proc.stdout.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0:
        raise RuntimeError(f"local-write-bridge exit {proc.returncode}: {stderr or stdout or 'no output'}")
    try:
        result = json.loads(stdout.splitlines()[-1]) if stdout else {}
    except (json.JSONDecodeError, IndexError) as e:
        raise RuntimeError(f"local-write-bridge: bad JSON on stdout: {stdout!r}") from e
    if not result.get("ok"):
        raise RuntimeError(f"local-write-bridge error: {result.get('error', 'unknown')}")
    return result
