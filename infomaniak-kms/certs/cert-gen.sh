#!/bin/bash
# Generate mTLS certificates for the Mycelium KMS.
#
# Usage:
#   bash cert-gen.sh init                  # Generate CA + KMS server cert
#   bash cert-gen.sh admin                 # Generate admin client cert
#   bash cert-gen.sh client <customerId>   # Generate per-VPS client cert
#
# The CA key (ca.key) should be kept offline after initial generation.
# Only certs signed by this CA are accepted by the KMS server.

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAYS_CA=3650       # 10 years
DAYS_SERVER=365    # 1 year
DAYS_CLIENT=365    # 1 year

case "${1:-}" in
  init)
    echo "==> Generating CA certificate (RSA-4096, ${DAYS_CA} days)..."
    openssl genrsa -out "${CERT_DIR}/ca.key" 4096
    openssl req -new -x509 -days $DAYS_CA -key "${CERT_DIR}/ca.key" -out "${CERT_DIR}/ca.crt" \
      -subj "/CN=Mycelium KMS CA/O=Mycelium"
    chmod 400 "${CERT_DIR}/ca.key"
    echo "  CA: ${CERT_DIR}/ca.crt (public) + ${CERT_DIR}/ca.key (KEEP OFFLINE)"

    echo ""
    echo "==> Generating KMS server certificate (${DAYS_SERVER} days)..."
    openssl genrsa -out "${CERT_DIR}/server.key" 2048
    openssl req -new -key "${CERT_DIR}/server.key" -out "${CERT_DIR}/server.csr" \
      -subj "/CN=kms.mycelium.swiss/O=Mycelium"

    # Add SAN for IP-based access (common for VPS-to-VPS)
    cat > "${CERT_DIR}/server-ext.cnf" <<EOF
subjectAltName = DNS:kms.mycelium.swiss, IP:127.0.0.1
EOF
    openssl x509 -req -days $DAYS_SERVER -in "${CERT_DIR}/server.csr" \
      -CA "${CERT_DIR}/ca.crt" -CAkey "${CERT_DIR}/ca.key" -CAcreateserial \
      -out "${CERT_DIR}/server.crt" -extfile "${CERT_DIR}/server-ext.cnf"
    rm -f "${CERT_DIR}/server.csr" "${CERT_DIR}/server-ext.cnf"
    chmod 400 "${CERT_DIR}/server.key"
    echo "  Server: ${CERT_DIR}/server.crt + ${CERT_DIR}/server.key"

    echo ""
    echo "==> Done. Next steps:"
    echo "  1. Copy ca.key to offline storage (USB drive, 1Password)"
    echo "  2. Run: bash cert-gen.sh admin"
    echo "  3. For each VPS: bash cert-gen.sh client <customerId>"
    ;;

  admin)
    echo "==> Generating admin client certificate (${DAYS_CLIENT} days)..."
    openssl genrsa -out "${CERT_DIR}/admin.key" 2048
    openssl req -new -key "${CERT_DIR}/admin.key" -out "${CERT_DIR}/admin.csr" \
      -subj "/CN=kms-admin/O=Mycelium"
    openssl x509 -req -days $DAYS_CLIENT -in "${CERT_DIR}/admin.csr" \
      -CA "${CERT_DIR}/ca.crt" -CAkey "${CERT_DIR}/ca.key" -CAcreateserial \
      -out "${CERT_DIR}/admin.crt"
    rm -f "${CERT_DIR}/admin.csr"
    chmod 400 "${CERT_DIR}/admin.key"
    echo "  Admin: ${CERT_DIR}/admin.crt + ${CERT_DIR}/admin.key"
    echo "  CN=kms-admin (grants access to /wrap, /rotate, /delete endpoints)"
    ;;

  client)
    CUSTOMER_ID="${2:?Usage: cert-gen.sh client <customerId>}"
    CLIENT_DIR="${CERT_DIR}/clients/${CUSTOMER_ID}"
    mkdir -p "${CLIENT_DIR}"

    echo "==> Generating client certificate for ${CUSTOMER_ID} (${DAYS_CLIENT} days)..."
    openssl genrsa -out "${CLIENT_DIR}/client.key" 2048
    openssl req -new -key "${CLIENT_DIR}/client.key" -out "${CLIENT_DIR}/client.csr" \
      -subj "/CN=${CUSTOMER_ID}/O=Mycelium"
    openssl x509 -req -days $DAYS_CLIENT -in "${CLIENT_DIR}/client.csr" \
      -CA "${CERT_DIR}/ca.crt" -CAkey "${CERT_DIR}/ca.key" -CAcreateserial \
      -out "${CLIENT_DIR}/client.crt"
    rm -f "${CLIENT_DIR}/client.csr"
    cp "${CERT_DIR}/ca.crt" "${CLIENT_DIR}/ca.crt"
    chmod 400 "${CLIENT_DIR}/client.key"

    echo "  Client cert: ${CLIENT_DIR}/client.crt"
    echo "  Client key:  ${CLIENT_DIR}/client.key"
    echo "  CA cert:     ${CLIENT_DIR}/ca.crt"
    echo "  CN=${CUSTOMER_ID} (identifies this VPS to the KMS)"
    echo ""
    echo "  Deploy to VPS: scp ${CLIENT_DIR}/* claude@<vps-ip>:/etc/mycelium/kms-certs/"
    ;;

  *)
    echo "Usage:"
    echo "  bash cert-gen.sh init                  # Generate CA + server cert"
    echo "  bash cert-gen.sh admin                 # Generate admin client cert"
    echo "  bash cert-gen.sh client <customerId>   # Generate per-VPS client cert"
    exit 1
    ;;
esac
