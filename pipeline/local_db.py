# pipeline/local_db.py — V1 single-user LOCAL data layer (used by cluster.py).
#
# Two transports (see d1_client.py for the same split):
#   * BRIDGE MODE (at-rest blindness, A′): ``MYCELIUM_DB_BRIDGE_URL`` set → POST to
#     the long-running loopback ``vault-bridge.js``, which owns the only handle to
#     the whole-file SQLCipher vault. See docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md.
#   * LEGACY MODE: unset → open the plaintext vault directly via stock ``sqlite3``;
#     batch_encrypted shells out to the spawn-per-call local-write-bridge.js.
#
#   query(sql, params)           → list[dict]   (SELECT) or [] (write via query)
#   batch(statements)            → run PLAINTEXT writes (columns NOT encrypted)
#   batch_encrypted(statements)  → run writes that touch ENCRYPTED_FIELDS columns
#                                  through the canonical JS adapter (auto-encrypt)
#
# A "statement" is {"sql": str, "params": list} (also accepts [sql, params]).
import base64
import json
import os
import sqlite3
import subprocess
import urllib.request
from pathlib import Path

DB_PATH = os.environ.get("MYCELIUM_DB", "")
_BRIDGE_URL = os.environ.get("MYCELIUM_DB_BRIDGE_URL") or None
_conn = None


# ── shared statement-shape helper ────────────────────────────────────────────
def _parts(s):
    if isinstance(s, dict):
        return s.get("sql", ""), s.get("params") or []
    if isinstance(s, (list, tuple)):
        return s[0], (s[1] if len(s) > 1 else []) or []
    return str(s), []


# ── BLOB transport over JSON (bridge mode only) ──────────────────────────────
# A SQLite BLOB crosses the loopback bridge as a tagged object {"__b64__": <b64>}.
# The legacy direct-sqlite3 path needs none of this (sqlite3 binds/returns bytes
# natively). Mirrors vault-bridge.js decodeParams/encodeRow. Used for raw LE-f32
# vector columns (Stage A: nomic_embedding, embedding_768, anchor_vector).
def _encode_param(p):
    if isinstance(p, (bytes, bytearray, memoryview)):
        return {"__b64__": base64.b64encode(bytes(p)).decode("ascii")}
    return p


def _encode_params(params):
    return [_encode_param(p) for p in (params or [])]


def _encode_stmt(s):
    if isinstance(s, dict):
        return {**s, "params": _encode_params(s.get("params"))}
    if isinstance(s, (list, tuple)):
        return [s[0], _encode_params(s[1] if len(s) > 1 else [])]
    return s


def _decode_value(v):
    if isinstance(v, dict) and len(v) == 1 and isinstance(v.get("__b64__"), str):
        return base64.b64decode(v["__b64__"])
    return v


def _decode_rows(rows):
    return [{k: _decode_value(v) for k, v in r.items()} for r in (rows or [])]


# ── bridge transport ─────────────────────────────────────────────────────────
def _post(route, body, timeout=120):
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


# ── legacy direct-sqlite3 transport ──────────────────────────────────────────
def _conn_get():
    global _conn
    if _conn is None:
        if not DB_PATH:
            raise RuntimeError("local_db: MYCELIUM_DB is not set")
        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA busy_timeout = 5000")  # tolerate the server holding a write lock
    return _conn


def query(sql, params=None):
    """Run a query against the local vault. SELECT → list[dict]; a write issued
    through query() (UPDATE/DELETE) commits and returns []."""
    if _BRIDGE_URL:
        rows = _post("/query", {"sql": sql, "params": _encode_params(params)}).get("rows", [])
        return _decode_rows(rows)
    conn = _conn_get()
    cur = conn.execute(sql, params or [])
    if cur.description is None:
        conn.commit()
        return []
    return [dict(r) for r in cur.fetchall()]


def batch(statements):
    """Run a batch of PLAINTEXT statements in one transaction. Only for columns
    NOT in ENCRYPTED_FIELDS (centroids, energy, coherence, …)."""
    if _BRIDGE_URL:
        return _post("/batch", {"statements": [_encode_stmt(s) for s in (statements or [])]})
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
    canonical JS encryption adapter, so the values land encrypted at rest. In
    bridge mode this is the long-running vault-bridge; in legacy mode it is the
    spawn-per-call local-write-bridge.js. Raises RuntimeError on failure."""
    if not statements:
        return {"ok": True, "written": 0}
    if _BRIDGE_URL:
        return _post("/batch_encrypted", {"statements": statements})
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
