# Remote Connect — Handoff Doc (2026-06-03)

**Date:** 2026-06-03
**Companions:** [REMOTE-CONNECT-TRANSPORT-DESIGN](REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-MANAGED-DESIGN](REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-RESIDUALS-DESIGN](REMOTE-CONNECT-RESIDUALS-DESIGN-2026-06-03.md) · predecessor [REMOTE-CONNECT-HANDOFF-2026-06-02](REMOTE-CONNECT-HANDOFF-2026-06-02.md) (design-era) · [MCP-OVERVIEW](MCP-OVERVIEW.md)
**Audience:** the next Claude Code instance picking up remote-connect.
**Branch:** `feat/remote-connect-phase2` (PR **#46**, stacked on #45). All work below is committed + pushed there.

---

## TL;DR — current state

The remote-connect transport is **fully built, adversarially hardened, and residual-fixed in code.** Everything that can be verified without live infrastructure is **GREEN**. What remains is **live-infra smoke + the managed relay fleet + the own-relay/Direct UI** — no core code is missing.

| Stage | Commits | Status |
|---|---|---|
| Design (transport + managed + residuals) | `2765dc4`, `6a2eb50`, `1938358` | ✅ 3 sweep-first design docs |
| **Build** (T0→G + UI) | `b1533f1` `a39de95` `84ed59e` `e054a78` `b256200` `e62d962` `1a98d7f` `16a7b8b` `537c292` `035bd51` | ✅ shipped |
| **Adversarial hardening** (6-agent red-team → fixes) | `27f939e` `2a6f3df` `d19182b` `7c3f27f` `9d51ba9` | ✅ C1–C5 + H1–H7 |
| **Residual fixes** (sweep-first) | `a2be9bf` `05f0312` `e173071` `9d36446` | ✅ R-A…R-E |
| **Verify gate** | — | ✅ **8/8 remote verifies GO** + `cargo check` GO + portal build GO |
| **Live-infra smoke** | — | ⬜ **NEXT** (needs a relay/DNS/CA/phone — can't be CI'd) |
| Managed relay FLEET (HA/DDoS/multi-instance) | — | ⬜ config shipped (`mycelium-managed/relay/`), not deployed |
| Own-relay / Direct **connect UI** (T4) | — | ⬜ backend supports via config; no UI yet |

Verify it's still green (REST `gh`, not GraphQL):
```
gh api repos/Curious-Life/mycelium.id/pulls --jq '.[]|"#\(.number) \(.head.ref) \(.state)"'   # #45, #46 open
git -C /tmp/myc-phase2 log --oneline | head -3   # last CODE commit 9d36446, + this docs-only handoff on top
cd /tmp/myc-phase2 && for v in loopback remote-config remote-runtime managed-claim provision newproxy-auth dns ct-monitor; do npm run --silent verify:$v >/dev/null && echo "GO $v" || echo "FAIL $v"; done
( cd /tmp/myc-phase2/src-tauri && cargo check )   # needs binaries/{frpc,caddy}-<triple> stubs to exist (see gotchas)
```

---

## 2026-06-03 session summary — start here

### What shipped (commits, oldest→newest)
| Commit | What |
|---|---|
| `2765dc4` | docs: TLS-passthrough **transport** design (supersedes cloudflared data plane) |
| `6a2eb50` | docs: **managed-stack** design (`mycelium-managed`) |
| `b1533f1` | **T0** `--http` binds `127.0.0.1` only (`server-http.js`) + `verify:loopback` |
| `a39de95` | **config** `remoteMode`/relay/cert keys + auth.db secret store (`config.js`) |
| `84ed59e` | **runtime.js** renderers: `frpc.toml` + `Caddyfile` (0600) + `verify:remote-runtime` |
| `e054a78` | **client seam**: `managed-claim.js` + loopback `/connect-managed`,`/managed/available`,`/disconnect` |
| `b256200` | **control-plane** `mycelium-managed/`: server + registry + dns + acme-dns clients |
| `e62d962` | **frps NewProxy auth-hook** (per-tenant hostname binding) |
| `1a98d7f` | **Tauri** externalBin + spawn frpc/caddy + `scripts/fetch-sidecars.sh` |
| `16a7b8b` | wire 5 remote verifies into the gate |
| `537c292` | living docs (ARCHITECTURE + V1-BUILD-SPEC: supersede Cloudflare Tunnel) |
| `035bd51` | **UI** `ManagedConnectSection.svelte` + `remoteMode`/`publicHost` in `/status` |
| `27f939e` | **harden**: action-bound claims, rate-limit + daily cap, nonce sweep, TOCTOU-safe provision, release teardown |
| `2a6f3df` | **harden**: auth.db 0600, host/cred validation, https-only CP, password gate, disconnect→release |
| `d19182b` | **harden**: release-safe sidecar resolution (no `$PATH` in release) |
| `7c3f27f` | **harden**: supply-chain checksums + `relay/frps.toml` + `nftables.conf`; per-tenant token in metadatas only |
| `9d51ba9` | **harden**: IPv6 `relayAddr` parse, availability debounce race, drop dead `relayVhostPort` |
| `1938358` | docs: **residual-fix** design |
| `a2be9bf` | **R-A** registry-backed nonces (HA) + **R-D** single-active-proxy guard |
| `05f0312` | **R-B** `verify:dns` (CF/deSEC shapes) + **R-E** CT-monitor + CAA |
| `e173071` | **R-C** crash-safe sidecar reaping (process-group + `RunEvent::Exit` + pidfile reaper) |
| `9d36446` | wire `verify:dns` + `verify:ct-monitor` into the gate |

### What was LEARNED (the load-bearing lines — read these)
- **cloudflared is OUT.** It terminates TLS at CF's edge → violates "the tunnel must not see plaintext." Replaced by **FRP `type=https`** which is genuine SNI **passthrough** (frps does NOT decrypt — verified in gofrp source) + **Caddy on the Mac** terminates with a cert whose key never leaves the Mac (ACME DNS-01 via acme-dns).
- **FRP multitenancy = a `NewProxy` HTTP server-plugin.** frps has **no add-proxy API and no hot-reload** (`server/api_router.go`), so the plugin (authorizing against the registry) is THE dynamic per-tenant gate — and it's the right one (zero restarts).
- **The Let's Encrypt managed-scale fear is defused: renewals are ARI-EXEMPT.** The 50-certs/registered-domain/week cap throttles only ~2,600 **new** signups/yr/`mycelium.id`; active renewing users are unbounded **provided Caddy uses ARI** (it does, default-on since CertMagic v0.21.0). **Google Public CA** (per-*project* quotas) is the scale-out backstop.
- **Caddy DNS-01 needs a custom `xcaddy` build** with `caddy-dns/acmedns`; acme-dns's universal CNAME means **one build serves every user** regardless of their DNS host.
- **`CloseProxy` is async + notification-only** → a stale close after a reconnect can wipe the new tunnel's slot → the fix is **compare-and-clear on `run_id`** + a TTL. **`DELETE /api/proxies` is prune-offline-only** — you CANNOT force-kill an active tunnel via the API; eviction is **admission-reject only**.
- **macOS has no `PR_SET_PDEATHSIG`** → a hard crash orphans sidecars; the backstop is a **PID-reuse-safe pidfile reaper at launch** (`ps -o comm=` match), scoped to caddy/frpc.
- **CAA + CT monitoring are DETECTION + bar-raising, NOT prevention** — a DNS-controlling attacker can rewrite CAA and pass DNS-01. The cryptographic MITM defense is **own-domain** (the user controls DNS). Stated in code + docs; don't oversell it.
- **`auth.db` was world-readable (0644)** — it holds the signing secret + operator password hash + relay/acme-dns secrets. Now `chmod 0600` + dir `0700` on every open.
- **Anthropic egress is a stable `160.79.104.0/21`**, BUT `/authorize` comes from the user's **browser**, not Anthropic — so a relay IP-allowlist would break login (the relay sees SNI only, not paths). No naive allowlist; rely on host-scrubbing + per-tenant caps + the password gate.

### Operator's directional calls (this session)
- **Network is hostile → tunnel must never see plaintext.** Drove the whole cloudflared→passthrough pivot.
- **Managed relay is the FOCUS**, but the same OSS stack must be self-hostable ("managed = mycelium operating the open-source stack; endpoints config-pointable"). Relay ownership = **"both"** (Direct / own-relay / managed) — but see open decision #1.
- **"Don't stop until done"** → the full build in one go. **"Fix all"** → the adversarial + residual passes.

---

## Production / repo state
- **Code lives in the worktree `/tmp/myc-phase2`** on `feat/remote-connect-phase2` (last CODE commit `9d36446`, + this docs-only handoff commit on top), pushed to origin. `node_modules` is a **symlink** to the Documents clone's (same arch — better-sqlite3 loads fine).
- **PR #45** (Phase 1) + **PR #46** (Phase 2 → now the whole epic) both **open**; #46 is stacked on #45 (auto-retargets to main when #45 merges). `main` has moved on (the other session's WebGL fix #51 etc.) — **the remote-connect code is ONLY on these branches.**
- **Nothing is deployed.** No relay, no acme-dns, no control-plane instance is running. `mycelium-managed/` is shippable code + `relay/{frps.toml,nftables.conf,README.md}` are deploy artifacts, not a live service.
- **Sidecar binaries are gitignored** (`src-tauri/binaries/`); `cargo check` needs stub files there (the session created `frpc/caddy-aarch64-apple-darwin` stubs). `fetch-sidecars.sh` produces the real ones.
- **Live stack** `~/mycelium.id` is on branch `fix/tauri-webgl-freeze` (another session) — **not** this work.
- **Real vault** `~/Library/Application Support/id.mycelium.app` was re-keyed ~19:21 on 2026-06-02; the running app is in setup/restore mode. **Operator has the recovery key.**

---

## Gotchas + lessons (2026-06-03)
- **`externalBin` is validated at `cargo check`/build time**, not just bundle time — a missing `binaries/<name>-<triple>` aborts the compile. Create stub files (any executable) to `cargo check`; `fetch-sidecars.sh` makes the real ones. (2026-06-03)
- **The shared Documents clone** (`~/Documents/GitHub/mycelium.id`) is driven by another live session — it switches branches under you. Re-check `git branch --show-current` before ANY git op there. Build in the worktree. (carried from 2026-06-02)
- **`gh` GraphQL is rate-limited** for this account → use REST (`gh api repos/.../pulls`). (carried)
- **Bash `cwd` resets between tool calls** and `${PIPESTATUS[0]}` after a `cd … | tail` came back empty → "build succeeded" commits didn't auto-fire. Capture exit via `cmd > file; RC=$?` (no pipe) and commit directly. (2026-06-03)
- **better-sqlite3 supports `DELETE … RETURNING`** (used for atomic single-use nonces) — confirmed working via `verify:provision` P12. (2026-06-03)
- **`libc` was already in the dep tree** (tauri transitive) → adding it as a direct dep for the group-kill needed no network fetch. (2026-06-03)
- **Dependabot** flags 1 low vuln on the default branch (unrelated to this work). (2026-06-03)
- Vault re-key ~19:21 — restore via the app's setup screen with the recovery key; **never paste the key into chat/logs.** (carried)

---

## Open decisions for the operator
1. **Managed relay fleet** — "both" was the call, but the **mycelium relay specifically needs the fleet built + a `/sweep-first-design` for multi-instance/HA/DDoS** before it ships. Today: Direct + own-VPS work with no mycelium infra; the managed relay's config (`relay/frps.toml`, `nftables.conf`, the control-plane) is written but **un-deployed**. Decide: stand up the fleet now, or ship Direct/own-VPS first and add managed later?
2. **Managed-path sovereignty** — recommended **acceptable WITH disclosure** (rogue-cert MITM is *detectable* via CAA+CT, not preventable; own-domain is the escape hatch). **Operator to ratify** before a managed launch.
3. **Let's Encrypt scale** — request a **per-registered-domain rate-limit increase** for `mycelium.id` (one ACME account) before mass signups, OR wire **Google Public CA** (per-project quotas). Decide before >~2,600 new managed users/yr.
4. **Pricing** — monetize *convenience* (managed relay), never *privacy* (own-domain/Direct/local stay free). Set the free-tier cap + price point.

---

## Pickup protocol (next session)
1. **Read this handoff cold**, then the 3 design docs (TRANSPORT, MANAGED, RESIDUALS). The code is done; you're picking up DEPLOYMENT, not architecture.
2. **Re-check git**: `gh api .../pulls` (REST); last CODE commit `9d36446` (+ docs-only handoff on top). Before any op in the Documents clone, re-check its branch.
3. **Confirm green**: run the 8 remote verifies + `cargo check` (create `src-tauri/binaries/{frpc,caddy}-<triple>` stubs first). All should pass with zero code changes.
4. **Live-infra smoke (the actual remaining work):**
   a. `bash scripts/fetch-sidecars.sh` (network) → pin the printed SHA-256s in `scripts/sidecar-checksums.txt` → `cargo tauri build` (the `.app`).
   b. Deploy the managed stack from `mycelium-managed/`: a relay VPS (Hetzner/OVH) running `frps` (`relay/frps.toml`) + `nftables.conf`; a self-hosted **acme-dns** (`disable_registration=true`); **apex DNS** (deSEC or Cloudflare DNS-only); the **control-plane** (`PORT=8790`, `MYC_DNS_PROVIDER`, `MYC_RELAY_ADDR`, `MYC_ACME_DNS`, etc.). Keep `/frps/handler` private (it's an unauthenticated token oracle — network-isolate it).
   c. Set **CAA** on `mycelium.id` (use `ct-monitor.js` `caaRecords()`); point **CT-monitor** at Cert Spotter.
   d. **Restore the vault** (operator recovery key) so `connect-managed` can sign.
   e. **LE staging → prod**: confirm a renewal registers as ARI-exempt; then a **real-phone** connect via `<handle>.mycelium.id`.
5. **T4** (after smoke): own-relay / Direct **connect UI** (backend already supports them via `remoteMode` + `relayAddr`/`acmeDnsServer`/`controlPlaneUrl` config; no UI yet) + the managed fleet HA.
6. **Always** `/sweep-first-design` before structural code; `/deploy-and-verify` after any deploy. Run the `verify:*` gate; the remote subset must stay 8/8.

---

## Glossary
- **passthrough relay** — `frps` in `type=https`/vhost mode: routes inbound :443 by TLS SNI to the right `frpc` and forwards **ciphertext**; never terminates TLS.
- **the three modes** — `managed` (mycelium relay + `<handle>.mycelium.id`), `own-relay` (user's frps/domain), `direct` (no relay; publicly-reachable Mac). All in one codebase; `remoteMode` in `remote.json`.
- **the claim** — an ed25519 signature (`identity.js`, derived from the master key) over `mycelium-handle-claim:v1:<action>:<handle>:<nonce>`; proves master-key ownership with no account. The control-plane verifies with the **public key alone** (`verifyWithPublicKey`).
- **single-active-proxy** — the relay hook lets ONE tunnel (`run_id`) bind a handle at a time; a stolen token can't run a concurrent tunnel.
- **acme-dns** — a tiny DNS server we self-host; a one-time CNAME per handle lets the Mac's Caddy answer DNS-01 with a scoped credential (key stays on the Mac).
