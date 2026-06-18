#!/usr/bin/env bash
# scripts/build-app-bundle.sh — assemble the self-contained runtime tree that
# `cargo tauri build` bundles into  Mycelium.app/Contents/Resources/app/.
#
# Output:  <repo>/build-staging/  — everything the packaged app needs at runtime
# with ZERO host prerequisites:
#   node                    bundled Node v22.x binary (target-arch)
#   python/bin/python3      relocatable python-build-standalone 3.12 + ALL wheels
#   hf-cache/hub/…          Nomic v1.5 ONNX model (offline first run, via HF_HOME)
#   node_modules/…          incl. the native better_sqlite3.node (HOST-arch)
#   src/ pipeline/ migrations/ package.json portal-app/build/
#
# The heavy runtime bits (Node binary, Python+wheels, model) are built ONCE into
# <repo>/.build-cache/runtime-<arch>/ and reused; only the app code re-syncs each
# run, so iterative `cargo tauri build`s stay fast. Wired as tauri.conf
# `build.beforeBuildCommand`. Verified relocatable by Spikes P + N
# (docs/DESIGN-packaged-app-distribution-2026-06-02.md).
#
# macOS, arm64 OR x86_64 — set MYC_ARCH (defaults to host). The bundled
# Node/Python/wheels + node_modules better_sqlite3.node are arch-specific and do
# NOT cross-compile: build each arch on a runner of that arch (Intel => macos-13,
# Apple Silicon => macos-14). node_modules is rsync'd from the host's npm install,
# so run `npm ci` on the target-arch runner before this script. Needs network at
# BUILD time (downloads + pip + npm) — never at the user's runtime.
# See docs/DESIGN-macos-signed-distribution-2026-06-17.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$REPO/build-staging"
CACHE="$REPO/.build-cache"

# ── Target architecture ───────────────────────────────────────────────────────
# Defaults to the host arch; override with MYC_ARCH=x86_64|arm64 to stage an
# Intel bundle on an Intel runner (native wheels + better_sqlite3.node + bundled
# Node/Python are arch-specific and DO NOT cross-compile — build each arch on a
# runner of that arch; see docs/DESIGN-macos-signed-distribution-2026-06-17.md).
MYC_ARCH="${MYC_ARCH:-$(uname -m)}"
case "$MYC_ARCH" in
  arm64|aarch64) MYC_ARCH=arm64;  PBS_ARCH=aarch64; NODE_ARCH=arm64 ;;
  x86_64|amd64)  MYC_ARCH=x86_64; PBS_ARCH=x86_64;  NODE_ARCH=x64   ;;
  *) echo "[build-app-bundle] FATAL — unsupported MYC_ARCH: $MYC_ARCH (want arm64|x86_64)" >&2; exit 1 ;;
esac
# Arch-scoped runtime cache so an arm64 cache never poisons an x86_64 build (and
# vice-versa) on a machine that builds both.
RT="$CACHE/runtime-${MYC_ARCH}"
# One-time migration: adopt the pre-arch-split cache (was $CACHE/runtime, always
# arm64) so existing arm64 dev machines don't re-download Node/Python + re-pip.
if [ "$MYC_ARCH" = arm64 ] && [ -d "$CACHE/runtime" ] && [ ! -d "$RT" ]; then
  mv "$CACHE/runtime" "$RT"
fi

PY_VER="3.12.13"; PBS_TAG="20260510"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PY_VER}%2B${PBS_TAG}-${PBS_ARCH}-apple-darwin-install_only.tar.gz"
NODE_VER="v22.22.3"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${NODE_ARCH}.tar.gz"

log(){ echo "[stage] $*"; }
mkdir -p "$CACHE" "$RT"

# ── 0. Liquid Glass app icon (Assets.car) ─────────────────────────────────────
# The committed Assets.car ships the adaptive Liquid Glass icon in every build
# (see src-tauri/Info.plist CFBundleIconName + tauri.conf resources). If full
# Xcode (actool) is present and Mycelium.icon is newer than the committed car,
# refresh it so the dev's build stays in sync; otherwise keep the committed car
# (no-Xcode builds still work).
refresh_glass_icon(){
  local icon="$REPO/src-tauri/icons/Mycelium.icon" car="$REPO/src-tauri/icons/Assets.car"
  [ -d "$icon" ] || { log "glass-icon: no Mycelium.icon, skipping"; return; }
  if /usr/bin/xcrun --find actool >/dev/null 2>&1 && /usr/bin/xcrun actool --version >/dev/null 2>&1; then
    if [ ! -f "$car" ] || [ "$icon" -nt "$car" ]; then
      log "glass-icon: regenerating Assets.car (icon changed)…"
      bash "$REPO/scripts/gen-glass-assets.sh"
    else
      log "glass-icon: Assets.car up to date"
    fi
  elif [ -f "$car" ]; then
    log "glass-icon: using committed Assets.car (full Xcode not selected)"
  else
    log "glass-icon: WARNING — no Assets.car and no actool; run: sudo xcode-select -s /Applications/Xcode.app && scripts/gen-glass-assets.sh"
  fi
}
refresh_glass_icon

# ── 1. Bundled Node binary (cached) ───────────────────────────────────────────
ensure_node(){
  if [ -x "$RT/node" ]; then log "node: cached ($("$RT/node" --version))"; return; fi
  log "node: downloading ${NODE_VER}…"
  local tgz="$CACHE/node-${NODE_VER}-${NODE_ARCH}.tar.gz"
  [ -f "$tgz" ] || curl -fsSL "$NODE_URL" -o "$tgz"
  local nx="$CACHE/node-x-${NODE_ARCH}"
  rm -rf "$nx"; mkdir -p "$nx"; tar -xzf "$tgz" -C "$nx"
  cp "$nx/node-${NODE_VER}-darwin-${NODE_ARCH}/bin/node" "$RT/node"; chmod +x "$RT/node"
  rm -rf "$nx"
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
  local tgz="$CACHE/pbs-${PY_VER}-${PBS_TAG}-${PBS_ARCH}.tar.gz"
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

# ── 4b. Deps-completeness preflight ───────────────────────────────────────────
# Fail LOUD if any declared dependency is missing from node_modules. Catches the
# class of bug where a dep is in package.json + lockfile but never actually
# installed (e.g. @better-auth/passkey), which would ship a bundle that crashes
# on boot for the code path that imports it. Cheap insurance before a ~1GB stage.
log "checking node_modules completeness…"
node -e '
  const fs = require("fs"), path = require("path");
  const repo = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies || {});
  const missing = deps.filter((d) => !fs.existsSync(path.join(repo, "node_modules", d, "package.json")));
  if (missing.length) {
    console.error("[build-app-bundle] FATAL — declared deps missing from node_modules: " + missing.join(", "));
    console.error("[build-app-bundle] run: npm install   (then rebuild)");
    process.exit(1);
  }
' "$REPO"

# ── 5. Assemble staging (code fresh each run; runtime bits from cache) ─────────
log "assembling ${STAGE}…"
rm -rf "$STAGE"; mkdir -p "$STAGE/pipeline"
rsync -a "$REPO/src/"               "$STAGE/src/"
rsync -a "$REPO/migrations/"        "$STAGE/migrations/" 2>/dev/null || true
rsync -a "$REPO/package.json"       "$STAGE/"
rsync -a "$REPO/portal-app/build/"  "$STAGE/portal-app/build/"
rsync -a "$REPO/node_modules/"      "$STAGE/node_modules/"
# Channel daemon (Telegram/Discord bridge) + any other workspace packages. The
# app supervises packages/channel-daemon/index.js (src/channels/supervisor.js);
# without this it isn't in the bundle and channels can never run. Exclude any
# nested node_modules (deps resolve from the top-level node_modules above).
rsync -a --exclude 'node_modules' --exclude '__tests__' --exclude '*.test.js' \
         "$REPO/packages/"          "$STAGE/packages/"
rsync -a --exclude '.venv' --exclude 'cache' --exclude '__pycache__' --exclude '*.pyc' \
         "$REPO/pipeline/"          "$STAGE/pipeline/"
cp "$RT/node" "$STAGE/node"; chmod +x "$STAGE/node"
rsync -a "$RT/python/"   "$STAGE/python/"
rsync -a "$RT/hf-cache/" "$STAGE/hf-cache/"

# Strip extended attributes (com.apple.provenance / quarantine / resource forks)
# from the staged tree. macOS adds these to files written by npm/curl/etc., and
# `codesign` rejects them with "resource fork, Finder information, or similar
# detritus not allowed" — which fails the WHOLE build at the signing step. This
# keeps the bundle reliably signable on any machine.
log "stripping xattrs from staging (codesign hygiene)…"
xattr -cr "$STAGE" 2>/dev/null || true

log "done. staging size: $(du -sh "$STAGE" | cut -f1)"
