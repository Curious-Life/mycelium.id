# Remote Connect — Handoff Doc (2026-06-03)

**Date:** 2026-06-03
**Companions:** [REMOTE-CONNECT-TRANSPORT-DESIGN](REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-MANAGED-DESIGN](REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-RESIDUALS-DESIGN](REMOTE-CONNECT-RESIDUALS-DESIGN-2026-06-03.md) · **[DEPLOY-RUNBOOK](REMOTE-CONNECT-DEPLOY-RUNBOOK.md)** (live-infra, exact commands) · predecessor [REMOTE-CONNECT-HANDOFF-2026-06-02](REMOTE-CONNECT-HANDOFF-2026-06-02.md) (design-era) · [MCP-OVERVIEW](MCP-OVERVIEW.md)
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
| **Local smoke — transport** (real frpc/frps/caddy) | `948e5f5` | ✅ **transport PROVEN** — `HTTP 200` e2e; TLS terminates at Caddy (relay sees only ciphertext); SNI routing enforced; **found + fixed a real `:80`-bind startup bug** |
| **Local smoke — managed auth** (real plugin-gated frps + control-plane) | — | ✅ **auth model PROVEN** — provision e2e (challenge→claim→registry); valid token admitted, forged rejected @Login, unowned host rejected @NewProxy; **frps↔plugin contract correct**; CloseProxy clears slot (R-D) |
| **Packaging — `.app` build** | `81ed240` | ✅ **PROVEN** — `fetch-sidecars.sh` (fixed a real `set -e`/TOFU abort) → `cargo tauri build` (1m34s, release+LTO): `Mycelium.app` bundles real `caddy`+`frpc`+`mycelium` in `Contents/MacOS/` — exactly where release `resolve_sidecar` looks |
| **Live-infra smoke** (operator-only) | — | ⬜ LAST GATE — all code + packaging now proven; remaining is pure infra: deploy relay+acme-dns+apex DNS+CAA, restore vault, LE staging→prod, real phone |
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
| `948e5f5` | **fix** Caddy `auto_https disable_redirects` (no privileged `:80` bind) + RT2 regression guard — found by the local e2e smoke |
| `81ed240` | **fix** `fetch-sidecars.sh` `set -e`/TOFU first-run abort (grep→awk) + pin frpc — found running the real packaging prep |

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
- **The local e2e smoke (2026-06-03) found a real startup bug.** The rendered Caddyfile let Caddy stand up an HTTP→HTTPS redirect vhost on `:80`; the non-root Tauri app can't bind a privileged port → Caddy aborts at launch → remote-connect silently broken on every real Mac. Fixed: `auto_https disable_redirects` (`948e5f5`). The smoke also **proved the privacy thesis**: the leaf cert is issued by Caddy's local CA (TLS terminates on the Mac), so the relay only ever forwards ciphertext; and an unknown SNI is refused at the relay. **STILL OPEN (deferred — direct mode only):** direct mode renders a bare-host site → Caddy binds `:443`, also privileged. Managed + own-relay are unaffected (Caddy on `127.0.0.1:8443`). Direct mode (T4, no UI yet) needs a high local port + the user forwarding `:443`, or elevation — fold this into the T4 direct-mode design.
- **The managed auth hook contract is correct against a real frps (Tier-2 smoke, 2026-06-03).** A plugin-gated `frps` + the live control-plane: provision ran end-to-end (challenge → ed25519 claim → registry); a valid per-tenant token was admitted (chain `200`); a forged token was rejected at **Login** (`unknown tenant token`); a valid token requesting an **unowned host** was rejected at **NewProxy** (`domain evil.mycelium.id not owned`). Our field paths match what frps 0.61.1 actually sends — `content.metas.token` @Login, `content.user.metas.token` + `content.custom_domains` @NewProxy — so **no bug in the hook** (the contract was the highest-risk seam). CloseProxy cleared the active slot on a clean disconnect (R-D), confirmed live.
- **Packaging is proven (2026-06-03).** `cargo tauri build --bundles app` (release+LTO, 1m34s) produced `Mycelium.app` with `caddy`+`frpc`+`mycelium` all in `Contents/MacOS/` — the exact dir the release `resolve_sidecar` searches (C5, no `$PATH`). Running the real `fetch-sidecars.sh` first surfaced a `set -e`/`pipefail` bug: `grep` no-match on the empty (first-run) manifest aborted the script *before* printing the TOFU hash or fetching frpc — i.e. it could never bootstrap. Fixed (grep→awk + `|| true`, `81ed240`) + pinned frpc. caddy left documented-TOFU (caddyserver on-demand builds aren't guaranteed byte-reproducible → a pin would false-positive; harden via xcaddy with pinned module versions). **The only remaining critical-path work is operator-run live infra + a real phone** — every in-session-verifiable layer (transport, auth, packaging) is green. (Pre-existing cosmetic nit surfaced by the build: bundle identifier `id.mycelium.app` ends in `.app`, which Tauri warns conflicts with the macOS bundle extension — out of remote-connect scope.)

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
- **Local e2e smoke recipe** (reproducible, no infra): fetch `caddy` + the FRP tarball (`frpc` **and** `frps`) per `scripts/fetch-sidecars.sh`; render `frpc.toml`/`Caddyfile` via the real `runtime.js` and swap only the Caddy `tls { dns acmedns … }` block → `tls internal`; run loopback `:4711`, `caddy :8443`, `frps` (control + `vhostHTTPSPort`), `frpc`; then `curl -k --resolve <host>:<vhostport>:127.0.0.1 https://<host>:<vhostport>/`. Asserts: `HTTP 200`, issuer `Caddy Local Authority` (TLS on the Mac), unknown-SNI refused. **macOS owns `:7000`** (Control Center / AirPlay) — use a different frps control port locally (the smoke used `:7010`); a Linux relay VPS is fine on `7000`. (2026-06-03)
- **Tier-2 (managed auth) smoke recipe**: boot `mycelium-managed` with `MYC_DNS_PROVIDER=mock MYC_ACME_DNS_MOCK=1` on a **clearly-free port** — the live stack owns `127.0.0.1:8790`, and `app.listen(port)` binds all families, so an IPv4 collision *silently shadows* you (curl hits the other server); provision via `/v1/challenge`→`buildClaim`→`/v1/provision` (throwaway master key); run a plugin-gated `frps.toml` (`[[httpPlugins]]` → CP `/frps/handler`, ops `Login,NewProxy,CloseProxy,Ping`); render frpc with the issued `relayToken`; assert valid-admitted / forged-rejected@Login / unowned-host-rejected@NewProxy. (2026-06-03)

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
4. **Live-infra smoke** — follow **[REMOTE-CONNECT-DEPLOY-RUNBOOK.md](REMOTE-CONNECT-DEPLOY-RUNBOOK.md)** (exact commands, verify ledger, security checklist). The actual remaining work, now all operator-run; the high-level shape:
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

---

## 2026-06-03 PM — LIVE DEPLOY on real `mycelium.id` + Claude-connect debugging — **START HERE**

We stood the managed stack up **live on the real `mycelium.id`** (operator = Martina, Cloudflare DNS) and drove a real Claude→vault connect. **Transport, cert, relay, control-plane, and the full OAuth handshake all work live.** ONE blocker remains — a JWT **audience** detail. The operator suspects Anthropic is blocking them; the evidence says otherwise (see *Not Anthropic*).

### Live stack (UP this session)
- **Hetzner cpx22 `77.42.122.15`** (hel1), cloud-init-hardened (`ops` user, key-only SSH, nftables, fail2ban).
- **frps** relay — `:443` SNI passthrough + `:7000` control (systemd, plugin-gated, no fixed token).
- **acme-dns** — docker, **postgres** (`joohoi/acme-dns:latest` lacks the sqlite3 driver) + **`--network host`** (dodges both the nftables `forward` drop AND systemd-resolved on `:53`); API loopback `:8081`.
- **control-plane** — `node /opt/mycelium/mycelium-managed/src/server.js` (systemd), `MYC_BIND_HOST=127.0.0.1`, Cloudflare token (IP-restricted to the box, Edit-zone-DNS), `MYC_ZONE=mycelium.id`.
- **Caddy edge** — `connect.mycelium.id:8443` → control-plane `/v1/*`; `acme.mycelium.id:8443` → acme-dns `/update`; DNS-01 via `caddy-dns/cloudflare`. (frps owns `:443` → edge on `:8443`.)
- **DNS** (Cloudflare, all grey): `connect`, `acme`, `ns.auth` A → box; `auth` NS → `ns.auth`; per-handle records auto-created by the control-plane.
- **First handle `0m.mycelium.id` provisioned** — real LE cert via DNS-01; `https://0m.mycelium.id/mcp` reachable, valid cert, `401`-gated.
- Deploy kit committed: `mycelium-managed/relay/deploy/`.

### The Mac (client)
- Feature is **only on `feat/remote-connect-phase2`** (PR #46), behind `main`. The branch `.app` is **NOT self-contained** (no bundled Node backend — only `main` has resource-bundling), so it runs via:
  `MYCELIUM_HOME=/tmp/myc-phase2 /tmp/myc-phase2/src-tauri/target/release/bundle/macos/Mycelium.app/Contents/MacOS/mycelium`
- **3 `Mycelium.app` copies share bundle id `id.mycelium.app`** → single-instance fights. Installed copies PARKED: `/Applications/Mycelium.app → /tmp/Mycelium-main-parked.app`, and `~/mycelium.id/.../Mycelium.app → ….parked`. **RESTORE these when done.**
- Vault = **throwaway** `id.mycelium.app` (real vault backed up at `…/id.mycelium.app.lockedrealvault-bak…`). `remote.json` has `controlPlaneUrl: https://connect.mycelium.id:8443` (set by hand — the UI has no field for it).

### Commits this session (all bugs found by running for real)
| Commit | Fix |
|---|---|
| `948e5f5` | Caddy `auto_https disable_redirects` — non-root app can't bind `:80` |
| `81ed240` | `fetch-sidecars.sh` `set -e`/TOFU first-run abort (grep→awk) + pin frpc |
| `2874a24` | Hetzner deploy kit + `MYC_BIND_HOST` + acme-dns register/update split |
| `ce737cf` | auto-refuse handles colliding with a live Cloudflare record |
| `6740dee` | quote Caddy `storage` path — macOS `Application Support` has a space |
| `12e276b` | serve the OAuth **`/login`** page (better-auth `mcp` `loginPage` configured but unbuilt → fresh clients 404'd) |
| `ed7004b` | serve **JWKS** (`jwt()` plugin + `useJWTPlugin`) — advertised `/api/auth/mcp/jwks` was 404 |

### THE CURRENT BLOCKER — better-auth MCP token signing (CORRECTED 2026-06-03 — NOT the audience)
The OAuth handshake **completes server-side** — from the live log, latest attempt:
```
GET  /api/auth/mcp/jwks      → 200   (Claude fetches the key → JWKS fix works)
POST /api/auth/mcp/register  → 201   (DCR)
GET  /api/auth/mcp/authorize → 302   (after /login as operator@mycelium.local)
POST /api/auth/mcp/token     → 200   (token ISSUED)
```
…but **no token-bearing `/mcp` request follows** (only an unauth `GET /mcp` probe). So **Claude gets the token and stops before `/mcp`.**

**CORRECTION (2026-06-03 — supersedes the earlier "wrong `aud`" diagnosis; do NOT chase it):** the access token is **opaque**, not a JWT — `node_modules/better-auth/dist/plugins/mcp/index.mjs:449` returns `generateRandomString(32,…)`; `useJWTPlugin` isn't even referenced in the mcp token path. There is no `aud` claim to fix. What IS broken is the plugin's **internally inconsistent token signing** (all verified live):
- both well-knowns advertise `id_token_signing_alg_values_supported: ["RS256"]` / `resource_signing_alg_values_supported: ["RS256"]`,
- the JWKS serves an **EdDSA** key,
- the `id_token` is signed with an **ephemeral HS256** key (`mcp/index.mjs:472-504`) that is never published.

A client that requests `openid` (it's in `scopes_supported`) and validates the `id_token` against the advertised RS256 / the EdDSA JWKS **cannot verify an HS256-ephemeral token → "authorization failed" before `/mcp`** — server-side, and identical across accounts/IPs (matches "fresh account on VPN = same error"). The metadata **chain itself is correct** (verified: `/mcp` 401 → `WWW-Authenticate` → protected-resource `resource=…/mcp` + `authorization_servers=[…]` → AS metadata with S256). So the bug is the token/`id_token` signing — a **better-auth@1.6.12 MCP-plugin limitation (our side)**. It does NOT rule out an *additional* Anthropic beta-gate (see below). **Temporary `[myc-oauth]`/`[myc-auth]` logging is live in `src/server-http.js` — remove before merge.**

### UPDATE 2026-06-03 — SERVER PROVEN FUNCTIONAL; the failure is CLAUDE-SIDE (decisive test)
Ran a scripted **reference OAuth 2.1 + DCR + PKCE MCP client** (`/tmp/myc-phase2/_oauth-probe.mjs`) against the LIVE `https://0m.mycelium.id`:
```
register 201 → sign-in 200 → authorize 302 → token 200 → POST /mcp initialize 200
  result: { protocolVersion 2025-06-18, capabilities.tools, serverInfo: mycelium 0.1.0 }   getMcpSession: OK
```
**Works WITH and WITHOUT `openid`.** ⇒ our cert, relay, OAuth, DCR, PKCE, and resource-server token validation are all correct end-to-end — a standards client connects and gets a live MCP session. The earlier "signing inconsistency breaks it" theory is **also wrong** (a background research agent confirmed: MCP 2025-06-18 is pure OAuth 2.1 — no OIDC, no id_token, Claude never validates the access token; opaque token + DB-lookup RS validation is spec-correct).

Claude does register/authorize/token (all 200) then **never sends the Bearer to `/mcp`** (log shows only unauth `/mcp` probes). Since a compliant client succeeds with the identical token, **Claude obtaining the token and not using it is Claude-side** (beta-gate / Claude bug). **The operator's "it's on Anthropic's side" read is SUPPORTED by this test.**

**The ONE residual our-side lever:** better-auth advertises `openid` (`node_modules/better-auth/dist/plugins/mcp/index.mjs:39` hardcoded in protected-resource meta; `:79` overridable via `oidcConfig.metadata.scopes_supported`; `:124` `defaultScope:"openid"`) and emits the unverifiable HS256 `id_token` ONLY when `openid` is requested (`:511`). Spec says Claude ignores it — UNVERIFIED for Claude's real client. **To settle + maybe fix:** (1) enhance `[myc-oauth]` to log the `authorize` query so Claude's actual `scope` is visible; (2) drop `openid` from `scopes_supported` + `defaultScope`; then ONE clean Claude attempt — calls `/mcp` ⇒ it was the id_token (our-side, fixed); still bails ⇒ **pure Anthropic gate → contact support with this proof.** Repro: re-run `_setpw.mjs` to set a known operator pw, then `_oauth-probe.mjs <pw>`.

### RESEARCH 2026-06-03 — known-issue cluster + UNTRIED server-side levers (don't escalate yet)
3-agent web sweep (Anthropic docs + GitHub + MCP spec). Findings:
- **The symptom is a well-known, Anthropic-tracked cluster:** `anthropics/claude-ai-mcp` #155 ("OAuth completes but /mcp never gets POST initialize"), #240, #291, #326, #327, #79, #217; `modelcontextprotocol/modelcontextprotocol` #2157; `anthropics/claude-code` #46140/#52871/#46539. Many are **closed "not planned"**, with reporters saying support called it **claude.ai-web-side** → corroborates the operator's read.
- **Anthropic's OWN troubleshooting doc** ([claude.com/docs/connectors/building/troubleshooting](https://claude.com/docs/connectors/building/troubleshooting)): when OAuth succeeds server-side but the connector still fails → **file a GitHub issue on `anthropics/claude-ai-mcp` with the `ofid_` reference id** (a *time-limited server-side failure-trace id*) + server URL + access logs. So the `ofid_…` codes the operator kept getting are exactly what Anthropic wants reported.
- **Gating:** custom connectors are **beta**; available Free/Pro/Max/Team/Enterprise (Free = 1 connector; Team/Ent = **Owner-only** add). **Hard requirement:** the MCP server must be reachable **from Anthropic's IP ranges (`160.79.104.0/21`)** — connections come from Anthropic's cloud, not the device. Confirm nothing between relay→app filters a cookieless `Authorization` POST from that range (the #327 Cloudflare-Bot-Fight-Mode case; likely N/A for our Caddy+frp).
- **CONFIRMED server-side gaps (verified live, 2026-06-03):**
  1. **RFC 9728 path-suffixed PRM `/.well-known/oauth-protected-resource/mcp` → 404** (we serve ONLY the root `/.well-known/oauth-protected-resource` → 200). Claude *independently probes the path-suffixed location* (#155 trace shows `GET /.well-known/oauth-protected-resource/api/mcp`). **VALIDATED 2026-06-03 against 3 servers that DO work with Claude — Sentry, Linear, Notion:** ALL serve the PRM at the **path-suffixed** location AND their `/mcp` 401 `WWW-Authenticate resource_metadata` points to the **suffixed** URL (Sentry serves *only* suffixed; root → 404). **We serve only root + point WWW-Authenticate at root → confirmed THE gap.** Their PRM is also **minimal** (`{resource, authorization_servers, bearer_methods_supported}` — NO `openid`/`scopes_supported`/`resource_signing_alg_values_supported`), corroborating fix #2. **FIX:** serve the PRM at the `/mcp`-suffixed path, set the `/mcp` 401 `WWW-Authenticate resource_metadata` to that suffixed URL, and minimize the PRM body.
  2. **Transport:** our `/mcp` is **Streamable-HTTP only** (no `/sse` → 404). Our live symptom (Claude loops unauth `GET /mcp`, never POSTs `initialize` with the bearer) **matches #291** (Streamable-HTTP fails, **`/sse` is the documented escape hatch**).
- **FIX ORDER before escalating** (cheap→big): (1) mirror PRM at the `/mcp` path-suffixed well-known; (2) drop `openid` + stop emitting the `id_token`; (3) verify Caddy/frp preserve `Accept: application/json, text/event-stream` + `MCP-Protocol-Version` + `Host` on `/mcp`; (4) optionally add an `/sse` transport (the #291 escape hatch); (5) else **file `anthropics/claude-ai-mcp` issue with the `ofid_` + the `_oauth-probe.mjs` reference-client proof** (exactly the evidence those issues hinge on). **So it is NOT cleanly Claude-side — real server-side levers remain untried.**

### Whose side is it? (SUPERSEDED by the UPDATE + RESEARCH subsections above — kept for history; server is proven functional, remaining levers = PRM-path + transport)
The operator believes Anthropic is deliberately blocking/targeting them. Synthesis after investigating (and being wrong twice — don't be over-confident here):
- **Most likely cause = OUR token signing** (see the blocker above): a better-auth@1.6.12 MCP-plugin defect. Provable, server-side, fixable. This is the lead to chase first.
- **The "connectors page won't load / VPN fixes it" is plausibly Anthropic-side** (custom connectors are in beta; could be a geo/beta gate) OR the operator's own network — it is **NOT** our relay. *(Corrected: an earlier version of this doc wrongly blamed our relay's nftables rate-limit. That page is served by claude.ai; our relay only ever serves `0m.mycelium.id`.)*
- **Deliberate IP-targeting is contradicted by the operator's own observation:** a *fresh account on a VPN* (different account, different IP) got the **identical** error. A block targeting them would have let that through. Same-error-everywhere ⇒ either our bug or a **blanket** gate — neither is "coordinated against *you*."
- **An Anthropic beta-gate on custom connectors is NOT ruled out** (the error says "contact support"). The way to actually know: the **reference-client test** in the blocker section. If a standards MCP client connects but Claude won't, *that* is the evidence it's Anthropic-side — and at that point "contact support" is the correct next move, not a workaround.

### Pickup protocol (next session)
1. Confirm live: `curl -s -o/dev/null -w '%{http_code}\n' https://0m.mycelium.id/api/auth/mcp/jwks` (200), `…/mcp` (401), `…/login?x=1` (200). Run the Mac app via the `MYCELIUM_HOME=…` command above (kill other copies first: `pkill -f 'Mycelium.app/Contents/MacOS/mycelium'`).
2. **Apply the server-side fixes — `/sweep-first-design` FIRST** (the server is PROVEN functional end-to-end via `_oauth-probe.mjs`; the signing theory is DEAD — see the UPDATE + RESEARCH subsections, which supersede "Whose side?" below). In order:
   a. **Serve the PRM at the `/mcp` path-suffixed well-known + point WWW-Authenticate at it** — `/.well-known/oauth-protected-resource/mcp` currently **404s** (root → 200); add a route in `src/server-http.js` returning the SAME JSON, AND change the `/mcp` 401 `WWW-Authenticate resource_metadata` to the suffixed URL. **CONFIRMED gap, validated against Sentry/Linear/Notion (all 3 work with Claude and do exactly this) — do this first.**
   b. **Drop `openid`** from advertised scopes (override `oidcConfig.metadata.scopes_supported`, ref `node_modules/better-auth/dist/plugins/mcp/index.mjs:79`; the protected-resource scopes at `:39` are hardcoded → may need a response rewrite) + stop emitting the `id_token` (`:511`).
   c. Verify Caddy/frp preserve `Accept: application/json, text/event-stream` + `MCP-Protocol-Version` + `Host` on `/mcp`.
   d. Restart the app (re-run `_setpw.mjs` for a known operator pw), do ONE clean Claude connect, watch `/tmp/myc-branch-app.log` for a **token-bearing `POST /mcp` → `getMcpSession: OK`**.
   e. Still failing → add `/sse` transport (#291 escape hatch); else **file `anthropics/claude-ai-mcp` issue w/ the `ofid_` + the `_oauth-probe.mjs` reference-client proof.**
3. **Relay nftables**: the connectors *page* not loading is NOT the relay (claude.ai serves it) — but still confirm the home IP isn't throttled on `:443` if `/authorize` (browser→relay) ever stalls (`mycelium-managed/relay/nftables.conf`: `limit rate 30/second` + `ct count over 128`).
4. Polish bucket, then merge: login identity = **handle** (not `operator@mycelium.local`); **user-facing password reset** (the UI set-password is a no-op for an existing user — this session reset via `/tmp/myc-phase2/_reset-operator.mjs` + `_clean-oauth.mjs` on `auth.db`); fix `jwks_uri` cleanly; **remove the temp logging**; **restore the parked apps**.
5. **Merge `feat/remote-connect-phase2` → main** (self-contained app, real vault, permanent handle; no `MYCELIUM_HOME`/parked-copy juggling). Resolve conflicts vs `main`'s #54/#57-59.

### Gotchas (2026-06-03)
- macOS `pgrep -a` ≠ Linux; kill app copies by PID or `pkill -f 'Mycelium.app/Contents/MacOS/mycelium'`.
- `node -e` with `"table"` in SQL → SQLite reads it as an identifier; use single quotes or a `.mjs` file.
- Running the branch `.app` binary can also launch the installed `/Applications` copy (shared bundle id) which grabs `:8787` with its non-remote backend → park the other copies.
- Operator password lives in `auth.db` (scrypt), never `remote.json`; `passwordSet` in `/api/v1/remote/status` reflects it.
- Temp helper scripts in `/tmp/myc-phase2` (untracked): `_reset-operator.mjs`, `_clean-oauth.mjs`, `_rematerialize.mjs` — delete or formalize.
