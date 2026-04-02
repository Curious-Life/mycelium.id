# Centralized Secrets API — Implementation Plan

**Date**: March 6, 2026
**Status**: Proposed
**Depends on**: Encryption system (complete), Agent auth (complete), .env split (complete)

---

## Problem

Secrets are currently scattered across `.env.*` files on VPS, `wrangler secret` values in the Worker, and dashboard settings in Cloudflare/Discord/GitHub. This works for a single server with one operator, but breaks when scaling to:

- **Multiple servers** — secrets must be copied manually to each box
- **Team members** — sharing `.env` files is insecure and error-prone
- **Customer tenants** — each tenant needs isolated secrets for their agents
- **More agents** — each new agent needs tokens deployed to every server

## Design

A `/api/secrets` endpoint on the existing Cloudflare Worker that agents call at startup to fetch their configuration. Secrets are stored encrypted in D1 using the existing envelope encryption, scoped per-agent and per-tenant.

### Why not Cloudflare Secrets Store?

- Secrets Store only integrates with Workers — VPS agents can't pull from it
- No tenant isolation concept — it's account-level, not per-agent
- Still in beta with pricing TBD
- Our Worker already has auth, encryption, and scope isolation

### Why this approach works

- Reuses existing `AGENT_TOKEN` auth (no new credentials to distribute)
- Reuses existing AES-256-GCM envelope encryption (secrets encrypted at rest in D1)
- Each agent's `.env` shrinks to just 2 vars: `MYA_WORKER_URL` and `AGENT_TOKEN`
- Secret rotation = update D1 row, agents pick up changes on next restart
- Tenant isolation is built-in via `user_id` on `AgentIdentity`

---

## Architecture

```
AGENT STARTUP                          CLOUDFLARE WORKER

1. Read AGENT_TOKEN from .env
2. GET /api/secrets                    3. Authenticate (agent-auth.ts)
   Authorization: Bearer <token>       4. Look up agent identity + scopes
                                       5. Query D1 secrets table
                                          WHERE user_id = ? AND scope IN (?)
                                       6. Decrypt secret values (crypto.ts)
                                       7. Return { secrets: { KEY: "value" } }
8. Inject into process.env
9. Continue normal startup
```

---

## D1 Schema

### Migration: `migrations/091_secrets_store.sql`

```sql
-- Centralized secrets store
-- Secrets are encrypted at rest using envelope encryption (same as messages/documents)
CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- e.g. "DISCORD_BOT_TOKEN", "SUPABASE_URL"
  value TEXT NOT NULL,            -- Encrypted envelope (AES-256-GCM)
  scope TEXT NOT NULL DEFAULT 'org',  -- Encryption scope: personal | org | wealth
  user_id TEXT NOT NULL DEFAULT 'system',  -- Tenant isolation
  agent TEXT,                     -- NULL = available to all agents in scope; "personal-agent" = only Mya
  version INTEGER NOT NULL DEFAULT 1,  -- Monotonic version counter (for future rotation history)
  description TEXT,               -- Human-readable note
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(key, user_id, agent)    -- One value per key per tenant per agent
);

-- Index for the primary query pattern
CREATE INDEX IF NOT EXISTS idx_secrets_lookup ON secrets(user_id, scope);
```

> **Note on `version`**: Column is present from day 1 to avoid a future migration. v1 ignores it — the rotation API (v2) will increment it on each update and optionally retain previous versions for rollback.

### Key scoping rules

| `agent` value | Who receives it |
|---|---|
| `NULL` | All agents owned by `user_id` with matching scope |
| `"personal-agent"` | Only Mya |
| `"wealth-agent"` | Only Rob |

This means shared secrets (like `SUPABASE_URL`) have `agent = NULL`, while agent-specific secrets (like `DISCORD_MYA_BOT_TOKEN`) have `agent = "personal-agent"`.

---

## Worker Endpoint

### `GET /api/secrets`

**Auth**: Required (any auth type — agent token, session, or legacy)

**Response**:
```json
{
  "secrets": {
    "DISCORD_BOT_TOKEN": "actual-token-value",
    "SUPABASE_URL": "https://...",
    "MYA_WORKER_SECRET": "..."
  },
  "count": 3,
  "agent": "personal-agent",
  "scopes": ["personal", "org"]
}
```

**Logic**:
1. Authenticate request → get `AgentIdentity` (agent, user_id, scopes)
2. Query D1: `SELECT key, value, scope FROM secrets WHERE user_id = ? AND scope IN (?) AND (agent IS NULL OR agent = ?)`
3. Decrypt each `value` using `decrypt()` from `crypto.ts` with caller's allowed scopes
4. Return flat `{ secrets: { key: value } }` map

**Error cases**:
- 401 — invalid/missing token
- 500 — decryption failure (should not happen if scopes are consistent)

### `PUT /api/secrets`

**Auth**: Required, admin only (`agent === "admin"`)

**Body**:
```json
{
  "key": "DISCORD_MYA_BOT_TOKEN",
  "value": "new-token-value",
  "scope": "org",
  "agent": "personal-agent",
  "user_id": "system",
  "description": "Mya's Discord bot token"
}
```

**Logic**:
1. Require admin auth
2. Encrypt `value` using `encrypt()` with specified scope
3. Upsert into D1 (ON CONFLICT UPDATE)
4. Return `{ ok: true }`

### `DELETE /api/secrets/:key`

**Auth**: Required, **admin only** (`ADMIN_SECRET`). Agent tokens cannot delete secrets — a compromised agent must not be able to wipe its own configuration.

**Query params**: `?agent=personal-agent&user_id=system` (optional filters)

---

## Handler Implementation

### File: `worker/src/handlers/secrets-api.ts`

```typescript
import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { encrypt, decrypt, isEncrypted, type Scope } from "../services/crypto";
import { importMasterKey } from "../services/crypto";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";

export async function handleGetSecrets(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;
  const masterKey = await importMasterKey(env.ENCRYPTION_MASTER_KEY);

  // Build scope placeholders
  const scopePlaceholders = identity.scopes.map(() => "?").join(",");
  const query = `
    SELECT key, value, scope FROM secrets
    WHERE user_id = ?
      AND scope IN (${scopePlaceholders})
      AND (agent IS NULL OR agent = ?)
    ORDER BY key
  `;

  const params = [identity.user_id, ...identity.scopes, identity.agent];
  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Decrypt all values
  const secrets: Record<string, string> = {};
  for (const row of results || []) {
    const val = row.value as string;
    try {
      secrets[row.key as string] = isEncrypted(val)
        ? await decrypt(val, identity.scopes, masterKey)
        : val;
    } catch {
      // Skip secrets we can't decrypt (scope mismatch shouldn't happen
      // given the WHERE clause, but defensive)
    }
  }

  return new Response(JSON.stringify({
    secrets,
    count: Object.keys(secrets).length,
    agent: identity.agent,
    scopes: identity.scopes,
  }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export async function handlePutSecret(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;
  if (identity.agent !== "admin" && identity.agent !== "portal") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const body = await request.json() as {
    key: string;
    value: string;
    scope?: Scope;
    agent?: string | null;
    user_id?: string;
    description?: string;
  };

  if (!body.key || !body.value) {
    return new Response(JSON.stringify({ error: "key and value required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const scope = body.scope || "org";
  const userId = body.user_id || identity.user_id;
  const masterKey = await importMasterKey(env.ENCRYPTION_MASTER_KEY);
  const encryptedValue = await encrypt(body.value, scope, masterKey);

  await env.DB.prepare(`
    INSERT INTO secrets (key, value, scope, user_id, agent, version, description, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
    ON CONFLICT(key, user_id, agent) DO UPDATE SET
      value = excluded.value,
      scope = excluded.scope,
      version = secrets.version + 1,
      description = excluded.description,
      updated_at = datetime('now')
  `).bind(
    body.key,
    encryptedValue,
    scope,
    userId,
    body.agent ?? null,
    body.description ?? null,
  ).run();

  return new Response(JSON.stringify({ ok: true, key: body.key }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export async function handleDeleteSecret(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;
  if (identity.agent !== "admin" && identity.agent !== "portal") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const url = new URL(request.url);
  const agent = url.searchParams.get("agent") || null;
  const userId = url.searchParams.get("user_id") || "system";

  await env.DB.prepare(
    "DELETE FROM secrets WHERE key = ? AND user_id = ? AND (agent IS ? OR agent = ?)"
  ).bind(key, userId, agent, agent).run();

  return new Response(JSON.stringify({ ok: true, deleted: key }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}
```

---

## Agent Bootstrap

### File: `lib/bootstrap-secrets.js`

```javascript
/**
 * Bootstrap agent secrets from the centralized secrets API.
 * Call at startup before any other initialization.
 *
 * Requires: MYA_WORKER_URL and AGENT_TOKEN in environment.
 *
 * Failure behavior: throws on startup if Worker is unreachable.
 * Agents must NOT start with stale or missing secrets — fail loud.
 */

// In-memory cache for periodic refresh (not persisted to disk)
let secretsCache = null;
let cacheTimestamp = 0;

// Refresh interval: 5 min. All secrets refreshed together — the Worker
// call is cheap and splitting by category adds complexity for no benefit.
const REFRESH_INTERVAL = 5 * 60 * 1000;

export async function bootstrapSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;

  if (!workerUrl || !agentToken) {
    console.warn("[secrets] MYA_WORKER_URL or AGENT_TOKEN not set, skipping bootstrap");
    return;
  }

  const res = await fetch(`${workerUrl}/api/secrets`, {
    headers: { Authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    throw new Error(`[secrets] Worker returned ${res.status} — agent cannot start without secrets`);
  }

  const { secrets, count } = await res.json();
  secretsCache = secrets;
  cacheTimestamp = Date.now();

  // Inject into process.env (don't override existing values)
  let injected = 0;
  for (const [key, value] of Object.entries(secrets)) {
    if (!process.env[key]) {
      process.env[key] = value;
      injected++;
    }
  }

  console.log(`[secrets] Loaded ${count} secrets, injected ${injected} new env vars`);
}

/**
 * Refresh secrets from the API. Called every 5 min via setInterval.
 * In-memory only — never writes to disk.
 * Refreshes all secrets together (single cheap Worker call).
 */
export async function refreshSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  const now = Date.now();
  if (now - cacheTimestamp < REFRESH_INTERVAL) return;

  try {
    const res = await fetch(`${workerUrl}/api/secrets`, {
      headers: { Authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn(`[secrets] Refresh failed: ${res.status}, using cached values`);
      return;
    }

    const { secrets } = await res.json();
    secretsCache = secrets;
    cacheTimestamp = now;

    // Update process.env with new values
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }

    console.log(`[secrets] Refreshed ${Object.keys(secrets).length} secrets`);
  } catch (err) {
    console.warn(`[secrets] Refresh failed: ${err.message}, using cached values`);
    // Non-fatal on refresh — agent keeps running with cached secrets
  }
}
```

### Usage in agent startup

```javascript
// agent-server.js (top of file, before any other imports that use env vars)
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';

// Fail loud if Worker is unreachable — do NOT start with missing secrets
await bootstrapSecrets();

// Refresh all secrets every 5 min (single cheap Worker call)
setInterval(refreshSecrets, 5 * 60 * 1000);

// ... rest of agent initialization
```

---

## Migration Path

### Phase 1 — Deploy infrastructure (no agent changes)

1. Run migration `091_secrets_store.sql` against D1
2. Add handler to `worker/src/index.ts` (route `/api/secrets`)
3. Deploy Worker

### Phase 2 — Seed secrets from current .env files

Script to bulk-import existing secrets:

```bash
# Run from local machine with ADMIN_SECRET
WORKER="https://your-worker.workers.dev"
ADMIN_TOKEN="<admin-secret>"

# Read each .env.* file and push secrets (uses jq to safely escape values)
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  jq -n --arg k "$key" --arg v "$value" \
    '{key:$k, value:$v, scope:"org"}' | \
  curl -s -X PUT "$WORKER/api/secrets" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" -d @-
done < .env.discord
```

Agent-specific secrets need the `agent` field:

```bash
# Mya-specific secrets (jq handles escaping)
jq -n --arg v "actual-token-value" \
  '{key:"DISCORD_MYA_BOT_TOKEN", value:$v, scope:"org", agent:"personal-agent"}' | \
curl -X PUT "$WORKER/api/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d @-
```

### Phase 3 — Add bootstrap to agents (gradual rollout)

1. Add `bootstrapSecrets()` call to `agent-server.js`
2. Deploy to VPS
3. Verify agents start correctly and load secrets
4. Remove duplicated vars from `.env.*` files one at a time
5. Eventually each agent's `.env` is just `MYA_WORKER_URL` + `AGENT_TOKEN`

### Phase 4 — Multi-tenant support (future)

When onboarding a customer tenant:

1. Create a new `AGENT_TOKEN` for their agent
2. Add to `AGENT_REGISTRY` with their `user_id`
3. Seed their secrets via `PUT /api/secrets` with their `user_id`
4. Their agent boots with just `MYA_WORKER_URL` + `AGENT_TOKEN`
5. They only see their own secrets (D1 WHERE clause on `user_id`)

---

## Secret Categories & Scope Assignment

| Category | Scope | Agent | Example keys |
|---|---|---|---|
| Infrastructure (shared) | `org` | `NULL` | `SUPABASE_URL`, `MYA_WORKER_URL`, `SENTRY_DSN` |
| Discord bot tokens | `org` | per-agent | `DISCORD_MYA_BOT_TOKEN` → agent=personal-agent |
| API keys (external) | `org` | `NULL` | `CLOUDFLARE_STREAM_TOKEN`, `TELEGRAM_BOT_TOKEN` |
| Crypto/wallet keys | `wealth` | `wealth-agent` | `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` |
| Personal agent config | `personal` | `personal-agent` | Agent-specific settings |

---

## Security Properties

| Property | How |
|---|---|
| **Encrypted at rest** | All secret values stored as AES-256-GCM envelopes in D1 |
| **Scope isolation** | Agent only receives secrets matching its scopes |
| **Tenant isolation** | D1 WHERE clause on `user_id` — agents never see other tenants' secrets |
| **Auth required** | Every request authenticated via `agent-auth.ts` (timing-safe) |
| **Admin-only writes** | Only `admin` auth can create/update/delete secrets. Agent tokens are read-only. |
| **Transport encryption** | HTTPS to Cloudflare Worker (TLS 1.3) |
| **No secret on disk** | After migration, agents only store `AGENT_TOKEN` on disk |
| **No disk cache** | Secrets cached in-memory only. Process death = cache gone. No stale secrets on disk. |
| **Audit trail** | `created_at`/`updated_at` + `version` on every secret; Worker request logs |

### Encryption Key Location

The `ENCRYPTION_MASTER_KEY` used to encrypt/decrypt secret values lives as a **Cloudflare Worker secret** (deployed via `wrangler secret put ENCRYPTION_MASTER_KEY`). It is stored in Cloudflare's KMS, injected into the Worker at runtime, and **never touches disk** on the VPS or in any git repo. This is the root of trust for the entire system.

### Security Boundary: What's Left on Disk

After full migration, each agent's `.env` contains exactly 2 values:

| Value | Compromise impact |
|---|---|
| `MYA_WORKER_URL` | Public endpoint — not a secret. Useless alone. |
| `AGENT_TOKEN` | **Bootstrap token.** Exposes all secrets for that agent's scopes. |

**`AGENT_TOKEN` is the security boundary.** Compromise of a single agent's token exposes all secrets within that agent's scope (e.g., Mya's token → personal + org secrets, Rob's token → wealth + org secrets). It does NOT expose secrets in other scopes or other tenants' secrets.

Mitigations:
- `.env` files are `chmod 600` (owner-only read)
- VPS access requires SSH key
- Agent tokens can be rotated instantly via `AGENT_REGISTRY` Worker secret update + `pm2 restart`
- Per-agent tokens limit blast radius vs. the old single `MYA_WORKER_SECRET` that unlocked everything

### Single Point of Failure

The Worker + D1 is a SPOF for agent startup. If Cloudflare is down, no agent can boot.

Mitigations:
- **In-memory cache**: Running agents retain secrets in `process.env`. A Cloudflare outage doesn't affect already-running agents.
- **Periodic refresh**: Agents refresh all secrets every 5 min. A brief outage during refresh is non-fatal — agents keep cached values.
- **Fail loud on startup**: If the Worker is unreachable during initial bootstrap, the agent throws and does NOT start. This prevents agents from running with missing secrets, which would cause confusing downstream failures.
- **No disk fallback**: Agents never write fetched secrets to disk. This is intentional — a disk cache would persist stale secrets and reintroduce the "secrets on disk" problem we're solving.

---

## Rotation Workflow (post-migration)

Rotating a secret becomes:

```bash
# 1. Generate new value
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update in secrets store
curl -X PUT "$WORKER/api/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"DISCORD_MYA_BOT_TOKEN\",\"value\":\"$NEW_TOKEN\",\"scope\":\"org\",\"agent\":\"personal-agent\"}"

# 3. Restart affected agent (picks up new secret on boot)
ssh mycelium-vps "pm2 restart personal-agent"
```

No more editing `.env` files, no more `pm2 delete && pm2 start` dance.

---

## Implementation Effort

| Step | Effort | Blocks on |
|---|---|---|
| D1 migration | 5 min | Nothing |
| Worker handler + routing | 30 min | Migration |
| Deploy Worker | 5 min | Handler |
| Bootstrap lib | 15 min | Worker deployed |
| Failure-mode testing | 30 min | Bootstrap lib |
| Seed existing secrets | 30 min | Bootstrap tested |
| Gradual .env cleanup | 1 hr | Seeding verified |
| **Total** | **~3 hrs** | |

### Failure-mode test cases

- Worker unreachable at startup → agent throws, does not start
- Expired/invalid `AGENT_TOKEN` → 401, agent throws
- Worker unreachable during refresh → warns, keeps cached values
- Agent requests secret outside its scope → secret not included in response
- Admin rotates a secret → agent picks it up on next refresh cycle

---

## Decisions (resolved)

1. **Cache TTL**: All secrets refreshed every 5 min (single Worker call — no need for per-category TTLs). In-memory only — no disk cache, ever.

2. **Portal UI**: Not needed for v1. Admin manages secrets via `curl` or `wrangler d1 execute`. Portal UI is a v2 feature if needed.

3. **Secret versioning**: `version` column added to schema from day 1 (auto-incremented on upsert). v1 doesn't expose version history — the rotation API (v2) will optionally retain previous versions for rollback.

---

## Recovery & Onboarding

### What needs to be recoverable

With the secrets API, the entire system derives from **3 values**. Everything else is either in D1 (encrypted with the master key) or re-issuable from third-party dashboards (Discord, Telegram, etc.).

| Value | Where it lives | If lost |
|---|---|---|
| `ENCRYPTION_MASTER_KEY` | Cloudflare KMS (Worker secret) | All D1 data unrecoverable — messages, documents, AND secrets |
| `ADMIN_SECRET` | Cloudflare KMS (Worker secret) | Can't manage secrets via API. Fixable via `wrangler secret put`. |
| Cloudflare account access | Your login + 2FA | Can't access dashboard, KMS, or D1. Full system loss. |

`AGENT_TOKEN` values live in `AGENT_REGISTRY` (Worker secret) — recoverable if you have Cloudflare access. Discord/Telegram tokens can be re-issued from their dashboards. Database content is in D1, encrypted with the master key.

### Admin Recovery Kit (1Password)

Create a **Secure Note** in 1Password called **"Mycelium Recovery Kit"**:

```
── ROOT OF TRUST ──────────────────────────────────

ENCRYPTION_MASTER_KEY: <64-char hex>
ADMIN_SECRET: <token>

── CLOUDFLARE ACCESS ──────────────────────────────

Account Email: <email>
API Token: <token with Workers + D1 permissions>
Account ID: <id>
D1 Database: mycelium-db (<your-d1-database-id>)

── WORKER ─────────────────────────────────────────

Worker URL: https://your-worker.workers.dev
Worker Name: mya-worker

── AGENT REGISTRY ─────────────────────────────────

<paste full AGENT_REGISTRY JSON here>

── RECOVERY STEPS ─────────────────────────────────

1. Log into Cloudflare with account email
2. Verify Worker is deployed (Workers & Pages → mya-worker)
3. If Worker lost: cd worker && npx wrangler deploy
4. If secrets lost: re-seed from .env backups or re-issue from dashboards
5. If master key lost: DATA IS UNRECOVERABLE — restore from D1 backup
   (Cloudflare retains D1 backups, but encrypted data needs the key)
```

**Update this note whenever you rotate `ENCRYPTION_MASTER_KEY`, `ADMIN_SECRET`, or any agent token.**

With these values you can:
1. Log into Cloudflare → access D1 + redeploy Worker
2. Decrypt everything in D1 (master key)
3. Manage secrets via API (admin secret)
4. Re-bootstrap every agent (registry has all tokens)

### Tenant / New User Onboarding

When onboarding a new user or tenant, they receive exactly **2 values**:

```
MYA_WORKER_URL=https://your-worker.workers.dev
AGENT_TOKEN=<their-generated-token>
```

They save these in their own 1Password vault (or whatever they use), put them in `.env`, and their agent boots. The secrets API provides everything else.

#### Onboarding script: `scripts/onboard-tenant.sh`

```bash
#!/bin/bash
# Usage: ./onboard-tenant.sh <tenant_id> <agent_name> <scopes>
# Example: ./onboard-tenant.sh acme-corp acme-agent "org"

set -euo pipefail

TENANT_ID="${1:?Usage: onboard-tenant.sh <tenant_id> <agent_name> <scopes>}"
AGENT_NAME="${2:?}"
SCOPES="${3:-org}"
WORKER="${MYA_WORKER_URL:?Set MYA_WORKER_URL}"
ADMIN_TOKEN="${ADMIN_SECRET:?Set ADMIN_SECRET}"

# 1. Generate agent token
AGENT_TOKEN=$(openssl rand -hex 32)

echo "=== Mycelium Onboarding Kit ==="
echo ""
echo "Tenant:  $TENANT_ID"
echo "Agent:   $AGENT_NAME"
echo "Scopes:  $SCOPES"
echo ""
echo "── Save these in your .env ──"
echo ""
echo "MYA_WORKER_URL=$WORKER"
echo "AGENT_TOKEN=$AGENT_TOKEN"
echo ""
echo "── Admin action required ──"
echo ""
echo "Add this entry to AGENT_REGISTRY (wrangler secret):"
echo ""

# Build registry entry
jq -n --arg token "$AGENT_TOKEN" \
      --arg agent "$AGENT_NAME" \
      --arg name "$AGENT_NAME" \
      --arg user_id "$TENANT_ID" \
      --arg scopes "$SCOPES" \
  '{($token): {agent: $agent, name: $name, user_id: $user_id, scopes: ($scopes | split(","))}}' | \
  jq -r 'to_entries[] | "  \"\(.key)\": \(.value | tojson)"'

echo ""
echo "Then seed their secrets:"
echo ""
echo "  # Example: shared infrastructure secrets for this tenant"
echo "  jq -n --arg v \"value\" '{key:\"SUPABASE_URL\",value:\$v,scope:\"org\",user_id:\"$TENANT_ID\"}' | \\"
echo "    curl -X PUT \"$WORKER/api/secrets\" -H \"Authorization: Bearer $ADMIN_TOKEN\" -H \"Content-Type: application/json\" -d @-"
echo ""
echo "=== Done ==="
```

#### Onboarding flow

1. **Admin** runs `./scripts/onboard-tenant.sh acme-corp acme-agent org`
2. **Admin** adds the generated token to `AGENT_REGISTRY` via `wrangler secret put`
3. **Admin** seeds the tenant's secrets via `PUT /api/secrets` with their `user_id`
4. **Tenant** receives 2 values (via 1Password shared vault, secure message, etc.)
5. **Tenant** puts values in `.env`, starts their agent
6. Agent calls `GET /api/secrets` → gets only their secrets (D1 `WHERE user_id = ?`)

### Recovery scenarios

| Scenario | Recovery path |
|---|---|
| VPS dies | Spin up new server. Copy `MYA_WORKER_URL` + `AGENT_TOKEN` from 1Password. Agent boots and pulls all secrets from API. |
| Cloudflare outage | Running agents unaffected (in-memory cache). Wait for recovery, then restart any crashed agents. |
| Master key compromised | Generate new key, re-encrypt all D1 data using `rotateEnvelope()` from `crypto.ts`, update 1Password. |
| Admin loses laptop | Log into 1Password from another device → recovery kit has everything. |
| Tenant leaves | Delete their secrets (`DELETE /api/secrets/*?user_id=<tenant>`), remove their token from `AGENT_REGISTRY`. |
| Need to move to new cloud | Export D1, deploy Worker elsewhere, update `MYA_WORKER_URL`. Agents just need the new URL. |
