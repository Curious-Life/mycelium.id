# Tenant Hardening Plan

**Date**: 2026-04-06
**Status**: Implementation plan
**Triggered by**: Multiple tenant isolation failures during managed hosting rollout

---

## Context

During the first managed hosting deployments, we discovered systemic issues with tenant data isolation, identity mapping, and deployment reliability. This plan addresses every failure mode encountered and prevents them from recurring.

### Failures encountered (2026-04-06)

| Failure | Root Cause | Impact |
|---------|-----------|--------|
| User @martin's data visible on 0mm portal | All VPS queried same D1, no tenant routing | Cross-tenant data exposure |
| Wrong handle shown on 0mm login page | DNS CNAME pointed to wrong VPS | Wrong user identity displayed |
| Swapped user IDs between marti and 0mm VPS | Manual .env setup, no verification | Tenant D1 routed to wrong database |
| First-login returned 500 | provisioning_jobs queried from empty tenant D1 | User couldn't authenticate |
| Setup token shown instead of master key form | checkFirstRun() found 0 users in fresh D1 | Wrong auth flow presented |
| Passkey registration failed with origin mismatch | PASSKEY_RP_ORIGIN set to wrong subdomain | User couldn't complete registration |
| Foreign key error on registration_token INSERT | User record not created before token | 500 on first login |
| ADMIN_SECRET ciphertext used as Bearer token | bootstrap-secrets injected encrypted blob | Silent 401 on all admin queries |
| Stats endpoint 500 | engagement_tier column doesn't exist | Profile page broken |
| Agent-server deployed without matching db-d1.js | Non-atomic deployment | rawQueryOwner is not a function |
| Stale tarball deployed to customer VPS | update-customers.sh built from stale local state | Old code running on customer |

---

## Implementation Plan

### Phase 1: Prevent identity mismatches (Critical)

#### 1.1 Startup self-check

**What**: Every agent-server verifies its own identity on boot before accepting requests.

**Where**: `agent-server.js`, new function `verifyTenantIdentity()` called before Express listener starts.

**Logic**:
```
1. Read MYA_USER_ID from process.env
2. If MYA_USER_ID is set (managed instance):
   a. Query rawQueryOwner('SELECT handle, vps_ip, email FROM provisioning_jobs WHERE user_id = ? AND status = ?', [MYA_USER_ID, 'ready'])
   b. If no row found → FATAL: "This VPS is not registered for user_id {MYA_USER_ID}"
   c. Extract expected handle from provisioning
   d. Parse PASSKEY_RP_ORIGIN → extract hostname → extract subdomain
   e. If subdomain !== handle → WARN: "PASSKEY_RP_ORIGIN mismatch: expected {handle}.mycelium.id, got {actual}"
   f. Test d1Query('SELECT 1 as ok') → confirm tenant D1 routing works
   g. If query returns from wrong D1 (check size_after in meta) → WARN
   h. Log: "[Startup] Identity verified: handle={handle}, user_id={MYA_USER_ID}, tenant D1 OK"
3. If MYA_USER_ID is NOT set (self-hosted):
   a. Skip tenant verification
   b. Log: "[Startup] Self-hosted mode — no tenant verification"
```

**Failure behavior**: Log warnings but don't crash — the VPS should still be accessible for debugging. Add a `GET /health/identity` endpoint that returns verification results.

**Files to modify**:
- `agent-server.js` — add `verifyTenantIdentity()`, call before `app.listen()`
- `agent-server.js` — add `GET /health/identity` endpoint

**Estimated effort**: 1 hour

---

#### 1.2 Provisioning script verification

**What**: After provisioning creates a VPS, verify the mapping is correct before marking the job as "ready".

**Where**: `scripts/provision-customer.sh`, new verification step after .env write.

**Logic**:
```
After writing .env to VPS:
1. SSH to VPS, read back MYA_USER_ID → compare to provisioning_jobs.user_id
2. SSH to VPS, read back PASSKEY_RP_ORIGIN → compare to expected https://{handle}.mycelium.id
3. SSH to VPS, read back AGENT_TOKEN_MYA → compare to what was written
4. Start PM2, wait 10s for bootstrap
5. curl http://localhost:3004/health → verify responds
6. curl http://localhost:3004/health/identity → verify no mismatches
7. Resolve {handle}.mycelium.id DNS → verify matches VPS_IP
8. If ANY check fails → set provisioning_jobs.status = 'failed', log error, exit
9. Only if ALL checks pass → set status = 'ready'
```

**Files to modify**:
- `scripts/provision-customer.sh` — add verification section after .env write

**Estimated effort**: 1 hour

---

#### 1.3 DNS consistency monitor

**What**: Periodic check that DNS records match provisioning_jobs.

**Where**: New script `scripts/verify-dns.js`, run via PM2 cron (daily).

**Logic**:
```
1. Query rawQueryOwner('SELECT handle, vps_ip FROM provisioning_jobs WHERE status = ?', ['ready'])
2. For each tenant:
   a. Resolve {handle}.mycelium.id via DNS (use dns.resolve4())
   b. Compare resolved IP to vps_ip
   c. If mismatch → log error, optionally fix via create-dns endpoint
3. Report: "DNS check: 2/2 OK" or "DNS MISMATCH: 0mm resolves to X, expected Y"
```

**Files to create**:
- `scripts/verify-dns.js`
- Add to `ecosystem.config.cjs` as a cron job (daily at 4am)

**Estimated effort**: 30 minutes

---

### Phase 2: Fix silent failures (High)

#### 2.1 Bootstrap-secrets: never inject ciphertext

**What**: If a secret can't be decrypted (no master key), skip it entirely instead of injecting the raw ciphertext into process.env.

**Where**: `lib/bootstrap-secrets.js`

**Current behavior**:
```javascript
// decryptValue() fails silently → returns ciphertext as-is
// refreshSecrets() injects ciphertext into process.env
process.env.ADMIN_SECRET = "eyJ2IjoxLCJzIjoib3Jn..." // ciphertext!
```

**New behavior**:
```javascript
async function decryptValue(value, mk) {
  if (!mk) return null;  // ← return null, not the ciphertext
  if (!isEncrypted(value)) return value;
  try {
    return await decrypt(value, mk);
  } catch {
    return null;  // ← return null on decrypt failure
  }
}

// In injection loop:
for (const [key, value] of Object.entries(decrypted)) {
  if (value === null) continue;  // ← skip undecryptable secrets
  if (!process.env[key]) {
    process.env[key] = value;
    injected++;
  }
}
```

**Also remove**: The `isEncryptedValue()` band-aid in `db-d1.js` `ownerHeaders()` and `adminHeaders()` — no longer needed if ciphertext is never injected.

**Files to modify**:
- `lib/bootstrap-secrets.js` — change `decryptValue()` return and injection loop
- `lib/db-d1.js` — remove `isEncryptedValue()` checks (keep as defense-in-depth, but add comment)

**Estimated effort**: 30 minutes

---

#### 2.2 Atomic deployments

**What**: Deploy all files as a single unit, verify hashes after extraction.

**Where**: `scripts/update-customers.sh`

**New flow**:
```bash
# 1. Build from committed state only
COMMIT=$(git rev-parse HEAD)
echo "Deploying commit: $COMMIT"

# 2. Create tarball from git (not working tree)
git archive HEAD | gzip > "$RELEASE_TAR"

# 3. Include portal build (not in git)
tar rf "$RELEASE_TAR" -C "$ROOT_DIR" portal/build 2>/dev/null

# 4. Compute hash manifest
MANIFEST=$(md5sum agent-server.js lib/db-d1.js lib/crypto-local.js lib/bootstrap-secrets.js)

# 5. Deploy to each VPS
for each customer VPS:
  scp tarball
  ssh: extract + npm install
  ssh: verify hashes match MANIFEST
  if mismatch: ABORT, don't restart
  ssh: pm2 delete + pm2 start (not restart — clear env cache)
  ssh: wait 5s, curl /health → verify OK
  ssh: curl /health/identity → verify no mismatches
  log: "OK: {handle} @ {ip} (commit {COMMIT})"
```

**Also add**: `--dry-run` flag that deploys but doesn't restart PM2.

**Files to modify**:
- `scripts/update-customers.sh` — rewrite deployment flow

**Estimated effort**: 1 hour

---

#### 2.3 Health endpoint validates full stack

**What**: `/health` currently returns `{status: "ok"}` without testing anything. Make it actually verify the stack.

**Where**: `agent-server.js`, existing `/health` endpoint.

**New response**:
```json
{
  "status": "ok",
  "checks": {
    "d1": "ok",
    "encryption": "disabled",
    "auth": "ok",
    "identity": {
      "handle": "0mm",
      "user_id": "e524018a...",
      "rp_origin_match": true,
      "tenant_d1": true
    }
  },
  "version": "abc1234",
  "uptime": 3600
}
```

**Checks**:
1. `d1` — `SELECT 1` via d1Query succeeds
2. `encryption` — ENCRYPTION_MASTER_KEY available (or explicitly "disabled")
3. `auth` — AGENT_TOKEN is set and non-empty
4. `identity` — results from startup self-check (cached)
5. `version` — git commit SHA from a `.version` file written during deploy

**Files to modify**:
- `agent-server.js` — enhance `/health` endpoint
- `scripts/update-customers.sh` — write `.version` file during deploy

**Estimated effort**: 45 minutes

---

### Phase 3: Strengthen isolation (Medium)

#### 3.1 Worker-side user_id enforcement for owner D1

**What**: When a query hits the owner D1 (no tenant binding), the Worker should verify that the query includes a `WHERE user_id = ?` clause matching the authenticated identity's user_id.

**Where**: `worker/src/handlers/db-proxy.ts`

**Logic**:
```
For SELECT queries on the owner D1 (not tenant D1):
1. Parse the table name from the SQL
2. If table has a user_id column (check against known list):
   a. Verify SQL contains WHERE ... user_id
   b. Verify the user_id param matches identity.user_id
   c. If mismatch → reject with 403
3. Skip for management tables (provisioning_jobs, waitlist, etc.)
```

**Known user_id tables**: messages, documents, attachments, people, clustering_points, territory_profiles, sessions, passkey_credentials, secrets, user_profiles, health_daily, wealth_*, agent_events, agent_tasks.

**Skip enforcement for**: provisioning_jobs, waitlist, subscriptions, stripe_events, agent_tokens (management tables).

**Implementation note**: This is a safety net, not the primary isolation mechanism (tenant D1s are the primary). It catches misconfigured self-hosted setups or owner VPS bugs.

**Files to modify**:
- `worker/src/handlers/db-proxy.ts` — add user_id enforcement for owner D1 queries

**Estimated effort**: 2 hours

---

#### 3.2 Handle reservation in owner D1

**What**: Handles must be globally unique. Currently checked at read time but not enforced at write time. Race condition possible.

**Where**: `lib/db-d1.js` `setHandle()`, owner D1

**Fix**:
```sql
-- Add to owner D1 (not tenant D1)
CREATE TABLE IF NOT EXISTS handle_reservations (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reserved_at TEXT DEFAULT (datetime('now'))
);
```

**Logic**:
```
setHandle(userId, handle):
1. Validate format + reserved words (existing)
2. rawQueryOwner('INSERT OR IGNORE INTO handle_reservations (handle, user_id) VALUES (?, ?)', [handle, userId])
3. rawQueryOwner('SELECT user_id FROM handle_reservations WHERE handle = ?', [handle])
4. If returned user_id !== userId → throw "Handle taken"
5. If matches → proceed with tenant D1 update
```

**Migration**: `109_handle_reservations.sql` (owner D1 only)

**Files to modify**:
- `migrations/109_handle_reservations.sql` — new table
- `lib/db-d1.js` `setHandle()` — reserve in owner D1 before tenant write

**Estimated effort**: 30 minutes

---

#### 3.3 Move AGENT_REGISTRY to D1

**What**: Agent tokens currently stored as a JSON Worker secret. Adding/removing a tenant requires editing the entire blob and redeploying the secret.

**Where**: Worker `agent-auth.ts`, owner D1 `agent_tokens` table

**Current**: Worker parses `env.AGENT_REGISTRY` JSON on every request.

**New**: Worker queries `agent_tokens` table in owner D1 (with KV cache, 60s TTL).

```sql
-- Already exists in schema:
CREATE TABLE agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT DEFAULT '["org"]',
  label TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Migration path**:
1. Worker checks D1 `agent_tokens` FIRST
2. Falls back to `AGENT_REGISTRY` JSON if not found (backwards compat)
3. Add script: `scripts/migrate-registry-to-d1.js` — reads JSON, inserts into D1
4. After migration verified: remove `AGENT_REGISTRY` secret

**Token storage**: Store SHA-256 hash of token in D1, not plaintext. Compare using timing-safe hash comparison.

**Caching**: Cache D1 lookups in Worker KV with 60s TTL. Invalidate on token create/revoke.

**Files to modify**:
- `worker/src/middleware/agent-auth.ts` — add D1 lookup with KV cache
- `scripts/migrate-registry-to-d1.js` — new migration script
- `agent-server.js` — token provisioning endpoint (already partially exists)

**Estimated effort**: 3 hours

---

### Phase 4: Observability (Medium)

#### 4.1 Deployment audit log

**What**: Every deployment to a customer VPS should be logged with commit SHA, file hashes, timestamp, and result.

**Where**: `scripts/update-customers.sh`, owner D1

```sql
CREATE TABLE IF NOT EXISTS deployment_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  handle TEXT,
  vps_ip TEXT,
  commit_sha TEXT,
  file_hashes TEXT,  -- JSON of filename → md5
  status TEXT,       -- 'success' | 'failed' | 'hash_mismatch'
  error TEXT,
  deployed_at TEXT DEFAULT (datetime('now'))
);
```

**Files to create**:
- `migrations/110_deployment_log.sql`

**Files to modify**:
- `scripts/update-customers.sh` — log each deployment

**Estimated effort**: 30 minutes

---

#### 4.2 Tenant activity dashboard

**What**: Admin endpoint that shows all tenants' health at a glance.

**Where**: `agent-server.js` (owner VPS only), new endpoint `GET /admin/tenants`

**Response**:
```json
{
  "tenants": [
    {
      "handle": "0mm",
      "email": "martinam.balodim+1@gmail.com",
      "vps_ip": "46.225.152.101",
      "status": "ready",
      "dns_ok": true,
      "last_health_check": "2026-04-06T16:00:00Z",
      "health": "ok",
      "message_count": 7,
      "last_deploy": "2026-04-06T15:30:00Z",
      "deploy_commit": "abc1234"
    }
  ]
}
```

**Files to modify**:
- `agent-server.js` — add `GET /admin/tenants` (admin auth only)

**Estimated effort**: 1 hour

---

## Implementation Order

| Step | What | Priority | Effort | Blocks |
|------|------|----------|--------|--------|
| **1** | 2.1 Bootstrap: never inject ciphertext | Critical | 30 min | Nothing |
| **2** | 1.1 Startup self-check | Critical | 1 hr | Nothing |
| **3** | 2.2 Atomic deployments | High | 1 hr | Nothing |
| **4** | 2.3 Health endpoint full stack | High | 45 min | 1.1 |
| **5** | 1.2 Provisioning verification | Critical | 1 hr | 1.1, 2.3 |
| **6** | 1.3 DNS consistency monitor | High | 30 min | Nothing |
| **7** | 3.2 Handle reservation | Medium | 30 min | Nothing |
| **8** | 3.1 Worker user_id enforcement | Medium | 2 hr | Nothing |
| **9** | 3.3 AGENT_REGISTRY to D1 | Medium | 3 hr | Nothing |
| **10** | 4.1 Deployment audit log | Medium | 30 min | 2.2 |
| **11** | 4.2 Tenant dashboard | Medium | 1 hr | Nothing |

**Total estimated effort**: ~12 hours

**Phases 1-2** (steps 1-6) should be done before onboarding any new paying customer. They prevent every failure mode we hit today.

**Phases 3-4** (steps 7-11) can be done incrementally. They add defense-in-depth and observability but aren't blocking.

---

## Invariants (must always hold)

After implementation, these must be true at all times:

1. `provisioning_jobs.user_id` = VPS `.env MYA_USER_ID` = `wrangler.toml DB_TENANT_{user_id}` binding
2. `provisioning_jobs.handle` = VPS `.env PASSKEY_RP_ORIGIN` hostname = DNS A record subdomain
3. `provisioning_jobs.vps_ip` = DNS A record target IP
4. Every tenant query goes through their own D1 (verified by `size_after` in D1 meta)
5. No ciphertext is ever used as an auth token
6. Every deployment is atomic (all files or none) and verified by hash
7. Startup self-check passes before agent accepts requests
8. Handle uniqueness enforced at write time in owner D1, not just read time
