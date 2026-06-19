#!/usr/bin/env bash
# pipeline/setup.sh — provision the Mycelium Python venv (embed + clustering).
#
# Creates a local virtualenv under pipeline/.venv and installs BOTH dependency
# sets a full local install needs:
#   • requirements-embed.txt — the embed service (Nomic v1.5 ONNX). REQUIRED;
#     a failure here aborts, because embedding is the critical path.
#   • requirements.txt       — the clustering/harmonics pipeline behind
#     "Generate" (faiss, leidenalg, igraph, scikit-learn, umap, scipy, ripser,
#     cryptography, python-dotenv…). Heavy native wheels, installed NON-FATALLY
#     so embedding still provisions on a host with no prebuilt wheel; Generate
#     then fails soft (run-clustering.sh's deps probe says so) until present.
# Then (unless EMBED_SKIP_WARMUP=1) it warms the HuggingFace cache by loading
# the Nomic v1.5 model once and embedding a probe string.
#
# Requires: python3 (>=3.10) and network access on first run so the model
# downloads from the HuggingFace Hub (nomic-ai/nomic-embed-text-v1.5,
# files onnx/model_quantized.onnx + tokenizer.json).
#
# Usage:
#   bash pipeline/setup.sh
#   EMBED_SKIP_WARMUP=1 bash pipeline/setup.sh           # install only, no model download
#   PIPELINE_SKIP_CLUSTER_DEPS=1 bash pipeline/setup.sh  # embed only, skip clustering deps
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${HERE}/.venv"
MODEL_ID="nomic-ai/nomic-embed-text-v1.5"

echo "[embed-setup] python: $(python3 --version)"

if [ ! -d "${VENV}" ]; then
  echo "[embed-setup] creating venv at ${VENV}"
  python3 -m venv "${VENV}"
fi

# shellcheck disable=SC1091
source "${VENV}/bin/activate"

echo "[embed-setup] upgrading pip"
python3 -m pip install --upgrade pip >/dev/null

echo "[embed-setup] installing embed-service requirements (requirements-embed.txt)"
python3 -m pip install -r "${HERE}/requirements-embed.txt"

# Clustering / harmonics deps — the heavier topology set that "Generate" (the
# 5-stage clustering pipeline) needs: faiss, leidenalg, igraph, scikit-learn,
# umap, scipy, ripser, cryptography, python-dotenv… NON-FATAL on purpose: these
# are heavy native wheels that may have no prebuilt wheel for some platforms. If
# they fail to install, embedding still works and Generate fails soft (the in-app
# preflight + run-clustering.sh's deps probe report it) rather than the whole
# setup aborting. Opt out with PIPELINE_SKIP_CLUSTER_DEPS=1. The `if … then`
# guard keeps a failed install from tripping `set -e`.
if [ "${PIPELINE_SKIP_CLUSTER_DEPS:-0}" = "1" ]; then
  echo "[embed-setup] PIPELINE_SKIP_CLUSTER_DEPS=1 — skipping clustering deps (Generate stays unavailable until they're installed)"
elif python3 -m pip install -r "${HERE}/requirements.txt"; then
  echo "[embed-setup] clustering/harmonics deps OK — Generate available"
else
  echo "[embed-setup] WARNING: clustering/harmonics deps failed to install." >&2
  echo "[embed-setup]   Embedding works; Generate (clustering) will not until these install." >&2
  echo "[embed-setup]   Retry: ${VENV}/bin/python3 -m pip install -r ${HERE}/requirements.txt" >&2
fi

if [ "${EMBED_SKIP_WARMUP:-0}" = "1" ]; then
  echo "[embed-setup] EMBED_SKIP_WARMUP=1 — skipping model download/warmup"
else
  echo "[embed-setup] warming model cache (${MODEL_ID}) — first run downloads ~170MB"
  # The service file name is hyphenated (not importable), so load it by path.
  python3 - <<PY
import importlib.util
spec = importlib.util.spec_from_file_location("embed_service", "${HERE}/embed-service.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
embs = mod.embed_texts(["hello world"], task="query")
assert embs.shape == (1, mod.OUTPUT_DIM), f"expected (1, {mod.OUTPUT_DIM}), got {embs.shape}"
print(f"[embed-setup] warmup OK — {embs.shape[1]}-dim vector")
PY
fi

echo "[embed-setup] done. Run:  ${VENV}/bin/python3 ${HERE}/embed-service.py --serve --port 8091"
