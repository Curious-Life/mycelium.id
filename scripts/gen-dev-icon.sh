#!/usr/bin/env bash
# scripts/gen-dev-icon.sh — regenerate the DEV-badged app icon set (src-tauri/icons-dev/).
#
# Takes the flat production icon (src-tauri/icons/icon.png) and overlays an elegant
# glassy violet "DEV" RIBBON tucked diagonally into the bottom-right corner (translucent
# + glossy sheen; re-applying the rounded-corner mask so the ribbon ends tuck under the
# squircle), then runs `cargo tauri icon` to emit the full set. The dev build (scripts/build-app-dev.sh)
# bundles src-tauri/icons-dev/icon.icns.
#
# SVG <text> rendering is unreliable in this ImageMagick build, so the ribbon is
# composited: a gradient strip + `-annotate` text (explicit font file) → rotated −45°
# → composited over the corner → re-clipped to the squircle mask.
#
# Requires: ImageMagick (magick), cargo-tauri, and the Arial Bold system font.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/src-tauri/icons/icon.png"
OUT="$REPO/src-tauri/icons-dev"
FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

command -v magick >/dev/null || { echo "error: ImageMagick (magick) required"; exit 1; }
[ -f "$FONT" ] || { echo "error: missing font $FONT"; exit 1; }
mkdir -p "$OUT"

# 1024 base (the committed flat icon is 512 → upscale), preserving the rounded alpha.
magick "$SRC" -resize 1024x1024 "$TMP/base.png"
magick "$TMP/base.png" -alpha extract "$TMP/mask.png"
# DEV ribbon: a gradient strip with spaced white "DEV", rotated into the bottom-right
# corner. Re-applying the squircle mask tucks the ribbon ends under the rounded edge.
# Glassy violet ribbon: translucent gradient (sky shows through faintly) + a glossy
# top sheen + a bright rim edge; the "DEV" text stays fully opaque for legibility.
magick -size 920x118 gradient:'#A684E0'-'#6B49A6' \
  -alpha set -channel A -evaluate multiply 0.78 +channel "$TMP/pg.png"
magick -size 920x118 gradient:'rgba(255,255,255,0.38)'-'rgba(255,255,255,0.02)' "$TMP/gloss.png"
magick "$TMP/pg.png" "$TMP/gloss.png" -compose over -composite \
  -fill 'rgba(255,255,255,0.55)' -draw 'rectangle 0,0 919,2' \
  -font "$FONT" -pointsize 66 -kerning 12 -fill white -gravity center -annotate +0+0 "DEV" \
  "$TMP/strip.png"
magick "$TMP/strip.png" -background none -rotate -45 "$TMP/strip_rot.png"
magick "$TMP/base.png" "$TMP/strip_rot.png" -gravity SouthEast -geometry +0+0 -composite "$TMP/rgb.png"
magick "$TMP/rgb.png" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$OUT/dev-1024.png"

cargo tauri icon "$OUT/dev-1024.png" -o "$OUT" >/dev/null
# Keep only the macOS essentials (cargo tauri icon also emits android/ios/windows bloat).
rm -rf "$OUT/android" "$OUT/ios"
rm -f "$OUT"/Square*Logo.png "$OUT/StoreLogo.png" "$OUT/icon.ico" "$OUT/icon.png" "$OUT/64x64.png"
echo "✓ wrote DEV-badged icon set → $OUT (icon.icns + pngs)"
