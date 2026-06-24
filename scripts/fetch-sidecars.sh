#!/usr/bin/env bash
# fetch-sidecars.sh — download the bundled sidecars per target triple into
# src-tauri/binaries/. Run BEFORE `cargo tauri build`.
#
#   frpc  : the FRP reverse-tunnel client (passthrough; frps does not decrypt)
#   caddy : built WITH the caddy-dns/acmedns plugin via Caddy's download API
#           (server-side custom build — no xcaddy/Go toolchain needed locally)
#
# Tauri's externalBin requires each binary to exist as `<name>-<target-triple>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$HERE/src-tauri/binaries"
mkdir -p "$BIN"

# Fail LOUD if a required tool is missing — esp. rustc, used just below for the
# target triple, which would otherwise die with a cryptic bash 127.
# shellcheck source=scripts/preflight.sh
source "$HERE/scripts/preflight.sh"
check_tools rustc curl tar awk

TRIPLE="$(rustc -Vv | awk -F': ' '/host/{print $2}')"
FRP_VERSION="${FRP_VERSION:-0.61.1}"

# Supply-chain: verify each downloaded sidecar against a pinned SHA-256, or (first
# run) print the hash to pin. A mismatch aborts — a backdoored TLS terminator must
# never reach the signed .app.
MANIFEST="$HERE/scripts/sidecar-checksums.txt"
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
verify_or_pin() {
  local file="$1" key="$2" got expected
  got="$(sha256_of "$file")"
  # Tolerate no-match / missing manifest under `set -o pipefail`: grep returns 1 on
  # no-match, which (with set -e) aborts the script on the FIRST (unpinned/TOFU) run —
  # the very run meant to print the hash to pin. awk exits 0 on no-match; `|| true`
  # additionally covers a missing manifest file.
  expected="$(awk -v k="$key" '$1==k{print $2}' "$MANIFEST" 2>/dev/null || true)"
  if [ -n "$expected" ]; then
    if [ "$got" != "$expected" ]; then echo "✗ CHECKSUM MISMATCH for $key — got $got, expected $expected (aborting)" >&2; rm -f "$file"; exit 1; fi
    echo "  ✓ checksum verified ($key)"
  else
    echo "  ⚠ no pinned checksum for $key (TOFU). After verifying provenance, pin it in scripts/sidecar-checksums.txt:" >&2
    echo "        $key $got" >&2
  fi
}

case "$TRIPLE" in
  aarch64-apple-darwin)      CADDY_OS=darwin; CADDY_ARCH=arm64; FRP_OS=darwin; FRP_ARCH=arm64 ;;
  x86_64-apple-darwin)       CADDY_OS=darwin; CADDY_ARCH=amd64; FRP_OS=darwin; FRP_ARCH=amd64 ;;
  x86_64-unknown-linux-gnu)  CADDY_OS=linux;  CADDY_ARCH=amd64; FRP_OS=linux;  FRP_ARCH=amd64 ;;
  aarch64-unknown-linux-gnu) CADDY_OS=linux;  CADDY_ARCH=arm64; FRP_OS=linux;  FRP_ARCH=arm64 ;;
  *) echo "unsupported target triple: $TRIPLE" >&2; exit 1 ;;
esac

echo "→ caddy (+caddy-dns/acmedns) for ${CADDY_OS}/${CADDY_ARCH}"
curl -fsSL "https://caddyserver.com/api/download?os=${CADDY_OS}&arch=${CADDY_ARCH}&p=github.com/caddy-dns/acmedns" -o "$BIN/caddy-$TRIPLE"
chmod +x "$BIN/caddy-$TRIPLE"
verify_or_pin "$BIN/caddy-$TRIPLE" "caddy-$TRIPLE"

echo "→ frpc ${FRP_VERSION} for ${FRP_OS}/${FRP_ARCH}"
TMP="$(mktemp -d)"
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${FRP_OS}_${FRP_ARCH}.tar.gz" -o "$TMP/frp.tgz"
tar -xzf "$TMP/frp.tgz" -C "$TMP"
cp "$TMP/frp_${FRP_VERSION}_${FRP_OS}_${FRP_ARCH}/frpc" "$BIN/frpc-$TRIPLE"
chmod +x "$BIN/frpc-$TRIPLE"
rm -rf "$TMP"
verify_or_pin "$BIN/frpc-$TRIPLE" "frpc-$TRIPLE"

echo "✓ sidecars ready in $BIN:"
ls -1 "$BIN" | sed 's/^/    /'
