#!/usr/bin/env bash
# scripts/sign-macos.sh — Developer-ID deep-sign the bundled Mycelium.app before
# notarization. REQUIRED because the app ships its own Node + relocatable Python
# (+ wheels) + native better_sqlite3.node under Contents/Resources/app/ — those
# are app *resources*, which Tauri does NOT sign, and notarization rejects any
# Mach-O that isn't signed with a Developer ID, the hardened runtime, and a
# secure timestamp. We find every Mach-O (by content, not extension — the bundled
# node/python binaries have no suffix), sign them inner-first, then sign the .app
# itself with the hardened-runtime entitlements. See
# docs/MAC-APP-RELEASE-RUNBOOK-2026-06-05.md §A.
#
# Usage:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     bash scripts/sign-macos.sh [path/to/Mycelium.app]
#
# Then: cargo tauri build already produced the .dmg, OR re-pack it; then
#   xcrun notarytool submit <dmg> --keychain-profile mycelium-notary --wait
#   xcrun stapler staple <dmg> && xcrun stapler staple <app>
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Mycelium.app}"
IDENTITY="${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to your 'Developer ID Application: Name (TEAMID)'}"
ENTITLEMENTS="${ENTITLEMENTS:-src-tauri/entitlements.plist}"

[ -d "$APP" ] || { echo "✗ app not found: $APP" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "✗ entitlements not found: $ENTITLEMENTS" >&2; exit 1; }
command -v codesign >/dev/null || { echo "✗ codesign not on PATH (install Xcode CLT)" >&2; exit 1; }

echo "→ deep-signing $APP"
echo "  identity:     $IDENTITY"
echo "  entitlements: $ENTITLEMENTS"

# 1. Sign nested code inner-first: any embedded .framework / nested .app bundles
#    first (so the container's seal covers a signed inner bundle), then every
#    loose Mach-O file (executables, .dylib, .so, .node).
sign_one() { codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@"; }

# Nested bundles (rare here — relocatable python is a dir tree, not a framework —
# but handle them if present), deepest path first.
find "$APP/Contents" \( -name "*.framework" -o -name "*.app" \) -print0 2>/dev/null \
  | awk 'BEGIN{RS="\0";ORS="\0"}{print length($0), $0}' | sort -z -rn | sed -z 's/^[0-9]* //' \
  | while IFS= read -r -d '' b; do sign_one "$b"; done

# Loose Mach-O files (content-detected — bundled node/python have no extension).
count=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then sign_one "$f"; count=$((count+1)); fi
done < <(find "$APP/Contents" -type f -print0)
echo "  signed $count nested Mach-O file(s)"

# 2. Sign the outer .app last, with the hardened-runtime entitlements.
codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

# 3. Verify the seal (strict, recursive).
echo "→ verifying"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "✓ signed. Next: notarize the .dmg (notarytool submit … --wait) then stapler staple the .dmg + .app."
