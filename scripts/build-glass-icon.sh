#!/usr/bin/env bash
# Inject the macOS 26 (Tahoe) Liquid Glass app icon into a built Tauri .app.
#
# Tauri's bundler ships a flat .icns; it does NOT consume Icon Composer .icon
# files. macOS shows the Liquid Glass / system-tinted icon only when the app
# bundle carries a compiled asset catalog (Assets.car) with an AppIcon built
# from the .icon, plus CFBundleIconName in Info.plist. This script does exactly
# that, then re-signs the bundle.
#
# Run AFTER `cargo tauri build` (the .app must already exist). Idempotent.
#
# Requires the FULL Xcode toolchain (actool), not just Command Line Tools:
#   sudo xcode-select -s /Applications/Xcode.app
#   xcodebuild -runFirstLaunch         # one-time, if prompted
#
# Usage:
#   scripts/build-glass-icon.sh [path/to/Mycelium.app]
# If no path is given, it searches src-tauri/target/release/bundle/macos.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
ICON="$HERE/src-tauri/icons/Mycelium.icon"
DEPLOY_TARGET="26.0"

APP="${1:-}"
if [[ -z "$APP" ]]; then
  APP="$(/usr/bin/find "$HERE/src-tauri/target" -maxdepth 5 -name '*.app' -path '*bundle/macos*' 2>/dev/null | head -1)"
fi
[[ -n "$APP" && -d "$APP" ]] || { echo "error: no .app found — pass the path, or build first (cargo tauri build)"; exit 1; }
[[ -d "$ICON" ]] || { echo "error: missing $ICON"; exit 1; }

# Need full Xcode for actool.
ACTOOL="$(/usr/bin/xcrun --find actool 2>/dev/null || true)"
if [[ -z "$ACTOOL" ]] || ! "$ACTOOL" --version >/dev/null 2>&1; then
  echo "error: actool unavailable. Select full Xcode first:"
  echo "  sudo xcode-select -s /Applications/Xcode.app && xcodebuild -runFirstLaunch"
  exit 1
fi

echo "App:    $APP"
echo "Icon:   $ICON"

WORK="$(/usr/bin/mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
XCASSETS="$WORK/Assets.xcassets"
mkdir -p "$XCASSETS/AppIcon.icon"
cp -R "$ICON/." "$XCASSETS/AppIcon.icon/"
printf '{ "info" : { "author" : "xcode", "version" : 1 } }\n' > "$XCASSETS/Contents.json"

mkdir -p "$WORK/car"
"$ACTOOL" "$XCASSETS" \
  --compile "$WORK/car" \
  --app-icon AppIcon \
  --platform macosx \
  --minimum-deployment-target "$DEPLOY_TARGET" \
  --output-partial-info-plist "$WORK/partial.plist" \
  --enable-on-demand-resources NO >/dev/null

RES="$APP/Contents/Resources"
cp "$WORK/car/Assets.car" "$RES/Assets.car"
# CFBundleIconName tells macOS to use the AppIcon in the asset catalog.
/usr/bin/plutil -replace CFBundleIconName -string AppIcon "$APP/Contents/Info.plist"

# Re-sign (ad-hoc by default; pass your identity in env CODESIGN_ID to use a real one).
codesign --force --deep --sign "${CODESIGN_ID:--}" "$APP" >/dev/null 2>&1 || \
  codesign --force --sign "${CODESIGN_ID:--}" "$APP"

echo "✓ Liquid Glass icon injected + app re-signed."
echo "  Verify: drag $APP to the Dock, or check Finder Get Info, on macOS 26."
