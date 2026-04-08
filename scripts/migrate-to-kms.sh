#!/bin/bash
# Migrate existing master key from tmpfs to Swiss KMS.
#
# Idempotent: safe to run multiple times. Leaves tmpfs key as fallback
# until manually removed after verification.
#
# Prerequisites:
#   - KMS server running and accessible
#   - Admin client cert at $ADMIN_CERT_DIR/{admin.crt, admin.key, ca.crt}
#   - VPS client cert deployed to /etc/mycelium/kms-certs/
#   - Customer ID known (from MYA_USER_ID in .env)
#
# Usage: bash scripts/migrate-to-kms.sh <kms-url> <customer-id>
# Example: bash scripts/migrate-to-kms.sh https://185.x.x.x:8443 e524018a2dd3d249c6de

set -euo pipefail

KMS_URL="${1:?Usage: migrate-to-kms.sh <kms-url> <customer-id>}"
CUSTOMER_ID="${2:?Usage: migrate-to-kms.sh <kms-url> <customer-id>}"
ADMIN_CERT_DIR="${ADMIN_CERT_DIR:-./infomaniak-kms/certs}"
VPS_CERT_DIR="/etc/mycelium/kms-certs"
MASTER_KEY_PATH="/run/mycelium/master.key"

log() { echo "[migrate-kms] $*"; }
fail() { echo "[migrate-kms] FATAL: $*" >&2; exit 1; }

# ── Step 1: Read current master key from tmpfs ──
log "Reading master key from ${MASTER_KEY_PATH}..."
[ -f "$MASTER_KEY_PATH" ] || fail "No master key at ${MASTER_KEY_PATH}"
KEK_HEX=$(cat "$MASTER_KEY_PATH")
[ ${#KEK_HEX} -eq 64 ] || fail "Master key must be 64 hex chars (got ${#KEK_HEX})"
log "Master key loaded (${KEK_HEX:0:8}...)"

# ── Step 2: Store in KMS via POST /wrap (admin cert) ──
log "Storing KEK in KMS for customer ${CUSTOMER_ID}..."
WRAP_RESULT=$(curl -s --cert "${ADMIN_CERT_DIR}/admin.crt" \
  --key "${ADMIN_CERT_DIR}/admin.key" \
  --cacert "${ADMIN_CERT_DIR}/ca.crt" \
  -X POST "${KMS_URL}/wrap" \
  -H "Content-Type: application/json" \
  -d "{\"customerId\":\"${CUSTOMER_ID}\",\"kek\":\"${KEK_HEX}\"}" 2>&1)

echo "$WRAP_RESULT" | grep -q '"ok":true' || {
  # May already exist — check
  echo "$WRAP_RESULT" | grep -q "already exists" && log "KEK already in KMS (idempotent)" || fail "KMS wrap failed: ${WRAP_RESULT}"
}
log "KEK stored in KMS"

# ── Step 3: Verify round-trip (unwrap with VPS cert, compare) ──
log "Verifying round-trip..."
[ -f "${VPS_CERT_DIR}/client.crt" ] || fail "No VPS client cert at ${VPS_CERT_DIR}/client.crt"

UNWRAP_RESULT=$(curl -s --cert "${VPS_CERT_DIR}/client.crt" \
  --key "${VPS_CERT_DIR}/client.key" \
  --cacert "${VPS_CERT_DIR}/ca.crt" \
  -X POST "${KMS_URL}/unwrap" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1)

RETURNED_KEK=$(echo "$UNWRAP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('kek',''))" 2>/dev/null || true)
[ "$RETURNED_KEK" = "$KEK_HEX" ] || fail "Round-trip verification FAILED: KMS returned different key"
log "Round-trip verified — KEK matches"

# ── Step 4: Update .env with KMS env vars ──
log "Updating .env..."
ENV_FILE="${HOME}/mycelium/.env"

# Remove any existing KMS vars
sed -i '/^KMS_URL=/d; /^KMS_CERT_PATH=/d; /^KMS_TTL_HOURS=/d' "$ENV_FILE" 2>/dev/null || true

# Append KMS config
cat >> "$ENV_FILE" <<EOF

# Split-Jurisdiction KMS (Swiss KEK server)
KMS_URL=${KMS_URL}
KMS_CERT_PATH=${VPS_CERT_DIR}
KMS_TTL_HOURS=72
EOF

log ".env updated with KMS_URL=${KMS_URL}"

# ── Step 5: Restart agents ──
log "Restarting agents..."
cd ~/mycelium
pm2 delete personal-agent 2>/dev/null || true
pm2 start ecosystem.config.cjs --only personal-agent 2>/dev/null
sleep 3

# ── Step 6: Verify health ──
HEALTH=$(curl -sf http://127.0.0.1:3004/health 2>&1 || true)
echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Encryption: {d.get(\"checks\",{}).get(\"encryption\",\"unknown\")}')" 2>/dev/null || true

log ""
log "=== Migration complete ==="
log ""
log "The master key is now served from the Swiss KMS at ${KMS_URL}"
log "The tmpfs key at ${MASTER_KEY_PATH} is still in place as a FALLBACK."
log ""
log "After 48 hours of successful operation, remove the tmpfs fallback:"
log "  rm ${MASTER_KEY_PATH}"
log ""
log "To verify KMS is being used, check agent logs for:"
log "  '[crypto] Master key source: KMS (Swiss jurisdiction)'"

# Zero the KEK from shell memory
KEK_HEX=""
RETURNED_KEK=""
