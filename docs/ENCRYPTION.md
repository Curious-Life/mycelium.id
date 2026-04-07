# Mycelium Encryption & Security Hardening

*Spec finalized Feb 28, 2026. Based on full codebase audit + threat model review.*
*Updated Apr 4, 2026: Swiss Vault — master key moved from Worker to VPS.*
*Updated Apr 7, 2026: Master key hardening — tmpfs storage, sodium SecureBuffer, encrypted swap, ptrace restriction, core dump disabled, --inspect blocked, PM2 dump filtering.*

---

## Current Architecture: Swiss Vault (Apr 2026)

The master key lives exclusively on the VPS. The Cloudflare Worker is a **pure ciphertext relay** — it stores and returns encrypted data but cannot decrypt it.

> **Honest scope note:** "Swiss Vault" describes **data at rest**. The master key is on the VPS, Cloudflare's storage layers (D1, R2, Vectorize) only see ciphertext, and a Cloudflare-side breach or subpoena cannot recover plaintext. **Live portal traffic is a separate trust boundary**: customer subdomains (`handle.mycelium.id`) are proxied through Cloudflare's edge, where Cloudflare terminates TLS with their own cert and inspects HTTP requests before re-encrypting to the VPS. During an active session, Cloudflare can technically observe live messages and queries in transit. This is the same subprocessor model every Cloudflare-fronted SaaS uses. We accept this tradeoff because the alternative — DNS-only with the VPS IP exposed publicly — removes Cloudflare's edge DDoS/scanning protection from a single-tenant box. See [Live portal traffic trust boundary](#live-portal-traffic-trust-boundary) below for the full analysis.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   VPS (trusted boundary)                 CLOUDFLARE                 │
│                                                                     │
│   ┌──────────────────────┐               ┌──────────────────────┐  │
│   │  AGENTS + PORTAL     │               │   MYA WORKER         │  │
│   │                      │               │                      │  │
│   │  lib/crypto-local.js │    HTTPS      │   Auth layer:        │  │
│   │  ┌────────────────┐  │  ─────────►   │   validate token     │  │
│   │  │ MASTER KEY     │  │  Bearer       │   → identity/scopes  │  │
│   │  │ (tmpfs / RAM)  │  │  token        │                      │  │
│   │  │                │  │               │   Passthrough:        │  │
│   │  │ encrypt →      │  │               │   store ciphertext   │  │
│   │  │ ciphertext out │  │               │   return ciphertext  │  │
│   │  │                │  │               │                      │  │
│   │  │ ciphertext in  │  │               │   NO master key      │  │
│   │  │ → decrypt      │  │               │   NO crypto ops      │  │
│   │  └────────────────┘  │               │                      │  │
│   │                      │               │   ┌────────────────┐ │  │
│   │  lib/db-d1.js        │               │   │  D1 (cipher)   │ │  │
│   │  auto-encrypt params │               │   │  Vectorize     │ │  │
│   │  auto-decrypt results│               │   │  R2            │ │  │
│   │                      │               │   └────────────────┘ │  │
│   └──────────────────────┘               └──────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Key files:**
- `lib/crypto-local.js` — AES-256-GCM encrypt/decrypt (Node.js webcrypto)
- `lib/db-d1.js` — transparent auto-encrypt on write, auto-decrypt on read
- `lib/bootstrap-secrets.js` — fetches ciphertext secrets from Worker, decrypts locally
- `scripts/enrichment-daemon.js` — decrypts content locally for AI tagging/embedding
- `scripts/seed-secret.js` — encrypts secrets locally before PUT to Worker

**Worker endpoints (ciphertext passthrough):**
- `POST /api/db/query` — execute SQL, return raw ciphertext
- `POST /api/db/batch` — batch SQL, return raw ciphertext
- `POST /api/search/hybrid` — FTS + Vectorize search, return raw ciphertext
- `GET /api/secrets` — return encrypted secret values
- `PUT /api/secrets` — store pre-encrypted secret values

---

## Master Key Hardening (Apr 7, 2026)

The master key is the single most sensitive piece of data in the system. Even with the Swiss Vault architecture (key on VPS only), the original implementation had the key sitting in `.env` on disk — readable by Hetzner rescue mode, disk theft, file leaks, or PM2's `dump.pm2` snapshot. This section documents the hardening that closed those gaps.

### 1. Key on tmpfs, not on disk

The master key is stored at `/run/mycelium/master.key` on a tmpfs (RAM-only) filesystem. Auto-mounted at boot via `/etc/fstab`:

```
tmpfs /run/mycelium tmpfs size=1M,mode=0700,uid=claude,gid=claude,noexec,nosuid,nodev 0 0
```

The file is `0400` (owner read-only). On reboot, the tmpfs is empty — the key must be re-provided via `bash scripts/set-master-key.sh`. This trade-off is intentional: planned reboots require re-keying, but disk theft and rescue mode can never recover the key.

### 2. sodium-native SecureBuffer

When `lib/crypto-local.js` reads the key file, it uses sodium-native's `sodium_malloc()` to allocate an mlock'd, MADV_DONTDUMP buffer. The key bytes never live in a regular Node `Buffer` or V8 heap string. Hex decoding uses pure arithmetic (no `String.fromCharCode` / `parseInt` which could intern key material in V8's string table). Both intermediate buffers are zeroed immediately after the `CryptoKey` is imported.

### 3. set-master-key.sh — never enters a bash variable

The setup script reads the key from stdin via `head -c` and writes it directly to the tmpfs file via `tr`. The key never enters a bash variable, never appears in `~/.bash_history` (`set +o history` at top), and the temp file is created on tmpfs (`mktemp -p /run/mycelium`) so it never touches disk.

### 4. Encrypted swap

Swap is enabled (needed for ML model loading) but encrypted with a random key generated from `/dev/urandom` at every boot. systemd unit `encrypted-swap.service`:

```
ExecStart=/bin/bash -c 'cryptsetup open --type plain --key-file /dev/urandom --key-size 256 /swapfile swap_crypt && mkswap /dev/mapper/swap_crypt && swapon /dev/mapper/swap_crypt'
```

Swap pages from previous boots become unreadable after reboot — the encryption key is lost.

### 5. PM2 dump.pm2 protection

PM2's `pm2 save` writes process environment variables to `~/.pm2/dump.pm2` in plaintext JSON. `filter_env` in `ecosystem.config.cjs` strips 20 sensitive env var names from PM2's serialization. Belt-and-suspenders: hourly cron with `flock` (`/etc/cron.d/scrub-pm2-dump`) runs `jq` to scrub any pre-existing dumps.

### 6. Memory protection sysctls

`/etc/sysctl.d/99-mycelium-security.conf`:
```
kernel.core_pattern=|/bin/false      # No core dumps to disk
fs.suid_dumpable=0                   # No suid process dumps
kernel.yama.ptrace_scope=1           # ptrace blocked except parent process
```

`/etc/security/limits.conf`:
```
* hard core 0
* soft core 0
```

This blocks `gdb -p <pid>` from another shell, prevents kernel from writing memory to disk on crash, and ensures suid binaries can't be dumped.

### 7. No --inspect in production

Every Node.js entry point (`agent-server.js`, `orchestrator.js`, `scripts/enrichment-service.js`, `scripts/enrichment-daemon.js`) checks `process.execArgv` at startup and exits with FATAL if `--inspect` is present. The Node.js inspector enables `v8.writeHeapSnapshot()` which would dump the entire JS heap, including any key material in flight.

### What an attacker still gets

| Attack | Result |
|--------|--------|
| Hetzner rescue mode → mount disk | tmpfs is RAM, no key on disk |
| Disk theft / .env leak | No key in any file |
| `cat ~/.pm2/dump.pm2` | Sensitive env vars filtered out |
| Force crash → core dump | Core dumps disabled |
| `gdb -p <agent_pid>` from another shell | "Operation not permitted" (ptrace_scope=1) |
| `node --inspect agent-server.js` → DevTools | FATAL exit at startup |
| Force swap-out → read /swapfile | Encrypted with random per-boot key |
| `cat ~/.bash_history` after `set-master-key.sh` | Key never entered a bash variable |

**Residual risk:** A root attacker on a *running* system can still read `/proc/$pid/mem` for an active process. This is the limitation that the future split-jurisdiction KMS architecture addresses — by moving the KEK to a separate server in a different jurisdiction, even root on the data VPS only sees encrypted DEKs. See [TRUST-MODEL.md](TRUST-MODEL.md) for the full threat analysis.

### Migration

For existing instances with the master key in `.env`:
```bash
sudo bash scripts/server-setup.sh    # Sets up tmpfs mount + sysctls + encrypted swap
bash scripts/migrate-key-to-tmpfs.sh # Reads from .env, writes to tmpfs, strips .env
pm2 delete all && pm2 start ecosystem.config.cjs
```

The script never puts the key in a shell variable. Verifies the key landed in tmpfs, then securely shreds the `.env` backup.

---

## Live portal traffic trust boundary

The Swiss Vault encryption model protects **data at rest**: every value in D1, every blob in R2, every vector in Vectorize is ciphertext that Cloudflare cannot decrypt. The master key never enters Cloudflare's environment in any form. For stored data, the trust boundary is the VPS — full stop.

**Live portal traffic is a different layer with a different trust model**, and we want to be explicit about it rather than wave hands.

### What actually happens during a portal session

Customer portals are served at `handle.mycelium.id` (e.g. `0mm.mycelium.id`). The DNS record for that subdomain is currently configured as a Cloudflare-proxied record (orange cloud). That means:

```
[Browser] ──HTTPS──► [Cloudflare edge] ──HTTPS──► [Customer VPS / Caddy] ──► [Agent on :3004]
            ▲                  ▲                          ▲
            │                  │                          │
        TLS to CF          TLS terminates           TLS re-established
        (CF cert)          at Cloudflare            (Cloudflare → VPS)
                           edge node
```

Cloudflare's edge:
1. Terminates the browser's TLS connection using a Cloudflare-managed certificate
2. Decrypts the HTTP request (it has to — that's how their proxy, WAF, caching, and rate limiting work)
3. Re-encrypts to your VPS over a separate TLS connection
4. Streams the response back the same way

During step 2, Cloudflare can technically read the plaintext HTTP request: chat messages you typed, search queries you ran, the raw body of any portal API call. They are a contractual subprocessor under their standard data processing terms — the same arrangement that covers every Cloudflare-fronted SaaS app.

### Why this does not break the "Cloudflare cannot read your data" claim about stored data

The claim is and remains: **stored data cannot be read by Cloudflare**.

- Vault content is encrypted on the VPS *before* it ever returns from an API call, *before* it's written to D1, *before* anything hits R2 or Vectorize
- The master key is not a Worker secret, not an environment variable, not in any request body, not in any header
- A breach of Cloudflare's storage layer, a subpoena to Cloudflare for stored records, a rogue Cloudflare employee with full database access — none of these recover plaintext

What Cloudflare *can* see is the **transient** plaintext of an active session: the request body of `POST /api/chat` while it's flowing through their edge. They cannot see your archive, your years of stored conversations, your historical documents — only what's in flight during the seconds you're actively using the portal.

### Why we accept this tradeoff

The clean technical fix is to switch the portal subdomain from "Proxied" to "DNS only" (gray cloud) and have Caddy on the VPS terminate TLS directly with a Let's Encrypt cert. Cloudflare would then only act as a DNS provider — returning the VPS IP from a query — and never touch HTTP traffic.

We considered this and rejected it for a single-tenant personal vault, for these reasons:

1. **Public IP exposure**: DNS-only puts the VPS's raw public IP on the internet for anyone to scan. Direct DDoS surface, port scanning, zero-day exposure with no edge protection.
2. **Hetzner DDoS protection alone is thinner**: Hetzner absorbs common volumetric attacks but doesn't provide application-layer protection like Cloudflare's WAF.
3. **IP reuse**: when a VPS is destroyed, the IP can be reassigned by the provider. If DNS isn't cleaned up promptly, the next holder of that IP gets traffic intended for the prior tenant.
4. **The asymmetry is wrong**: removing CF eliminates a *contractual* subprocessor risk (Cloudflare's TOS, MiCA-style legal posture, audit reports) and replaces it with *raw internet exposure* on a single small VPS. For a personal vault on a CAX11, the exposure risk is the bigger one.

The future direction is to shrink the live-traffic surface without exposing the VPS publicly:
- **Client-side encryption for chat content**: encrypt message bodies in the browser with a key derived from the user's passkey, so Cloudflare's edge sees only an opaque blob
- **End-to-end TLS via direct tunnels** (Tailscale, WireGuard, or Cloudflare Tunnel without HTTP termination) for advanced users who want to skip the edge proxy entirely

Until those land, the honest answer is: **stored data is encrypted with a key Cloudflare doesn't have. Live portal traffic flows through Cloudflare's edge as plaintext during active sessions, the same as every other Cloudflare-fronted SaaS.** We disclose this on the marketing site, in this doc, and in [TRUST-MODEL.md](TRUST-MODEL.md).

### What an attacker at the Cloudflare edge layer can and cannot do

| Attack | Result |
|--------|--------|
| Read D1 / R2 / Vectorize storage | Ciphertext only |
| Subpoena Cloudflare for stored records | Ciphertext only — we cannot produce plaintext, neither can they |
| Compromise a Cloudflare edge node *while you're actively using the portal* | Can observe the messages and queries sent during that session |
| Compromise a Cloudflare edge node when no one is using the portal | Sees nothing — there's no traffic to inspect |
| Recover historical sessions from a past compromise | No — Cloudflare does not retain bodies of proxied requests at the edge by default; even if they did, only the duration of the compromise window is exposed |
| Extract the master key from Cloudflare | Impossible — the key is not present in any Cloudflare system |
| Extract per-user data at rest | Impossible — D1 holds ciphertext only |

The remaining "live traffic visible during active sessions" surface is the same trust boundary that every Cloudflare-fronted application carries, including most banks and most "private" tools. We're not pretending it doesn't exist.

---

## Original Design (Feb–Mar 2026, superseded)

> The original architecture had the master key as a Cloudflare Worker secret,
> with the Worker handling all encryption/decryption transparently. This was
> replaced by Swiss Vault in April 2026 to consolidate trust to the VPS.

## Problem

One secret (`MYA_WORKER_SECRET`) unlocks everything — every transcript, every document, every message, every financial record. All content in D1 is plaintext. R2 stores plaintext. If the Worker secret leaks or the VPS is compromised, an attacker gets the full contents of the owner's mind.

## Design Principles

1. **Encrypt at the boundary.** All encryption/decryption happens on the VPS via `crypto-local.js`. The Worker is a ciphertext relay.
2. **4 scopes.** personal, org, wealth, moms — same VPS = same blast radius. Narrow scope isolation adds complexity without real security for a single-user system.
3. **Envelope encryption.** Per-record random DEKs wrapped with scope keys. Key rotation is cheap — re-wrap DEKs, don't re-encrypt content. Scales to millions of records.
4. **Zero changes to agent code.** Agents send plaintext, receive plaintext. `db-d1.js` handles all crypto transparently.
5. **Keep FTS5.** Exact keyword search is genuinely useful. Encrypt content columns, keep a separate searchable column for metadata.
6. **Filter at the SQL layer.** Scope filtering happens in the WHERE clause, not post-fetch. Don't pull rows you'll skip.

---

## Architecture Overview

> See "Current Architecture: Swiss Vault" diagram at the top of this document.
> The original diagram below is kept for historical reference.
>
> **Key change:** Crypto operations moved from Worker to VPS (`lib/crypto-local.js`).
> Worker is now a ciphertext passthrough — no master key, no encrypt/decrypt.

---

## Key Hierarchy

Single master key. Three scopes. User isolation at the SQL layer (`WHERE user_id = ?`), not the crypto layer. All users share the same scope keys — this is Model A (simpler, ship first). Per-user key derivation is a V2 enhancement if needed.

```
ENCRYPTION_MASTER_KEY  (VPS .env.crypto — never leaves VPS; backup in 1Password)
        │
        │  HKDF-SHA256 with domain-separated info strings
        │
        ├── HKDF("mycelium:scope:personal:v1")  ──► scope_key_personal
        │                                             Personal agent only
        │                                             Telegram, mind/, journals,
        │                                             transcripts, personal docs
        │
        ├── HKDF("mycelium:scope:org:v1")  ────────► scope_key_org
        │                                             All agents
        │                                             Company docs, research,
        │                                             commercial, publishing
        │
        └── HKDF("mycelium:scope:wealth:v1")  ─────► scope_key_wealth
                                                      Wealth agent + personal only
                                                      Financial data, portfolios,
                                                      transactions, positions

User isolation:
  Every query includes WHERE user_id = ? (already enforced today).
  Scope keys are shared across users — a compromised Worker
  could theoretically decrypt any user's data.
  This is acceptable: the Worker MUST decrypt to serve data,
  so it's already in the trust boundary regardless.
```

Three scopes. One master key derives all three deterministically. No additional secrets to manage.

---

## Scope Assignment

Data gets assigned a scope at write time based on context:

```
┌─────────────────────────────────────────────────────────────┐
│                    SCOPE INFERENCE                           │
│                                                             │
│  Priority order (first match wins):                         │
│                                                             │
│  1. Explicit scope parameter          → as specified        │
│  2. source = "telegram"               → personal            │
│  3. source = "whatsapp"               → personal            │
│  4. path starts with "mind/"          → personal            │
│  5. path starts with "internal/"      → personal            │
│  6. path starts with "transcriptions/"→ personal            │
│  7. path starts with "wealth/"        → wealth              │
│  8. agent_id = "wealth-agent"         → wealth              │
│  9. agent_id = "personal-agent"       → personal            │
│  10. Default (everything else)        → org                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Agent → Scope Access Matrix

```
              personal    org    wealth
  ─────────────────────────────────────
  Mya           ✓         ✓       ✓      (sees everything)
  Com           ·         ✓       ·
  Ada           ·         ✓       ·
  Rex           ·         ✓       ·
  Noa           ·         ✓       ·
  Rob           ·         ✓       ✓      (org read + wealth read/write)
  Portal        ✓         ✓       ✓      (Owner = full access)
  QA            ·         ✓       ·
```

---

## Agent Token Registry

Replace the single `MYA_WORKER_SECRET` with per-agent tokens. Each token maps to an agent identity, user_id, and allowed scopes.

```jsonc
// Stored as Cloudflare Worker secret: AGENT_REGISTRY
{
  // ── the owner's agents ──
  "tok_mya_<random48hex>": {
    "agent": "personal-agent",
    "name": "Mya",
    "user_id": "<owner-uuid>",
    "scopes": ["personal", "org", "wealth"]
  },
  "tok_com_<random48hex>": {
    "agent": "company-agent",
    "name": "Com",
    "user_id": "<owner-uuid>",
    "scopes": ["org"]
  },
  "tok_ada_<random48hex>": {
    "agent": "research-agent",
    "name": "Ada",
    "user_id": "<owner-uuid>",
    "scopes": ["org"]
  },
  "tok_rex_<random48hex>": {
    "agent": "commercial-intelligence-agent",
    "name": "Rex",
    "user_id": "<owner-uuid>",
    "scopes": ["org"]
  },
  "tok_rob_<random48hex>": {
    "agent": "wealth-agent",
    "name": "Rob",
    "user_id": "<owner-uuid>",
    "scopes": ["org", "wealth"]
  },
  "tok_noa_<random48hex>": {
    "agent": "publishing-agent",
    "name": "Noa",
    "user_id": "<owner-uuid>",
    "scopes": ["org"]
  },
  "tok_qa_<random48hex>": {
    "agent": "qa-agent",
    "name": "QA",
    "user_id": "<owner-uuid>",
    "scopes": ["org"]
  },

  // ── Portal tokens (one per user session) ──
  // These are generated at login and stored in D1 sessions table.
  // The Worker resolves session tokens → user_id + full scopes.
  // Not in the static registry — resolved dynamically (see below).
}
```

Each agent token: 48-byte random hex string. Generated once via `openssl rand -hex 48`. Set via `wrangler secret put AGENT_REGISTRY`.

### Portal / User Session Tokens

Portal users don't use the static agent registry. Instead:

1. User logs in via passkey → session token created in D1 `sessions` table
2. Portal sends `Authorization: Bearer <session_token>` to Worker
3. Worker looks up session in D1 → resolves `user_id`
4. Portal sessions always get full scopes (`personal`, `org`, `wealth`) — the user owns their data
5. The `user_id` from the session is used in all WHERE clauses

This means new users get encryption automatically — no admin token setup needed per user.

---

## Encryption Flow

### Write Path (Agent → Worker → D1)

```
  Agent                          Worker                           D1
    │                              │                               │
    │  POST /api/data/store        │                               │
    │  Authorization: Bearer       │                               │
    │    tok_mya_abc123            │                               │
    │  Body: {                     │                               │
    │    table: "messages",        │                               │
    │    data: {                   │                               │
    │      content: "Hello...",    │                               │
    │      role: "user",           │                               │
    │      source: "telegram"      │                               │
    │    }                         │                               │
    │  }                           │                               │
    │ ────────────────────────►    │                               │
    │                              │                               │
    │                    1. Validate token                         │
    │                       tok_mya → Mya,                        │
    │                       scopes: [personal,org,wealth]         │
    │                              │                               │
    │                    2. Infer scope from context               │
    │                       source="telegram" → "personal"        │
    │                              │                               │
    │                    3. Derive scope key                       │
    │                       HKDF(master, "personal") → scopeKey   │
    │                              │                               │
    │                    4. Generate random DEK (256-bit)          │
    │                       crypto.generateKey(AES-GCM, 256)      │
    │                              │                               │
    │                    5. Generate random IV (12 bytes)          │
    │                              │                               │
    │                    6. Encrypt content with DEK               │
    │                       AES-256-GCM(DEK, IV, "Hello...")      │
    │                       → ciphertext + auth tag               │
    │                              │                               │
    │                    7. Wrap DEK with scope key                │
    │                       AES-KW(scopeKey, DEK) → wrappedDEK    │
    │                              │                               │
    │                    8. Build encrypted field:                 │
    │                       base64({                               │
    │                         "v":1,                               │
    │                         "s":"personal",                      │
    │                         "iv":"<12 bytes>",                   │
    │                         "ct":"<ciphertext+tag>",             │
    │                         "dk":"<wrappedDEK>"                  │
    │                       })                                     │
    │                              │                               │
    │                              │  INSERT INTO messages         │
    │                              │  (content, role, source,      │
    │                              │   scope, ...)                 │
    │                              │  VALUES                       │
    │                              │  ('<encrypted>', 'user',      │
    │                              │   'telegram', 'personal')     │
    │                              │ ───────────────────────────►  │
    │                              │                               │
    │                              │         OK                    │
    │                              │ ◄───────────────────────────  │
    │          OK                  │                               │
    │ ◄────────────────────────    │                               │
```

### Read Path (Agent → Worker → D1 → Decrypt)

```
  Agent                          Worker                           D1
    │                              │                               │
    │  POST /api/data/query        │                               │
    │  Authorization: Bearer       │                               │
    │    tok_ada_def456            │                               │
    │  Body: {                     │                               │
    │    table: "messages",        │                               │
    │    filters: {limit: 10}      │                               │
    │  }                           │                               │
    │ ────────────────────────►    │                               │
    │                              │                               │
    │                    1. Validate token                         │
    │                       tok_ada → Ada,                        │
    │                       scopes: [org]                         │
    │                              │                               │
    │                    2. Add scope filter to SQL                │
    │                       (filter at DB layer, not post-fetch)  │
    │                              │                               │
    │                              │  SELECT * FROM messages      │
    │                              │  WHERE scope IN ('org')      │
    │                              │  ORDER BY created_at DESC    │
    │                              │  LIMIT 10                    │
    │                              │ ───────────────────────────►  │
    │                              │                               │
    │                              │  Returns only org-scoped     │
    │                              │  rows (personal rows never   │
    │                              │  leave D1)                   │
    │                              │ ◄───────────────────────────  │
    │                              │                               │
    │                    3. For each row:                          │
    │                       Parse encrypted envelope               │
    │                       Derive scope key for row.scope        │
    │                       Unwrap DEK: AES-KW⁻¹(scopeKey, dk)   │
    │                       Decrypt: AES-GCM⁻¹(DEK, iv, ct)      │
    │                       → plaintext                           │
    │                              │                               │
    │  Response: [                 │                               │
    │    {content:"decrypted",...}, │                               │
    │    ...only org-scoped rows   │                               │
    │  ]                           │                               │
    │ ◄────────────────────────    │                               │
```

### Key Rotation (the payoff of envelope encryption)

With envelope encryption, rotation re-wraps the small DEK per record — content is **never decrypted or re-encrypted**. This is fast, safe, and scales to millions of records.

```
  Admin                          Worker                           D1
    │                              │                               │
    │  Trigger rotation            │                               │
    │  (manual or scheduled)       │                               │
    │ ────────────────────────►    │                               │
    │                              │                               │
    │                    1. Load new master key                    │
    │                       (ENCRYPTION_MASTER_KEY_V2)            │
    │                              │                               │
    │                    2. For each encrypted row:                │
    │                              │                               │
    │                       a. Parse envelope → get scope, dk     │
    │                              │                               │
    │                       b. Derive OLD scope key               │
    │                          HKDF(old_master, scope)            │
    │                              │                               │
    │                       c. Unwrap DEK with old key            │
    │                          AES-KW⁻¹(old_scopeKey, dk)        │
    │                              │                               │
    │                       d. Derive NEW scope key               │
    │                          HKDF(new_master, scope)            │
    │                              │                               │
    │                       e. Re-wrap DEK with new key           │
    │                          AES-KW(new_scopeKey, DEK)          │
    │                          → new_dk                            │
    │                              │                               │
    │                       f. UPDATE envelope.dk = new_dk         │
    │                          (iv and ct UNCHANGED)              │
    │                              │                               │
    │                    Content never decrypted.                  │
    │                    Only the 32-byte DEK is re-wrapped.      │
    │                              │                               │
    │                    3. At 20K records, re-wrapping            │
    │                       takes seconds, not minutes.           │
    │                       Scales to millions.                   │
    │                              │                               │
    │                    4. Switch master key reference            │
    │                    5. Delete old master key                  │
    │                              │                               │
    │          Done                │                               │
    │ ◄────────────────────────    │                               │
```

**Why this matters at scale:** With direct encryption, rotating a key across 1M records means decrypting and re-encrypting 1M content blobs (potentially GBs of data). With envelope encryption, it means re-wrapping 1M × 32-byte DEKs — a few MB of crypto operations that complete in seconds.

---

## Crypto Primitives

| Purpose | Algorithm | Notes |
|---------|-----------|-------|
| Content encryption | AES-256-GCM | Random DEK per record. 12-byte IV, 128-bit auth tag (explicit `tagLength: 128`) |
| Key wrapping | AES-KW (256-bit) | Wraps per-record DEK with scope key |
| Key derivation | HKDF-SHA256 | Deterministic scope keys from master key |
| Token comparison | `crypto.subtle.timingSafeEqual` | Prevents timing attacks on auth |
| Master key | 256-bit random | `openssl rand -hex 32` |

All natively supported by Cloudflare Workers Web Crypto API. Zero npm dependencies.

### Envelope Encryption

Each record gets its own random 256-bit Data Encryption Key (DEK). The DEK encrypts the content. The DEK itself is wrapped (encrypted) with the scope key. This means:

- **Normal read/write:** Unwrap DEK with scope key → decrypt/encrypt content with DEK
- **Key rotation:** Unwrap DEK with OLD scope key → re-wrap DEK with NEW scope key → done. Content is never re-encrypted. Only the 32-byte DEK wrapper changes per record.

```
┌─────────────────────────────────────────────────────────────┐
│                   ENVELOPE ENCRYPTION                        │
│                                                             │
│   Master Key                                                │
│       │                                                     │
│       │ HKDF                                                │
│       ▼                                                     │
│   Scope Key (e.g. "personal")                               │
│       │                                                     │
│       │ AES-KW (wrap)                                       │
│       ▼                                                     │
│   ┌─────────────────┐    AES-256-GCM    ┌──────────────┐   │
│   │ Wrapped DEK     │◄─────────────────►│ Random DEK   │   │
│   │ (stored in DB)  │                   │ (in memory)  │   │
│   └─────────────────┘                   └──────┬───────┘   │
│                                                │            │
│                                    AES-256-GCM │            │
│                                                ▼            │
│                                   ┌────────────────────┐    │
│                                   │ Plaintext content  │    │
│                                   │      ▲      │      │    │
│                                   │      │      ▼      │    │
│                                   │ Ciphertext (in DB) │    │
│                                   └────────────────────┘    │
│                                                             │
│   KEY ROTATION (cheap):                                     │
│   Old Scope Key → unwrap DEK → re-wrap with New Scope Key  │
│   Content never touched. Only 32-byte DEK re-wrapped.       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Encrypted Field Format

Sensitive fields stored as base64-encoded JSON:

```json
{
  "v": 1,
  "s": "personal",
  "iv": "<12 bytes, base64>",
  "ct": "<ciphertext + GCM auth tag, base64>",
  "dk": "<DEK wrapped with scope key, base64>"
}
```

- `v` — schema version (enables future migration)
- `s` — scope ID (determines which scope key unwraps the DEK)
- `iv` — AES-GCM initialization vector (random per record)
- `ct` — ciphertext with appended GCM authentication tag
- `dk` — DEK wrapped via AES-KW with the scope key

---

## What Gets Encrypted

### Encrypt (content that would be damaging if leaked)

| Table | Fields | Default Scope |
|-------|--------|---------------|
| `messages` | `content`, `thinking` | Inferred from source + agent_id |
| `documents` | `content`, `summary` | Inferred from path + agent_id |
| `attachments` | `transcript` | Linked message scope |
| `clustering_points` | `content` | Source record scope |
| `agent_events` | `payload` | agent_id |
| `agent_tasks` | `context`, `result` | agent_id |
| `people` | `description`, `metadata` | `personal` always |
| `wealth_transactions` | `notes` | `wealth` always |
| `wealth_positions` | *(all numeric fields)* | `wealth` always |
| `wealth_snapshots` | *(all numeric fields)* | `wealth` always |

### Don't Encrypt (needed for queries, routing, or non-sensitive)

| Field Type | Reason |
|-----------|--------|
| IDs, timestamps, foreign keys | Required for joins and filtering |
| `role`, `source`, `agent_id`, `channel_id` | Required for query routing |
| `path`, `title` | Needed for document lookup and FTS5 |
| `tags`, `entities`, `entity_summary` | Used for filtering (semi-public metadata) |
| Embeddings (1024D, 256D) | Lossy projection — can't reconstruct plaintext |
| `scope` column (new) | Must be readable to filter before decryption |
| Session tokens, user settings | Protected by separate auth layer |

### FTS5 Strategy

**Keep FTS5 on non-encrypted metadata.** The `messages_fts` index currently covers `content` and `entity_summary`. After encryption:

- Drop `content` from FTS5 index
- Keep `entity_summary` in FTS5 (entities are semi-public metadata)
- Add `title` to FTS5 for document search
- Hybrid search still works: FTS5 matches on metadata, Vectorize matches on semantic content

Exact keyword search degrades slightly (can't search message body text) but remains functional for entity names, document titles, and tags.

---

## Endpoint Changes

### New Structured Endpoints (encrypt/decrypt transparently)

```
POST /api/data/store          — Encrypt sensitive fields, INSERT/UPDATE
POST /api/data/query          — SELECT, decrypt, filter by scope
POST /api/data/files/upload   — Encrypt file body, store in R2
GET  /api/data/files/:key     — Decrypt file body, serve from R2
```

Each endpoint:
1. Authenticates agent (Bearer token → identity + scopes)
2. On write: infers scope, encrypts sensitive fields, stores
3. On read: retrieves rows, filters by scope, decrypts, returns

### Lock Down Raw Query Endpoint

The existing `/api/db/query` endpoint becomes metadata-only:

```typescript
const REDACTED_COLUMNS = [
  'content', 'thinking', 'transcript', 'description',
  'notes', 'metadata', 'context', 'result', 'payload',
  'summary', 'diff'
];

// Strip sensitive columns from raw query results
function redactResults(rows: any[]): any[] {
  return rows.map(row => {
    const clean = { ...row };
    for (const col of REDACTED_COLUMNS) {
      if (col in clean) clean[col] = '[ENCRYPTED]';
    }
    return clean;
  });
}
```

Agents that need content must use `/api/data/query`. The raw endpoint stays available for metadata queries (timestamps, IDs, counts, joins) but can never return plaintext content.

---

## Multi-User & Onboarding

Encryption is invisible to users. No key management, no seed phrases, no recovery flow. The Worker handles everything.

### New User Signup Flow

```
  New User                       Portal                    Agent Server              Worker
    │                              │                           │                       │
    │  1. Receives invite link     │                           │                       │
    │     (registration token)     │                           │                       │
    │ ────────────────────────►    │                           │                       │
    │                              │                           │                       │
    │  2. Opens portal             │                           │                       │
    │     Registers passkey        │                           │                       │
    │     (WebAuthn)               │                           │                       │
    │ ────────────────────────►    │                           │                       │
    │                              │  3. POST /auth/register   │                       │
    │                              │ ─────────────────────►    │                       │
    │                              │                           │                       │
    │                              │     Create user row       │  INSERT INTO users    │
    │                              │     Generate session      │ ─────────────────►    │
    │                              │     token (32-byte hex)   │                       │
    │                              │                           │  INSERT INTO sessions │
    │                              │                           │ ─────────────────►    │
    │                              │                           │                       │
    │  4. Session cookie set       │                           │                       │
    │     User is in.              │                           │                       │
    │ ◄────────────────────────    │                           │                       │
    │                              │                           │                       │
    │  5. User sends first msg     │                           │                       │
    │ ────────────────────────►    │                           │                       │
    │                              │  6. POST /portal/chat     │                       │
    │                              │     Cookie: session_tok   │                       │
    │                              │ ─────────────────────►    │                       │
    │                              │                           │                       │
    │                              │     Resolve session →     │                       │
    │                              │     user_id               │                       │
    │                              │                           │  7. POST /api/data/   │
    │                              │                           │     store              │
    │                              │                           │  Bearer: agent_token   │
    │                              │                           │  X-User-ID: <uuid>     │
    │                              │                           │ ─────────────────►    │
    │                              │                           │                       │
    │                              │                           │   Worker encrypts     │
    │                              │                           │   with scope key      │
    │                              │                           │   (shared across all  │
    │                              │                           │    users — Model A)   │
    │                              │                           │                       │
    │                              │                           │   Stores with         │
    │                              │                           │   user_id in row      │
    │                              │                           │   (SQL isolation)     │
    │                              │                           │                       │
    │  8. Done. User never         │                           │                       │
    │     sees encryption.         │                           │                       │
```

### What the user sees

Nothing. The portal looks and works exactly the same. Behind the scenes:

- All their messages, documents, and data are encrypted at rest in D1
- Their data is isolated from other users via `user_id` in every query
- Scope filtering ensures agents only see data they're authorized for
- The user never creates, manages, or recovers any keys

### What the admin does per new user

Nothing encryption-related. The existing flow works:

1. Admin generates a registration token (`POST /auth/register-token`)
2. Sends invite link to new user
3. User registers passkey, session created
4. All subsequent data is automatically encrypted

No per-user key provisioning. No secrets to distribute. The single master key in the Worker handles all users.

### User Data Isolation

```
┌─────────────────────────────────────────────────────────────┐
│                     D1 DATABASE                              │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ messages                                               │  │
│  │                                                        │  │
│  │ user_id = "owner-uuid"  │ scope = "personal"         │  │
│  │ content = eyJ...encrypted│                             │  │
│  │                          │                             │  │
│  │ user_id = "owner-uuid"  │ scope = "org"              │  │
│  │ content = eyJ...encrypted│                             │  │
│  │                          │                             │  │
│  │ user_id = "alice-uuid"   │ scope = "personal"         │  │
│  │ content = eyJ...encrypted│  ◄── Same scope key as     │  │
│  │                          │      the owner's personal      │  │
│  │                          │      (Model A: shared keys) │  │
│  │                          │      BUT isolated by        │  │
│  │                          │      WHERE user_id = ?      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Queries always include:                                    │
│    WHERE user_id = ? AND scope IN (?)                       │
│                                                             │
│  the owner's agents can never see Alice's data.                │
│  Alice's agents can never see the owner's data.                │
│  Even though the encryption keys are the same.              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Security note:** In Model A, a compromised Worker could theoretically decrypt any user's data (same scope keys). This is acceptable because the Worker is already in the trust boundary — it must decrypt to serve data. User isolation is enforced at the SQL layer, which is the same trust model as any multi-tenant SaaS. Per-user key derivation (Model B) is a V2 enhancement that adds defense-in-depth if the user base grows large enough to warrant it.

---

## Database Migration

### New Columns

```sql
-- Add scope column to all content tables
ALTER TABLE messages ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE documents ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE attachments ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE clustering_points ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE agent_events ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE agent_tasks ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE people ADD COLUMN scope TEXT DEFAULT 'personal';
ALTER TABLE wealth_transactions ADD COLUMN scope TEXT DEFAULT 'wealth';
ALTER TABLE wealth_positions ADD COLUMN scope TEXT DEFAULT 'wealth';
ALTER TABLE wealth_snapshots ADD COLUMN scope TEXT DEFAULT 'wealth';

-- Index for scope-based filtering
CREATE INDEX idx_messages_scope ON messages(scope);
CREATE INDEX idx_documents_scope ON documents(scope);

-- Migration tracking
CREATE INDEX idx_messages_unencrypted
  ON messages(id) WHERE scope IS NOT NULL AND content NOT LIKE 'eyJ%';
CREATE INDEX idx_documents_unencrypted
  ON documents(id) WHERE scope IS NOT NULL AND content NOT LIKE 'eyJ%';
```

The `eyJ%` prefix check is a heuristic — base64-encoded JSON envelopes starting with `{"v":1,...}` always begin with `eyJ`. This allows the backfill script to be idempotent.

---

## VPS Hardening

This is conspicuously absent from the original Mya/Com specs and is arguably higher ROI than the crypto work. The VPS is the crown jewel — if it falls, encryption is theater.

### Immediate

| Action | How | Why |
|--------|-----|-----|
| SSH key-only auth | Verify `/etc/ssh/sshd_config`: `PasswordAuthentication no` | Prevent brute force |
| Firewall rules | `ufw allow from <trusted-IPs> to any port 22` | Restrict SSH access |
| `.env` permissions | `chmod 600 /home/claude/mycelium/.env` | Owner-read-write only |
| Log directory permissions | `chmod 700 /var/log/mycelium/` | Prevent log snooping |
| Fail2ban | `apt install fail2ban` + SSH jail config | Auto-ban brute force IPs |
| Agent bind address | Change `BIND_HOST: '0.0.0.0'` → `'127.0.0.1'` for personal-agent | Only expose via reverse proxy |

### Audit Logging

Add agent identity to every Worker request:

```
Agent process → HTTP header: X-Agent-ID: personal-agent
Worker → logs: { timestamp, agent_id, endpoint, method, scope, success }
```

Store in a separate `audit_log` table (not encrypted — operational data):

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  scope TEXT,
  table_name TEXT,
  record_count INTEGER,
  success INTEGER NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Auto-purge after 90 days
-- (run via scheduled Worker or cron)
```

---

## Implementation Checklist

### Phase 1: Crypto Infrastructure (Worker)

**Goal:** Deploy crypto service, auth middleware, and new encrypted endpoints. No existing data is modified. Old endpoints still work.

- [x] **1.1** Generate master key: `openssl rand -hex 32` → save to physical backup
- [x] **1.2** Generate per-agent tokens: `openssl rand -hex 48` × 8 (mya, com, ada, rex, rob, noa, qa, portal)
- [x] **1.3** Build `src/services/crypto.ts`:
  - [x] `importMasterKey(hexKey)` — import from env
  - [x] `deriveScopeKey(masterKey, scope)` — HKDF-SHA256 with `mycelium:scope:{scope}:v1` info
  - [x] `encrypt(plaintext, scope, masterKey)` — generate DEK + IV, encrypt with DEK, wrap DEK with scope key, return base64 envelope
  - [x] `decrypt(envelope, allowedScopes, masterKey)` — parse envelope, check scope, unwrap DEK, decrypt content
  - [x] `rotateEnvelope(envelope, oldMasterKey, newMasterKey)` — unwrap DEK with old, re-wrap with new (content untouched)
  - [x] `inferScope(context)` — deterministic scope from source/path/agent_id (priority rules from spec)
  - [x] Scope key cache (Map) to avoid re-deriving per record in batch ops
- [x] **1.4** Build `src/middleware/agent-auth.ts`:
  - [x] Parse `Authorization: Bearer <token>` header
  - [x] Look up token in `AGENT_REGISTRY` (timing-safe comparison)
  - [x] Fall back to session token lookup in D1 `sessions` table (for portal)
  - [x] Return `{ agent, name, user_id, scopes }` or 401
- [x] **1.5** Build `src/handlers/data-api.ts`:
  - [x] `POST /api/data/store` — authenticate, infer scope, encrypt sensitive fields, INSERT/UPDATE via D1
  - [x] `POST /api/data/query` — authenticate, add `WHERE scope IN (?) AND user_id = ?`, SELECT, decrypt, return
  - [ ] `POST /api/data/files/upload` — authenticate, encrypt file buffer, store in R2 (future)
  - [ ] `GET /api/data/files/:key` — authenticate, decrypt file, serve (future)
  - [x] `POST /api/admin/rotate-key` — portal-only, re-wrap all DEKs with new master key
  - [x] `POST /api/admin/backfill` — portal-only, encrypt existing plaintext rows in batches
- [x] **1.6** Add column redaction to existing `src/handlers/db-proxy.ts`:
  - [x] Strip `content`, `thinking`, `transcript`, `description`, `notes`, `metadata`, `context`, `result`, `payload`, `summary`, `diff` from `/api/db/query` results
  - [x] Return `[ENCRYPTED]` placeholder for redacted columns
  - [x] Gated behind `ENABLE_CONTENT_REDACTION` env var (activate in Phase 3)
- [x] **1.7** Route new endpoints in `src/index.ts`
- [x] **1.8** Write D1 migration `migrations/090_encryption_scope.sql`:
  - [x] Add `scope TEXT DEFAULT 'org'` to: messages, documents, attachments, clustering_points, agent_events, agent_tasks
  - [x] Add `scope TEXT DEFAULT 'personal'` to: people
  - [x] Add `scope TEXT DEFAULT 'wealth'` to: wealth_transactions, wealth_positions, wealth_snapshots
  - [x] Add indexes: `idx_messages_scope`, `idx_documents_scope`
  - [x] Add audit_log table
- [x] **1.9** Run migration against D1: `npx --yes wrangler d1 execute mycelium-v2 --remote --file=migrations/090_encryption_scope.sql`
- [x] **1.10** Set Worker secrets:
  - [x] `wrangler secret put ENCRYPTION_MASTER_KEY`
  - [x] `wrangler secret put AGENT_REGISTRY` (JSON with all tokens)
- [x] **1.11** Deploy Worker: `npx --yes wrangler deploy`
- [x] **1.12** **Test:** `curl` to `/api/data/store` with agent token → verify encrypted record in D1 → `/api/data/query` returns decrypted plaintext

### Phase 2: Agent Token Rollout (VPS)

**Goal:** Each agent uses its own token. Shared `MYA_WORKER_SECRET` still works as fallback during transition.

- [ ] **2.1** Update `lib/db-d1.js`:
  - [ ] Read `AGENT_TOKEN` env var (fall back to `MYA_WORKER_SECRET`)
  - [ ] Add `X-Agent-ID` header to all fetch calls
- [ ] **2.2** Update `lib/embed.js` — same token + header changes
- [ ] **2.3** Update `mcp/setup.js` — pass `AGENT_TOKEN` instead of `MYA_WORKER_SECRET` to MCP server env
- [ ] **2.4** Update `ecosystem.config.cjs`:
  - [ ] Add per-agent `AGENT_TOKEN_*` env vars to each agent's env block
  - [ ] Map to `AGENT_TOKEN` in each process
- [ ] **2.5** Update `.env` on VPS with per-agent tokens:
  - [ ] `AGENT_TOKEN_MYA=tok_mya_...`
  - [ ] `AGENT_TOKEN_COM=tok_com_...`
  - [ ] `AGENT_TOKEN_ADA=tok_ada_...`
  - [ ] `AGENT_TOKEN_REX=tok_rex_...`
  - [ ] `AGENT_TOKEN_ROB=tok_rob_...`
  - [ ] `AGENT_TOKEN_NOA=tok_noa_...`
  - [ ] `AGENT_TOKEN_QA=tok_qa_...`
  - [ ] `AGENT_TOKEN_PORTAL=tok_portal_...`
- [ ] **2.6** SCP updated files to VPS: `agent-server.js`, `lib/db-d1.js`, `lib/embed.js`, `mcp/setup.js`, `ecosystem.config.cjs`
- [ ] **2.7** Restart all agents: `pm2 delete all && pm2 start ecosystem.config.cjs`
- [ ] **2.8** **Test:** Each agent can query D1, generate embeddings, run hybrid search
- [ ] **2.9** **Test:** Portal login still works (session token → Worker → D1)

### Phase 3: Dual-Write (new data encrypted)

**Goal:** All new writes encrypted. Old plaintext data still readable during transition.

- [ ] **3.1** Update `lib/db-d1.js` write methods to call `/api/data/store`:
  - [ ] `messages.insert()` — encrypt `content`, `thinking`
  - [ ] `documents.upsert()` — encrypt `content`, `summary`
  - [ ] `attachments.insert()` — encrypt `transcript`
  - [ ] `wealth.addTransaction()` — encrypt `notes`
  - [ ] Include `source`, `agent_id`, `path` context for scope inference
- [ ] **3.2** Update `lib/db-d1.js` read methods to call `/api/data/query`:
  - [ ] `messages.selectRecent()`, `selectPaginated()`, `selectTimeline()`
  - [ ] `documents.get()`, `list()`
  - [ ] `attachments.getById()`, `listByUser()`
  - [ ] `wealth.listTransactions()`, `getPositions()`, `getSnapshots()`
- [ ] **3.3** Worker handles mixed content:
  - [ ] If content starts with `eyJ` → decrypt (envelope)
  - [ ] If content is plaintext → return as-is (legacy)
  - [ ] This allows old and new data to coexist
- [ ] **3.4** Verify `/api/db/query` column redaction is active (from 1.6)
- [ ] **3.5** SCP + deploy updated `lib/db-d1.js` to VPS, restart agents
- [ ] **3.6** **Test:** Send a message via portal → verify it's encrypted in D1
- [ ] **3.7** **Test:** Read old plaintext messages → still works
- [ ] **3.8** **Test:** Hybrid search returns results from both encrypted and plaintext records
- [ ] **3.9** **Soak:** Run for 2-3 days, monitor for errors in agent logs

### Phase 4: Backfill (encrypt existing data)

**Goal:** Encrypt all existing plaintext content. After this, all data in D1 is ciphertext.

- [ ] **4.1** Trigger backfill via `/api/admin/backfill`:
  - [ ] Processes tables in order: messages, documents, attachments, people, wealth_*, clustering_points, agent_events, agent_tasks
  - [ ] Batch size: 200 rows per iteration
  - [ ] For each row: infer scope from agent_id/source/path → set `scope` column → encrypt content fields
  - [ ] Idempotent: skip rows where content starts with `eyJ`
  - [ ] Log progress: `Encrypted 1500/8234 messages (18%)`
- [ ] **4.2** **Validate:** Count encrypted vs total per table
  ```sql
  SELECT COUNT(*) as total,
         SUM(CASE WHEN content LIKE 'eyJ%' THEN 1 ELSE 0 END) as encrypted
  FROM messages;
  ```
- [ ] **4.3** **Validate:** Spot-check 10 records per table — decrypt and verify content matches original
- [ ] **4.4** **Validate:** Portal UI shows data correctly (documents, messages, wealth)
- [ ] **4.5** **Validate:** Agent search works (hybrid search returns backfilled records)

### Phase 5: VPS Hardening

**Goal:** Lock down the VPS as the highest-value target.

- [ ] **5.1** Verify SSH key-only: `grep PasswordAuthentication /etc/ssh/sshd_config` → must be `no`
- [ ] **5.2** Install fail2ban: `apt install fail2ban` + configure SSH jail
- [ ] **5.3** Set `.env` permissions: `chmod 600 /home/claude/mycelium/.env`
- [ ] **5.4** Set log permissions: `chmod 700 /var/log/mycelium/`
- [ ] **5.5** Change personal-agent `BIND_HOST` to `127.0.0.1` in ecosystem.config.cjs
- [ ] **5.6** Set up audit logging:
  - [ ] Worker logs every request: `{ timestamp, agent_id, endpoint, method, scope, success }`
  - [ ] Stored in `audit_log` table (from migration 090)
- [ ] **5.7** Add UFW firewall rules: allow 22 (SSH) from trusted IPs, allow 80/443 for portal
- [ ] **5.8** **Test:** Verify all agents still work after bind address change
- [ ] **5.9** **Test:** Verify SSH access still works after firewall rules

### Phase 6: Cut Over & Cleanup

**Goal:** Remove all legacy plaintext paths. Encryption is now the only way.

- [ ] **6.1** Verify 100% encryption: no rows where `content NOT LIKE 'eyJ%'` in any content table
- [ ] **6.2** Update FTS5 to exclude encrypted content:
  - [ ] Drop content from `messages_fts` triggers
  - [ ] Keep `entity_summary` in FTS5
  - [ ] Rebuild: `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`
- [ ] **6.3** Remove `MYA_WORKER_SECRET` from VPS `.env`
- [ ] **6.4** Remove `MYA_WORKER_SECRET` from Worker secrets: `wrangler secret delete MYA_WORKER_SECRET`
- [ ] **6.5** Remove legacy token support from Worker auth middleware
- [ ] **6.6** Remove fallback to `MYA_WORKER_SECRET` in `lib/db-d1.js` and `lib/embed.js`
- [ ] **6.7** Deploy final Worker + VPS changes
- [ ] **6.8** **Test:** Full end-to-end: portal login → chat → search → documents → wealth data
- [ ] **6.9** **Test:** Old shared secret returns 401

### Timeline

| Phase | Effort | Depends On |
|-------|--------|------------|
| Phase 1: Crypto infrastructure | 3-4 hours | Nothing |
| Phase 2: Agent token rollout | 1-2 hours | Phase 1 |
| Phase 3: Dual-write | 2-3 hours | Phase 2 |
| Phase 4: Backfill | 1 hour (+ soak) | Phase 3 stable for 2-3 days |
| Phase 5: VPS hardening | 1-2 hours | Independent (can run in parallel with Phase 3-4) |
| Phase 6: Cut over | 1 hour | Phase 4 + Phase 5 complete |
| **Total** | **~1.5-2 days** | |

---

## Threat Model After Implementation

| Attack Vector | Before | After |
|--------------|--------|-------|
| D1 database dump | Full plaintext | Encrypted (useless without master key) |
| R2 bucket dump | All files readable | Encrypted files (Phase 7 — future) |
| Worker secret leak | Full DB access | Per-agent tokens — limited to that agent's scopes |
| VPS compromised | All data via shared secret | Agent tokens + encrypted DB, but attacker can impersonate agents |
| Worker runtime compromised | Game over | Game over (unavoidable — Worker must decrypt) |
| Single agent token stolen | Full DB access (same secret) | Only that agent's scoped data accessible |
| Vectorize index dump | Embeddings (lossy) | Same (acceptable — can't reconstruct text) |
| Log file exposed | Secrets in logs | Sanitized logs + restricted permissions |

**Remaining risk:** VPS compromise still gives an attacker all agent tokens, which collectively cover all scopes. Encryption protects against D1-side threats (Cloudflare compromise, credential leak) but not VPS-side threats. VPS hardening (Phase 5) is the mitigation — reduce attack surface, detect intrusion early via audit logs.

---

## Operational Runbooks

### Generate Master Key

```bash
# 256-bit random key
openssl rand -hex 32
# Set as Worker secret (prompted for value, never visible in config)
wrangler secret put ENCRYPTION_MASTER_KEY --config /path/to/wrangler.toml
```

### Generate Agent Tokens

```bash
for agent in mya com ada rex rob noa qa portal; do
  echo "tok_${agent}_$(openssl rand -hex 48)"
done
```

### Rotate a Compromised Agent Token

```bash
# 1. Generate new token
NEW_TOKEN="tok_com_$(openssl rand -hex 48)"

# 2. Update AGENT_REGISTRY in Worker (edit JSON, replace old token)
wrangler secret put AGENT_REGISTRY --config /path/to/wrangler.toml

# 3. Update agent's .env on VPS
ssh mycelium-vps "sed -i 's/AGENT_TOKEN_COM=.*/AGENT_TOKEN_COM=$NEW_TOKEN/' ~/mycelium/.env"

# 4. Restart the affected agent (delete + start to pick up new env)
ssh mycelium-vps "cd ~/mycelium && pm2 delete company-agent && pm2 start ecosystem.config.cjs --only company-agent"

# 5. Verify
ssh mycelium-vps "PID=\$(pm2 pid company-agent) && cat /proc/\$PID/environ | tr '\\0' '\\n' | grep AGENT_TOKEN"
```

No re-encryption needed. Old token simply stops working.

### Rotate Master Key

Envelope encryption makes this fast — only DEK wrappers change, content is never touched.

```bash
# 1. Generate new key
openssl rand -hex 32

# 2. Set as new secret (keep old one during transition)
wrangler secret put ENCRYPTION_MASTER_KEY_V2 --config /path/to/wrangler.toml

# 3. Trigger DEK re-wrapping via Worker endpoint
#    This re-wraps every DEK with new scope keys derived from the new master.
#    Content is NEVER decrypted. At 20K records this takes seconds.
curl -X POST https://mya.worker.dev/api/admin/rotate-key \
  -H "Authorization: Bearer tok_portal_xxx" \
  -d '{"from": "v1", "to": "v2"}'

# 4. After completion, swap references and delete old key
wrangler secret put ENCRYPTION_MASTER_KEY  # paste new key
wrangler secret delete ENCRYPTION_MASTER_KEY_V2
```

### Master Key Backup

The master key is the single point of failure. If lost, all encrypted data is irrecoverable.

1. Write the master key on paper. Store physically (safe, not digital).
2. Never store the master key in the same system as the encrypted data.
3. The key exists in exactly two places: Cloudflare Worker secrets + your physical backup.

---

## Future Enhancements (not V1)

| Enhancement | When | Why |
|------------|------|-----|
| R2 file encryption | When attachments contain sensitive files | Currently R2 stores plaintext files |
| Blind indexes for FTS5 | If exact keyword search on encrypted content is needed | HMAC-hashed tokens for keyword match |
| Per-user key derivation (Model B) | If user base exceeds ~100 users | `HKDF(master, user_id + scope)` per-user scope keys. Compromising one user's key tree doesn't expose others. |
| Client-side encryption | For highest-sensitivity data | User holds key, even Worker can't read |
| Streaming encryption (AES-CTR) | If files exceed 100MB | GCM buffers limit at ~128MB |
| Hardware KMS | When Cloudflare Workers KMS is GA | Hardware-backed key protection |

---

## Files to Create/Modify

### New Files (Worker — MYA-0.2/src/)

| File | Purpose |
|------|---------|
| `src/services/crypto.ts` | encrypt(), decrypt(), deriveScopeKey(), inferScope(), wrapDEK(), unwrapDEK(), rotateEnvelope() |
| `src/middleware/agent-auth.ts` | Token validation, scope resolution, agent identity |
| `src/handlers/data-api.ts` | `/api/data/*` structured endpoints |

### Modified Files (Worker)

| File | Change |
|------|--------|
| `src/handlers/db-proxy.ts` | Add column redaction to `/api/db/query` results |
| `src/index.ts` | Route new `/api/data/*` endpoints |

### Modified Files (Mycelium)

| File | Change |
|------|--------|
| `ecosystem.config.cjs` | Per-agent `AGENT_TOKEN` instead of shared `MYA_WORKER_SECRET` |
| `lib/db-d1.js` | Use `AGENT_TOKEN`, add `X-Agent-ID` header, route writes to `/api/data/store` |
| `lib/embed.js` | Use `AGENT_TOKEN` instead of `MYA_WORKER_SECRET` |
| `mcp/setup.js` | Pass `AGENT_TOKEN` to MCP server env |
| `agent-server.js` | Pass `AGENT_TOKEN` to Worker calls |

### Migration Files

| File | Purpose |
|------|---------|
| `migrations/090_encryption_scope.sql` | Add `scope` column + indexes to all content tables |
