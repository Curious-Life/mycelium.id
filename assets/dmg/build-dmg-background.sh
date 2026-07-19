#!/usr/bin/env bash
# assets/dmg/build-dmg-background.sh — render the macOS DMG installer background
# from its SVG source into the HiDPI TIFF that Tauri bundles.
#
#   dmg-background.svg  ──rsvg──▶  560x400 @72dpi  ┐
#                       ──rsvg──▶ 1120x800 @144dpi ┴─tiffutil─▶ dmg-background.tiff
#
# Why a multi-rep TIFF (not a plain PNG): macOS Finder paints a DMG background at
# its *point* size, unscaled. A bare 1120x800 PNG would render at 1120x800 POINTS
# and be clipped to the window's top-left quarter. The Apple-sanctioned retina
# vehicle is a HiDPI TIFF: a 560x400 base rep + a 1120x800 @2x rep combined with
# `tiffutil -cathidpicheck`, so the window is 560x400 pt and stays crisp on retina.
#
# The committed dmg-background.tiff is referenced by src-tauri/tauri.conf.json
# (bundle.macOS.dmg.background, path relative to src-tauri). Re-run this after
# editing the SVG, then commit the regenerated .tiff.
#
# Requires: librsvg (`brew install librsvg`) + macOS `sips`/`tiffutil` (built in).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v rsvg-convert >/dev/null || { echo "FATAL: rsvg-convert missing — run: brew install librsvg" >&2; exit 1; }

echo "[dmg-bg] rendering 1x (560x400) + 2x (1120x800) from SVG…"
rsvg-convert -w 560  -h 400 dmg-background.svg -o dmg-background.png
rsvg-convert -w 1120 -h 800 dmg-background.svg -o dmg-background@2x.png

echo "[dmg-bg] tagging DPI + combining into HiDPI TIFF…"
sips -s dpiWidth 72  -s dpiHeight 72  -s format tiff dmg-background.png    --out _bg-1x.tiff >/dev/null
sips -s dpiWidth 144 -s dpiHeight 144 -s format tiff dmg-background@2x.png --out _bg-2x.tiff >/dev/null
tiffutil -cathidpicheck _bg-1x.tiff _bg-2x.tiff -out dmg-background.tiff
rm -f _bg-1x.tiff _bg-2x.tiff

base=$(sips -g pixelWidth -g pixelHeight dmg-background.tiff | awk '/pixel/{print $2}' | paste -sd x -)
echo "[dmg-bg] done — dmg-background.tiff (base rep ${base}, +2x HiDPI companion)"
