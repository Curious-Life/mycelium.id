#!/usr/bin/env bash
# scripts/claude-memory-sync.sh — share Claude Code's project memory across accounts +
# team members via this repo.
#
# Claude auto-loads/writes memory from a PER-ACCOUNT, PER-CLONE-PATH directory:
#     ~/.claude/projects/<path-hash>/memory/        (NOT in git, account-local)
# This script bridges that to the committed, team-shared source of truth:
#     <repo>/.claude/memory/                         (in git, travels to every clone)
#
# Usage:
#   bash scripts/claude-memory-sync.sh link    # RECOMMENDED, one-time per clone:
#                                              #   symlink the account dir → repo, so Claude
#                                              #   auto-loads shared memory AND every memory
#                                              #   it writes lands in the repo (git add/commit
#                                              #   to share). Backs up any existing dir first.
#   bash scripts/claude-memory-sync.sh pull    # copy repo → account memory (additive; load
#                                              #   shared memory without linking)
#   bash scripts/claude-memory-sync.sh push    # copy account memory → repo (capture memory
#                                              #   written before you linked; review + commit)
#   bash scripts/claude-memory-sync.sh status  # show both locations + whether linked
#
# The <path-hash> is derived from this clone's ABSOLUTE PATH (Claude's convention: '/' and
# '.' → '-'), so it's computed fresh for each team member's clone location.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/.claude/memory"
HASH="$(printf '%s' "$REPO" | sed 's|[/.]|-|g')"
DST="$HOME/.claude/projects/$HASH/memory"

mode="${1:-status}"
case "$mode" in
  link)
    mkdir -p "$SRC" "$(dirname "$DST")"
    if [ -L "$DST" ]; then echo "[claude-memory] already linked: $DST → $(readlink "$DST")"; exit 0; fi
    if [ -d "$DST" ] && [ -n "$(ls -A "$DST" 2>/dev/null || true)" ]; then
      bak="$DST.backup-$(date +%s 2>/dev/null || echo bak)"
      echo "[claude-memory] backing up existing account memory → $bak"
      mv "$DST" "$bak"
      echo "[claude-memory] (its contents are preserved there; 'push' first if any were unshared)"
    else
      rm -rf "$DST"
    fi
    ln -s "$SRC" "$DST"
    echo "[claude-memory] linked $DST → $SRC (auto-load + auto-commit; git add .claude/memory to share)"
    ;;
  pull)
    mkdir -p "$DST"
    rsync -a "$SRC/" "$DST/"   # additive — never deletes account-local-only memories
    echo "[claude-memory] pulled repo → $DST"
    ;;
  push)
    mkdir -p "$SRC"
    rsync -a "$DST/" "$SRC/"
    echo "[claude-memory] pushed $DST → $SRC — review 'git status' + commit to share"
    ;;
  status)
    echo "  repo (shared, committed): $SRC  ($(ls "$SRC"/*.md 2>/dev/null | wc -l | xargs) files)"
    echo "  account (auto-loaded):    $DST"
    if [ -L "$DST" ]; then echo "  → LINKED to $(readlink "$DST")"
    elif [ -d "$DST" ]; then echo "  → standalone dir ($(ls "$DST"/*.md 2>/dev/null | wc -l | xargs) files) — run 'link' to share"
    else echo "  → absent — run 'link' (or 'pull') to hydrate"; fi
    ;;
  *) echo "usage: $0 link|pull|push|status" >&2; exit 1;;
esac
