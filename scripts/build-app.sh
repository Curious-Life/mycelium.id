#!/usr/bin/env bash
# scripts/build-app.sh — ONE command: fresh clone → built Mycelium desktop app.
#
# Replaces the 6-step manual gauntlet (install Rust → install cargo-tauri →
# portal build → fetch-sidecars → cargo tauri build) with a single entry point
# that CHECKS prerequisites with actionable errors. This is the fix for the
# "contributor without Rust ran the build and nothing happened" report.
#
#   npm run build:app            # build Mycelium.app (+ dmg)
#   npm run build:app -- --dev   # run the app (cargo tauri dev)
#   npm run build:app -- --yes   # non-interactive (auto-install Rust if missing)
#
# Normal END USERS don't run this — they download the notarized DMG. This is the
# CONTRIBUTOR / source-build path.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/preflight.sh
source "$REPO/scripts/preflight.sh"

DEV=0; YES=0
for a in "$@"; do case "$a" in --dev) DEV=1;; --yes|-y) YES=1;; -h|--help) sed -n '2,16p' "$0"; exit 0;; esac; done

echo "[mycelium] build-app — checking prerequisites…"
check_tools node npm curl rsync       # hard requirements (helpful error if missing)
check_xcode_clt                       # macOS: Xcode CLT (compiles native modules)

# ── Rust (cargo) — the prerequisite the tester was missing ────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  echo "[mycelium] Rust (cargo) is required to build the desktop app." >&2
  if [ "$YES" = 1 ] || [ -t 0 ]; then
    if [ "$YES" != 1 ]; then
      read -r -p "  Install Rust via rustup now? [Y/n] " ans
      case "$ans" in [Nn]*) echo "  aborted — install Rust, then re-run: $(_install_hint rustc)" >&2; exit 1;; esac
    fi
    echo "[mycelium] installing Rust via rustup…"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    echo "  install: $(_install_hint rustc)" >&2
    exit 1
  fi
fi
command -v cargo >/dev/null 2>&1 || {
  echo "[mycelium] FATAL — cargo still not on PATH. Open a new shell or run: source \$HOME/.cargo/env" >&2; exit 1; }

# ── Tauri CLI (cargo-tauri) — low-risk, auto-install ──────────────────────────
if ! command -v cargo-tauri >/dev/null 2>&1; then
  echo "[mycelium] installing the Tauri CLI (cargo install tauri-cli)…"
  cargo install tauri-cli --version '^2.0' --locked
fi

# ── npm deps + the canonical SvelteKit UI (idempotent) ────────────────────────
[ -d "$REPO/node_modules" ] || { echo "[mycelium] installing npm deps…"; ( cd "$REPO" && npm install ); }
# Build portal-app/build now so it's present for `cargo tauri dev` too (build
# uses build-app-bundle.sh's beforeBuildCommand, but dev has no such hook).
node "$REPO/scripts/ensure-portal-built.mjs"

# ── Sidecars (frpc + caddy) — REQUIRED before cargo tauri build ───────────────
echo "[mycelium] fetching sidecars (frpc + caddy)…"
bash "$REPO/scripts/fetch-sidecars.sh"

# ── Build (or run) ────────────────────────────────────────────────────────────
cd "$REPO"
if [ "$DEV" = 1 ]; then
  echo "[mycelium] launching the app (cargo tauri dev)…"
  exec cargo tauri dev
fi
echo "[mycelium] building the app (cargo tauri build)… this takes a few minutes"
cargo tauri build
echo "[mycelium] ✓ done — bundle(s):"
ls -d  "$REPO"/src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
ls     "$REPO"/src-tauri/target/release/bundle/dmg/*.dmg    2>/dev/null || true
