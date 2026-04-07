# Mycelium STRIDE Threat Model

**Date**: 2026-04-06
**Classification**: CONFIDENTIAL
**Version**: 1.0
**Scope**: Full system -- Portal, Agent-Server, Cloudflare Worker, D1, R2, Vectorize, VPS agents

---

## System Overview

Mycelium is a multi-agent personal intelligence system handling private messages, financial records, health data, contact networks, and geopolitical intelligence. A single user's entire cognitive history is stored, encrypted, and searchable.

### Data Flow Diagram

```
                           INTERNET
                              |
                         [TLS @ Edge]
                              |
                    +---------+---------+
                    |    Caddy Proxy    |  Trust Boundary 1: Internet <-> VPS
                    |  TLS termination  |
                    |  X-Forwarded-For  |
                    +---------+---------+
                              |
              +---------------+---------------+
              |           LOCALHOST            |  Trust Boundary 2: Caddy <-> VPS procs
              |                               |
  +-----------+-----------+     +-------------+-------------+
  |    Agent-Server       |     |   Discord/Telegram Bots   |
  |    (Express, :5173)   |     |   (:3003, :5003, :5009)   |
  |                       |     |   127.0.0.1 bound         |
  |  - Portal SPA served  |     +-------------+-------------+
  |  - WebAuthn auth      |                   |
  |  - CSRF protection    |     +-------------+-------------+
  |  - Cookie sessions    |     |   AI Agents (PM2)         |
  |                       |     |   personal, wealth, co,   |
  +-----------+-----------+     |   research, intel, moms   |
              |                 |   All run as user `claude` |
              |                 +-------------+-------------+
              |                               |
              +---------------+---------------+
                              |
                    +---------+---------+
                    |  lib/crypto-local  |  MASTER KEY lives here
                    |  AES-256-GCM       |  (VPS .env.crypto)
                    |  HKDF per-scope    |
                    +---------+---------+
                              |
                  HTTPS + Bearer Token
                              |                Trust Boundary 3: VPS <-> Cloudflare
                    +---------+---------+
                    |  Cloudflare Worker |
                    |  (ciphertext only) |
                    |                    |
                    |  - Agent auth      |
                    |  - D1 SQL proxy    |
                    |  - Vectorize       |
                    |  - R2 storage      |
                    |  - Rate limiting   |
                    |  - Workers AI      |
                    +---------+---------+
                              |
              +---------------+---------------+
              |               |               |
         +----+----+    +----+----+    +------+------+
         |   D1    |    |   R2    |    |  Vectorize  |
         |  (SQL)  |    | (blobs) |    | (embeddings)|
         +---------+    +---------+    +-------------+
           cipher-        cipher-        plaintext
           text            text          vectors
```

### Trust Boundaries

| # | Boundary | Controls |
|---|----------|----------|
| TB1 | Internet <-> Caddy | TLS 1.3, HSTS, reverse proxy |
| TB2 | Caddy <-> VPS processes | localhost only, X-Forwarded-For injection, worker secret |
| TB3 | VPS <-> Cloudflare Worker | HTTPS, per-agent Bearer tokens (AGENT_TOKEN), ADMIN_SECRET |
| TB4 | Agent <-> Agent (VPS) | Same Linux user (`claude`), same filesystem, localhost HTTP |

### Asset Inventory

| Asset | Sensitivity | Location |
|-------|-------------|----------|
| Private messages (journals, therapy, relationships) | CRITICAL | D1 (encrypted) |
| Financial records (positions, transactions, net worth) | CRITICAL | D1 (encrypted) |
| Health data (sleep, HRV, workouts) | HIGH | D1 (encrypted) |
| Contact network (2,480 people, LinkedIn data) | HIGH | D1 (encrypted) |
| Encryption master key (AES-256, 256-bit) | CRITICAL | VPS `.env.crypto` |
| ADMIN_SECRET | CRITICAL | VPS `.env`, D1 secrets table |
| Agent tokens (per-agent) | HIGH | VPS `.env.agents`, Worker AGENT_REGISTRY |
| Session tokens (portal) | HIGH | D1 sessions table, browser cookie |
| Geopolitical intelligence (war room) | MEDIUM | KV (plaintext), git repo |
| Vectorize embeddings | MEDIUM | Cloudflare Vectorize (plaintext) |
| R2 attachments (files, images) | HIGH | R2 (encrypted) |

---

## STRIDE Analysis

---

### S -- SPOOFING

#### S-1: Agent Token Impersonation

**Description**: An attacker who obtains one agent's AGENT_TOKEN can impersonate that agent to the Worker, gaining access to its scoped data.

**Attack vector**: Extract token from VPS `.env.agents`, process environment (`/proc/<pid>/environ`), PM2 logs, or memory dump. All agents run as the same Linux user `claude`, so any compromised agent process can read another's environment.

**Impact**: Full access to the impersonated agent's encryption scopes. A stolen personal-agent token grants access to personal + org data (messages, journals, contacts).

**Likelihood**: Medium. Requires VPS access, but all agents share user `claude` -- a single agent compromise cascades.

**Current mitigation**:
- Per-agent tokens (not shared secret) limit blast radius to one agent's scopes
- Timing-safe comparison on all token checks
- Token stored as env var (not in code or config files)
- Worker iterates all registry entries to prevent timing leaks on which token matched

**Residual risk**: All agents run as the same user. Process isolation is zero. Any agent can read any other agent's `/proc/<pid>/environ`. The per-agent token model provides logical isolation but not OS-level isolation.

**DREAD**: D:8 R:6 E:5 A:10 D:4 = **6.6**

---

#### S-2: Session Token Theft (Portal)

**Description**: Attacker steals an active portal session cookie to impersonate the user. Portal sessions have full scope access (personal, org, wealth, moms).

**Attack vector**: XSS (if CSP is weak), browser extension malware, network-level MITM (unlikely with HSTS), or cookie theft from browser storage.

**Impact**: Complete account takeover. Portal sessions have all 4 scopes -- attacker can read every message, contact, financial record, and health entry.

**Likelihood**: Low. Cookies are HttpOnly + SameSite=Lax + Secure (in production). CSRF double-submit pattern is in place. No known XSS vectors.

**Current mitigation**:
- HttpOnly session cookie (not accessible to JavaScript)
- SameSite=Lax prevents cross-site request attachment
- Secure flag in production (HTTPS only)
- CSRF double-submit cookie pattern (separate non-HttpOnly CSRF token)
- Session expiry in D1 (`expires_at > datetime('now')`)
- Security email notifications on new login

**Residual risk**: SameSite=Lax (not Strict) allows top-level navigation attacks. Session lifetime is not documented -- long-lived sessions increase window of exposure.

**DREAD**: D:9 R:4 E:3 A:10 D:3 = **5.8**

---

#### S-3: Legacy Shared Secret (MYA_WORKER_SECRET)

**Description**: The legacy `MYA_WORKER_SECRET` still works for Worker authentication. It grants org-scope access and bypasses per-agent token granularity. The `X-Agent-ID` header is explicitly not trusted for scope assignment.

**Attack vector**: If `MYA_WORKER_SECRET` leaks (env file, logs, process listing), attacker gets org-scope access. More concerning: multiple agent processes still reference `MYA_WORKER_SECRET` as fallback auth.

**Impact**: Org-scope read/write access to D1 via the Worker proxy. Cannot directly access personal/wealth/moms scopes (legacy auth deliberately restricted to org).

**Likelihood**: Low-Medium. The secret exists in `.env` on VPS and is referenced in `enrichMessages()` as fallback when `AGENT_TOKEN` is not set.

**Current mitigation**:
- Legacy auth grants only org scope (not personal/wealth/moms)
- X-Agent-ID header is not trusted for scope assignment
- Per-agent tokens are the primary auth path

**Residual risk**: The secret should be rotated and eventually deprecated. Its continued existence widens the attack surface unnecessarily.

**DREAD**: D:5 R:5 E:4 A:10 D:5 = **5.8**

---

#### S-4: PORTAL_APP_TOKEN Bypass of WebAuthn

**Description**: A static `PORTAL_APP_TOKEN` env var allows native apps to skip WebAuthn passkey authentication entirely. If this token leaks, it grants full portal access without any cryptographic challenge.

**Attack vector**: Extract from VPS `.env`, process memory, or network traffic if not over TLS.

**Impact**: Full portal access (all 4 scopes) without possessing a passkey.

**Likelihood**: Low. Token is only used for native app auth flows where WebAuthn is unavailable.

**Current mitigation**:
- Token is optional (only set when native app support is needed)
- Timing-safe comparison

**Residual risk**: This is a password-equivalent long-lived credential with no expiry, no rotation, and no second factor. It undermines the entire WebAuthn security model.

**DREAD**: D:9 R:7 E:4 A:10 D:3 = **6.6**

---

### T -- TAMPERING

#### T-1: SQL Injection via DB Proxy

**Description**: The Worker's `/api/db/query` endpoint accepts arbitrary SQL from authenticated agents. A compromised agent (or one with prompt injection) could craft SQL to modify data outside its intended scope.

**Attack vector**: Agent sends crafted SQL via the D1 proxy. The proxy validates DDL is blocked and unrestricted DELETE requires WHERE, but does not validate SQL semantics beyond that. UPDATE and INSERT to any table are allowed.

**Impact**: Data corruption, unauthorized writes to other agents' data, privilege escalation via direct `secrets` or `sessions` table manipulation.

**Likelihood**: Medium. The proxy is a generic SQL passthrough. Agents execute arbitrary SQL generated by the Claude CLI subprocess, which could be manipulated via prompt injection.

**Current mitigation**:
- DDL blocked (DROP, ALTER, CREATE, etc.)
- Unrestricted DELETE blocked (requires WHERE clause)
- SQL length limit (50,000 chars)
- Parameter count limit (500)
- SELECT on user-data tables requires user_id/agent_id filter (for non-admin auth)
- Authenticated requests only

**Residual risk**: No semantic validation on INSERT/UPDATE. An agent can INSERT into `secrets`, `sessions`, `passkey_credentials`, or `agent_tokens` if it knows the schema. The user_id filter only applies to SELECT queries, not writes.

**DREAD**: D:8 R:6 E:5 A:10 D:4 = **6.6**

---

#### T-2: Prompt Injection Leading to Tool Abuse

**Description**: AI agents execute Claude CLI with tool access (filesystem, shell commands). A carefully crafted user message or imported document could manipulate the agent's behavior to exfiltrate data, modify files, or run arbitrary commands.

**Attack vector**: User message or imported content contains adversarial instructions that cause the Claude subprocess to execute unintended bash commands, read sensitive files (`.env`, master key), or send data to external endpoints via curl.

**Impact**: Master key exfiltration (game over for all encryption), arbitrary command execution on VPS, data exfiltration to attacker-controlled servers.

**Likelihood**: Medium. Claude has built-in prompt injection resistance, but agents are given tool access including bash and file operations. The attack surface includes imported documents, LinkedIn exports, and Obsidian notes.

**Current mitigation**:
- Claude CLI's built-in safety filters
- Agent processes have no sudo/root access
- Agents run in fork mode (separate Node processes)
- Spawn task guardrails (max 3 per parent, max 10 total, TTL limits)

**Residual risk**: The Claude subprocess can read any file owned by user `claude`, including `.env.crypto` (master key), all agent tokens, and all other agents' state files. There is no sandbox, no seccomp filter, and no filesystem isolation.

**DREAD**: D:10 R:4 E:4 A:10 D:3 = **6.2**

---

#### T-3: Enrichment Pipeline Content Manipulation

**Description**: The Worker's `/api/enrich` endpoint processes message content with Workers AI (Llama 4 Scout for tagging, BGE-M3 for embedding). Enrichment runs on unencrypted content that the VPS decrypts and sends to the Worker.

**Attack vector**: The enrichment daemon (`scripts/enrichment-daemon.js`) decrypts content locally then sends plaintext to the Worker for AI processing. An attacker who compromises the Worker (or intercepts the HTTPS connection) sees plaintext content during enrichment.

**Impact**: Exposure of decrypted message content during the enrichment window. The Worker processes plaintext content to generate tags and embeddings.

**Likelihood**: Low. Requires compromise of Cloudflare's infrastructure or a TLS downgrade. The Worker legitimately needs plaintext for AI processing.

**Current mitigation**:
- HTTPS between VPS and Worker
- Rate limiting on enrichment endpoints
- Worker does not persist plaintext (processes and discards)

**Residual risk**: This is an architectural trade-off. The Swiss Vault design keeps the master key off the Worker, but enrichment requires sending plaintext to the Worker for AI processing. This creates a window where content is unencrypted outside the VPS trust boundary.

**DREAD**: D:7 R:3 E:3 A:10 D:3 = **5.2**

---

#### T-4: File Upload Path Traversal

**Description**: The agent-server accepts file paths via JSON body for file sending endpoints (`/telegram/send-file`, `/portal/send-file`, `/collab/send`). A crafted `filePath` could read arbitrary files from the VPS.

**Attack vector**: An agent (via prompt injection) or a request with the worker secret sends `{"filePath": "/home/claude/mycelium/.env.crypto"}` to a file-sending endpoint.

**Impact**: Exfiltration of master key, agent tokens, or any file readable by user `claude`.

**Likelihood**: Medium. The file-sending endpoints accept a raw filesystem path. The `uploadFileToR2()` function calls `fs.readFile(filePath)` with no path validation or sandboxing.

**Current mitigation**:
- File-sending endpoints require worker secret or portal auth
- Inter-agent endpoints are localhost-only

**Residual risk**: No path validation. No allowlist of permitted directories. A compromised agent can exfiltrate any file on the VPS via the file upload flow.

**DREAD**: D:9 R:7 E:5 A:10 D:4 = **7.0**

---

### R -- REPUDIATION

#### R-1: Insufficient Audit Logging

**Description**: Security-critical operations lack comprehensive audit trails. Decryption operations, scope violations, secret access, and admin actions are logged to stdout but not to a persistent, tamper-evident audit store.

**Attack vector**: An attacker who gains VPS access can modify or delete PM2 log files (`/var/log/mycelium/*.log`) to cover their tracks. Logs are plain text files owned by user `claude`.

**Impact**: Inability to detect, investigate, or prove unauthorized access after a breach. No forensic trail for key operations.

**Likelihood**: High (that logging is insufficient for forensics, not that an attack occurs).

**Current mitigation**:
- PM2 stdout/stderr logging to `/var/log/mycelium/`
- Security email notifications for new device registration, login, and data export
- `agent_events` table in D1 records some agent actions
- Sentry for error tracking (PII disabled)

**Residual risk**: No centralized, append-only audit log. No log integrity verification. No alerting on suspicious patterns (e.g., mass decryption, unusual query patterns, off-hours access). Logs are mutable by the same user that runs the agents.

**DREAD**: D:6 R:8 E:2 A:10 D:6 = **6.4**

---

#### R-2: No Key Usage Logging

**Description**: The master key is used for every encrypt/decrypt operation but there is no logging of which scope key was derived, which records were decrypted, or by which agent process.

**Attack vector**: If an agent's scope is misconfigured (e.g., wealth-agent accidentally given personal scope), it silently decrypts data outside its intended scope with no record.

**Impact**: Scope violations go undetected. There is no way to determine after the fact what data was accessed by which agent.

**Likelihood**: High (as a gap, not as an active attack).

**Current mitigation**:
- `AGENT_SCOPES` env var controls which scopes each agent declares
- `allowedScopes` parameter on `decrypt()` function
- `ScopeViolationError` thrown on scope mismatch (logs to console.error)

**Residual risk**: Console logs are ephemeral and modifiable. No structured audit of scope derivation events. PM2 log rotation may discard evidence.

**DREAD**: D:4 R:8 E:2 A:10 D:5 = **5.8**

---

### I -- INFORMATION DISCLOSURE

#### I-1: Embedding Inversion (Vectorize)

**Description**: Vectorize stores plaintext embeddings (BGE-M3 1024D) of all messages and documents. These embeddings are NOT encrypted because vector similarity search requires plaintext vectors. Research shows embedding inversion attacks can reconstruct approximate original text from embeddings.

**Attack vector**: Attacker gains access to Cloudflare Vectorize index (via Worker compromise or Cloudflare account compromise) and applies embedding inversion techniques to reconstruct message content.

**Impact**: Partial reconstruction of private messages, journals, and documents from their vector representations. Quality depends on the embedding model and inversion technique.

**Likelihood**: Low-Medium. Requires Cloudflare infrastructure access. Inversion quality is imperfect but improving with research.

**Current mitigation**:
- Vectorize access requires authenticated Worker requests
- Vectors are not directly exposed via public endpoints
- Rate limiting on vector query endpoints

**Residual risk**: This is a fundamental architectural trade-off -- semantic search requires plaintext vectors. Differential privacy noise could mitigate inversion but would degrade search quality. No DP is currently applied.

**DREAD**: D:7 R:3 E:3 A:10 D:3 = **5.2**

---

#### I-2: Cross-Agent Data Access (Same User, Same Filesystem)

**Description**: All agents run as Linux user `claude` on the same VPS. Any agent process can read any other agent's files, environment variables, state, and the master encryption key.

**Attack vector**: A compromised agent reads `/proc/<other_pid>/environ` to extract another agent's AGENT_TOKEN, or reads `.env.crypto` directly for the master key, or reads another agent's state files under `~/agents/`.

**Impact**: Complete data breach. With the master key, all 4 encryption scopes are decryptable.

**Likelihood**: Medium. Requires compromising one agent (e.g., via prompt injection, dependency supply chain attack, or Claude CLI vulnerability).

**Current mitigation**:
- AGENT_SCOPES env var provides logical scope restriction
- Per-agent tokens limit Worker-side access
- Scope enforcement on decrypt calls

**Residual risk**: No OS-level isolation. No separate Linux users per agent. No mount namespaces, no cgroups, no seccomp. This is the single biggest architectural risk -- the scope model is enforced in application code, not by the OS.

**DREAD**: D:10 R:5 E:5 A:10 D:5 = **7.0**

---

#### I-3: Master Key in Environment Variable

**Description**: The `ENCRYPTION_MASTER_KEY` (256-bit, hex-encoded) is stored in `.env.crypto` and loaded as a process environment variable on every agent. It is present in `/proc/<pid>/environ` for every PM2-managed process that uses `db-d1.js`.

**Impact**: If the master key is extracted, all encrypted data across all scopes is decryptable. This is the single most valuable secret in the system.

**Attack vector**: Read `.env.crypto` (same user), read `/proc/<pid>/environ` (same user), memory dump of any agent process, or PM2 environment inspection (`pm2 env <id>`).

**Likelihood**: Medium. The key is accessible to every process running as user `claude`.

**Current mitigation**:
- File permissions on `.env.crypto` (owner-read only)
- Key is not logged or transmitted (except to derive scope keys)
- Key is not sent to Worker (Swiss Vault design)
- Backup in 1Password

**Residual risk**: The key exists in cleartext in memory of every agent process and in `.env.crypto` on disk. No HSM, no TPM, no encrypted-at-rest protection. `age` encryption for the key file is planned but not implemented.

**DREAD**: D:10 R:6 E:5 A:10 D:4 = **7.0**

---

#### I-4: Intel Endpoints with Wildcard CORS

**Description**: The public intel API (`/api/intel/*`) uses `Access-Control-Allow-Origin: *`. While this serves only pre-curated KV data (no encrypted content), it exposes the system's public intelligence feed to any origin.

**Attack vector**: Any website can make cross-origin requests to read intel data (situation reports, market data, signals, entity data).

**Impact**: Low -- intel data is intentionally public. However, the wildcard CORS could be abused for reconnaissance (confirming system existence, fingerprinting endpoints).

**Likelihood**: High (trivial to exploit), but impact is deliberately low by design.

**Current mitigation**:
- Intel endpoints only serve KV-cached data (no D1, no encrypted content)
- Snapshot ingest endpoint (`POST /api/intel/snapshot`) has empty CORS origin (no browser access) and requires ADMIN_SECRET
- Whitelisted KV keys prevent injection of arbitrary data

**Residual risk**: Minimal. This is an accepted risk for the public intel dashboard use case.

**DREAD**: D:2 R:9 E:9 A:1 D:8 = **5.8**

---

#### I-5: Error Messages Leaking Internals

**Description**: D1 query errors return `e?.message?.slice(0, 200)` in the response body. SQL error messages from D1 can reveal table names, column names, and query structure.

**Attack vector**: Authenticated attacker sends malformed SQL to `/api/db/query` and reads error details to map the database schema.

**Impact**: Schema discovery aids further attacks (T-1). Not a direct data leak but reduces attacker effort.

**Likelihood**: Medium. Requires valid auth token.

**Current mitigation**:
- `safeError()` function on agent-server sanitizes error messages
- Worker returns truncated error details (200 char limit)

**Residual risk**: Worker-side errors still include D1 error messages. Agent-server uses `safeError()` for its own endpoints but not all Worker responses are sanitized before forwarding to the portal.

**DREAD**: D:3 R:7 E:6 A:10 D:6 = **6.4**

---

### D -- DENIAL OF SERVICE

#### D-1: Resource Exhaustion via Agent Spawning

**Description**: Agents can spawn sub-tasks via `/spawn-task` and `/spawn-task-async`, each of which launches a Claude CLI subprocess. Uncontrolled spawning could exhaust VPS CPU and memory.

**Attack vector**: Prompt injection or compromised agent triggers recursive spawning. Each spawn launches a full Claude CLI process.

**Impact**: VPS becomes unresponsive, all agents and portal go down. 7.6GB RAM + 4GB swap could be exhausted by a few concurrent Claude processes.

**Likelihood**: Low-Medium. Guardrails exist but could be circumvented by a compromised parent agent.

**Current mitigation**:
- Max 3 spawns per parent agent
- Max 10 spawns total across all agents
- Default 30-minute TTL, max 2-hour TTL per spawn
- AbortController for TTL enforcement
- `max_memory_restart` in PM2 config (1G per agent)

**Residual risk**: The limits are application-level, not OS-level. A direct `child_process.spawn()` call bypasses spawner guardrails. PM2 memory restart is reactive, not preventive.

**DREAD**: D:6 R:4 E:4 A:10 D:4 = **5.6**

---

#### D-2: Rate Limiting Bypass (Worker)

**Description**: Worker rate limiting uses KV-based sliding window counters. If KV is unavailable, rate limiting fails closed (denies all requests). But KV key structure (`rl:<endpoint>:<identifier>:<window>`) uses the authenticated agent identity as identifier, not IP.

**Attack vector**: If an attacker obtains a valid token, rate limits are per-agent. A stolen token from one agent doesn't share rate limit buckets with other agents. However, agent rate limits are generous (10,000/hour for AI, 600/hour for DB).

**Impact**: Excessive Worker CPU, D1 query load, or Workers AI quota exhaustion.

**Likelihood**: Low. Requires valid auth token and deliberately high request volume.

**Current mitigation**:
- KV-based sliding window counters
- Fail-closed when KV unavailable
- Per-endpoint limits (AI: 10,000/hr, DB: 600/hr, admin: 10/hr, generate: 60/hr)
- Agent-server auth rate limiting (10 attempts/minute per IP)

**Residual risk**: DB limit of 600/hr is generous for a single-user system. AI limit of 10,000/hr reflects batch operations but could be reduced.

**DREAD**: D:4 R:5 E:4 A:10 D:5 = **5.6**

---

#### D-3: JSON Body Size Limit

**Description**: The agent-server accepts JSON bodies up to 10MB (`express.json({ limit: '10mb' })`). Combined with Busboy for multipart uploads, large payloads could tie up the single-threaded Node.js event loop.

**Attack vector**: Send many concurrent 10MB JSON requests to authenticated endpoints. Each request is parsed synchronously in the event loop.

**Impact**: Agent-server becomes unresponsive. Portal stops working. Agent tasks queue up.

**Likelihood**: Low. Requires valid auth and sustained attack.

**Current mitigation**:
- 10MB limit on JSON parsing
- Caddy may impose additional limits (not verified)
- Auth required on all state-changing endpoints

**Residual risk**: 10MB is generous for API requests. Consider reducing to 1MB for non-upload endpoints.

**DREAD**: D:5 R:6 E:5 A:10 D:4 = **6.0**

---

### E -- ELEVATION OF PRIVILEGE

#### E-1: Agent-to-Admin Escalation via Secrets Table

**Description**: Authenticated agents can execute arbitrary INSERT/UPDATE SQL via the `/api/db/query` proxy. The Worker's user_id filter only applies to SELECT queries. An agent can INSERT rows into the `secrets`, `sessions`, or `agent_tokens` tables to escalate its own privileges.

**Attack vector**:
1. Agent sends `INSERT INTO agent_tokens (token_hash, agent_id, user_id, scopes, is_active) VALUES (?, ?, ?, '["personal","org","wealth","moms"]', 1)` via `/api/db/query`
2. Agent now has a token with all scopes
3. Or: Agent INSERTs into `sessions` to create a portal session with full access

**Impact**: Complete privilege escalation from org-only scope to all scopes. Bypasses the entire per-agent token security model.

**Likelihood**: Medium. Requires a compromised agent or successful prompt injection that generates SQL writes to system tables.

**Current mitigation**:
- DDL blocked (no CREATE TABLE, but INSERT/UPDATE to existing tables is allowed)
- Agent processes are given limited scopes via AGENT_SCOPES
- Worker validates auth but does not restrict which tables agents can write to

**Residual risk**: Critical gap. The DB proxy should maintain a table-level ACL or block writes to system tables (`secrets`, `sessions`, `passkey_credentials`, `agent_tokens`, `users`, `registration_tokens`, `provisioning_jobs`).

**DREAD**: D:9 R:7 E:6 A:10 D:4 = **7.2**

---

#### E-2: Scope Escalation via Master Key Access

**Description**: Every agent process on the VPS has the master key in its environment. The `AGENT_SCOPES` restriction is enforced in application code (`allowedScopes` parameter to `decrypt()`), not by the crypto system itself. An agent can call `decrypt()` without the `allowedScopes` parameter to bypass scope restrictions.

**Attack vector**: A compromised agent (or prompt injection) modifies its own code or calls `decrypt()` directly from a spawned process without passing `allowedScopes`.

**Impact**: All 4 scopes decryptable. Personal journals, financial data, health records, family messages all exposed.

**Likelihood**: Medium. Application-level scope enforcement can be bypassed by any code running as user `claude`.

**Current mitigation**:
- `AGENT_SCOPES` env var parsed and enforced by `db-d1.js` auto-decrypt
- `ScopeViolationError` thrown when scope mismatch detected
- Console error logging on scope violations

**Residual risk**: The master key derives all scope keys deterministically. There is no cryptographic enforcement -- scope isolation is purely application-level. This is the fundamental limitation of having a single master key with HKDF derivation.

**DREAD**: D:10 R:6 E:5 A:10 D:4 = **7.0**

---

#### E-3: Tenant Isolation Bypass (Managed Hosting)

**Description**: For managed hosting customers, tenant D1 routing depends on the `X-Tenant-ID` header. If a tenant binding is not found, the Worker falls back to the owner's D1 database. A request with a missing or invalid tenant ID could route to the wrong database.

**Attack vector**: Agent sends request without `X-Tenant-ID` header (or with wrong value), causing queries to hit the owner's D1 instead of the tenant's isolated D1.

**Impact**: Cross-tenant data access. A customer's agent could read/write the owner's data.

**Likelihood**: Low-Medium. The fallback is documented as "safe because user_id filtering," but user_id filtering only applies to SELECT queries on user-data tables.

**Current mitigation**:
- Per-tenant D1 bindings in wrangler.toml
- user_id filtering on SELECT queries (for non-admin auth)
- Startup self-check verifies tenant identity (planned, per TENANT-HARDENING-PLAN.md)

**Residual risk**: The fallback-to-owner pattern is inherently dangerous. A missing binding should return 503, not silently route to the owner's database. User_id filtering does not cover writes.

**DREAD**: D:8 R:5 E:4 A:5 D:4 = **5.2**

---

#### E-4: Admin Privilege via ADMIN_SECRET

**Description**: `ADMIN_SECRET` grants unrestricted access across all scopes and all tables. It bypasses user_id filtering (admin/legacy auth gets a warning only, not a block). It is used by scripts, provisioning, and as a fallback auth mechanism.

**Attack vector**: Extract `ADMIN_SECRET` from VPS `.env` or from the secrets table in D1. Use it to execute arbitrary queries without user_id restrictions.

**Impact**: Full, unrestricted access to all data for all tenants.

**Likelihood**: Low-Medium. The secret is stored in `.env` and injected via bootstrap-secrets. Available to any process running as user `claude`.

**Current mitigation**:
- Timing-safe comparison
- Admin endpoints require `identity.agent === "admin"` check
- Security email on sensitive admin actions (export, provisioning)

**Residual risk**: The ADMIN_SECRET is a god-mode credential with no expiry, no rotation, no MFA, and no audit trail beyond console logs. It should be rotated regularly and usage should trigger alerts.

**DREAD**: D:10 R:6 E:4 A:10 D:4 = **6.8**

---

## Risk Summary Matrix

| ID | Threat | Category | DREAD | Residual Risk |
|----|--------|----------|-------|---------------|
| **E-1** | Agent-to-Admin via Secrets/Sessions table writes | Elevation | **7.2** | Table-level ACL needed on DB proxy |
| **I-2** | Cross-agent data access (same user) | Info Disclosure | **7.0** | No OS-level process isolation |
| **I-3** | Master key in env var of every process | Info Disclosure | **7.0** | No HSM/TPM, no encrypted-at-rest |
| **E-2** | Scope escalation via master key | Elevation | **7.0** | Application-level scope only |
| **T-4** | File upload path traversal | Tampering | **7.0** | No path validation on file reads |
| **E-4** | ADMIN_SECRET god-mode | Elevation | **6.8** | No rotation, no expiry |
| **S-1** | Agent token impersonation | Spoofing | **6.6** | Same Linux user for all agents |
| **S-4** | PORTAL_APP_TOKEN WebAuthn bypass | Spoofing | **6.6** | Static credential, no 2FA |
| **T-1** | SQL injection via DB proxy | Tampering | **6.6** | No write-side table ACL |
| **R-1** | Insufficient audit logging | Repudiation | **6.4** | No centralized tamper-evident log |
| **I-5** | Error messages leaking internals | Info Disclosure | **6.4** | Worker returns D1 error details |
| **T-2** | Prompt injection tool abuse | Tampering | **6.2** | No sandbox for Claude CLI |
| **D-3** | JSON body size exhaustion | DoS | **6.0** | 10MB limit generous |
| **S-2** | Session token theft | Spoofing | **5.8** | SameSite=Lax, not Strict |
| **S-3** | Legacy shared secret | Spoofing | **5.8** | Should be deprecated |
| **R-2** | No key usage logging | Repudiation | **5.8** | Ephemeral console logs only |
| **I-4** | Intel wildcard CORS | Info Disclosure | **5.8** | Accepted risk (public data) |
| **D-1** | Agent spawning exhaustion | DoS | **5.6** | App-level limits only |
| **D-2** | Rate limit bypass | DoS | **5.6** | Generous per-agent limits |
| **T-3** | Enrichment plaintext window | Tampering | **5.2** | Architectural trade-off |
| **I-1** | Embedding inversion | Info Disclosure | **5.2** | No DP on vectors |
| **E-3** | Tenant isolation bypass | Elevation | **5.2** | Fallback-to-owner pattern |

---

## Recommended Mitigations (Priority Order)

### P0 -- Immediate (DREAD >= 7.0)

1. **Table-level write ACL on DB proxy** (E-1, T-1): Maintain a whitelist of tables each agent is allowed to write to. Block writes to `secrets`, `sessions`, `passkey_credentials`, `agent_tokens`, `users`, `registration_tokens`, `provisioning_jobs`. This is the highest-impact fix for its effort.

2. **File path validation** (T-4): Validate all `filePath` parameters against an allowlist of permitted directories (e.g., `/home/claude/agents/<agent>/`, `/tmp/`). Reject paths containing `..`, starting with `/etc/`, or pointing to `.env*` files.

3. **Process isolation for agents** (I-2, E-2, I-3): At minimum, run each agent as a separate Linux user with restricted filesystem permissions. Ideally, use systemd sandboxing (`ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=yes`). Long-term, consider containers.

### P1 -- Short Term (DREAD 6.0-6.9)

4. **ADMIN_SECRET rotation** (E-4): Implement quarterly rotation. Add audit logging for all ADMIN_SECRET usage. Consider time-bounded admin tokens instead of a permanent secret.

5. **Deprecate MYA_WORKER_SECRET** (S-3): Complete migration to per-agent tokens. Remove legacy auth path from Worker.

6. **Deprecate PORTAL_APP_TOKEN** (S-4): Implement a proper OAuth flow for native apps, or use time-bounded app tokens with device registration.

7. **Centralized audit log** (R-1, R-2): Write all auth events, scope derivations, decryption operations, and admin actions to an append-only D1 table. Include: timestamp, agent_id, operation, scope, target_table, user_id, IP, success/failure.

8. **Error sanitization** (I-5): Strip D1 error details from Worker responses. Return generic error codes instead of SQL error messages.

9. **Claude CLI sandboxing** (T-2): Restrict the Claude subprocess's filesystem access. At minimum, set `HOME` to a per-agent temp directory and use a restricted PATH. Block access to `.env*` files via AppArmor or read-only bind mounts.

### P2 -- Medium Term (DREAD < 6.0)

10. **Tenant fallback removal** (E-3): Change `getD1ForTenant()` to return null (503) instead of falling back to owner DB when a tenant binding is not found.

11. **Scope-aware session tokens** (S-2): Consider scoped portal sessions (e.g., a "view-only" session for shared dashboards vs. full admin session).

12. **Differential privacy on embeddings** (I-1): Research and evaluate DP noise injection for Vectorize vectors to mitigate inversion attacks while maintaining search quality.

13. **Reduce JSON body limit** (D-3): Lower to 1MB for non-upload endpoints. Keep 10MB only for file import paths.

14. **SameSite=Strict cookies** (S-2): Evaluate impact of upgrading from Lax to Strict. May break OAuth redirect flows.

---

## Appendix: Attack Trees

### Full Compromise (Master Key Extraction)

```
Goal: Extract ENCRYPTION_MASTER_KEY
├── VPS access as user `claude`
│   ├── Prompt injection → Claude CLI reads .env.crypto
│   ├── Dependency supply chain → malicious npm package reads env
│   ├── SSH key compromise → direct VPS login
│   └── Exploit in Node.js/PM2 → RCE as `claude`
├── /proc filesystem
│   └── Any agent reads /proc/<other_pid>/environ
├── PM2 environment inspection
│   └── pm2 env <process_id> (requires user `claude`)
└── Cloudflare account compromise
    └── Cannot extract key (Swiss Vault: key not in Worker)
```

### Scope Escalation

```
Goal: Read personal-scope data from org-scope agent
├── Direct master key access (see above) → derive personal scope key
├── DB proxy write escalation
│   ├── INSERT into agent_tokens with personal scope
│   └── INSERT into sessions with full portal access
├── Bootstrap-secrets injection
│   └── Modify AGENT_SCOPES env var in secrets table
└── Code modification
    └── Edit lib/crypto-local.js to remove allowedScopes check
```

---

## Review Schedule

This threat model should be reviewed:
- After any architectural change (new trust boundary, new auth mechanism)
- After any security incident
- Quarterly, at minimum
- When adding new tenants (managed hosting customers)

---

*Generated 2026-04-06. Next review due: 2026-07-06.*
