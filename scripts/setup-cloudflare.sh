#!/usr/bin/env bash
set -euo pipefail

# setup-cloudflare.sh — Create all Cloudflare resources for a new Mycelium instance
#
# Usage:
#   bash scripts/setup-cloudflare.sh [--name mycelium]
#
# Prerequisites:
#   - wrangler installed (npm i -g wrangler)
#   - wrangler login completed
#
# What this script does:
#   1. Creates D1 database
#   2. Creates Vectorize indexes (semantic search + clustering)
#   3. Creates R2 bucket
#   4. Creates KV namespace
#   5. Creates Queues (Telegram async processing)
#   6. Generates wrangler.toml with correct resource IDs
#   7. Runs database migrations
#   8. Generates agent tokens + AGENT_REGISTRY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$ROOT_DIR/worker"

# Defaults
PROJECT_NAME="mycelium"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) PROJECT_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--name project-name]"
      echo "  --name  Project name prefix for Cloudflare resources (default: mycelium)"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

DB_NAME="${PROJECT_NAME}-db"
SEARCH_INDEX="${PROJECT_NAME}-search"
CLUSTER_INDEX="${PROJECT_NAME}-cluster"
BUCKET_NAME="${PROJECT_NAME}-attachments"
QUEUE_NAME="${PROJECT_NAME}-telegram"

echo "================================================"
echo "  Mycelium — Cloudflare Resource Setup"
echo "================================================"
echo ""
echo "  Project name: $PROJECT_NAME"
echo "  Working in:   $WORKER_DIR"
echo ""

# Check wrangler
if ! command -v wrangler &>/dev/null && ! npx wrangler --version &>/dev/null 2>&1; then
  echo "ERROR: wrangler not found. Install with: npm i -g wrangler"
  exit 1
fi

WRANGLER="npx wrangler"

# ── 1. D1 Database ──────────────────────────────────────────────

echo "-> Creating D1 database: $DB_NAME"
D1_OUTPUT=$($WRANGLER d1 create "$DB_NAME" 2>&1) || true
D1_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' || echo "")

if [[ -z "$D1_ID" ]]; then
  # Maybe it already exists
  D1_ID=$($WRANGLER d1 list --json 2>/dev/null | jq -r ".[] | select(.name == \"$DB_NAME\") | .uuid" || echo "")
fi

if [[ -z "$D1_ID" ]]; then
  echo "   ERROR: Could not create or find D1 database. Check wrangler output:"
  echo "$D1_OUTPUT"
  exit 1
fi
echo "   D1 ID: $D1_ID"
echo ""

# ── 2. Vectorize Indexes ────────────────────────────────────────

echo "-> Creating Vectorize index: $SEARCH_INDEX (1024D, cosine)"
$WRANGLER vectorize create "$SEARCH_INDEX" --dimensions=1024 --metric=cosine 2>/dev/null || echo "   (may already exist)"

echo "-> Creating Vectorize index: $CLUSTER_INDEX (256D, cosine)"
$WRANGLER vectorize create "$CLUSTER_INDEX" --dimensions=256 --metric=cosine 2>/dev/null || echo "   (may already exist)"
echo ""

# ── 3. R2 Bucket ────────────────────────────────────────────────

echo "-> Creating R2 bucket: $BUCKET_NAME"
$WRANGLER r2 bucket create "$BUCKET_NAME" 2>/dev/null || echo "   (may already exist)"
echo ""

# ── 4. KV Namespace ─────────────────────────────────────────────

echo "-> Creating KV namespace: ${PROJECT_NAME}-kv"
KV_OUTPUT=$($WRANGLER kv namespace create "${PROJECT_NAME}-kv" 2>&1) || true
KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id\s*=\s*"\K[^"]+' || echo "")

if [[ -z "$KV_ID" ]]; then
  KV_ID=$($WRANGLER kv namespace list --json 2>/dev/null | jq -r ".[] | select(.title | contains(\"${PROJECT_NAME}-kv\")) | .id" || echo "")
fi

if [[ -z "$KV_ID" ]]; then
  echo "   WARNING: Could not determine KV namespace ID. You may need to set it manually in wrangler.toml."
else
  echo "   KV ID: $KV_ID"
fi
echo ""

# ── 5. Queues ────────────────────────────────────────────────────

echo "-> Creating Queue: $QUEUE_NAME"
$WRANGLER queues create "$QUEUE_NAME" 2>/dev/null || echo "   (may already exist)"

echo "-> Creating DLQ: ${QUEUE_NAME}-dlq"
$WRANGLER queues create "${QUEUE_NAME}-dlq" 2>/dev/null || echo "   (may already exist)"
echo ""

# ── 6. Generate wrangler.toml ────────────────────────────────────

TOML_PATH="$WORKER_DIR/wrangler.toml"
echo "-> Writing $TOML_PATH"

cat > "$TOML_PATH" <<TOML
name = "$PROJECT_NAME"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[limits]
cpu_ms = 30000

[ai]
binding = "AI"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "$BUCKET_NAME"

[[kv_namespaces]]
binding = "KV"
id = "${KV_ID:-REPLACE_WITH_KV_NAMESPACE_ID}"

[[queues.producers]]
binding = "TELEGRAM_QUEUE"
queue = "$QUEUE_NAME"

[[queues.consumers]]
queue = "$QUEUE_NAME"
max_batch_size = 1
max_batch_timeout = 0
max_retries = 2
dead_letter_queue = "${QUEUE_NAME}-dlq"

[[d1_databases]]
binding = "DB"
database_name = "$DB_NAME"
database_id = "$D1_ID"

[[vectorize]]
binding = "VECTORS_1024"
index_name = "$SEARCH_INDEX"

[[vectorize]]
binding = "VECTORS_256"
index_name = "$CLUSTER_INDEX"

[vars]
ENVIRONMENT = "production"
TOML

echo "   Done."
echo ""

# ── 7. Run Migrations ───────────────────────────────────────────

echo "-> Running D1 migrations..."
MIGRATION_DIR="$ROOT_DIR/migrations"
MIGRATION_COUNT=0
MIGRATION_ERRORS=0

for f in "$MIGRATION_DIR"/*.sql; do
  [[ -f "$f" ]] || continue
  BASENAME=$(basename "$f")
  echo -n "   $BASENAME... "
  if $WRANGLER d1 execute "$DB_NAME" --remote --file="$f" 2>/dev/null; then
    echo "ok"
    ((MIGRATION_COUNT++))
  else
    echo "FAILED (may be idempotent, continuing)"
    ((MIGRATION_ERRORS++))
  fi
done
echo "   Applied $MIGRATION_COUNT migrations ($MIGRATION_ERRORS skipped/failed)"
echo ""

# ── 8. Generate Agent Tokens ─────────────────────────────────────

echo "-> Generating agent tokens..."

AGENTS=("company-agent:Com:org" "personal-agent:Mya:personal,org")
REGISTRY="{"
ENV_LINES=""
FIRST=true

for entry in "${AGENTS[@]}"; do
  IFS=: read -r agent_id agent_name scopes <<< "$entry"
  TOKEN=$(openssl rand -hex 24)
  ENV_PREFIX=$(echo "$agent_name" | tr '[:lower:]' '[:upper:]')

  # Build scopes array
  SCOPES_JSON=$(echo "$scopes" | jq -R 'split(",")')

  if [[ "$FIRST" == true ]]; then
    FIRST=false
  else
    REGISTRY+=","
  fi

  REGISTRY+="\"$TOKEN\":{\"agent\":\"$agent_id\",\"name\":\"$agent_name\",\"user_id\":\"system\",\"scopes\":$SCOPES_JSON}"
  ENV_LINES+="AGENT_TOKEN_${ENV_PREFIX}=$TOKEN\n"

  echo "   $agent_name ($agent_id): $TOKEN"
done

REGISTRY+="}"

echo ""
echo "-> Add these to your .env file:"
echo ""
echo -e "$ENV_LINES"

# Save registry to temp file for wrangler secret put
REGISTRY_FILE=$(mktemp)
echo "$REGISTRY" > "$REGISTRY_FILE"
echo "-> Agent registry JSON saved to: $REGISTRY_FILE"
echo "   To set as Worker secret:"
echo "   cat $REGISTRY_FILE | cd worker && npx wrangler secret put AGENT_REGISTRY"
echo ""

# ── 9. Generate other secrets ────────────────────────────────────

echo "-> Generating secrets..."
ADMIN_SECRET=$(openssl rand -hex 32)
WORKER_SECRET=$(openssl rand -hex 24)
USER_ID=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")

echo ""
echo "   Add these to your .env:"
echo ""
echo "   ADMIN_SECRET=$ADMIN_SECRET"
echo "   MYA_WORKER_SECRET=$WORKER_SECRET"
echo "   MYA_USER_ID=$USER_ID"
echo ""
echo "   Set these as Worker secrets:"
echo "   echo '$ADMIN_SECRET' | cd worker && npx wrangler secret put ADMIN_SECRET"
echo "   echo '$WORKER_SECRET' | cd worker && npx wrangler secret put MYA_WORKER_SECRET"
echo ""

# ── Summary ──────────────────────────────────────────────────────

echo "================================================"
echo "  Cloudflare setup complete!"
echo "================================================"
echo ""
echo "  Resources created:"
echo "    D1 Database:  $DB_NAME ($D1_ID)"
echo "    Vectorize:    $SEARCH_INDEX (1024D), $CLUSTER_INDEX (256D)"
echo "    R2 Bucket:    $BUCKET_NAME"
echo "    KV Namespace: ${KV_ID:-check wrangler.toml}"
echo "    Queues:       $QUEUE_NAME + DLQ"
echo ""
echo "  Next steps:"
echo "    1. Deploy worker:  cd worker && npx wrangler deploy"
echo "    2. Set secrets:    See commands above"
echo "    3. Configure VPS:  bash scripts/server-setup.sh"
echo "    4. Edit .env:      Add tokens + Worker URL"
echo "    5. Start agents:   pm2 start ecosystem.config.cjs"
echo ""
echo "  Full guide: docs/SELF-HOSTING.md"
echo ""
