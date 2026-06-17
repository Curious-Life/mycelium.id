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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-src-tauri/target/release/bundle/macos/Mycelium.app}"
IDENTITY="${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to your 'Developer ID Application: Name (TEAMID)'}"
ENTITLEMENTS="${ENTITLEMENTS:-$HERE/src-tauri/entitlements.plist}"
# Child entitlements for the bundled interpreters (node, python3) — they run as
# their OWN processes, so hardened-runtime exceptions are NOT inherited from the
# .app and must be on their own signatures: V8's JIT (allow-jit /
# allow-unsigned-executable-memory) and python3's dlopen of wheel .so not signed
# by our Team ID (disable-library-validation). Signing them with --options
# runtime but no entitlements notarizes fine yet CRASHES at launch. The Go
# sidecars (caddy/frpc) need neither, so they get hardened runtime only.
ENT_CHILD="${ENT_CHILD:-$HERE/src-tauri/entitlements-child.plist}"

[ -d "$APP" ] || { echo "✗ app not found: $APP" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "✗ entitlements not found: $ENTITLEMENTS" >&2; exit 1; }
[ -f "$ENT_CHILD" ] || { echo "✗ child entitlements not found: $ENT_CHILD" >&2; exit 1; }
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
# node + python3* get the child entitlements; everything else (.dylib/.so/.node,
# caddy, frpc) gets hardened runtime only (least privilege). -type f skips the
# python3 → python3.12 symlink, so we match python3.* to catch the real binary.
count=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q "Mach-O" || continue
  case "${f##*/}" in
    node|python3|python3.*) sign_one --entitlements "$ENT_CHILD" "$f" ;;
    *)                      sign_one "$f" ;;
  esac
  count=$((count+1))
done < <(find "$APP/Contents" -type f -print0)
echo "  signed $count nested Mach-O file(s)"
[ "$count" -gt 0 ] || { echo "✗ found 0 nested Mach-O — enumeration is broken, aborting before a false-clean notarization" >&2; exit 1; }

# 2. Sign the outer .app last, with the hardened-runtime entitlements.
codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

# 3. Verify the seal (strict, recursive).
echo "→ verifying"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "✓ signed. Next: notarize the .dmg (notarytool submit … --wait) then stapler staple the .dmg + .app."
