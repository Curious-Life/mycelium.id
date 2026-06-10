#!/usr/bin/env bash
# run-lab.sh — run the cluster lab against a BACKUP COPY of the live vault.
# Never touches the live DB. Keys come from the Keychain via keystore.js and
# travel only through env (never argv, never logs — CLAUDE.md §4).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

LIVE_DB="${LIVE_DB:-$HOME/Library/Application Support/id.mycelium.app/mycelium.db}"
WORK="${WORK:-/tmp/mycelium-cluster-lab}"
mkdir -p "$WORK"

[ -f "$LIVE_DB" ] || { echo "live vault not found: $LIVE_DB" >&2; exit 1; }

# Consistent snapshot even while the app is running.
sqlite3 "$LIVE_DB" ".backup '$WORK/vault-copy.db'"

# Pull keys from the Keychain (stdout captured into shell vars, not argv).
KEYS="$(node --input-type=module -e "
import { readUserMaster, deriveSystemKey } from './src/account/keystore.js';
const u = readUserMaster();
if (!u) { console.error('no user master in keychain'); process.exit(1); }
process.stdout.write(u + ' ' + deriveSystemKey(u));
")"
USER_MASTER="${KEYS%% *}"
SYSTEM_KEY="${KEYS##* }"

PYTHON="pipeline/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON="python3"

MYCELIUM_DB="$WORK/vault-copy.db" \
MYCELIUM_USER_ID="${MYCELIUM_USER_ID:-local-user}" \
USER_MASTER="$USER_MASTER" \
SYSTEM_KEY="$SYSTEM_KEY" \
exec "$PYTHON" pipeline/lab/cluster_lab.py "$@"
