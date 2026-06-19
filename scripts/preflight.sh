#!/usr/bin/env bash
# scripts/preflight.sh — SOURCED helper. Turns a missing build prerequisite into
# a loud, actionable error instead of a cryptic bash "command not found" (127).
#
# A fresh contributor without Rust used to get `cargo: command not found` (or,
# worse, `rustc: command not found` from fetch-sidecars.sh) with zero guidance.
# Source this and call `check_tools <tool>…` / `check_xcode_clt` up front.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/preflight.sh"
#   check_tools node npm curl rsync

_install_hint() {
  case "$1" in
    node|npm)        echo "Node >=22 — https://nodejs.org  (macOS: brew install node@22)";;
    rustc|cargo)     echo "Rust — curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   (then: source \$HOME/.cargo/env)";;
    cargo-tauri)     echo "Tauri CLI — cargo install tauri-cli --version '^2.0'";;
    curl)            echo "curl — preinstalled on macOS; Linux: apt-get install curl";;
    rsync)           echo "rsync — preinstalled on macOS; Linux: apt-get install rsync";;
    python3)         echo "Python >=3.10 — https://python.org  (macOS: brew install python@3.12)";;
    *)               echo "install '$1' and re-run";;
  esac
}

# check_tools <tool>…  — exits 1 (aborting the sourcing script) if any are missing.
check_tools() {
  local missing=0 t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 && continue
    echo "[mycelium] FATAL — '$t' is required but not on PATH." >&2
    echo "           install: $(_install_hint "$t")" >&2
    missing=1
  done
  [ "$missing" -eq 0 ] || exit 1
}

# macOS only: the Xcode Command Line Tools (needed to compile better-sqlite3 etc.)
check_xcode_clt() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  xcode-select -p >/dev/null 2>&1 && return 0
  echo "[mycelium] FATAL — Xcode Command Line Tools not installed." >&2
  echo "           install: xcode-select --install" >&2
  exit 1
}
