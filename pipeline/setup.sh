#!/usr/bin/env bash
# pipeline/setup.sh — provision the Mycelium embed-service venv.
#
# Creates a local virtualenv under pipeline/.venv, installs pinned deps,
# and (unless EMBED_SKIP_WARMUP=1) warms the HuggingFace cache by loading
# the Nomic v1.5 model once and embedding a probe string.
#
# Requires: python3 (>=3.10) and network access on first run so the model
# downloads from the HuggingFace Hub (nomic-ai/nomic-embed-text-v1.5,
# files onnx/model_quantized.onnx + tokenizer.json).
#
# Usage:
#   bash pipeline/setup.sh
#   EMBED_SKIP_WARMUP=1 bash pipeline/setup.sh   # install only, no download
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

echo "[embed-setup] installing pinned requirements"
python3 -m pip install -r "${HERE}/requirements-embed.txt"

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
