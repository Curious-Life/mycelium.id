#!/usr/bin/env bash
# Create a git worktree with every heavy, REGENERABLE asset symlinked from one
# canonical checkout — so each worktree stays ~20-40 MB instead of ~3-6 GB.
#
# Without this, a fresh worktree gets its own copies of node_modules (~90 MB),
# portal-app/node_modules (~200 MB), pipeline/.venv (~760 MB) and .build-cache
# (~3 GB, the Nomic model + bundled runtime). Multiplied across worktrees that is
# how the disk filled up. Symlinks are transparent to node/python/builds.
#
# Usage:
#   scripts/new-worktree.sh <branch-name> [base-ref]
#     base-ref defaults to origin/main.
#
# The canonical asset source defaults to the sibling `mycelium.id` checkout (where
# the real copies live). Override with MYCELIUM_CANON=/path/to/checkout.
set -euo pipefail

BRANCH="${1:?usage: scripts/new-worktree.sh <branch-name> [base-ref]}"
BASE="${2:-origin/main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Resolve the GitHub root via the git COMMON dir, so this works whether run from a
# top-level checkout OR from inside an existing worktree (where REPO_ROOT/.. is the
# worktrees dir, not the GitHub root). common-dir → main repo → its parent.
COMMON="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$REPO_ROOT/$COMMON" ;; esac
MAIN_REPO="$(cd "$(dirname "$COMMON")" && pwd)"
GITHUB_ROOT="$(dirname "$MAIN_REPO")"
WT_DIR="$GITHUB_ROOT/mycelium-id-worktrees/${BRANCH##*/}"
# Canonical assets live in the public mycelium.id checkout (all real: node_modules,
# .build-cache, pipeline/.venv, portal-app/node_modules). Override with MYCELIUM_CANON.
CANON="${MYCELIUM_CANON:-$GITHUB_ROOT/mycelium.id}"

if [ ! -d "$CANON" ]; then
  echo "canonical checkout not found: $CANON (set MYCELIUM_CANON)" >&2
  exit 1
fi

git -C "$REPO_ROOT" fetch origin --quiet || true
git -C "$REPO_ROOT" worktree add "$WT_DIR" -b "$BRANCH" "$BASE"

for asset in node_modules portal-app/node_modules pipeline/.venv .build-cache; do
  src="$CANON/$asset"
  [ -e "$src" ] || continue
  mkdir -p "$(dirname "$WT_DIR/$asset")"
  rm -rf "$WT_DIR/$asset"
  ln -s "$src" "$WT_DIR/$asset"
  echo "  linked $asset -> $src"
done

echo "worktree ready: $WT_DIR  (branch $BRANCH off $BASE)"
