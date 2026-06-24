#!/usr/bin/env bash
# Compile the Liquid Glass app icon (src-tauri/icons/Mycelium.icon) into the
# asset catalog (src-tauri/icons/Assets.car) that macOS 26 (Tahoe) reads to
# render the icon AND tint it live (Default / Dark / colorless-Tinted).
#
# Together with src-tauri/Info.plist (CFBundleIconName=Mycelium) and the
# tauri.conf `resources` entry "icons/Assets.car", every normal `cargo tauri
# build` ships the adaptive icon in BOTH the .app and the .dmg — so new users
# who install get the Liquid Glass icon that re-tints with system appearance.
#
# IMPORTANT: pass the .icon to actool DIRECTLY (NOT wrapped in an .xcassets) —
# wrapping it makes actool silently emit an empty catalog. The icon's runtime
# name is the .icon FILE basename ("Mycelium"), which is what CFBundleIconName
# must match. Assets.car is committed so builds work without full Xcode.
#
# Requires the FULL Xcode toolchain (actool), not just Command Line Tools:
#   sudo xcode-select -s /Applications/Xcode.app
#   sudo xcodebuild -runFirstLaunch      # one-time, if prompted
#
# Usage: scripts/gen-glass-assets.sh

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON="$REPO/src-tauri/icons/Mycelium.icon"
OUT="$REPO/src-tauri/icons/Assets.car"
ICON_NAME="$(basename "$ICON" .icon)"   # runtime icon name == CFBundleIconName

[[ -d "$ICON" ]] || { echo "error: missing $ICON"; exit 1; }

ACTOOL="$(/usr/bin/xcrun --find actool 2>/dev/null || true)"
if [[ -z "$ACTOOL" ]] || ! "$ACTOOL" --version >/dev/null 2>&1; then
  echo "error: actool unavailable (needs full Xcode). Run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch"
  exit 1
fi

WORK="$(/usr/bin/mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
"$ACTOOL" "$ICON" \
  --compile "$WORK" \
  --app-icon "$ICON_NAME" \
  --include-all-app-icons \
  --enable-icon-stack-fallback-generation=disabled \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --platform macosx \
  --minimum-deployment-target 26.0 \
  --output-partial-info-plist "$WORK/partial.plist" >/dev/null

[[ -f "$WORK/Assets.car" ]] || { echo "error: actool produced no Assets.car"; exit 1; }
cp "$WORK/Assets.car" "$OUT"
echo "✓ wrote $OUT ($(/usr/bin/stat -f%z "$OUT") bytes); CFBundleIconName=$ICON_NAME"
