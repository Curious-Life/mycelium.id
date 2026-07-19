#!/usr/bin/env bash
# scripts/build-app-dev.sh — build (and install) the DEV variant of the desktop app.
#
#   npm run build:app:dev          # build + install "Mycelium Dev.app" to /Applications
#   npm run build:app:dev -- --no-install   # build only, don't touch /Applications
#
# The dev app coexists with the production Mycelium.app:
#   - productName  "Mycelium Dev"        → distinct name in Finder / Dock / menu bar
#   - identifier   id.mycelium.app.dev   → distinct LaunchServices identity + icon
#   - vault        the REAL production vault (id.mycelium.app). The Tauri shell
#                  (src-tauri/src/main.rs) detects the .dev build, redirects
#                  MYCELIUM_DATA_DIR to the production vault, AND sets
#                  MYCELIUM_SNAPSHOT_ON_BOOT=1 — so the dev app is the daily driver on
#                  your actual data while every schema change is snapshotted first
#                  (fail-closed; src/account/snapshot-on-boot.js). Run ONE at a time:
#                  dev + prod share the vault AND the ports (:8787).
#   - icon         glassy violet "DEV"   → instantly distinguishable
# Overrides live in src-tauri/tauri.conf.dev.json; the badged icons in src-tauri/icons-dev/
# (regenerate with scripts/gen-dev-icon.sh).
#
# Icon note (macOS 26 Tahoe): the production build ships a Liquid Glass icon via
# Assets.car + Info.plist CFBundleIconName=Mycelium, which would otherwise OVERRIDE our
# flat dev icns. So after the build we drop CFBundleIconName + Assets.car from the dev
# bundle → macOS falls back to CFBundleIconFile=icon.icns (= the DEV-badged icns), then
# we ad-hoc re-sign. (A glass dev icon is possible but not worth the fragility here.)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL=1
for a in "$@"; do case "$a" in --no-install) INSTALL=0;; -h|--help) sed -n '2,20p' "$0"; exit 0;; esac; done

APP_NAME="Mycelium Dev"
BUILT="$REPO/src-tauri/target/release/bundle/macos/${APP_NAME}.app"

# ── 0. Safety gate — the dev app runs against the REAL vault, so never INSTALL a
# build whose vault-integrity suites are red. Env-independent (no ML stack). Runs
# first so it fails before the multi-minute build. (--no-install skips the gate.)
if [ "$INSTALL" = 1 ]; then
  echo "[mycelium-dev] safety gate: vault-integrity verifies …"
  for s in snapshot-on-boot at-rest at-rest-migration at-rest-boot; do
    if ! node "$REPO/scripts/verify-$s.mjs" >"/tmp/devgate-$s.log" 2>&1; then
      echo "[mycelium-dev] FATAL — verify:$s is RED; refusing to install a dev build that runs on your real vault." >&2
      tail -8 "/tmp/devgate-$s.log" >&2
      exit 1
    fi
    echo "[mycelium-dev]   ✓ verify:$s"
  done
fi

# ── 1. Build with the dev config override (reuses the full prereq+stage pipeline) ──
echo "[mycelium-dev] building ${APP_NAME}.app …"
MYC_TAURI_CONFIG="$REPO/src-tauri/tauri.conf.dev.json" bash "$REPO/scripts/build-app.sh" "$@"

[ -d "$BUILT" ] || { echo "[mycelium-dev] FATAL — build produced no ${BUILT}" >&2; exit 1; }

# ── 2. Force the flat DEV icon (drop the Tahoe glass override) ──────────────────
echo "[mycelium-dev] applying the DEV icon (dropping glass Assets.car + CFBundleIconName)…"
rm -f "$BUILT/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$BUILT/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$BUILT/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon.icns" "$BUILT/Contents/Info.plist"
# Re-sign ad-hoc after mutating the bundle (codesign seals Info.plist + resources).
codesign --force --deep --sign - "$BUILT" >/dev/null 2>&1 || \
  echo "[mycelium-dev] WARNING — ad-hoc re-sign failed; the app may still launch (Gatekeeper: right-click → Open)."

echo "[mycelium-dev] ✓ built: $BUILT"

# ── 3. Install + refresh the icon cache ─────────────────────────────────────────
if [ "$INSTALL" = 1 ]; then
  DEST="/Applications/${APP_NAME}.app"
  echo "[mycelium-dev] installing → $DEST"
  rm -rf "$DEST"
  cp -R "$BUILT" "$DEST"
  # De-dupe the 4.2G embedding model: the dev app is a local-only daily driver, so
  # point its hf-cache at the production app's copy instead of shipping a second one.
  # Only when production is installed (else keep the bundled copy so dev still works).
  PROD_HF="/Applications/Mycelium.app/Contents/Resources/app/hf-cache"
  DEV_HF="$DEST/Contents/Resources/app/hf-cache"
  if [ -d "$PROD_HF" ] && [ -e "$DEV_HF" ] && [ ! -L "$DEV_HF" ]; then
    rm -rf "$DEV_HF" && ln -s "$PROD_HF" "$DEV_HF"
    echo "[mycelium-dev] de-duped embedding model → symlink to production hf-cache (saved ~4.2G)"
  fi
  # Re-sign after mutating the bundle (icon step below also signs, but the symlink lands here).
  codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true
  # Nudge the Finder/Dock icon cache so the new badge shows immediately.
  touch "$DEST"
  /usr/bin/touch "$DEST/Contents/Info.plist" 2>/dev/null || true
  killall Finder 2>/dev/null || true
  echo "[mycelium-dev] ✓ installed. Launch \"${APP_NAME}\" from /Applications — it uses your REAL vault + auto-snapshots before migrations. Quit production Mycelium first (they share the vault + ports)."
else
  echo "[mycelium-dev] (skipped install — open it from: $BUILT)"
fi
