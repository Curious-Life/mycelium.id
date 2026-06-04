"""graph_metrics.py — graph-topology primitives over the cofire territory graph.

Pure numpy functions, no I/O. Home for graph-level measures the topology-graph
family needs that have no JS equivalent (JS lacks an eigensolver). Today:
algebraic connectivity (Fiedler value) for §-spec graph_spectral_gap — a global
"how well-connected is the mindscape" measure (0 = fragmented/disconnected).

Small graphs (a few hundred territories) → dense eigh is plenty fast. Consumed
by the graph_spectral_gap topology metric (wired with the criticality/topology
build); shipped here now as the shared primitive (one source of truth).
"""

from __future__ import annotations

import numpy as np


def fiedler_value(adjacency) -> float:
    """Algebraic connectivity = 2nd-smallest eigenvalue of the NORMALIZED graph
    Laplacian L = I - D^{-1/2} A D^{-1/2} (isolated nodes contribute a zero row).

    A is symmetrized (cofire edges are undirected) and self-loops dropped.
    Returns 0.0 for n < 2 or a disconnected graph (λ2 → 0). Range ~[0, 2] for
    the normalized Laplacian.
    """
    A = np.asarray(adjacency, dtype=np.float64)
    if A.ndim != 2 or A.shape[0] != A.shape[1]:
        raise ValueError("adjacency must be a square 2D matrix")
    n = A.shape[0]
    if n < 2:
        return 0.0
    A = np.maximum(A, A.T)            # undirected
    np.fill_diagonal(A, 0.0)          # no self-loops
    deg = A.sum(axis=1)
    with np.errstate(divide="ignore"):
        dinv = np.where(deg > 0, 1.0 / np.sqrt(deg), 0.0)
    L = np.eye(n) - (dinv[:, None] * A * dinv[None, :])
    L = (L + L.T) / 2.0               # enforce numerical symmetry
    eig = np.linalg.eigvalsh(L)
    eig.sort()
    return float(eig[1])              # second-smallest = algebraic connectivity


if __name__ == "__main__":
    # Self-test (not in the npm verify chain — that chain is pure-node; this
    # needs numpy). Run: pipeline/.venv/bin/python3 pipeline/graph_metrics.py
    import sys

    # two disjoint edges (1-2, 3-4) → disconnected → λ2 = 0
    disc = fiedler_value([[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]])
    # path P3 (1-2-3) → connected → λ2 = 1 (normalized Laplacian)
    path = fiedler_value([[0, 1, 0], [1, 0, 1], [0, 1, 0]])
    # triangle K3 → λ2 = 1.5 (normalized Laplacian eigenvalues 0, 1.5, 1.5)
    tri = fiedler_value([[0, 1, 1], [1, 0, 1], [1, 1, 0]])
    ok = abs(disc) < 1e-9 and abs(path - 1.0) < 1e-9 and abs(tri - 1.5) < 1e-9
    print(f"fiedler_value: disconnected={disc:.6f}  path_P3={path:.6f}  triangle_K3={tri:.6f}")
    print(f"VERDICT: {'GO — algebraic connectivity correct (disconnected→0, P3→1, K3→1.5)' if ok else 'NO-GO'}  EXIT={0 if ok else 1}")
    sys.exit(0 if ok else 1)
