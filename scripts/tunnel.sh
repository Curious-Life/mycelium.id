#!/usr/bin/env bash
# scripts/tunnel.sh — bring up a Cloudflare NAMED tunnel for the remote MCP server.
#
# A NAMED (account) tunnel — NOT a quick tunnel — is required: quick tunnels
# (`cloudflared tunnel --url`) give a random *.trycloudflare.com URL AND do not
# support SSE, which the Streamable-HTTP MCP transport needs (SSE keep-alive
# within 100s or Cloudflare 524s the stream). A named tunnel gives a STABLE
# hostname on your own domain + SSE. See docs/REMOTE-CONNECT-DESIGN + V1-SPEC §11.
#
# Prereqs:
#   - a Cloudflare account with your domain added to it
#   - cloudflared installed:  brew install cloudflared
#   - the Mycelium remote server running locally (Settings → Remote access →
#     Enable, then restart the app) so 127.0.0.1:4711 is up.
#
# Usage:
#   scripts/tunnel.sh <hostname>          e.g.  scripts/tunnel.sh mycelium.example.com
# Env overrides:
#   MYCELIUM_PORT (default 4711) · MYCELIUM_TUNNEL_NAME (default "mycelium")
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: scripts/tunnel.sh <hostname>   e.g.  scripts/tunnel.sh mycelium.yourdomain.com" >&2
  exit 2
fi
PORT="${MYCELIUM_PORT:-4711}"
NAME="${MYCELIUM_TUNNEL_NAME:-mycelium}"
CFDIR="$HOME/.cloudflared"

command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared not found — install it: brew install cloudflared" >&2; exit 1; }

# 1. One-time browser login — authorizes cloudflared for your Cloudflare account
#    + the zone (domain) you'll route under. Writes ~/.cloudflared/cert.pem.
if [ ! -f "$CFDIR/cert.pem" ]; then
  echo "→ One-time: a browser will open to authorize cloudflared with your Cloudflare account…"
  cloudflared tunnel login
fi

# 2. Create the named tunnel if it doesn't exist yet (idempotent).
if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$NAME"; then
  echo "→ Creating named tunnel '$NAME'…"
  cloudflared tunnel create "$NAME"
fi

# Resolve the tunnel UUID + its credentials file.
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n {print $1}')"
if [ -z "$UUID" ]; then echo "could not resolve tunnel UUID for '$NAME'" >&2; exit 1; fi
CREDS="$CFDIR/$UUID.json"

# 3. Route the hostname → this tunnel (creates the DNS CNAME under your zone).
echo "→ Routing https://$HOST → tunnel '$NAME'…"
cloudflared tunnel route dns "$NAME" "$HOST" || true   # idempotent; "already exists" is fine

# 4. Minimal ingress config: the hostname → the local MCP server; everything else 404.
cat > "$CFDIR/config.yml" <<YML
tunnel: $UUID
credentials-file: $CREDS
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YML

cat <<MSG

  ✓ Tunnel ready.
    Public URL  : https://$HOST   ← put this in Settings → Remote access → Public URL
    Connector   : https://$HOST/mcp   ← add THIS in Claude → Connectors
    Forwarding  : https://$HOST → http://127.0.0.1:$PORT

  Leave this process running while you use the connection. Ctrl-C to stop.

MSG

exec cloudflared tunnel run "$NAME"
