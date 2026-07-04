#!/usr/bin/env bash
# Build the Tauri auto-updater artifact from the ALREADY-notarized+stapled .app:
#   1) Mycelium.app.tar.gz   — a tar of the notarized app (so the swapped app passes
#                              Gatekeeper on relaunch — this is why we do it AFTER
#                              notarize-macos.sh, not via Tauri's build-time
#                              createUpdaterArtifacts which would tar the ad-hoc app);
#   2) Mycelium.app.tar.gz.sig — an Ed25519 signature over the tarball (the Tauri
#                              updater key — SEPARATE from Apple codesigning);
#   3) latest.json           — the static manifest the app's updater endpoint serves.
#
# Fail-closed but graceful:
#   • pubkey still the placeholder  → the shipped app's updater is DORMANT, so skip
#     the artifacts (DMG-only release). Lets releases ship before the updater is set up.
#   • pubkey real but signing secret missing → REFUSE (a self-checking app with no
#     signed manifest is a broken/insecure state).
#
# Env: VER (app version), MYC_ARCH (default aarch64), TAURI_SIGNING_PRIVATE_KEY[_PASSWORD].
set -euo pipefail

VER="${VER:?VER (app version) required}"
ARCH="${MYC_ARCH:-aarch64}"
PLATFORM="darwin-${ARCH}"
REPO="Curious-Life/mycelium.id"
PLACEHOLDER="REPLACE_WITH_MINISIGN_PUBLIC_KEY"
APP="src-tauri/target/release/bundle/macos/Mycelium.app"
OUT="dist"

PUBKEY="$(node -p "require('./src-tauri/tauri.conf.json').plugins?.updater?.pubkey || ''" 2>/dev/null || echo '')"
if [ -z "$PUBKEY" ] || [ "$PUBKEY" = "$PLACEHOLDER" ]; then
  echo "▸ updater pubkey is unset/placeholder — DMG-only release, no updater artifacts."
  exit 0
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "ERROR: plugins.updater.pubkey is set but TAURI_SIGNING_PRIVATE_KEY is missing." >&2
  echo "       The shipped app self-checks for updates; refusing to publish without a" >&2
  echo "       signed latest.json (an unsigned/absent manifest can't be verified)." >&2
  exit 1
fi

[ -d "$APP" ] || { echo "ERROR: notarized app not found at $APP (run notarize-macos.sh first)" >&2; exit 1; }
# Fail closed: the app MUST be notarized+stapled before we tar it, else the swapped
# app is Gatekeeper-blocked on relaunch.
xcrun stapler validate "$APP"

mkdir -p "$OUT"
TARBALL="$OUT/Mycelium.app.tar.gz"
tar -czf "$TARBALL" -C "$(dirname "$APP")" "$(basename "$APP")"

# Ed25519-sign the tarball (writes $TARBALL.sig). Reads the key from the env vars.
cargo tauri signer sign "$TARBALL"
SIG="$(cat "$TARBALL.sig")"

URL="https://github.com/${REPO}/releases/download/v${VER}/Mycelium.app.tar.gz"
export NOTES="${RELEASE_NOTES:-Mycelium v${VER} — see the release page for details.}"
PUBDATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# signature = VERBATIM contents of the .sig (a path/URL does NOT work). JSON-encode
# the sig + notes so newlines/quotes are safe.
python3 - "$VER" "$PLATFORM" "$URL" "$PUBDATE" > "$OUT/latest.json" <<PY
import json, os, sys
ver, platform, url, pubdate = sys.argv[1:5]
sig = open("$TARBALL.sig", encoding="utf-8").read()
notes = os.environ.get("NOTES", "Mycelium v%s." % ver)
print(json.dumps({
    "version": ver,
    "notes": notes,
    "pub_date": pubdate,
    "platforms": {platform: {"signature": sig, "url": url}},
}, indent=2))
PY

echo "▸ wrote $OUT/latest.json + $TARBALL + $TARBALL.sig  (platform=$PLATFORM, v$VER)"
