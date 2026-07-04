#!/usr/bin/env bash
# scripts/make-dmg.sh — build the *designed* Mycelium installer .dmg from a
# (already-signed/stapled) .app: on-brand background, fixed window bounds,
# 160pt icons, and the drag arrow layout (app icon → Applications folder).
#
# This is the ONLY place the shipped drag-to-Applications window is defined.
# `cargo tauri build` is invoked with `--bundles app` in the release workflow,
# so Tauri's own dmg bundler (and its tauri.conf.json bundle.macOS.dmg block)
# does NOT run for releases — this script owns the real installer window.
# (tauri.conf.json still carries a matching dmg block so a plain
# `cargo tauri build` locally produces the same design.)
#
# Layout MUST stay in sync with the art in assets/dmg/dmg-background.svg:
# the two icon slots there are drawn empty; Finder paints the real .app icon and
# the Applications-folder alias on top at APP_POS / APPS_POS below.
#
# Usage:  bash scripts/make-dmg.sh <path/to/Mycelium.app> <path/to/out.dmg>
# Requires: hdiutil + osascript (macOS, GUI session for the Finder arrange step).
set -euo pipefail

APP="${1:?usage: make-dmg.sh <App.app> <out.dmg>}"
DMG_OUT="${2:?usage: make-dmg.sh <App.app> <out.dmg>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BG_SRC="$HERE/assets/dmg/dmg-background.tiff"

[ -d "$APP" ]     || { echo "✗ app not found: $APP" >&2; exit 1; }
[ -f "$BG_SRC" ]  || { echo "✗ dmg background missing: $BG_SRC (run assets/dmg/build-dmg-background.sh)" >&2; exit 1; }
for t in hdiutil osascript ditto; do command -v "$t" >/dev/null || { echo "✗ missing tool: $t" >&2; exit 1; }; done

VOL="Mycelium"
APP_NAME="$(basename "$APP")"     # Mycelium.app

# ── window + icon layout (keep in lock-step with the background art) ──────────
WIN_X=460; WIN_Y=180; WIN_W=560; WIN_H=380
ICON_SIZE=160; TEXT_SIZE=13
APP_X=150;  APP_Y=172             # Mycelium.app icon centre
APPS_X=410; APPS_Y=172            # Applications alias centre
WIN_R=$((WIN_X + WIN_W)); WIN_B=$((WIN_Y + WIN_H))

# A volume named "$VOL" already mounted (a prior failed run, or the real
# installer open) would make hdiutil mount ours as "$VOL 1" — and the Finder
# script below, which addresses the disk by name, would then arrange the WRONG
# volume. Fail loud instead of silently designing someone else's disk image.
[ -e "/Volumes/$VOL" ] && { echo "✗ a volume named '$VOL' is already mounted (/Volumes/$VOL) — unmount it first: hdiutil detach '/Volumes/$VOL'" >&2; exit 1; }

# ── stage the volume contents ────────────────────────────────────────────────
# Init before the trap so an early failure (or set -u) never references an unset
# var, and so cleanup always detaches a mounted image even on the failure path.
STAGE=""; TMP_DMG=""; DEV=""
cleanup() { [ -n "$DEV" ] && hdiutil detach "$DEV" -force >/dev/null 2>&1 || true; rm -rf "$STAGE" "$TMP_DMG" 2>/dev/null || true; }
trap cleanup EXIT
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"
mkdir "$STAGE/.background"
cp "$BG_SRC" "$STAGE/.background/background.tiff"

# ── create a read/write image sized to content + slack for the .DS_Store ─────
SIZE_MB=$(( $(du -sm "$STAGE" | awk '{print $1}') + 64 ))
TMP_DMG="$(mktemp -u).dmg"
hdiutil create -srcfolder "$STAGE" -volname "$VOL" -fs HFS+ \
  -format UDRW -megabytes "$SIZE_MB" -ov "$TMP_DMG" >/dev/null

# ── mount, arrange with Finder, detach ───────────────────────────────────────
# Derive the ACTUAL mount point from the attach output rather than assuming
# /Volumes/$VOL; assert it's the fresh one so we never script a stray volume.
ATTACH="$(hdiutil attach -readwrite -noverify -noautoopen "$TMP_DMG")"
DEV="$(printf '%s\n' "$ATTACH" | grep -E '^/dev/' | head -1 | awk '{print $1}')"
MNT="$(printf '%s\n' "$ATTACH" | grep -Eo '/Volumes/.*$' | head -1)"
[ -n "$DEV" ] && [ "$MNT" = "/Volumes/$VOL" ] || { echo "✗ mounted at unexpected point: dev='$DEV' mnt='$MNT' (wanted /Volumes/$VOL)" >&2; exit 1; }
# give Finder a moment to register the new volume before scripting it
for _ in 1 2 3 4 5; do [ -d "$MNT" ] && break; sleep 1; done

osascript <<EOF
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {$WIN_X, $WIN_Y, $WIN_R, $WIN_B}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to $ICON_SIZE
    set text size of opts to $TEXT_SIZE
    set background picture of opts to file ".background:background.tiff"
    set position of item "$APP_NAME" of container window to {$APP_X, $APP_Y}
    set position of item "Applications" of container window to {$APPS_X, $APPS_Y}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF

sync
# Finder may still hold the volume for a beat after `close`; retry before the
# convert (a busy detach under set -e would otherwise abort mid-build).
for _ in 1 2 3 4 5; do hdiutil detach "$DEV" >/dev/null 2>&1 && { DEV=""; break; }; sleep 1; done
[ -z "$DEV" ] || { echo "✗ could not detach $DEV" >&2; exit 1; }

# ── convert to a compressed, distributable read-only image ───────────────────
mkdir -p "$(dirname "$DMG_OUT")"; rm -f "$DMG_OUT"
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null

echo "✓ designed dmg → $DMG_OUT"
