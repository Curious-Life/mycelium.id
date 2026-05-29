---
name: Security is non-negotiable — Swiss Vault standard
description: Zero security compromises. Flag vulnerabilities proactively. Master key on VPS only, Worker is ciphertext passthrough. All agents must enforce this. Embedding vectors are sensitive — treat as plaintext equivalent.
type: feedback
---

Security is the #1 priority in Mycelium. NEVER compromise security for convenience, speed, or simplicity. This applies to ALL Claude Code instances working on this project across ALL VPS instances.

**Why:** Mycelium handles the most intimate data a human produces: thoughts, reflections, relationships, inner work, financial records, and personal meaning-making. This is not a web app — it is a cognitive vault. The system must meet Swiss Vault level security: data sovereignty, zero-knowledge architecture, defense-in-depth isolation. Every line of code must be written as if an attacker is reading it.

**How to apply:**

Core architecture (Swiss Vault):
- Master encryption key lives ONLY on VPS (tmpfs or KMS, never disk)
- Cloudflare Worker has NO master key — it is a pure ciphertext relay
- All encryption/decryption happens on VPS via `lib/crypto-local.js`
- Never add crypto operations to the Worker
- Per-user key hierarchy: master → HKDF(userId) → HKDF(scope) → scope key
- 4 scopes: personal, org, wealth, moms — enforced via AGENT_SCOPES env var
- Two-key separation: SYSTEM_KEY (operator infra) vs USER_MASTER_KEY (customer data)

Tenant isolation (TOTAL — every layer):
- D1 databases: per-tenant (separate databases via getD1ForTenant)
- Vectorize: per-tenant NAMESPACES (enforced at storage layer by Cloudflare)
- R2 attachments: per-tenant key prefixes
- Secrets: per-tenant encryption with scope-derived keys
- No shared state between tenants except operator metadata (provisioning_jobs, handle_reservations)
- X-Tenant-ID header MUST be validated against authenticated token's tenant_id

Embedding vectors are sensitive:
- BGE-M3 1024D embeddings are semantic fingerprints of plaintext content
- Embedding inversion attacks can reconstruct approximate message content WITHOUT the master key
- NEVER expose raw embedding values (float arrays) in API responses except to admin auth
- Treat vector storage with the same paranoia as the encrypted messages themselves
- Vectorize getByIds MUST strip `values` from response (only return metadata)

When writing code:
- Always ask: "if this machine/process is compromised, what's exposed?"
- Defense in depth: every security boundary needs at least 2 independent enforcement layers
- Fail closed: missing auth → reject. Missing key → refuse write. Unknown tenant → deny.
- Never transmit secrets (master key, tokens) in HTTP request bodies
- Never log sensitive data (keys, tokens, PII) — use structured audit logging
- Use parameterized queries — never concatenate user input into SQL
- Validate all inputs at system boundaries
- Use timing-safe comparisons for all secret comparisons

When noticing vulnerabilities:
- **FLAG IMMEDIATELY** — don't wait to be asked
- Describe: what's vulnerable, what an attacker could do, severity (CRITICAL/HIGH/MEDIUM/LOW)
- Propose a fix with the secure approach first
- Never dismiss a vulnerability as "unlikely" — if it's exploitable, flag it

When suggesting approaches:
- Lead with the secure option, not the fast one
- Prefer architecture changes over security shortcuts
- If a feature request conflicts with security, explain the tradeoff and recommend the secure path
- No plaintext secrets in version control, logs, error messages, or client-side code
- No `sendDefaultPii`, no wildcard CORS, no `StrictHostKeyChecking=no`, no `NOPASSWD:ALL`
- No security shortcuts: never expose encrypted data via plaintext columns, unauth endpoints, or debug modes

Existing hardening (Apr 2026):
- Scope enforcement on decrypt (ScopeViolationError)
- SQL user_id enforcement (Worker rejects unfiltered queries)
- CORS whitelist (no wildcards), CSRF double-submit cookies
- Security headers (HSTS, CSP, X-Frame-Options)
- Rate limiting (fail-closed), audit logging
- AppArmor profiles (agents can't read .env)
- Per-user key hierarchy (envelope v2/v3)
- Vectorize namespace isolation (per-tenant, 4-layer defense in depth)
- Full security audit: docs/SECURITY-AUDIT-2026-04-06.md
- Threat model: docs/THREAT-MODEL.md
- Incident response: docs/INCIDENT-RESPONSE.md
