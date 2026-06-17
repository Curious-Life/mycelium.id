#!/usr/bin/env python3
# Property test for cluster.py's full-text window + weight-pool helpers
# (_split_windows / _weighted_pool_windows). Pure: no ONNX model, no D1.
#
# Proves the β fix: a long imported transcript/document clusters on its FULL
# content (windowed + token-weighted-pooled), while a short text yields exactly
# one window whose vector is IDENTICAL to the pre-chunking single-pool output —
# so existing clustering_points vectors stay stable. Run via the .mjs wrapper.
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CLUSTER_PY = os.path.join(HERE, "..", "cluster.py")
sys.path.insert(0, os.path.join(HERE, ".."))  # so cluster.py's sibling imports resolve
spec = importlib.util.spec_from_file_location("cluster", CLUSTER_PY)
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)

ledger = []
def rec(name, ok, detail=""):
    ledger.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")

W = cl.NOMIC_WINDOW

# ── _split_windows ──────────────────────────────────────────────────────────
win, owner, wt = cl._split_windows([list(range(300))], W)
rec("C1 short text (<=window) → exactly ONE window, weight = token count",
    len(win) == 1 and owner == [0] and wt == [300], f"windows={len(win)} weights={wt}")

n = 2 * W + 137
win, owner, wt = cl._split_windows([list(range(n))], W)
rec("C2 long text → ceil(n/window) windows; weights sum to FULL length (no tail dropped)",
    len(win) == 3 and sum(wt) == n and set(owner) == {0} and wt == [W, W, 137],
    f"windows={len(win)} sum={sum(wt)} of {n}")

win, owner, wt = cl._split_windows([list(range(10)), list(range(W + 5))], W)
rec("C3 multiple texts → owner indices map correctly",
    owner == [0, 1, 1] and wt == [10, W, 5], f"owner={owner} wt={wt}")

win, owner, wt = cl._split_windows([[]], W)
rec("C4 empty text → 1 window (never zero windows)", len(win) == 1 and owner == [0])

# ── _weighted_pool_windows ──────────────────────────────────────────────────
dim = 4
out = cl._weighted_pool_windows(np.array([[1, 2, 3, 4]], dtype=np.float32), [0], [50], 1, dim)
rec("C5 one window → IDENTITY (existing short-text vectors stay byte-identical)",
    np.allclose(out[0], [1, 2, 3, 4]), f"out={out[0].tolist()}")

# two windows, weights 100 & 300 → (0*100 + 10*300)/400 = 7.5 (token-weighted, NOT plain mean 5)
out = cl._weighted_pool_windows(np.array([[0, 0, 0, 0], [10, 10, 10, 10]], dtype=np.float32),
                                [0, 0], [100, 300], 1, dim)
rec("C6 two windows → token-count-weighted mean (7.5, not plain-mean 5)",
    np.allclose(out[0], [7.5] * 4), f"out={out[0].tolist()}")

# per-text isolation: text0 = windows 0,1 (weights 1,1 → mean 1.5); text1 = window 2 (=8)
out = cl._weighted_pool_windows(np.array([[1, 1, 1, 1], [2, 2, 2, 2], [8, 8, 8, 8]], dtype=np.float32),
                                [0, 0, 1], [1, 1, 1], 2, dim)
rec("C7 per-text pooling isolates each text's windows",
    np.allclose(out[0], [1.5] * 4) and np.allclose(out[1], [8] * 4),
    f"t0={out[0].tolist()} t1={out[1].tolist()}")

# ── constants: full-text budget, not the old 2000-char single window ─────────
rec("C8 budget raised to full-text (chars>=40k, total>=8192 tokens, window=512)",
    cl.NOMIC_MAX_CHARS >= 40000 and cl.NOMIC_MAX_TOTAL_TOKENS >= 8192 and cl.NOMIC_WINDOW == 512,
    f"chars={cl.NOMIC_MAX_CHARS} total={cl.NOMIC_MAX_TOTAL_TOKENS} window={cl.NOMIC_WINDOW}")

ok = all(ledger)
print("\n" + "=" * 64)
print(f"VERDICT: {'GO' if ok else 'NO-GO'} — cluster.py full-text window+weight-pool "
      f"(long content embedded in full; short-text identity preserved)")
print("=" * 64)
sys.exit(0 if ok else 1)
