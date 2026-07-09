#!/usr/bin/env bash
# scripts/notarize-macos.sh — one-command post-build path to a notarized,
# stapled Mycelium.app + .dmg. Run AFTER `cargo tauri build`.
#
# Why a wrapper: `cargo tauri build` emits the .app and .dmg together, but it
# does NOT sign the bundled Node/Python/native binaries under Resources/app/
# (they're app resources, not sidecars), and the emitted .dmg wraps the
# unsigned .app. So the correct order is: deep-sign the .app → notarize+staple
# the .app → rebuild the .dmg from the stapled .app → notarize+staple the .dmg.
# See docs/MAC-APP-RELEASE-RUNBOOK-2026-06-05.md §A.
#
# Prereqs (one-time):
#   - "Developer ID Application" cert in the login keychain
#   - xcrun notarytool store-credentials "mycelium-notary" --apple-id … --team-id … --password <app-specific>
#
# Usage:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     bash scripts/notarize-macos.sh
#   # optional: NOTARY_PROFILE=mycelium-notary (default), APP=…, DMG_OUT=…
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP:-$HERE/src-tauri/target/release/bundle/macos/Mycelium.app}"
DMG_OUT="${DMG_OUT:-$HERE/src-tauri/target/release/bundle/dmg/Mycelium-notarized.dmg}"
PROFILE="${NOTARY_PROFILE:-mycelium-notary}"
: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to your 'Developer ID Application: Name (TEAMID)'}"

[ -d "$APP" ] || { echo "✗ app not found: $APP — run 'cargo tauri build' first" >&2; exit 1; }
for t in codesign xcrun ditto hdiutil; do command -v "$t" >/dev/null || { echo "✗ missing tool: $t" >&2; exit 1; }; done
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || { echo "✗ no notary profile '$PROFILE' — run: xcrun notarytool store-credentials \"$PROFILE\" --apple-id … --team-id … --password <app-specific>" >&2; exit 1; }

# 1. Deep-sign every nested Mach-O + the .app (hardened runtime + timestamp).
echo "── 1/4  deep-sign ──────────────────────────────────────────────"
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" bash "$HERE/scripts/sign-macos.sh" "$APP"

# 2. Notarize the .app (zip for submission) and staple.
echo "── 2/4  notarize .app ──────────────────────────────────────────"
ZIP="$(mktemp -d)/Mycelium.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"

# Free disk before the DMG image. The .app is now signed+notarized+stapled and
# fully self-contained; hdiutil needs ~1.5 GB of scratch to stage + compress the
# image, and on a macOS runner that just spent its headroom on notarization that
# tips into "hdiutil: create failed - No space left on device" (v0.1.5 build).
# Everything except the built bundle is dead weight now — drop the cargo target
# intermediates + node_modules to reclaim several GB. Best-effort; never fail here.
echo "── free disk before DMG (keep only the built bundle) ──"
df -h / | tail -1
( set +e
  find "$HERE/src-tauri/target" -mindepth 1 -maxdepth 1 ! -name release -exec rm -rf {} + 2>/dev/null
  find "$HERE/src-tauri/target/release" -mindepth 1 -maxdepth 1 ! -name bundle -exec rm -rf {} + 2>/dev/null
  rm -rf "$HERE/node_modules" "$HERE/portal-app/node_modules" 2>/dev/null
  true )
df -h / | tail -1

# 3. Build the DESIGNED distributable .dmg FROM the stapled .app — on-brand
#    background + drag-arrow layout (app icon → Applications). The window design
#    lives in scripts/make-dmg.sh (single source of truth for the installer view).
echo "── 3/4  build designed .dmg from stapled app ───────────────────"
bash "$HERE/scripts/make-dmg.sh" "$APP" "$DMG_OUT"
# Code-sign the DMG itself (Developer ID, secure timestamp). Notarizing an UNSIGNED
# dmg succeeds and staples, but `spctl --assess --context context:primary-signature`
# then rejects it (no primary signature to evaluate). Signing the disk image gives
# it a primary signature so Gatekeeper assessment passes. No --options runtime: a
# dmg is data, not executable code.
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG_OUT"

# 4. Notarize + staple the .dmg (so the disk image itself passes Gatekeeper).
echo "── 4/4  notarize .dmg ──────────────────────────────────────────"
xcrun notarytool submit "$DMG_OUT" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG_OUT"

echo ""
echo "✓ DONE → $DMG_OUT"
echo "  verify: spctl -a -t open --context context:primary-signature \"$DMG_OUT\"   # → accepted"
echo "          codesign --verify --deep --strict \"$APP\" && xcrun stapler validate \"$APP\""
