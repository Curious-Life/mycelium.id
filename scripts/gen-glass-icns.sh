#!/usr/bin/env bash
# Render the Liquid Glass app icon (src-tauri/icons/Mycelium.icon) to the flat
# raster icon set that Tauri bundles — so every `cargo tauri build` (and every
# .dmg new users install) ships the glass-look icon. No build-pipeline changes.
#
# Why bake instead of ship the .icon directly: macOS 26's *dynamic* glass/tint
# needs a compiled Assets.car, and actool/Xcode 26.5 on this machine will not
# compile a macOS .icon into one (verified — even Apple's own sample .icon yields
# no car). So we render the .icon's macOS "Default" appearance — which already
# carries the glass material (specular, depth, edge light) — to PNG and feed it
# through `cargo tauri icon`. The icon LOOKS like the Icon Composer design; it
# just won't re-tint live with system appearance settings. Re-run when the .icon
# (or assets/mushroom.svg) changes. Mycelium.icon stays the source of truth.
#
# Requires Icon Composer (ships with Xcode) for `ictool`, and `cargo tauri`.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON="$REPO/src-tauri/icons/Mycelium.icon"
ICTOOL="${ICTOOL:-/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool}"
# Squircle rendered at this size, then centred in a 1024 transparent canvas so the
# .icns gets the standard macOS icon margin (~10%). 824/1024 matches Apple's grid.
INNER=824

[[ -d "$ICON" ]] || { echo "error: missing $ICON"; exit 1; }
[[ -x "$ICTOOL" ]] || { echo "error: ictool not found at $ICTOOL (set ICTOOL=…). Needs Xcode + Icon Composer."; exit 1; }

WORK="$(/usr/bin/mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "Rendering macOS Default (glass) at ${INNER}px…"
"$ICTOOL" "$ICON" --export-image --output-file "$WORK/inner.png" \
  --platform macOS --rendition Default --width "$INNER" --height "$INNER" --scale 1 >/dev/null

# Pad to a 1024 transparent square (centred) → proper macOS icon margin.
/usr/bin/sips --padToHeightWidth 1024 1024 "$WORK/inner.png" --out "$WORK/master.png" >/dev/null
echo "Master: $(/usr/bin/sips -g pixelWidth -g pixelHeight "$WORK/master.png" | /usr/bin/tail -2 | tr '\n' ' ')"

echo "Regenerating src-tauri/icons/* via cargo tauri icon…"
( cd "$REPO/src-tauri" && cargo tauri icon "$WORK/master.png" >/dev/null )
# This repo is desktop-only; drop the mobile sets cargo-tauri also emits.
rm -rf "$REPO/src-tauri/icons/android" "$REPO/src-tauri/icons/ios"
echo "✓ glass icon rasters written (icon.icns, icon.ico, *.png + Windows Square*)."
