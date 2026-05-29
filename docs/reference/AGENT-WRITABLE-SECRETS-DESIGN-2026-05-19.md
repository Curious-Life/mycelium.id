# Agent-Writable Secrets — Design Exploration

**Date:** 2026-05-19
**Status:** design discussion, not implementation. Pre-sweep — needs `/sweep-first-design` before any code.
**Operator question:** "I want to give a deploy key to a repo so the agent can update it. What would implementing this in a robust, scalable, secure way look like?"

---

## TL;DR

Three architectural shapes. Recommended: **(B) Operator-witnessed agent generation** — agent generates the keypair in its own scope, encrypts the private key via the canonical chokepoint, emits the public key + intent for operator confirmation through portal UI, and the operator-confirmed write commits the row. Agent never holds an unencrypted persistent secret; operator's intent is captured before the secret takes effect.

The simpler shape (A) Operator generates and uploads — reuses the existing `/portal/settings/secret` pattern, works today, doesn't need new code. Recommend it for the immediate deploy-key use case unless the agent generating the key is structurally important.

(C) Hardware-isolated KMS — defers the secret material to an external signing service. Right answer for "agent never holds the private key even momentarily." Heavyweight; defer until threat model requires it.

---

## What already exists

| Component | Path | Status |
|---|---|---|
| `secrets` D1 table | `migrations/092_secrets_store.sql` | ✅ envelope-encrypted, scope-aware, per-agent allowlist (`agent` column = `NULL` for any-in-scope, or specific agent name) |
| Operator UI for secrets | `packages/portal/src/routes/(app)/agents/_AgentRow.svelte` | ✅ Per-agent bot-token entry; calls `saveSecret(key)` → PUT `/portal/settings/secret` |
| Portal API | `packages/server/routes/portal-settings.js` | ✅ GET (metadata only, never values) + PUT + DELETE |
| Encryption chokepoint | `packages/core/crypto-local.js` + `packages/core/db-d1.js:241` `d1Query` | ✅ system-key family for `secrets` table (see `SYSTEM_KEY_TABLES`); auto-encrypt on write, auto-decrypt on read |
| Per-agent allowlist policy | `packages/core/agent-secret-policy.js` (per memory entry) | ✅ derives which secrets a given agent may read |
| Audit log | `audit_log` table + Worker-side audit hooks | ✅ every D1 write logged; specifically secrets writes get audited |
| Scope guardian | `crypto-local.js:93-109` `scopeGuardian.check()` | ✅ ScopeViolationError on cross-scope read attempt |

**What's missing for the operator's use case:**

1. No way for an **agent** to write to the secrets table today. The only writer is the **operator** via `/portal/settings/secret`.
2. No MCP tool that lets an agent emit a "please save this secret" request.
3. No operator-confirmation flow when an agent wants to introduce a new secret.
4. No structured way to capture **intent** alongside the secret — "this is a deploy key for `github.com/foo/bar`, authorized to push only," vs. "this is a database password I'll use immediately."
5. No revocation / rotation primitives exposed to agents (operator can DELETE via portal, but agents have no programmatic recourse).

---

## Threat model

**What we're defending against:**

1. **Malicious model output** — Claude generates a tool call that exfiltrates a secret, generates a backdoor key, or stores a key in a place that another agent can read.
2. **Cross-scope leakage** — Mya (personal-agent) ends up holding wealth-agent's deploy keys or vice versa.
3. **Operator-impersonation** — Agent submits "operator approved this" without the operator actually approving.
4. **Persistent compromise** — A one-time agent compromise persists across restarts because the agent wrote a long-lived key to a place it can also read.
5. **Replay** — Old agent-emitted secrets get re-applied without operator knowing.
6. **Side-channel exfil** — Agent doesn't directly leak the secret but emits a derivative (e.g., a hash, a fingerprint, a partial) that enables offline attack.

**What we accept** (out of scope for v1):

- Host-level compromise (root on the VPS) → defenders here are AppArmor + sudo gates + tmpfs master key; encryption-at-rest is moot.
- Operator credential compromise (operator's portal session token leaks) → defenders here are passkey + short-lived sessions; agent-secrets work doesn't change that surface.
- The agent legitimately misusing a granted secret (e.g., it has the deploy key and pushes wrong code) — that's the same as a human operator misusing a credential; mitigated by audit + scope of the credential itself.

---

## Three architectural shapes

### (A) Operator generates, uploads — reuses existing path

**Flow:**

1. Operator generates an SSH keypair on their laptop: `ssh-keygen -t ed25519 -f deploy_foo_bar -C "agent-deploy:foo/bar"`.
2. Operator opens portal, navigates to Agents → personal-agent → Secrets, adds entry with key=`DEPLOY_KEY_GITHUB_FOO_BAR` value=`<private key contents>`.
3. PUT `/portal/settings/secret` → encrypted at write via canonical chokepoint → stored in `secrets` table with `agent='personal-agent'`, `scope='personal'`.
4. Operator installs the public key on the target (GitHub Deploy Keys page).
5. Agent reads the secret at runtime via existing read path (`db.rawQuery("SELECT value FROM secrets WHERE key = ? AND user_id = ? AND agent = ?", ...)`), uses it to set `GIT_SSH_COMMAND`, invokes `git push`.

**Strengths:**

- Zero new code. Reuses `/portal/settings/secret` exactly.
- Operator generates the key → operator's threat model applies. Agent never sees an in-memory unencrypted persistent key (it loads encrypted value at runtime, decrypts in-process for the single git invocation).
- Audit is automatic — portal-settings PUT logs to audit_log.
- Revocation is one DELETE in the portal UI.

**Weaknesses:**

- Operator has to manually paste a private key into a web form. Friction.
- No structured intent capture — `DEPLOY_KEY_GITHUB_FOO_BAR` is just a string label; the system doesn't know "this key is authorized for `github.com/foo/bar` push only."
- If the operator wants to grant agents the ability to provision their own deploy keys (e.g., one per repo, scoped automatically), this path doesn't scale.

**Recommendation:** **Ship this for the immediate deploy-key use case.** Zero new attack surface, zero new code. Operator's existing trust model applies.

---

### (B) Operator-witnessed agent generation — agent generates, operator confirms

**Flow:**

1. Agent decides it needs a deploy key for `github.com/foo/bar`. Calls MCP tool `requestSecret({ kind: 'ssh-deploy-key', scope: 'personal', purpose: 'github.com/foo/bar push', rotation: '90d' })`.
2. Tool implementation:
   a. Generates `ed25519` keypair in the agent's process.
   b. Computes a `request_id` (UUID).
   c. Encrypts the private key via `crypto-local.encrypt(privateKey, 'personal', masterKey, userId)`.
   d. Writes a row to a NEW table `secrets_pending` with state=`pending`, encrypted private key, public key (clear), intent metadata, fingerprint (for operator verification).
   e. Returns the public key + request_id + a portal-confirmation URL to the agent.
3. Agent emits to the operator (via existing explicit-send chokepoints): "I generated a deploy key for `github.com/foo/bar` — public: `ssh-ed25519 AAAA... agent-deploy:foo/bar`. Confirm at `<portal-url>/secrets/pending/<request_id>` or install the public key first."
4. Operator opens portal, sees the pending request: kind, scope, purpose, fingerprint, expiry. Operator either:
   - **Confirms**: portal POSTs to `/portal/settings/secret/confirm-pending` → secrets_pending row is moved (atomically) to `secrets` with the same encrypted value + the intent metadata; secrets_pending row is deleted.
   - **Rejects**: secrets_pending row is deleted; agent receives a `requestSecretStatus(request_id)` poll result indicating rejection.
   - **Lets it expire**: secrets_pending rows TTL after N hours (cron purge).
5. Agent reads the confirmed secret at runtime, uses for `git push`.

**Strengths:**

- Operator's intent is captured BEFORE the secret takes effect. A compromised agent can request keys all day, but none of them are usable until operator confirmation.
- Operator sees fingerprint + purpose + expected rotation date — can verify the request is for the right target.
- Structured intent metadata enables future automation ("rotate this every 90 days," "revoke when the linked repo is removed").
- Generation in-agent enables scale: one deploy key per repo, generated automatically, doesn't require operator to manually keygen each one.
- Encrypted private key never leaves the encryption boundary. Agent process holds it in memory for the moment between generation and write, then never again — except when it's decrypted to use it.

**Weaknesses:**

- A compromised agent process at the moment of generation can exfiltrate the private key BEFORE encryption. This is unavoidable for any agent-generated-secret flow.
- New code surface: `secrets_pending` table + MCP tool + portal UI for pending-list + confirm/reject endpoint + cron for expiry.
- More moving parts to audit.

**Recommendation:** **Build this as a v2 when one or more of the following is true:** (1) operator wants deploy-key provisioning to scale beyond manual paste, (2) operator wants structured intent (purpose, rotation, expiry) tied to each secret, (3) operator wants agents to be able to PROPOSE new secrets without operator pre-generating each one.

---

### (C) Hardware-isolated KMS — agent never holds the key

**Flow:**

1. Secrets live in a KMS (Cloudflare's KMS, AWS KMS, or self-hosted Vault) — never on the VPS.
2. Agent doesn't request "give me the private key." Agent requests "sign this hash with the deploy key labeled `gh:foo/bar`."
3. KMS performs the signing operation, returns the signature.
4. For git push specifically: agent uses `ssh -o ProxyCommand` or an SSH agent socket forwarded from KMS. Operator-side `ssh-agent` integration with hardware-isolated signing.

**Strengths:**

- Agent NEVER holds the private key, even in-memory at generation time.
- Operator-side compromise doesn't expose the keys; KMS access is gated by KMS-specific policy (HSM, role-based, etc.).
- Rotation can be done out-of-band without any agent involvement.

**Weaknesses:**

- Heavyweight: KMS infrastructure, new authentication surface, latency on every signing op.
- SSH key operations (Ed25519 signing for `git push`) need either a KMS-aware SSH agent or a custom SSH transport — both are project-tier work.
- Mycelium's existing master key is already on tmpfs; adding KMS for some secrets but not others creates two parallel trust models. Best done as a fleet-wide migration, not per-secret.

**Recommendation:** **Defer until the threat model requires it.** Specifically: until there's a compliance or contractual requirement that "the private key must never be in the agent's process memory." For the personal/wealth/moms scope use cases, (A) or (B) suffice.

---

## Recommended sequence

1. **Now (v0, 0 LOC):** Use (A) for the immediate deploy-key ask. Operator generates locally, pastes into portal, agent reads at runtime. Document the pattern.

2. **When operator wants to scale to many deploy keys (v1, ~400 LOC):** Build (B). New `secrets_pending` table, MCP tool `requestSecret`, portal UI for pending list + confirm/reject, cron for expiry. Sweep-first-design REQUIRED. Test coverage for the cross-scope guardian on pending → confirmed transition.

3. **When threat model requires hardware isolation (v2):** Build (C). Multi-month effort. Separate design doc.

---

## Open design questions before any v1 implementation

These are the rocks `/sweep-first-design` would surface:

1. **What's the right table shape for `secrets_pending`?** Mirror `secrets` exactly + extra fields (state, expiry, request_id, intent metadata)? Or separate table that gets atomically moved on confirm? Schema mistake here cascades into every downstream reader.

2. **How does the agent receive the confirmation URL safely?** Embedding it in chat text means a compromised agent could swap the URL. Solution: confirmation lives in the portal at a predictable path (`/secrets/pending`) keyed on agent ID; agent emits "go look at your portal" not "click this URL."

3. **What is the operator UI's verification surface?** Operator needs to see: kind, scope, purpose, public key fingerprint, expected rotation date, full requesting agent identity. The public key fingerprint MUST be displayed so operator can cross-check with the target (e.g., GitHub Deploy Keys page) before confirming.

4. **What about race conditions?** Two pending requests for the same key name from the same agent — what's the expected behavior? Reject the second? Allow both with separate IDs? Naming uniqueness probably belongs at the CONFIRMED layer; pending should allow duplicates.

5. **TTL for pending requests?** 24h? Configurable per-request? What if operator is on vacation? — secrets_pending rows should TTL but not aggressively; agent should be able to re-request.

6. **MCP tool surface size — single `requestSecret` or per-kind tools?** A single tool with a `kind` discriminator is simpler. Per-kind tools (`requestSshDeployKey`, `requestApiToken`) are more discoverable but inflate the tool surface (which the 2026-05-07 reply-deferral work showed has real cost).

7. **How is the agent's request authenticated?** It's running as personal-agent with the personal scope key. The MCP tool can already attribute the request to that agent. Beyond that, do we need a "user identity assertion" — the operator's user_id signed somehow? Probably overkill for v1; the MCP tool is already scope-bound.

8. **Cross-cutting with the scope guardian:** if Mya (`personal` scope) requests a secret with `scope: 'wealth'`, what happens? Should be a hard reject at the MCP tool layer. Same shape as autoEncryptParams refusing cross-scope writes today.

9. **How is the public key conveyed to the target?** For the GitHub deploy-key case, the operator probably installs it manually on GitHub. For automation: agent could request a CF Worker secret rotation, an SSH server reload, etc. — that's a separate tool per target.

10. **Revocation interface:** existing DELETE on `/portal/settings/secret` works. Should we also expose `revokeSecret(key)` as an MCP tool for the AGENT to recommend revocation? Probably yes — symmetry with `requestSecret`.

---

## Companion artifacts when v1 lands

- **Sweep-first-design doc**: `docs/AGENT-WRITABLE-SECRETS-DESIGN-<date>.md` v1 (this doc becomes v0 / the exploration)
- **Migration**: `migrations/<N>_secrets_pending.sql`
- **MCP tool**: in `packages/tools/agent-tools/` — `request-secret.js`
- **Portal route**: `packages/server/routes/portal-settings.js` extended with `/portal/settings/secret/pending` (list) + `/portal/settings/secret/confirm-pending` (POST) + `/portal/settings/secret/reject-pending` (POST)
- **Portal UI**: new component for the pending list under Agents → personal-agent → Pending Secrets, with kind, purpose, fingerprint, confirm/reject buttons
- **Cron**: scripts/expire-pending-secrets.js — daily, deletes secrets_pending rows older than TTL
- **Audit**: every pending → confirmed transition logged with operator's user_id

---

## What NOT to do

Things that look reasonable but fail under threat model:

- **"Let agents write directly to `secrets` table"** — no operator-confirmation step → a compromised agent can install backdoor keys silently. Hard no.
- **"Have the agent emit the private key in chat for the operator to copy-paste back"** — moves the secret through the chat surface, which is logged, screenshotted, etc. The whole point is to keep the private key in the encryption envelope.
- **"Generate the keypair on the operator's laptop via portal-side JS"** — different threat model entirely. JavaScript on the operator's machine has a different trust profile than agent code on the VPS; mixing them is confusing. Pick one location, stick with it.
- **"Skip the audit trail because operator approved each one"** — operator approval is necessary but not sufficient. Audit logs are the only forensic record if something gets compromised later.
- **"Let agents define their own MCP tools for new secret types at runtime"** — dynamic tool definition is a separate (much harder) capability. Keep tool surface fixed.

---

## Decision point for the operator

Pick one for the immediate deploy-key use case:

- **(a) Use shape (A) now** — operator generates locally, pastes into portal, agent reads. Zero new code. Recommended.
- **(b) Build shape (B) before doing this deploy-key task** — ~400 LOC + sweep + portal UI + cron. Right if scale matters or if this is the first of many.
- **(c) Investigate shape (C)** — KMS exploration. Multi-month. Skip unless contracted/required.
