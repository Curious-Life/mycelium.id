#!/usr/bin/env bash
# scripts/stage-hf-models.sh — stage ONLY the allowlisted HF models into a bundle cache.
#
#   stage-hf-models.sh <src-hub-dir> <dest-hf-cache-dir>
#
# WHY. build-app-bundle.sh used to `rsync -a` the operator's ENTIRE global
# ~/.cache/huggingface/hub into the .app. Whatever any experiment ever downloaded
# shipped inside every build: on 2026-07-16 that was ~15.5GB of concluded-eval
# Qwen3-TTS models, which made a 21GB .app, filled the disk to 0 twice, and broke
# an install halfway through. The bundle's contract is exactly ONE model — Nomic
# v1.5 for the offline first run (the embed service is the only consumer of the
# bundled HF_HOME; whisper deliberately uses the USER cache, see
# src/transcribe/supervisor.js:31).
#
# Behavior:
#   - copies only ALLOWLIST models from <src-hub-dir> (skips silently if absent —
#     the caller falls back to a targeted download)
#   - PRUNES anything not allowlisted already sitting in the dest (a previously
#     bloated build-staging self-heals instead of staying 20GB forever)
#   - idempotent; exits 0 even when the src hub is missing (fresh box)
set -euo pipefail

SRC_HUB="${1:?usage: stage-hf-models.sh <src-hub-dir> <dest-hf-cache-dir>}"
DEST="${2:?usage: stage-hf-models.sh <src-hub-dir> <dest-hf-cache-dir>}"

# The bundle's one offline-first-run model. Extend deliberately, never wholesale.
ALLOWLIST=(
  "models--nomic-ai--nomic-embed-text-v1.5"
)

mkdir -p "$DEST/hub"

# Prune: anything in dest/hub that isn't allowlisted goes (incl. stale .locks).
for d in "$DEST/hub"/* "$DEST/hub"/.locks; do
  { [ -e "$d" ] || [ -L "$d" ]; } || continue   # -L: a DANGLING symlink is not -e but must still be pruned
  base="$(basename "$d")"
  keep=0
  for a in "${ALLOWLIST[@]}"; do
    [ "$base" = "$a" ] && keep=1 && break
  done
  if [ "$keep" -eq 0 ]; then
    rm -rf "$d"
    echo "[stage-hf] pruned non-allowlisted: $base"
  fi
done

# Copy: allowlisted models only, when the source has them.
for a in "${ALLOWLIST[@]}"; do
  if [ -d "$SRC_HUB/$a" ]; then
    rsync -a "$SRC_HUB/$a" "$DEST/hub/"
    echo "[stage-hf] staged: $a"
  fi
done
exit 0
