# Auth & web-access — Handoff

**Date:** 2026-06-19
**Audience:** the next Claude Code instance.
**Companions:** [`docs/DESIGN-require-passkey-web-2026-06-19.md`](DESIGN-require-passkey-web-2026-06-19.md), the federation audit (memory `federation-security-audit`), the boot-perf handoff [`docs/SESSION-HANDOFF-2026-06-19.md`](SESSION-HANDOFF-2026-06-19.md).

## TL;DR — what shipped (all merged to main)

| PR | commit | What |
|---|---|---|
| #276 | `c363732` | Federation: verify peer signatures over the **raw request bytes** (was re-canonicalize) + inbound-lexicon DoS bound + Matrix deploy-contract notes. 3 independent adversarial reviewers, all HOLDS/NO-REGRESSION. |
| #280 | `1b2824a` | **Login with @handle, not `operator@mycelium.local`** (email kept internal-only) + Touch ID copy fix + `/login` web dead-end fix + **session idle timeout (24h)** + OAuth token/register throttles + password-strength gate. |
| #283 | `2fe0955` | **Opt-in require-a-passkey for web sign-in** (portal + connector), passkey-only, auto-disable on host change, structurally no-lockout. |

`origin/main` @ `2fe0955`.

## What was learned (the durable findings)

- **The managed relay is a TLS-passthrough dumb pipe.** `mycelium-managed/relay/frps.toml` is SNI-passthrough; the user's **own Mac's Caddy terminates TLS** and holds the only cert key. So the relay operator never sees plaintext, password, or session cookies — only SNI + traffic metadata. This is the load-bearing reason web access is confidential. (Own-relay + own domain removes even the metadata.)
- **Web access = two paths.** (a) Portal: browser → `/auth/session` 401 → SPA `/login` → operator password → better-auth session cookie → `require-vault-auth.js` owner-pin. (b) Connector: Claude → `/api/auth/mcp/authorize` → the :4711 `/login` form → token. The desktop never logs in (loopback = "always signed in" via `auth-shim.js`).
- **`invalid_client` is benign.** It comes ONLY from `/api/auth/mcp/authorize` when the `client_id` isn't in the `oauthApplication` table. The live `auth.db` had `oauthApplication: 0` — a password reset (Jun 16) **cascade-deleted** the registered connectors (by design, `config.js setOperatorPassword`). FIX = re-add the connector in Claude (fresh DCR). ALSO fixed in #280: the relay routes `/login`→:4711, so a plain web sign-in there used to dead-end at `invalid_client`; now no-`client_id` → portal `/`.
- **better-auth sessions are untaggable** (passkey verify mints an identical session) → passkey enforcement blocks the password *login endpoints*, not request validation.
- **Passkey rpID is frozen per-boot from the mutable handle** → a host change orphans enrolled passkeys → the require-passkey policy auto-disables on host change.

## Production state — needs an app rebuild

The running desktop app is the OLD bundle; #280/#283 are bundled JS, so they are NOT live until the app is rebuilt from main.
```
git -C /Users/altus/Documents/GitHub/mycelium.id log origin/main -1 --format='%h'   # expect 2fe0955 (or later)
```
Rebuild: `cargo tauri build` (set `bundle.targets:["app"]` temporarily to skip the DMG hang; FORCE-rebuild portal-app first — `ensure-portal-built` can skip a stale build). See the boot-perf handoff for the exact procedure.

## Open decisions / pickup protocol

1. **Re-add the Claude connector** (fixes the user's `invalid_client`): Claude → Settings → Connectors → remove Mycelium → Add `https://<handle>.mycelium.id/mcp`. With #280 the sign-in shows `@handle` + password (no email).
2. **Rebuild + relaunch the app** from main; verify the login shows `@handle` + password (no `operator@mycelium.local`), and the "Set up a passkey?" copy (not "Face ID").
3. **Real-Mac Touch ID smoke of require-passkey (#283)** BEFORE relying on it: enroll a passkey over the web, flip the Settings toggle "Require a passkey for web sign-in", then confirm the passkey ceremony works on both the portal and the connector `/login`. The feature is OFF by default + fails closed, so it's dormant until enabled — the device test matters at enable time. The WebAuthn glue in the served `/login.js` is the only un-headless-tested part.
4. **Deferred (unchanged):** portal-load-perf frontend phase; the broader "ultra secure" item not taken — Tailscale-only / IP-allowlist mode (a first-class "no public exposure" option) is a good future PR.

## Verification commands

```
# session timeout applied (24h, not 7d): sign in over the relay, inspect the session row, or trust the #280 smoke
# require-passkey enforcement (headless): see the #283 enforcement smoke (10/10) — password 403s at all 3 endpoints when policy on + a passkey enrolled
node scripts/verify-auth-hardening.mjs   # expect GO 20/20
node scripts/verify-portal-auth.mjs      # expect GO 14/14
```

## Gotchas (2026-06-19)

- The Bash **sandbox redacts auth tokens** in `grep` output (`token`/`register`/`oauth`→`n`) and sometimes returns empty on large files — use `awk`/`sed`/`Read` or `dangerouslyDisableSandbox`, and read OAuth endpoint paths empirically from the live discovery doc, not grep.
- Federation **unit tests fail locally** on real DNS (`bob.mycelium.id` ENOTFOUND, no injected `lookup` stub) — run `verify:federation` (which injects `lookup`) for a real signal; they pass in CI.
- Squash-merge from a worktree prints `fatal: 'main' is already used by worktree` — that's the cosmetic post-merge local checkout; the merge itself succeeds.
