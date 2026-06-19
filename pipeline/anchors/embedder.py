"""pipeline/anchors/embedder.py — pluggable embedder for the anchor stage (E1).

Two implementations behind one interface ``embed(texts) -> np.ndarray (N, 768)``
of L2-normalized float32 rows:

  - HttpEmbedder (PRODUCTION): POSTs to the V1 embed-service
    (pipeline/embed-service.py, 127.0.0.1:8091, the SAME service cluster.py /
    enrich use to produce messages.embedding_768). Uses the /batch endpoint with
    task='document'. The service L2-normalizes; we re-normalize defensively.

  - StubEmbedder (VERIFY GATE): a DETERMINISTIC, network-free, model-free
    embedder. A seeded hash of each input text drives a fixed RNG → a stable
    768-D unit vector. Same text ⇒ same vector across runs/processes, so the
    verify gate can assert cosine-proximity behavior WITHOUT a model download or
    a running service. NEVER used in production (selected only by env var).

Selection (compute-anchors.py):
    ANCHOR_EMBEDDER = 'stub'  → StubEmbedder         (verify gate sets this)
    ANCHOR_EMBEDDER = 'http'  → HttpEmbedder         (default / production)

Security: embeddings are semantic fingerprints — request bodies / vectors are
NEVER logged here (the HTTP service already enforces this loopback-only).
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from typing import Sequence

import numpy as np

OUTPUT_DIM = 768
_EMBED_PORT = int(os.environ.get("MYCELIUM_EMBED_PORT", "8091"))
_EMBED_BASE = f"http://127.0.0.1:{_EMBED_PORT}"


def _l2_normalize(arr: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalize a (N, D) float32 array (clip tiny norms)."""
    a = np.asarray(arr, dtype=np.float32)
    if a.ndim == 1:
        a = a[None, :]
    norms = np.linalg.norm(a, axis=1, keepdims=True).clip(min=1e-8)
    return (a / norms).astype(np.float32)


class HttpEmbedder:
    """Production embedder — calls the V1 embed-service /batch endpoint."""

    label = "nomic-v1.5"

    def __init__(self, base_url: str = _EMBED_BASE, task: str = "document", timeout: float = 60.0):
        self._base = base_url.rstrip("/")
        self._task = task
        self._timeout = timeout

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, OUTPUT_DIM), dtype=np.float32)
        body = json.dumps({"texts": list(texts), "task": self._task}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base}/batch", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        embs = np.asarray(payload["embeddings"], dtype=np.float32)
        if embs.ndim != 2 or embs.shape[1] != OUTPUT_DIM:
            raise ValueError(
                f"embed-service returned shape {embs.shape}, expected (*, {OUTPUT_DIM})"
            )
        return _l2_normalize(embs)


class StubEmbedder:
    """Deterministic, model-free embedder for the verify gate.

    Each text maps to a fixed 768-D unit vector via a hash-seeded RNG. Identical
    text → identical vector (stable across runs/processes/machines). NO network,
    NO model, NO file IO. Behaviorally faithful enough to prove the cosine-anchor
    PLUMBING (anchors mean → metrics cosine → encrypt → decrypt → CVP-gate),
    which is what the gate verifies. It does NOT claim semantic validity — that
    is exactly what CVP (deliverable C) is for, and why these metrics ship
    cvp_status='pending'.
    """

    label = "stub-deterministic"

    def __init__(self, dim: int = OUTPUT_DIM):
        self._dim = dim

    def _vec(self, text: str) -> np.ndarray:
        h = hashlib.sha256(text.encode("utf-8")).digest()
        seed = int.from_bytes(h[:8], "little")
        rng = np.random.default_rng(seed)
        v = rng.standard_normal(self._dim).astype(np.float32)
        return v

    def embed(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._dim), dtype=np.float32)
        rows = np.stack([self._vec(t) for t in texts])
        return _l2_normalize(rows)


def get_embedder():
    """Select the embedder by env var. Default = HttpEmbedder (production)."""
    kind = os.environ.get("ANCHOR_EMBEDDER", "http").strip().lower()
    if kind == "stub":
        return StubEmbedder()
    return HttpEmbedder()
