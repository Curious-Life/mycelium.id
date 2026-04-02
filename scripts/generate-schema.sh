#!/usr/bin/env bash
# Dump the complete schema from the production D1 database.
# This is the single source of truth for fresh installs.
#
# Usage: bash scripts/generate-schema.sh
# Output: migrations/d1-schema-generated.sql
#
# Requires: wrangler CLI authenticated with Cloudflare

set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="mycelium-v2"
OUT="migrations/d1-schema-generated.sql"
WORKER_DIR="worker"

echo "==> Dumping schema from production D1 ($DB_NAME)..."

cd "$WORKER_DIR"

TABLES=$(npx wrangler d1 execute "$DB_NAME" --remote --command="SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '%_fts_%' AND name NOT LIKE '%_content' AND sql NOT LIKE '%virtual%' ORDER BY name" --json 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
(d[0]?.results||[]).forEach(r=>{if(r.sql)console.log(r.sql+';')});
")

INDEXES=$(npx wrangler d1 execute "$DB_NAME" --remote --command="SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' ORDER BY name" --json 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
(d[0]?.results||[]).forEach(r=>{if(r.sql)console.log(r.sql+';')});
")

TRIGGERS=$(npx wrangler d1 execute "$DB_NAME" --remote --command="SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name" --json 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
(d[0]?.results||[]).forEach(r=>{if(r.sql)console.log(r.sql+';')});
")

VIRTUAL=$(npx wrangler d1 execute "$DB_NAME" --remote --command="SELECT sql FROM sqlite_master WHERE type='table' AND sql LIKE '%virtual%' ORDER BY name" --json 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
(d[0]?.results||[]).forEach(r=>{if(r.sql)console.log(r.sql+';')});
")

cd ..

T_COUNT=$(echo "$TABLES" | grep -c "CREATE TABLE" || true)
I_COUNT=$(echo "$INDEXES" | grep -c "CREATE INDEX" || true)

cat > "$OUT" << HEADER
-- ============================================================================
-- Cloudflare D1 Schema for Mycelium (complete)
-- AUTO-GENERATED on $(date -u +%Y-%m-%d) from production database.
-- Regenerate: bash scripts/generate-schema.sh
--
-- Fresh install:
--   npx wrangler d1 execute <db-name> --remote --file=migrations/d1-schema-generated.sql
--
-- Also create via wrangler CLI:
--   npx wrangler vectorize create mycelium-search --dimensions=1024 --metric=cosine
--   npx wrangler vectorize create mycelium-cluster --dimensions=256 --metric=cosine
--   npx wrangler r2 bucket create mycelium-attachments
--   npx wrangler kv namespace create mycelium-kv
-- ============================================================================

HEADER

{
  echo "-- ── Tables ($T_COUNT) ─────────────────────────────────────────────────────"
  echo ""
  echo "$TABLES"
  echo ""
  echo "-- ── Indexes ($I_COUNT) ────────────────────────────────────────────────────"
  echo ""
  echo "$INDEXES"
  if [ -n "$TRIGGERS" ]; then
    echo ""
    echo "-- ── Triggers ────────────────────────────────────────────────────────────"
    echo ""
    echo "$TRIGGERS"
  fi
  if [ -n "$VIRTUAL" ]; then
    echo ""
    echo "-- ── Virtual Tables (FTS5) ─────────────────────────────────────────────"
    echo ""
    echo "$VIRTUAL"
  fi
} >> "$OUT"

echo ""
echo "==> Generated $OUT"
echo "    $T_COUNT tables, $I_COUNT indexes"

# Validate: apply to temp SQLite to confirm it works
TEMP_DB=$(mktemp /tmp/mycelium-validate-XXXXXX.db)
trap "rm -f $TEMP_DB" EXIT
if sqlite3 "$TEMP_DB" < "$OUT" 2>/dev/null; then
  VALIDATE_COUNT=$(sqlite3 "$TEMP_DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
  echo "    Validated: $VALIDATE_COUNT tables created successfully in temp SQLite"
else
  echo "    ⚠  Validation failed — schema may have D1-specific syntax"
fi
