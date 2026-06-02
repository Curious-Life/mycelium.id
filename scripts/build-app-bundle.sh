#!/usr/bin/env bash
# scripts/build-app-bundle.sh — assemble the self-contained runtime tree that
# `cargo tauri build` bundles into  Mycelium.app/Contents/Resources/app/.
#
# Output:  <repo>/build-staging/  — everything the packaged app needs at runtime
# with ZERO host prerequisites:
#   node                    bundled Node v22.x arm64 binary
#   python/bin/python3      relocatable python-build-standalone 3.12 + ALL wheels
#   hf-cache/hub/…          Nomic v1.5 ONNX model (offline first run, via HF_HOME)
#   node_modules/…          incl. the native better_sqlite3.node (arm64)
#   src/ pipeline/ migrations/ package.json portal-app/build/
#
# The heavy runtime bits (Node binary, Python+wheels, model) are built ONCE into
# <repo>/.build-cache/runtime/ and reused; only the app code re-syncs each run, so
# iterative `cargo tauri build`s stay fast. Wired as tauri.conf
# `build.beforeBuildCommand`. Verified relocatable by Spikes P + N
# (docs/DESIGN-packaged-app-distribution-2026-06-02.md).
#
# macOS arm64 only (matches the bundled Node/Python + native wheels). Needs network
# at BUILD time (downloads + pip + npm) — never at the user's runtime.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$REPO/build-staging"
CACHE="$REPO/.build-cache"
RT="$CACHE/runtime"

PY_VER="3.12.13"; PBS_TAG="20260510"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PY_VER}%2B${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
NODE_VER="v22.22.3"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz"

log(){ echo "[stage] $*"; }
mkdir -p "$CACHE" "$RT"

# ── 1. Bundled Node binary (cached) ───────────────────────────────────────────
ensure_node(){
  if [ -x "$RT/node" ]; then log "node: cached ($("$RT/node" --version))"; return; fi
  log "node: downloading ${NODE_VER}…"
  local tgz="$CACHE/node-${NODE_VER}.tar.gz"
  [ -f "$tgz" ] || curl -fsSL "$NODE_URL" -o "$tgz"
  rm -rf "$CACHE/node-x"; mkdir -p "$CACHE/node-x"; tar -xzf "$tgz" -C "$CACHE/node-x"
  cp "$CACHE/node-x/node-${NODE_VER}-darwin-arm64/bin/node" "$RT/node"; chmod +x "$RT/node"
  rm -rf "$CACHE/node-x"
  log "node: $("$RT/node" --version)"
}

# ── 2. Relocatable Python + all wheels (cached; re-pip only if reqs change) ────
ensure_python(){
  local reqhash
  reqhash="$(cat "$REPO/pipeline/requirements.txt" "$REPO/pipeline/requirements-embed.txt" | shasum -a 256 | cut -d' ' -f1)"
  if [ -x "$RT/python/bin/python3" ] && [ "$(cat "$RT/python/.deps-hash" 2>/dev/null || true)" = "$reqhash" ]; then
    log "python: cached (deps current)"; return
  fi
  log "python: building relocatable ${PY_VER} + wheels (one-time, slow)…"
  local tgz="$CACHE/pbs-${PY_VER}-${PBS_TAG}.tar.gz"
  [ -f "$tgz" ] || curl -fsSL "$PBS_URL" -o "$tgz"
  rm -rf "$RT/python"; tar -xzf "$tgz" -C "$RT"   # extracts ./python/
  "$RT/python/bin/python3" -m pip install --quiet --disable-pip-version-check \
     -r "$REPO/pipeline/requirements.txt" -r "$REPO/pipeline/requirements-embed.txt"
  echo "$reqhash" > "$RT/python/.deps-hash"
  log "python: $("$RT/python/bin/python3" --version) — $(du -sh "$RT/python" | cut -f1)"
}

# ── 3. Nomic model for offline first run (cached) ─────────────────────────────
ensure_model(){
  if [ -d "$RT/hf-cache/hub" ]; then log "model: cached"; return; fi
  log "model: staging Nomic v1.5 (offline)…"
  mkdir -p "$RT/hf-cache"
  if [ -d "$HOME/.cache/huggingface/hub" ]; then
    rsync -a "$HOME/.cache/huggingface/hub" "$RT/hf-cache/"
  else
    HF_HOME="$RT/hf-cache" "$RT/python/bin/python3" - <<'PY'
from huggingface_hub import hf_hub_download
hf_hub_download("nomic-ai/nomic-embed-text-v1.5", "onnx/model_quantized.onnx")
hf_hub_download("nomic-ai/nomic-embed-text-v1.5", "tokenizer.json")
print("model warmed")
PY
  fi
  log "model: $(du -sh "$RT/hf-cache" | cut -f1)"
}

ensure_node
ensure_python
ensure_model

# ── 4. Build the portal UI ────────────────────────────────────────────────────
log "building portal…"
npm --prefix "$REPO/portal-app" run build >/dev/null

# ── 5. Assemble staging (code fresh each run; runtime bits from cache) ─────────
log "assembling $STAGE…"
rm -rf "$STAGE"; mkdir -p "$STAGE/pipeline"
rsync -a "$REPO/src/"               "$STAGE/src/"
rsync -a "$REPO/migrations/"        "$STAGE/migrations/" 2>/dev/null || true
rsync -a "$REPO/package.json"       "$STAGE/"
rsync -a "$REPO/portal-app/build/"  "$STAGE/portal-app/build/"
rsync -a "$REPO/node_modules/"      "$STAGE/node_modules/"
rsync -a --exclude '.venv' --exclude 'cache' --exclude '__pycache__' --exclude '*.pyc' \
         "$REPO/pipeline/"          "$STAGE/pipeline/"
cp "$RT/node" "$STAGE/node"; chmod +x "$STAGE/node"
rsync -a "$RT/python/"   "$STAGE/python/"
rsync -a "$RT/hf-cache/" "$STAGE/hf-cache/"

log "done. staging size: $(du -sh "$STAGE" | cut -f1)"
