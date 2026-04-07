# Mycelium Security Audit Report

**Date:** 2026-04-06
**Classification:** CONFIDENTIAL
**Auditor:** Senior Security Specialist (automated deep audit)
**Standard:** Swiss Vault / Government-Grade Security Posture

---

## Executive Summary

Mycelium is a multi-agent personal intelligence system handling deeply sensitive personal data: private conversations, financial records, health data, contact networks, and geopolitical intelligence. The system aspires to "Swiss Vault" security — meaning data sovereignty, zero-knowledge architecture, and defense-in-depth isolation.

**Overall Assessment: MODERATE-HIGH risk.** The cryptographic foundations are strong (AES-256-GCM, HKDF key derivation, envelope encryption). However, critical gaps in scope enforcement, tenant isolation, and operational security undermine the architecture's theoretical strength. A sophisticated attacker who compromises one agent on the VPS can currently access ALL scopes — personal, wealth, health, and family data.

### Grading (Government Agency Standard)

| Domain | Grade | Comment |
|--------|-------|---------|
| Cryptographic Primitives | **A** | AES-256-GCM, HKDF, random IVs, auth tags — textbook correct |
| Key Architecture | **A-** | Swiss Vault (master key on VPS only) is excellent design |
| Scope Isolation (Crypto) | **F** | VPS decrypt has zero scope validation — all scopes accessible |
| Scope Isolation (Query) | **D** | SQL scope filtering documented but not enforced |
| Tenant Isolation | **C** | Per-tenant D1 is good, but fallback + missing user_id filters |
| Authentication | **B+** | WebAuthn + per-agent tokens + timing-safe comparison |
| Network Security | **C+** | CORS fixed, localhost binding, but no security headers |
| Portal Client Security | **C** | Master key sent in plaintext POST body, no CSP, CDN without SRI |
| Supply Chain | **C** | No artifact integrity verification, SQL injection in provisioning |
| Operational Security | **D+** | No key rotation ever performed, no audit logging, no IRP |
| Monitoring & Detection | **D** | No intrusion detection, no anomaly alerting, no file integrity |

---

## TIER 1 — CRITICAL VULNERABILITIES (Immediate Action Required)

These findings would cause an immediate audit failure at any government agency or financial institution.

---

### CRIT-01: VPS Scope Isolation is Security Theater

**Files:** `lib/crypto-local.js:169-194`, `lib/crypto-local.js:210-222`
**Severity:** CRITICAL
**CVSS Estimate:** 8.8

The system defines 4 encryption scopes (personal, org, wealth, moms) with per-scope key derivation via HKDF. This is excellent design. **However, the VPS-side `decrypt()` function accepts ANY envelope regardless of scope.**

```javascript
// crypto-local.js:169 — NO scope validation
async function decrypt(encoded, masterKey) {
  const envelope = JSON.parse(...);
  // Missing: if (!allowedScopes.includes(envelope.s)) throw Error('Access denied')
  const scopeKey = await deriveScopeKey(masterKey, envelope.s, ['unwrapKey']);
  // Decrypts ANY scope without checking authorization
}
```

The Worker-side crypto (worker/src/services/crypto.ts:200-203) correctly validates scopes:
```typescript
if (!allowedScopes.includes(envelope.s)) {
  throw new Error(`Access denied: scope "${envelope.s}" not in allowed scopes`);
}
```

**But the master key lives on the VPS, not the Worker.** So the VPS — where all decryption happens — has no scope enforcement. Any agent that gets the master key (or is already on the VPS) can decrypt everything.

**Impact:** Complete scope isolation failure. Wealth-agent can read personal journals. A compromised research-agent can read health data. The 4-scope architecture provides zero additional protection beyond the master key itself.

**Fix:** Add `allowedScopes` parameter to VPS `decrypt()` and `decryptFields()`. Each agent must declare its allowed scopes (from its token metadata), and decryption must refuse envelopes outside that scope.

---

### CRIT-02: Silent Decryption Failures Mask Unauthorized Access

**Files:** `lib/crypto-local.js:214-218`, `lib/crypto-local.js:371-388`, `lib/bootstrap-secrets.js:41-46`
**Severity:** CRITICAL
**CVSS Estimate:** 7.5

When decryption fails (wrong scope, corrupted data, key mismatch), the system silently catches the error and either leaves ciphertext in place or returns null. No error is thrown, no audit event is logged.

```javascript
// crypto-local.js:214-218
try {
  result[key] = await decrypt(value, masterKey);
} catch {
  // Failed to decrypt — leave as-is (might be wrong scope)
  // NO: audit log, alert, or error propagation
}
```

**Impact:**
- Unauthorized scope access attempts are invisible
- Data integrity violations go undetected
- Impossible to detect a compromised agent probing other scopes
- No forensic trail for incident response

**Fix:** Distinguish between "wrong scope" (security event → log + alert) and "corrupted data" (data integrity event → log + alert). Never silently swallow.

---

### CRIT-03: SQL Queries Lack Mandatory Scope Filtering

**File:** `lib/db-d1.js:111-138`, `lib/db-d1.js:583-595`, `lib/db-d1.js:627-631`
**Severity:** CRITICAL
**CVSS Estimate:** 8.1

The ENCRYPTION.md design doc states: *"Filter at the SQL layer. Scope filtering happens in the WHERE clause, not post-fetch."* This is NOT implemented.

Specific violations:

1. **`selectByAgent()`** — Filters by `agent_id` only, not `user_id`. Cross-tenant data leakage if agents share IDs.
2. **`listAgentIds()`** — No WHERE clause at all. Returns agent IDs from ALL tenants.
3. **General queries** — `d1Query()` does not inject scope or user_id filters. The Worker logs a warning for missing user_id but does NOT enforce it.

**Impact:** An agent on the shared owner D1 can read messages, documents, and contacts from any tenant. Combined with CRIT-01 (no scope validation on decrypt), the entire row is accessible in plaintext.

**Fix:**
- Make `user_id` a mandatory parameter for all user-data table queries
- Worker must enforce (reject, not warn) queries missing user_id on user-data tables
- Add scope column to WHERE clause based on authenticated agent's allowed scopes

---

### CRIT-04: Master Encryption Key Sent in Plaintext POST Body

**File:** `portal/src/routes/login/+page.svelte:199-217`
**Severity:** CRITICAL
**CVSS Estimate:** 9.1

During first login, the portal sends the raw master encryption key in the POST body:

```typescript
body: JSON.stringify({ keyHash, masterKey: key })
```

The key is hashed client-side (SHA-256) for verification, but the **raw 256-bit master key** is also transmitted. Even over HTTPS, this means:
- The key exists in the browser's JavaScript memory
- The key traverses the TLS-terminated proxy (Caddy/Cloudflare)
- The key could be logged by any middleware, WAF, or load balancer
- Browser dev tools, extensions, or malware can intercept it

**Impact:** The single most sensitive secret in the entire system is exposed during setup. If intercepted, all encrypted data across all scopes is compromised permanently.

**Fix:** Never transmit the master key. Use a zero-knowledge proof or SRP (Secure Remote Password) protocol. The server should verify the client possesses the key without ever seeing it. Alternatively, derive a verification token client-side and never send the key itself.

---

### CRIT-05: SQL Injection in Provisioning Script

**File:** `scripts/provision-customer.sh:52-65`
**Severity:** CRITICAL
**CVSS Estimate:** 8.6

The `update_job()` function concatenates shell variables directly into SQL strings:

```bash
local sql="UPDATE provisioning_jobs SET status='${status}', vps_ip='${ip}'"
```

Variables `$ip`, `$portal`, `$error`, `$SERVER_ID` are not escaped. A crafted VPS IP like `1.2.3.4', status='compromised` would inject arbitrary SQL.

**Impact:** An attacker controlling DNS or VPS provisioning responses could manipulate the provisioning database, potentially redirecting customers to malicious servers.

**Fix:** Use parameterized queries (the `params` array pattern is already used elsewhere in the same script).

---

## TIER 2 — HIGH SEVERITY (Fix Within 1 Week)

---

### HIGH-01: No Security Headers on Any Response

**Files:** `worker/src/utils/cors.ts`, `agent-server.js:1004`
**Severity:** HIGH

Missing from all Worker and agent-server responses:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy` (CSP)
- `X-Frame-Options` (portal has it in hooks.server.ts, but not on API responses)
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection`
- `Referrer-Policy`
- `Permissions-Policy`

The portal's `hooks.server.ts` sets some headers, but the Worker (65+ endpoints) and agent-server (100+ endpoints) set none.

**Impact:** Clickjacking, MIME sniffing, content injection, and missing HSTS allow downgrade attacks.

**Fix:** Add a shared security headers middleware to both Worker and agent-server.

---

### HIGH-02: Rate Limiting Fails Open

**File:** `worker/src/utils/rate-limit.ts:36`
**Severity:** HIGH

If the KV store is unavailable, the rate limiter returns `{ allowed: true }`:

```typescript
// If KV not available, allow the request
if (!kv) return { allowed: true, remaining: -1 };
```

**Impact:** A KV outage (or deliberate KV exhaustion) disables all rate limiting. Attackers get unlimited access to AI endpoints (transcription, TTS, embeddings), admin operations, and database queries.

**Fix:** Fail closed. If KV is unavailable, deny requests with a 503. Or use in-memory fallback counting.

---

### HIGH-03: External Scripts Loaded Without Integrity Verification

**File:** `portal/src/routes/(app)/intel/+page.svelte:464-467, 1136`
**Severity:** HIGH

Multiple CDN scripts loaded dynamically without Subresource Integrity (SRI):

```typescript
s.src = 'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js';
// No integrity="" attribute
const GlobeModule = await import('https://cdn.jsdelivr.net/npm/globe.gl@2/+esm');
// Dynamic import, no SRI possible
```

**Impact:** If jsdelivr CDN is compromised (has happened), malicious JavaScript executes in the portal context with full access to the user's session, cookies, and displayed data.

**Fix:** Bundle these dependencies locally instead of loading from CDN. If CDN is required, use SRI hashes and pin exact versions.

---

### HIGH-04: User Enumeration via Signup Lookup

**File:** `worker/src/index.ts:3834-3886`
**Severity:** HIGH

The `/api/signup/lookup` endpoint reveals whether an email or handle exists in the system, and returns provisioning status + portal URLs.

**Impact:** Attacker can enumerate all registered users, map handles to email addresses, and discover customer VPS URLs.

**Fix:** Return generic responses regardless of whether the user exists. Use rate limiting and CAPTCHA.

---

### HIGH-05: No Token Rotation Has Ever Occurred

**Files:** SECURITY-HARDENING.md, .env.example
**Severity:** HIGH

Per the existing security documentation, no secret rotation has ever been performed. Static secrets include:
- `ADMIN_SECRET` (full-access database key)
- `MYA_WORKER_SECRET` (Worker authentication)
- 7x `DISCORD_BOT_TOKEN`
- `ENCRYPTION_MASTER_KEY` (256-bit master key)
- All `AGENT_TOKEN_*` values
- `PORTAL_APP_TOKEN`

**Impact:** If any secret was ever logged, cached, or observed (e.g., the GitHub OAuth token that was in git remotes), it remains valid indefinitely.

**Fix:** Implement and execute quarterly rotation. Document the rotation procedure. The envelope encryption design already supports key rotation without re-encrypting data — use it.

---

### HIGH-06: Password-less Sudo for Deploy User

**File:** `scripts/server-setup.sh:45`
**Severity:** HIGH

```bash
echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME}
```

The `claude` user has unrestricted passwordless root access.

**Impact:** Any agent process running as `claude` can escalate to root. A compromised agent can modify system files, install rootkits, or exfiltrate the master key from memory.

**Fix:** Restrict sudo to specific commands needed for PM2 and Caddy management:
```
claude ALL=(ALL) NOPASSWD: /usr/bin/pm2, /usr/bin/caddy, /bin/systemctl restart caddy
```

---

### HIGH-07: Sentry Sends PII by Default

**File:** `lib/sentry.js:22`
**Severity:** HIGH

```javascript
sendDefaultPii: true,
```

Unhandled exceptions may include user messages, file paths, contact names, financial data, or health records in the Sentry error payload. This data is sent to Sentry.io (third-party US service).

**Impact:** Sensitive user data leaked to third-party error tracking service, violating zero-knowledge architecture.

**Fix:** Set `sendDefaultPii: false`. Add a `beforeSend` hook to strip sensitive fields. Consider self-hosted Sentry.

---

### HIGH-08: SSH Host Key Verification Disabled in Provisioning

**File:** `scripts/provision-customer.sh:37`, `scripts/update-customers.sh:32`
**Severity:** HIGH

```bash
SSH_OPTS="-i ${SSH_KEY_FILE} -o StrictHostKeyChecking=no"
```

**Impact:** MITM attack during customer VPS provisioning. An attacker intercepting the SSH connection could receive the customer's master key, agent tokens, and full deployment.

**Fix:** Use `StrictHostKeyChecking=accept-new` (trust on first use) or pre-populate known_hosts from the VPS provider API.

---

## TIER 3 — MEDIUM SEVERITY (Fix Within 1 Month)

---

### MED-01: CORS Origin Fallback Logic Flaw

**File:** `worker/src/utils/cors.ts:18`

The `corsOrigin()` function returns the first allowed origin as fallback when the request origin doesn't match the whitelist. This could allow mismatched CORS headers.

**Fix:** Return no `Access-Control-Allow-Origin` header for non-matching origins (reject the request).

---

### MED-02: No Content Security Policy (CSP)

**Files:** Portal, Worker, agent-server

No CSP header is set anywhere. The portal loads external scripts from jsdelivr, Google Fonts, and CartoDB — all of which should be whitelisted in a strict CSP.

**Fix:** Implement a strict CSP with `script-src 'self'`, `style-src 'self' fonts.googleapis.com`, and nonces for inline scripts.

---

### MED-03: Localhost Authentication Bypass Trusts X-Forwarded-For

**File:** `agent-server.js:1283, 1691, 4868`

Localhost requests skip `MYA_WORKER_SECRET` validation. The IP check uses `req.ip` which respects `X-Forwarded-For` if Express trusts proxies.

**Fix:** Ensure Express `trust proxy` is set correctly. Consider requiring authentication even for localhost in multi-tenant deployments.

---

### MED-04: Health Endpoint Leaks Operational Details

**File:** `agent-server.js:1201-1253`

The `/health` endpoint (no auth required) returns: agent model, tier, version, encryption status, AGENT_TOKEN availability, and feature flags. This is reconnaissance gold.

**Fix:** Return only `{ status: "ok" }` on unauthenticated health checks. Detailed status behind authentication.

---

### MED-05: No Audit Logging System

**Files:** Entire codebase

Despite migration 090 creating an `audit_log` table, no code writes to it. There is no audit trail for:
- Secret access or modification
- Admin operations
- Authentication events (login, logout, failed attempts)
- Data export or bulk operations
- Configuration changes
- Decryption operations

**Fix:** Implement structured audit logging for all security-relevant operations. Government systems require immutable, tamper-evident audit logs.

---

### MED-06: No CSRF Token Validation

**File:** Portal authentication flow

The portal relies entirely on `SameSite=Lax` cookies for CSRF protection. No explicit CSRF tokens are generated or validated.

**Fix:** Add CSRF tokens as belt-and-suspenders defense. `SameSite=Lax` is insufficient against subdomain attacks.

---

### MED-07: Email Validation is Trivial

**File:** `worker/src/index.ts:2451`

Waitlist signup only checks `includes("@")`. This allows: `x@`, `@y`, `@@`, and other invalid emails.

**Fix:** Use RFC 5322 email validation regex or a validation library.

---

### MED-08: No File Integrity Monitoring on VPS

**Files:** Server deployment scripts

No AIDE, OSSEC, Tripwire, or equivalent file integrity monitoring is configured. Changes to deployed code, configuration, or system binaries go undetected.

**Fix:** Install and configure AIDE or similar. Alert on changes to `/home/claude/mycelium/`, `/etc/caddy/`, and system binaries.

---

### MED-09: Cloudflare Resource IDs in Version Control

**File:** `worker/wrangler.toml:29, 55, 62`

D1 database IDs, KV namespace IDs, and Vectorize index names are committed to the repository. While IDs alone don't grant access, they are useful for targeted attacks against the Cloudflare account.

**Fix:** Use environment variables or `wrangler.toml` overrides for resource IDs.

---

### MED-10: Release Tarballs Not Integrity-Checked

**File:** `scripts/provision-customer.sh:166-187`

Customer deployments download/cache release tarballs without SHA256 checksum verification.

**Impact:** A compromised build artifact or cache could deploy malicious code to customer VPS instances.

**Fix:** Sign releases with GPG. Verify signatures before deployment.

---

## TIER 4 — LOW / INFORMATIONAL

| ID | Finding | File | Risk |
|----|---------|------|------|
| LOW-01 | Zero HKDF salt (acceptable but unconventional) | crypto-local.js:19 | Low |
| LOW-02 | Setup token printed to console logs | agent-server.js:5049 | Low |
| LOW-03 | PORTAL_APP_TOKEN has no expiry | agent-server.js:4834 | Low |
| LOW-04 | No API versioning | Worker routes | Informational |
| LOW-05 | Port allocation is predictable (5000+index*2) | ecosystem.config.cjs | Informational |
| LOW-06 | Google Fonts loaded from CDN (tracking) | portal/src/app.html:19-22 | Low |
| LOW-07 | WebAuthn challenges stored in-memory (lost on restart) | lib/auth/passkey.js:26-44 | Low |
| LOW-08 | No commit signing enforcement | CI workflow | Low |
| LOW-09 | Master key validation: accepts any 64 hex chars | agent-server.js:5204 | Low |
| LOW-10 | D1 has no Row-Level Security (by design) | Migration files | Informational |

---

## COMPARISON: Current State vs. Government-Grade Requirements

### What a Top-Level Agency Would Require

| Requirement | Current State | Gap |
|-------------|---------------|-----|
| **Hardware Security Modules (HSM)** for master key | Software `.env` file | Must use HSM or TPM for key storage |
| **FIPS 140-3 validated crypto** | WebCrypto (not FIPS-validated) | Need FIPS-validated module |
| **Mandatory Access Control (MAC)** | No SELinux/AppArmor | Must confine each agent process |
| **Network segmentation** | All agents on same VPS | Each agent in isolated network namespace or VM |
| **Air-gapped key ceremony** | Key generated ad-hoc | Need witnessed, documented key ceremony |
| **Immutable audit logs** | No audit logging at all | Append-only log with integrity chain |
| **Intrusion Detection System (IDS)** | None | OSSEC/Wazuh with SIEM integration |
| **Penetration testing** | Never performed | Annual pentest by independent firm |
| **Incident Response Plan (IRP)** | None documented | Written IRP with escalation procedures |
| **Disaster Recovery** | 1Password backup noted | Documented DR with tested recovery |
| **Threat Model Document** | None | Formal threat model (STRIDE/DREAD) |
| **Security clearance for operators** | N/A | Background checks for all with access |
| **Data classification scheme** | Implicit (scopes) | Formal classification with handling procedures |
| **Supply chain verification** | Dependabot only | SBOM, signed dependencies, reproducible builds |
| **Zero-trust networking** | Localhost trust | mTLS between all services |
| **Key rotation** | Never performed | Automated quarterly rotation |
| **Secure boot chain** | Not configured | Measured boot + remote attestation |
| **Memory protection** | None | Process isolation, no-swap, mlock for keys |
| **Compliance certification** | None | SOC2 Type II, ISO 27001 minimum |

---

## RECOMMENDED HARDENING ROADMAP

### Phase 0 — Emergency Fixes (This Week)

1. **Fix VPS scope validation** (CRIT-01) — Add `allowedScopes` to decrypt functions
2. **Fix SQL scope enforcement** (CRIT-03) — Enforce user_id + scope in all user-data queries
3. **Fix master key transmission** (CRIT-04) — Implement SRP or zero-knowledge verification
4. **Fix provisioning SQL injection** (CRIT-05) — Use parameterized queries
5. **Rotate all secrets** that may have been exposed via GitHub OAuth token (HIGH-05)

### Phase 1 — Core Hardening (This Month)

6. **Add security headers** to Worker and agent-server (HIGH-01)
7. **Fix rate limiter to fail closed** (HIGH-02)
8. **Bundle CDN dependencies locally** (HIGH-03)
9. **Implement audit logging** (MED-05) — Write to audit_log table
10. **Restrict sudo** to specific commands (HIGH-06)
11. **Fix Sentry PII** — `sendDefaultPii: false` + beforeSend hook (HIGH-07)
12. **Add CSP header** to portal (MED-02)
13. **Fix CORS fallback** (MED-01)
14. **Fix SSH host key verification** (HIGH-08)

### Phase 2 — Defense in Depth (Next Quarter)

15. **Install file integrity monitoring** (AIDE/OSSEC) (MED-08)
16. **Implement CSRF tokens** (MED-06)
17. **Add intrusion detection** (Wazuh/OSSEC with alerting)
18. **Create formal threat model** (STRIDE methodology)
19. **Write incident response plan**
20. **Implement automated key rotation** (quarterly minimum)
21. **Add SELinux/AppArmor profiles** for agent processes
22. **Implement structured logging** with log aggregation
23. **Sign releases** with GPG for customer deployments

### Phase 3 — Government-Grade (6 Months)

24. **HSM integration** for master key storage (e.g., YubiHSM, AWS CloudHSM)
25. **mTLS** between all internal services
26. **Network namespace isolation** for each agent
27. **SBOM generation** and dependency signing
28. **SOC2 Type II preparation**
29. **Annual penetration testing** by independent firm
30. **Memory protection** — mlock for key material, disable swap for agent processes
31. **Formal key ceremony** — documented, witnessed master key generation
32. **Disaster recovery testing** — quarterly recovery drill

---

## Architecture Recommendations for True Swiss Vault Security

### 1. Per-User Key Hierarchy (Most Important)

Current: Single master key → HKDF → 4 scope keys
Recommended: Per-user master key → HKDF → per-user scope keys → envelope keys

This ensures that even if one user's key is compromised, other users' data remains protected. The current single master key means compromising it exposes ALL users.

### 2. Zero-Knowledge Authentication

Current: Master key sent in plaintext during setup
Recommended: SRP (Secure Remote Password) protocol — server never sees the key, only verifies possession via zero-knowledge proof.

### 3. Forward Secrecy for Envelope Keys

Current: Scope key wraps content key (AES-KW), content key encrypts data
Recommended: Add ephemeral Diffie-Hellman key exchange so that compromise of the master key doesn't retroactively expose old data. Each encryption operation should use a fresh ephemeral key pair.

### 4. Cryptographic Audit Trail

Current: No audit logging
Recommended: Every decryption operation produces a signed, timestamped audit record: `{ who, what_scope, what_record_id, when, from_ip }`. These records are append-only and integrity-chained (hash chain or Merkle tree).

### 5. Hardware-Backed Key Storage

Current: Master key in `.env` file (plaintext on disk)
Recommended: Store master key in a Hardware Security Module (HSM) or Trusted Platform Module (TPM). The key never leaves the hardware — all crypto operations are performed inside the HSM.

### 6. Process Isolation via Mandatory Access Control

Current: All agents run as same user (`claude`) with shared filesystem access
Recommended: Each agent runs in its own:
- Linux user account (UID isolation)
- AppArmor/SELinux profile (file access restriction)
- Network namespace (port isolation)
- cgroup (resource limits)

This way, a compromised research-agent cannot read the wealth-agent's memory or files.

### 7. Secure Enclave for Sensitive Operations

For the most sensitive operations (key derivation, decryption of financial/health data), consider running a minimal enclave process (e.g., using Intel SGX or AMD SEV) that:
- Holds the master key in encrypted memory
- Performs decryption only for authorized callers
- Cannot be inspected even by root

---

## Summary of Findings by Severity

| Severity | Count | Key Examples |
|----------|-------|-------------|
| **CRITICAL** | 5 | Scope isolation bypass, master key in POST body, SQL injection, no scope filtering |
| **HIGH** | 8 | No security headers, rate limit fail-open, CDN without SRI, no rotation, sudo |
| **MEDIUM** | 10 | No CSP, no CSRF tokens, no audit logs, no FIM, CORS flaw |
| **LOW/INFO** | 10 | Zero HKDF salt, setup token in logs, predictable ports |
| **TOTAL** | 33 | |

---

## Conclusion

The Mycelium system has a **well-designed cryptographic foundation** — the Swiss Vault pattern, envelope encryption, and HKDF key derivation are architecturally sound. The WebAuthn authentication, timing-safe comparisons, and per-agent token model show security awareness.

However, **the implementation has critical gaps** that reduce the effective security posture from "Swiss Vault" to "locked front door with open windows." The three most urgent issues are:

1. **Scope isolation is not enforced on the VPS** — the master key can decrypt everything
2. **The master key is transmitted in plaintext** during setup
3. **SQL queries don't enforce scope or tenant boundaries** as designed

Until these are fixed, the system's actual security is determined by the weakest agent process on the VPS, not by the cryptographic architecture.

For true government-grade security, the system needs HSM-backed key storage, mandatory access control, network segmentation, formal audit logging, and independent penetration testing. These are achievable in phases, and the existing architecture is a good foundation to build upon.

---

*This report should be treated as confidential. Findings should be remediated before sharing externally. The audit was performed through static code analysis; runtime penetration testing is recommended as a follow-up.*
