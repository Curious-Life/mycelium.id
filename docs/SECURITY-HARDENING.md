# Security Hardening — Implementation Plan

**Date**: March 6, 2026
**Status**: In progress

---

## Current State (Post Session 1)

### Already Completed

| Fix | Where | Deployed |
|-----|-------|----------|
| SQL injection prevention (column whitelists) | `worker/src/handlers/data-api.ts` | Worker |
| Legacy auth hardening (X-Agent-ID no longer trusted for scopes) | `worker/src/middleware/agent-auth.ts` | Worker |
| Admin endpoint protection (identity-based, not scope-based) | `worker/src/handlers/data-api.ts` | Worker |
| Timing-safe secret comparisons | `agent-server.js` | VPS |
| Telegram HTTP API auth middleware (`requireSecret`) | `telegram-bot.js` | VPS |
| Discord user allowlist enforcement | `lib/discord-bot.js` + all 6 bot configs | VPS |

### Still Vulnerable

| Issue | Severity | Section |
|-------|----------|---------|
| GitHub OAuth token in git remote URLs (both repos on VPS) | **Critical** | 1 |
| Telegram bot binds to `*:3003` (all interfaces, internet-reachable) | **Critical** | 2a |
| WhatsApp bot binds to `*` (all interfaces) | **High** | 2a |
| CORS `Access-Control-Allow-Origin: *` on 40+ worker endpoints | **High** | 3 |
| `/debug-secrets` endpoint has zero auth | **Medium** | 4 |
| 69 secrets in single `.env` file (zero compartmentalization) | **Medium** | 5 |
| No secret rotation has ever happened | **Medium** | 6 |
| Crypto private key stored as plaintext in `.env` | **Medium** | 7 |

---

## Phase 1 — Critical Network Fixes (Code changes, deployable now)

### 1a. Bind telegram-bot to localhost

**File**: `telegram-bot.js` line 704

```javascript
// BEFORE
app.listen(HTTP_PORT, () => {

// AFTER
app.listen(HTTP_PORT, '127.0.0.1', () => {
```

**Deploy**: `scp telegram-bot.js mycelium-vps:~/mycelium/ && ssh mycelium-vps "pm2 restart mya-telegram-bot"`

**Risk**: Port 3003 is currently reachable from the internet (confirmed via `ss -tlnp` showing `*:3003`). The `requireSecret` middleware added in Session 1 provides defense-in-depth, but binding to localhost eliminates the exposure entirely.

### 1b. Bind whatsapp-bot to localhost

**File**: `whatsapp-bot.js` line 645

```javascript
// BEFORE
app.listen(HTTP_PORT, () => {

// AFTER
app.listen(HTTP_PORT, '127.0.0.1', () => {
```

**Deploy**: `scp whatsapp-bot.js mycelium-vps:~/mycelium/ && ssh mycelium-vps "pm2 restart mya-whatsapp-bot"` (if running)

---

## Phase 2 — Git Remote Token Removal

### 2a. Switch VPS git remotes from HTTPS+token to SSH

**Current state** (confirmed):
```
# /home/claude/mycelium
origin  https://oauth2:<REDACTED>@github.com/org/mycelium.git

# /home/claude/agents/company-agent/repo
origin  https://oauth2:<REDACTED>@github.com/org/company-agent
```

A GitHub OAuth token was embedded in both remote URLs, stored in plaintext in `.git/config` on the VPS.

**Fix** (run on VPS):
```bash
# Mycelium repo
cd /home/claude/mycelium
git remote set-url origin git@github.com:your-org/mycelium.git

# Company agent repo
cd /home/claude/agents/company-agent/repo
git remote set-url origin git@github.com:your-org/company-agent.git
```

**Prerequisite**: VPS SSH key must be added to the GitHub org. Check:
```bash
ssh -T git@github.com
```

### 2b. Revoke the exposed GitHub OAuth token

**Action**: GitHub → Settings → Personal access tokens → find and revoke the exposed token

**Owner**: Admin (manual action)

---

## Phase 3 — Worker CORS Restriction

### Problem

40+ worker endpoints return `Access-Control-Allow-Origin: *`, allowing any website to make authenticated cross-origin requests to the API. Only 2 endpoints correctly restrict to `https://your-portal-domain.com`:
- `/api/data/store` and `/api/data/query` (in `data-api.ts`)
- `/api/db/*` proxy endpoints (in `db-proxy.ts`)

### Affected Endpoints

**Group A — Agent-to-Worker calls (VPS → Cloudflare, no browser involved)**:
These don't need CORS at all since they're server-to-server. But CORS headers don't hurt — they're ignored by non-browser clients. Low priority.

| Path | Handler |
|------|---------|
| `/api/transcribe` | AI processing |
| `/api/tts` | AI processing |
| `/api/describe-image` | AI processing |
| `/api/store-attachment` | R2 storage |
| `/api/embed` | Embeddings |
| `/api/backfill-agent-embeddings` | Admin |

**Group B — Portal/browser calls (need specific origin)**:
These are called from the Portal UI at `https://your-portal-domain.com` and should be restricted.

| Path | Handler |
|------|---------|
| `/upload` | File upload |
| `/upload-url` | URL upload |
| `/import-claude` | Import |
| `/analyze-claude` | Import |
| `/import-openai` | Import |
| `/analyze-openai` | Import |
| `/import-obsidian` | Import |
| `/analyze-obsidian` | Import |
| `/upload-obsidian-attachment` | Import |
| `/rewrite-obsidian-embeds` | Import |
| `/import-mya-logs` | Import |
| `/analyze-mya-logs` | Import |
| `/import-apple-notes` | Import |
| `/analyze-apple-notes` | Import |
| `/api/links/*` | Links API |
| `/create-direct-upload` | Video |
| `/finalize-video-upload` | Video |
| `/attachments/*` | R2 serve |

### Implementation

Create a shared CORS helper in the worker:

**File**: `worker/src/utils/cors.ts` (new)

```typescript
const ALLOWED_ORIGINS = new Set([
  "https://your-portal-domain.com",
  "https://www.your-portal-domain.com",
  "http://localhost:5173",  // Portal dev
]);

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://your-portal-domain.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
    "Vary": "Origin",
  };
}
```

Then replace all `"Access-Control-Allow-Origin": "*"` with `...corsHeaders(request)`.

**Impact**: Server-to-server calls (agents) won't be affected since they don't send `Origin` headers. Only browser-initiated requests are filtered.

**Deploy**: `cd worker && npx wrangler deploy`

---

## Phase 4 — Remove `/debug-secrets` Endpoint

### Problem

`worker/src/index.ts` line ~137 exposes `/debug-secrets` with zero authentication. While it only returns boolean flags (not actual values), it confirms which secrets are configured, which is useful reconnaissance for attackers.

**File**: `worker/src/index.ts`

**Fix**: Either:
- **Option A**: Delete it entirely (recommended — it was a dev tool)
- **Option B**: Gate it behind `ADMIN_SECRET` auth

---

## Phase 5 — Secrets Compartmentalization

### Current State

Single file `/home/claude/mycelium/.env` with 69 active variables. Permissions are correct (`600 claude`), but a single file leak exposes everything.

### Proposed Split

```
/home/claude/mycelium/
├── .env                    # Non-sensitive: ports, channel IDs, paths, feature flags
├── .env.discord            # 6 Discord bot tokens + client ID/secret + bot IDs
├── .env.database           # Supabase URL + keys, MYA_WORKER_URL + secret
├── .env.crypto             # CDP keys, wallet secret, ADMIN_SECRET
├── .env.agents             # AGENT_TOKEN_MYA/COM/ADA/REX/ROB/NOA/QA, PORTAL_APP_TOKEN
└── .env.cloudflare         # Account ID, stream token
```

### Variable Assignment

**`.env`** (non-sensitive, 25 vars):
```
OWNER_TELEGRAM_ID, DISCORD_ALLOWED_SERVERS, DISCORD_ALLOWED_USERS,
DISCORD_COMPANY_CHANNEL, DISCORD_RESEARCH_CHANNEL, DISCORD_COMMERCIAL_INTEL_CHANNEL,
DISCORD_BUILDER_CHANNEL, DISCORD_COLLAB_CHANNEL, DISCORD_PUBLISHING_CHANNEL,
DISCORD_WEALTH_CHANNEL, DISCORD_REPORTS_CHANNEL, DISCORD_BUG_REPORTS_CHANNEL,
COMPANY_REPO_PATH, RESEARCH_DIR, AGENT_REPO_PATH, AGENT_DIR,
COMMERCIAL_INTEL_AGENT_URL, ORCHESTRATOR_URL, PUBLISHING_AGENT_URL,
MAX_BOT_PORT, NOA_BOT_PORT, MYA_USER_ID, DB_BACKEND,
PASSKEY_RP_ID, PASSKEY_RP_NAME, PASSKEY_RP_ORIGIN, PORTAL_ORIGINS,
SENTRY_DSN, SENTRY_ORG, SENTRY_PROJECT
```

**`.env.discord`** (12 vars):
```
DISCORD_BOT_TOKEN, DISCORD_MYA_BOT_TOKEN, DISCORD_MYA_BOT_ID,
DISCORD_RESEARCH_BOT_TOKEN, DISCORD_COMMERCIAL_INTEL_BOT_TOKEN,
DISCORD_PUBLISHING_BOT_TOKEN, DISCORD_WEALTH_BOT_TOKEN,
DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
DISCORD_COM_BOT_ID, DISCORD_ADA_BOT_ID, DISCORD_REX_BOT_ID,
DISCORD_NOA_BOT_ID, DISCORD_ROB_BOT_ID
```

**`.env.database`** (5 vars):
```
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
MYA_WORKER_URL, MYA_WORKER_SECRET
```

**`.env.crypto`** (4 vars):
```
CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET, ADMIN_SECRET
```

**`.env.agents`** (8 vars):
```
AGENT_TOKEN_MYA, AGENT_TOKEN_COM, AGENT_TOKEN_ADA, AGENT_TOKEN_REX,
AGENT_TOKEN_ROB, AGENT_TOKEN_NOA, AGENT_TOKEN_QA, PORTAL_APP_TOKEN
```

**`.env.cloudflare`** (3 vars):
```
CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_TOKEN, SENTRY_AUTH_TOKEN
```

### PM2 Integration

Update `ecosystem.config.cjs` to load multiple env files:

```javascript
const dotenv = require('dotenv');
const path = require('path');

// Load env files in order (later files override earlier)
const envFiles = ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare'];
for (const file of envFiles) {
  dotenv.config({ path: path.resolve(__dirname, file) });
}
```

**Important**: After splitting, `chmod 600` all `.env.*` files and add them to `.gitignore`.

---

## Phase 6 — Key Rotation (Manual)

### P0 — Leaked/Exposed Keys (rotate immediately)

| Secret | Where to rotate | Current exposure |
|--------|----------------|------------------|
| GitHub OAuth token (revoked) | GitHub → Settings → Tokens → Revoke | Was in `.git/config` on VPS (2 repos) |
| `CLAUDE_API_KEY` (Anthropic) | console.anthropic.com → API Keys | If ever in lumensis git history |
| `CLOUDFLARE_STREAM_TOKEN` | Cloudflare dashboard → API Tokens | If ever in lumensis git history |

### P1 — Periodic Rotation (quarterly cadence)

| Secret | Where to rotate | Notes |
|--------|----------------|-------|
| `MYA_WORKER_SECRET` | Generate new, update Worker secret + VPS `.env` | Shared legacy token — rotate to force migration |
| `ADMIN_SECRET` | Generate new, update Worker secret + VPS `.env` | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API | Full DB access |
| `TELEGRAM_BOT_TOKEN` | @BotFather → /revoke + /newtoken | |
| All 6 `DISCORD_*_BOT_TOKEN` | Discord Developer Portal → Bot → Reset Token | One at a time, verify each |
| `PORTAL_APP_TOKEN` | Generate new, update both sides | |
| All 7 `AGENT_TOKEN_*` | Generate new, update `AGENT_REGISTRY` Worker secret + VPS `.env` | |

### Rotation Procedure

```bash
# Generate a new 64-char hex token
openssl rand -hex 32

# For Worker secrets (Cloudflare):
cd worker && echo "NEW_VALUE" | npx wrangler secret put SECRET_NAME

# For VPS:
# 1. Edit ~/.env file
# 2. pm2 delete <process> && pm2 start ecosystem.config.cjs --only <process>
# 3. Verify: PID=$(pm2 pid <process>) && cat /proc/$PID/environ | tr "\0" "\n" | grep SECRET_NAME
```

---

## Phase 7 — Crypto Key Protection

### Problem

CDP wallet credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) are stored as plaintext in `.env`. These control actual financial assets.

### Option A — Encrypted `.env.crypto` (recommended for now)

Use `age` encryption:

```bash
# Install (one-time)
sudo apt install age

# Generate encryption key (one-time)
age-keygen -o /home/claude/.age-key.txt
chmod 400 /home/claude/.age-key.txt

# Encrypt the crypto env file
age -R /home/claude/.age-key.txt -o .env.crypto.age .env.crypto

# Remove plaintext
rm .env.crypto

# At startup (in ecosystem.config.cjs or wrapper script):
# age -d -i /home/claude/.age-key.txt .env.crypto.age > /tmp/.env.crypto
# source /tmp/.env.crypto
# rm /tmp/.env.crypto
```

### Option B — Hardware wallet (when wallet > $10K)

Move funds to a Ledger/Trezor. Use WalletConnect for transaction signing. Private key never touches disk.

---

## Phase 8 — Monitoring & Audit

### Automated Daily Check (cron or PM2 watcher)

Create `scripts/security-check.sh`:

```bash
#!/bin/bash
# Run daily via cron: 0 8 * * * /home/claude/mycelium/scripts/security-check.sh

ISSUES=()

# Check for services on public interfaces
PUBLIC=$(ss -tlnp | grep -E '0\.0\.0\.0|:::' | grep -v ':22\|:80\|:443')
if [ -n "$PUBLIC" ]; then
  ISSUES+=("Services on public interfaces: $PUBLIC")
fi

# Check .env permissions
for f in /home/claude/mycelium/.env*; do
  PERMS=$(stat -c '%a' "$f")
  if [ "$PERMS" != "600" ]; then
    ISSUES+=("Bad permissions on $f: $PERMS (should be 600)")
  fi
done

# Check SSH authorized_keys count
KEYS=$(wc -l < /home/claude/.ssh/authorized_keys)
if [ "$KEYS" -gt 2 ]; then
  ISSUES+=("SSH authorized_keys has $KEYS keys (expected 2)")
fi

# Check PM2 process count
PROCS=$(pm2 list --no-color | grep -c 'online')
if [ "$PROCS" -lt 15 ]; then
  ISSUES+=("Only $PROCS PM2 processes online (expected 18+)")
fi

# Report
if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "SECURITY ISSUES FOUND:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
  # Could send to Discord webhook or email
  exit 1
fi

echo "All checks passed."
```

### Quarterly Rotation Checklist

- [ ] Rotate `ADMIN_SECRET`
- [ ] Rotate `MYA_WORKER_SECRET`
- [ ] Rotate all `AGENT_TOKEN_*` (7 tokens)
- [ ] Rotate `PORTAL_APP_TOKEN`
- [ ] Review SSH `authorized_keys` (currently 2 keys)
- [ ] Review GitHub org member access
- [ ] Check for unused PM2 processes
- [ ] Verify UFW rules unchanged

---

## Implementation Order

| Step | Phase | Effort | Can automate? |
|------|-------|--------|---------------|
| 1 | 1a: Bind telegram to localhost | 5 min | Yes |
| 2 | 1b: Bind whatsapp to localhost | 5 min | Yes |
| 3 | 2a: Switch git remotes to SSH | 5 min | Yes |
| 4 | 4: Remove `/debug-secrets` | 5 min | Yes |
| 5 | 3: CORS restriction | 30 min | Yes |
| 6 | 2b: Revoke GitHub token | 5 min | Admin (manual) |
| 7 | 6 P0: Rotate leaked keys | 15 min | Admin (manual) |
| 8 | 5: Split .env files | 1 hr | Partially |
| 9 | 7: Encrypt crypto keys | 30 min | Partially |
| 10 | 8: Security monitoring | 30 min | Yes |
| 11 | 6 P1: Quarterly rotation | 30 min | Admin (manual) |

Steps 1-5 can be done by Claude Code in a single session.
Steps 6-7 require admin manual action in dashboards.
Steps 8-11 are infrastructure changes best done together on VPS.

---

## Verification Checklist

After all phases complete:

- [ ] `ss -tlnp` shows no Node services on `0.0.0.0` or `*` (only 127.0.0.1)
- [ ] `git remote -v` in both VPS repos shows `git@github.com:` (not `https://oauth2:`)
- [ ] Worker endpoints return `Access-Control-Allow-Origin: https://your-portal-domain.com` (not `*`)
- [ ] `/debug-secrets` returns 404 or 401
- [ ] `.env` split into scoped files, all `chmod 600`
- [ ] GitHub OAuth token revoked
- [ ] All P0 keys rotated
- [ ] Security check script runs daily via cron
- [ ] No secrets in any git history (check with `git log --all -p | grep -i "sk-ant\|gho_"`)
