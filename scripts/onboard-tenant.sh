#!/bin/bash
# Usage: ./onboard-tenant.sh <tenant_id> <agent_name> <scopes>
# Example: ./onboard-tenant.sh acme-corp acme-agent "org"
#
# Generates a new AGENT_TOKEN, prints the onboarding kit,
# and shows the admin steps to register the tenant.

set -euo pipefail

TENANT_ID="${1:?Usage: onboard-tenant.sh <tenant_id> <agent_name> <scopes>}"
AGENT_NAME="${2:?}"
SCOPES="${3:-org}"
WORKER="${MYA_WORKER_URL:?Set MYA_WORKER_URL}"

# 1. Generate agent token
AGENT_TOKEN=$(openssl rand -hex 32)

echo "=== Mycelium Onboarding Kit ==="
echo ""
echo "Tenant:  $TENANT_ID"
echo "Agent:   $AGENT_NAME"
echo "Scopes:  $SCOPES"
echo ""
echo "── Save these in your .env (or 1Password) ──"
echo ""
echo "MYA_WORKER_URL=$WORKER"
echo "AGENT_TOKEN=$AGENT_TOKEN"
echo ""
echo "── Admin action required ──"
echo ""
echo "1. Add this entry to AGENT_REGISTRY (wrangler secret):"
echo ""

# Build registry entry
jq -n --arg token "$AGENT_TOKEN" \
      --arg agent "$AGENT_NAME" \
      --arg name "$AGENT_NAME" \
      --arg user_id "$TENANT_ID" \
      --arg scopes "$SCOPES" \
  '{($token): {agent: $agent, name: $name, user_id: $user_id, scopes: ($scopes | split(","))}}' | \
  jq -c '.'

echo ""
echo "2. Merge the above into the existing AGENT_REGISTRY JSON, then:"
echo "   cd worker && echo '<merged-json>' | npx wrangler secret put AGENT_REGISTRY"
echo ""
echo "3. Seed their secrets:"
echo "   export ADMIN_SECRET=<your-admin-secret>"
echo "   jq -n --arg v \"value\" '{key:\"SUPABASE_URL\",value:\$v,scope:\"org\",user_id:\"$TENANT_ID\"}' | \\"
echo "     curl -X PUT \"$WORKER/api/secrets\" -H \"Authorization: Bearer \$ADMIN_SECRET\" -H \"Content-Type: application/json\" -d @-"
echo ""
echo "=== Done ==="
