# Remote Connect — TLS-Passthrough Transport (Design)

**The tunnel must never see plaintext. TLS terminates on the user's Mac; the relay forwards ciphertext only. The data is decrypted at exactly two points — the user's Mac and the AI provider's servers — and nowhere in between.**

> **Date:** 2026-06-02 · **Status:** DESIGN (sweep-first, pre-implementation)
> **Supersedes** the *data plane* of [REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md](REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md) (Cloudflare remotely-managed tunnels — which terminate TLS at CF's edge). The control-plane *spine* carries over: ed25519 handle claims, config-reconcile (Tauri reads `remote.json`, not IPC), secrets in auth.db/Keychain, Rust-owned child lifecycle.
> **Builds on** Phases 1–2 (PRs #45/#46) and [REMOTE-CONNECT-DESIGN-2026-06-02.md](REMOTE-CONNECT-DESIGN-2026-06-02.md).
> **Sweep:** 8 parallel agents (4 reading our code, 4 verifying external facts) + the 6 load-bearing files read directly. Verification table at the end.
> **Audience:** the next Claude Code instance building the transport.

---

## 0. Headline — the pivot, in one breath

`frpc` (on the Mac) ↔ `frps` (a public relay) using FRP's **`type = "https"`** mode, which routes by the TLS **SNI without decrypting**. A **Caddy** instance *on the Mac* holds the cert and terminates TLS, then reverse-proxies plain HTTP to the existing `:4711` OAuth/MCP server. The relay sees ciphertext + SNI + traffic metadata — never plaintext, never the vault, never the OAuth tokens.

```
 Claude cloud (Anthropic)  ── MCP client, reaches INBOUND over HTTPS
   │  TLS session: Anthropic  ⟷  the Mac's Caddy   (relay is NOT a TLS endpoint)
   │  https://alice.example.com/mcp
   ▼
 DNS: alice.example.com → relay public IP        [Cloudflare users: DNS-only / GREY cloud]
   ▼
 ┌──────────────────────────────────────────────┐
 │ RELAY VPS — frps, type=https, vhostHTTPSPort  │  sees: SNI "alice", IPs, timing, bytes
 │ reads SNI from ClientHello, forwards CIPHERTEXT│  never: path, headers, body, tools, data
 │ frps does NOT terminate TLS (gofrp.org)        │
 └──────────────────────────────────────────────┘
   ▲  (reverse tunnel: frpc on the Mac dialed OUT; relay forwards inbound down it)
   │  no inbound port opened on the Mac / router
 ┌──────────────────────────────────────────────┐
 │ THE MAC                                        │
 │ frpc  → 127.0.0.1:8443  Caddy (TLS terminates) │  cert key BORN + STAYS here (ACME DNS-01)
 │        → 127.0.0.1:4711  node --http (plain)   │  better-auth OAuth gate (operator password)
 │        → vault: AES-GCM at rest, key in Keychain
 └──────────────────────────────────────────────┘
```

**The consequence you must register:** removing cloudflared removes the *free, backend-less* tunnel — cloudflared was free **because** CF terminates TLS in the path, and a passthrough relay can't be both free and blind. So reachability now splits three ways (§3.0): a publicly-reachable **always-on Mac goes Direct (no relay at all)**; everyone behind NAT needs a **relay** — their own VPS (sovereign, free to us) or a mycelium fleet (convenient, costs us). The relay is purely a *NAT-traversal* device — **CGNAT users have no other option**, while a Mac that can accept inbound `:443` needs no relay.

---

## 1. Goals & non-goals

**Goal.** Remote MCP connectivity where the network is treated as hostile: ciphertext from Anthropic to the Mac, TLS terminating only on the Mac, the tunnel operator cryptographically unable to read traffic. Wire it into the existing `remote.json` / operator-password / `--http` / better-auth machinery and the Tauri child lifecycle. **The managed relay is the focus** — the default one-click path, operated by mycelium. **Own-relay and Direct are first-class full-control options**, runnable from the open-source repo: every managed component (relay, acme-dns, control-plane) is itself open-source and self-hostable, and all endpoints are config-pointable — **"managed" just means mycelium operates an instance of the same code.** A user running it themselves with Claude gets full control by construction.

**Non-goals (this design).**
- Hiding plaintext from the **AI endpoint** — impossible for a cloud AI; that's the "local model" lane (later). Accepted.
- Hiding the **SNI hostname** from the relay (would need ECH + client support we don't control). Metadata residual, accepted.
- **The managed stack's internals** (handle registry, mycelium DNS automation, per-tenant relay isolation, the LE rate-limit strategy, relay-fleet DDoS) — managed is **the focus**, but its control-plane is a new networked service and gets **its own `/sweep-first-design`** before code (§6.5). THIS doc designs the Mac-side transport + the config interface to it — which is identical for managed and own-relay (only the endpoint URLs differ).
- Local-model lane, account system, >relay-scale sharding.

---

## 2. Revision history

- **v2 (this doc).** Data plane pivots **cloudflared → FRP `type=https` passthrough + Caddy-on-Mac TLS**. Driver: operator requirement "treat the network as hostile; the tunnel must not see plaintext." Pivots vs. the v1 auto-provision design:
  - **Relay = FRP passthrough, not Cloudflare.** Sweep 5 confirmed (gofrp.org) that `frps` in HTTPS-vhost mode does **not** terminate TLS — it SNI-routes ciphertext to the origin, which holds the cert. cloudflared/CF **disqualified** (terminates at edge).
  - **+ Caddy on the Mac** (custom `xcaddy` build with `caddy-dns/acmedns`) terminates TLS using a **per-Mac cert whose key never leaves the Mac** (ACME DNS-01 via acme-dns). New requirement vs. v1 (where CF held the cert).
  - **Path B is no longer backend-free.** Passthrough has no free middlebox → own-domain needs a relay (own VPS or ours).
  - **+ we run a small acme-dns server** (universal CNAME delegation) so one Caddy build serves every user regardless of their DNS host.
- **v1.** The cloudflared two-path auto-provision design. Superseded on the data plane only.

---

## 3. Architecture

### 3.0 Three connectivity modes — managed by default, self-host for full control

The **managed relay is the default** (the one-click path most users get; mycelium operates it). It is **not special code** — it's the same open-source stack mycelium runs as a service, and every endpoint is **config-pointable**, so a full-control user self-hosts the whole thing from the repo. The app auto-detects reachability and recommends a mode, but the choice is the user's.

| Mode | Reach | Relay operator | For whom |
|---|---|---|---|
| **Managed** *(default)* | `frpc` ↔ mycelium `frps`, `<handle>.mycelium.id` | mycelium (OSS, self-hostable) | the non-technical majority — one click, no domain |
| **Own relay** | `frpc` ↔ **your** `frps` + your domain | **you** (from the repo) | full-control / sovereignty users |
| **Direct** *(no relay)* | DNS → home IP; router forwards `:443` → Caddy | none | an always-on, publicly-reachable Mac |

**The principle: "managed" = mycelium operating the open-source stack.** The relay (`frps` wrapper), the `acme-dns` server, and the control-plane all ship in the repo and are runnable by anyone. Config points at mycelium's endpoints by default (`relayAddr`, `acmeDnsServer`, `controlPlaneUrl`) and overrides to your own — so "use your own" isn't a second-class fork, it's the same software, different operator. **Cert/sovereignty:** in *every* mode the TLS key is born on and stays on the Mac, so even mycelium's relay can't read traffic or MITM honestly (CT-monitored; own-relay/Direct remove even that residual). **Cost/DDoS:** managed costs us bandwidth+ops and lets our fleet absorb floods; own-relay shifts both to the user's VPS; Direct has no relay (no cost, no scrubbing — the home uplink is the target).

**"Can't I just use an always-on Mac, no relay?"** Yes — **if the Mac is publicly reachable.** Always-on fixes *sleep*, not *NAT*. Direct mode needs a **public IP** (static, or dynamic + a DDNS updater), the ability to **port-forward `:443`**, and an ISP that **doesn't CGNAT** and **doesn't block inbound 443**. All true → no relay, no `frpc`, no cost, max sovereignty; Caddy just terminates on the Mac as usual. **CGNAT (common on mobile/fibre/cable) makes Direct impossible regardless of skill** — no public IP exists to reach — so a relay is the only option for those users.

**Direct-mode shape:** Caddy listens on the **public** `:443` (not loopback) and `reverse_proxy`s to the loopback `127.0.0.1:4711`; **no `frpc`**. Cert via the same acme-dns/DNS-01 path (HTTP-01 also works if `:80` is forwarded). DNS A → home IP, set once for a static IP; a **dynamic** IP needs a DDNS updater (per-provider API or `caddy-dynamicdns`). A **reachability probe** (a small external callback to `publicHost:443`) decides Direct-viable vs. fall-back-to-relay.

**Direct-mode trade:** no relay → no metadata to any operator, but the **home IP is published in DNS and directly attackable**, with no scrubbing — a flood lands on the home uplink. Relay mode hides the IP and can absorb/cap. **Direct = max sovereignty, min resilience.**

### 3.1 The local chain (relay modes — frpc + Caddy + node)
| Hop | Process | Binds | Role |
|---|---|---|---|
| 1 | `frpc` (bundled sidecar) | outbound to relay | reverse tunnel; carries raw TLS; `type=https`, `customDomains=[publicHost]`, `localPort=8443` |
| 2 | `caddy` (bundled, custom build) | `127.0.0.1:8443` (TLS) | **terminates TLS** for `publicHost` using ACME DNS-01 (acme-dns); `reverse_proxy 127.0.0.1:4711` |
| 3 | `node --http` (existing) | `127.0.0.1:4711` (plain) | better-auth OAuth 2.1 + Streamable-HTTP MCP; bound loopback-only (see T0) |

`frpc` + `caddy` are spawned by **Rust** into the existing `Server(Mutex<Vec<Child>>)` (main.rs:34) and killed on `Destroyed` (main.rs:185-195). Both are single-process Go binaries → `child.kill()` is sufficient (Sweep 8).

### 3.2 The relay (frps)
- `vhostHTTPSPort = 443`; routes inbound :443 by SNI to the matching `frpc`; forwards ciphertext.
- `auth.token` authenticates the tunnel client. (Multi-tenant hostname binding is a managed-phase concern — §6.5.)
- **Own-domain V1:** user's own VPS *or* a mycelium relay. **Managed:** a mycelium relay fleet.

### 3.3 The cert (ACME DNS-01, key on the Mac)
- Caddy is a **custom `xcaddy` build** with `caddy-dns/acmedns` (stock Caddy can't do DNS-01 — Sweep 9).
- We run a small **acme-dns** server. The Mac's Caddy registers once → scoped credentials that can write **only** its own `_acme-challenge` TXT.
- The user adds **one CNAME**: `_acme-challenge.<publicHost> → <id>.auth.acme-dns.mycelium.id`. Own-domain: manual (or automated if their DNS has an API). Managed: we create it (we own the zone).
- Caddy obtains + auto-renews the cert; **the private key is generated on and never leaves the Mac.** Stored in Caddy's data dir (`<dataDir>/caddy`, files `0600`/dirs `0700` — Sweep 6).

---

## 4. Sweep findings (consolidated, cited)

**Data plane — FRP passthrough (Sweep 5).** `frps` HTTPS-vhost "**will not perform TLS termination**" (gofrp.org/en/docs/examples/vhost-http). FRP uniquely combines reverse-tunnel + no-decrypt SNI routing. `auth.token` gates the client; per-proxy `transport.bandwidthLimit` + `bandwidthLimitMode=server` caps bandwidth. nginx/HAProxy/sniproxy do passthrough but aren't reverse tunnels; rathole tunnels but can't SNI-route. **cloudflared/CF terminate — out.**

**Cert (Sweep 6, 9).** LE limit = **50 certs / registered domain / 7 days**; registered domain = eTLD+1 → **all `<handle>.mycelium.id` share one bucket** (renewals NOT exempt) → managed onboarding hard-capped ≈50 new users/week without mitigation. **Own-domain has no such cap** (each domain = its own bucket). Wildcard dodges it but = one key → breaks "key on each Mac" → **rejected.** Caddy DNS-01 = **custom xcaddy build**; `caddy-dns/acmedns` + universal CNAME means **one build serves all users**. acme-dns scopes the credential to one TXT (github.com/joohoi/acme-dns).

**Anthropic egress + OAuth origins (Sweep 7).** Outbound `160.79.104.0/21` is **official + "stable, won't change without notice"** (platform.claude.com/docs/en/api/ip-addresses). BUT per the MCP authz spec, **`/authorize` + login + consent come from the user's BROWSER**, while metadata/DCR/token/`/mcp` come from Anthropic's backend. The relay sees **SNI only (no paths)** → an Anthropic-only allowlist on the data hostname **would break interactive login.** → IP-allowlist is **not** the V1 primary defense (see §5, §7).

**Tauri sidecar (Sweep 8).** `bundle.externalBin` = array (multiple sidecars); per-target-triple filename **required** (`frpc-aarch64-apple-darwin`, `caddy-…`); triple via `rustc --print host-tuple`. **Sidecars are NOT reliably auto-killed** → use `std::process::Command` + own the `Child` in the kill-set (our existing pattern). No `tauri-plugin-shell` needed.

**Our code (Sweeps 1-4 + my reads).**
- `remote.json` = `{v, publicBaseUrl, operatorEmail, remoteEnabled}`; `writeRemoteConfig` allowlist = exactly those 3 (config.js:52-63). Secrets → auth.db (resolveAuthSecret pattern, config.js:71-95).
- All OAuth URLs derive from `baseURL = readRemoteConfig().publicBaseUrl` (auth.js:35-36, 55, 67; server-http.js:97,104). `--http` must boot with `publicBaseUrl = https://<publicHost>` **before first connect**; no `X-Forwarded` parsing.
- MCP transport = **stateful Streamable HTTP**, session-keyed (server-http.js:18-23, 143-149) — passthrough carries SSE fine.
- **Gap:** `server-http.js:278` is `app.listen(port, …)` with **no host** → binds all interfaces, not loopback. The threat model needs loopback (T0 fix).
- Master key reaches `--http` via Keychain (`key-source.js:89-110`) → `unlock()` → bridged to `getMasterKey()` (index.js:63-70). So identity-signing + vault work in-process.
- Tauri child set + kill verified (main.rs:34,134-152,185-195).

---

## 5. Threat model — the three boundaries, drawn explicitly

| Boundary | Who could see plaintext | Verdict |
|---|---|---|
| **At rest** (the vault) | only processes holding the master key (Keychain) | unchanged; AES-256-GCM; key never leaves the Mac |
| **In transit** (Anthropic → Mac) | **nobody** between the endpoints — relay/ISP/wifi see ciphertext + SNI | **NEW guarantee**: TLS terminates on the Mac; relay forwards ciphertext |
| **At endpoint** (Anthropic) | the AI provider | inherent + accepted; closed only by a local model (later) |

**What the relay sees:** SNI hostname, source IP (Anthropic's, or the user's browser during `/authorize`), timing, byte volume. **Never:** path, headers, body, tool names/args, vault data, OAuth tokens.

**Cert-trust residual (the real own-vs-managed distinction):**
- **Own domain** (user controls DNS): only the user can obtain a cert for their host → relay operator is **cryptographically excluded** from MITM. *(Caveat: if their DNS is at Cloudflare, CF — as DNS operator — could issue a cert; mitigate with CAA + CT monitoring. Keep the record DNS-only/grey or CF also reads traffic.)*
- **Managed `*.mycelium.id`:** on the honest path mycelium can't decrypt (key on the Mac), **but** as the apex-DNS owner mycelium *could* issue a rogue cert and MITM. **Detectable** via CT monitoring + CAA; not fully foreclosable for a cloud client (can't pin Anthropic's client). Disclose; own-domain is the escape hatch.

**New attack surface:** the relay (public) and acme-dns server (public). Both carry no plaintext. DDoS = **availability**, never confidentiality (§7). In **Direct mode** there's no relay in the path, but the **home IP is exposed in DNS** and takes floods directly (no scrubbing) — still an availability trade only; TLS still terminates on the Mac.

---

## 6. Module shape

### 6.1 Config (`src/remote/config.js`) — +~25 LOC
Extend `readRemoteConfig`/`writeRemoteConfig` allowlist with non-secret keys:
- `remoteMode: 'off' | 'managed' | 'own-relay' | 'direct'` (default `'off'`)
- `publicHost: string` (e.g. `<handle>.mycelium.id` or `alice.example.com`); `publicBaseUrl` derives as `https://${publicHost}` when unset
- `relayAddr` (frps `host:port`), `relayVhostPort` (default 443), **`acmeDnsServer`**, **`controlPlaneUrl`** — all default to mycelium's managed endpoints and **override to a self-hosted instance** (the full-control path). Non-secret → safe in `remote.json`.

Secrets via **new auth.db rows** (mirror `resolveAuthSecret`): `resolveTunnelToken()` (FRP `auth.token`), `resolveAcmeDnsCreds()` (acme-dns username/password/subdomain/server_url). Never in `remote.json`.

### 6.2 Remote runtime renderer (`src/remote/runtime.js`, NEW) — +~150 LOC
Pure functions (testable, no Rust):
- `renderFrpcToml({ publicHost, relayAddr, relayVhostPort, token, localPort=8443 })` → frpc.toml string.
- `renderCaddyfile({ publicHost, dataDir, acmeCredsPath, upstream='127.0.0.1:4711', listen='127.0.0.1:8443' })` → Caddyfile string (`tls { dns acmedns <creds> }`, `reverse_proxy`, `storage file_system <dataDir>/caddy`).
- `registerAcmeDns({ serverUrl })` → POST `/register` → `{username,password,subdomain,fulldomain}`; persist creds; return the CNAME target.
- `materializeRemoteConfigs({ dataDir })` → writes `frpc.toml`, `Caddyfile`, `acmedns.json` (all `0600`) from config + secrets. Idempotent; called when the connect flow completes and on `--http` boot.

### 6.3 Router (`src/remote/router.js`) — +~80 LOC (loopback-only, mounts at `/api/v1/remote`)
- `POST /connect/own-domain { publicHost, relayAddr }` → `registerAcmeDns` → `materializeRemoteConfigs` → `writeRemoteConfig({remoteMode:'own-domain', publicHost, publicBaseUrl, relayAddr})` → returns `{ cnameName, cnameTarget, connectorUrl }` for the UI to display.
- `GET /remote/detail` → current mode/host/relay + cert state (does `<dataDir>/caddy` hold a cert for publicHost?) + tunnel-up probe + the CNAME instruction.
- `POST /disconnect` → `writeRemoteConfig({remoteMode:'off', remoteEnabled:false})`.

### 6.4 Tauri shell (`src-tauri/src/main.rs`) — +~70 LOC; `tauri.conf.json` + a fetch script
- `bundle.externalBin: ["binaries/frpc", "binaries/caddy"]`; `scripts/fetch-sidecars.sh` downloads per-triple `frpc` + builds/downloads the custom `caddy` (xcaddy with `caddy-dns/acmedns`) into `src-tauri/binaries/<name>-<triple>`.
- Replace `remote_enabled()` with `remote_mode()` (reads `remoteMode`); when `!= 'off'`:
  1. spawn `node src/index.js --http` with `MYCELIUM_PORT=4711` **+ `MYCELIUM_BASE_URL=https://<publicHost>`** (read from remote.json) so OAuth emits correct URLs;
  2. resolve the bundled `caddy` path (next to the main exe) → `Command::new(caddy).args(["run","--config",<dataDir>/Caddyfile,"--adapter","caddyfile"])` → push to children;
  3. resolve `frpc` → `Command::new(frpc).args(["-c",<dataDir>/frpc.toml])` → push to children.
- All three die on `Destroyed` via the existing drain loop.

### 6.5 Managed stack (`mycelium-managed`) — **THE FOCUS**; open-source + self-hostable; **separate sweep-design** first, ~400-600 LOC
This is the primary product path **and** the exact code a full-control user self-hosts (own-relay = pointing `relayAddr`/`acmeDnsServer`/`controlPlaneUrl` at your own instance). Sketch only (do NOT build without its own sweep): `POST /provision { handle, publicKey, nonce, signature }` (verify ed25519 via identity.js) → reserve handle (first-claim-wins, keyed by publicKey) → create `<handle>.mycelium.id` DNS at the relay + the `_acme-challenge` CNAME → issue a **per-tenant** frps token bound server-side to that handle's `customDomains` (so tenant A can't bind tenant B's host) → return `{ relayAddr, acmeDnsServer }`. **Plus** the relay fleet (`frps`), the acme-dns server, the LE rate-limit strategy (request increase / domain-shard / monitor), and DDoS hardening. **Everything here ships in the open-source repo with a self-host guide** — managed and own-relay are one codebase, different operator.

### 6.7 Prereq hardening (T0) — +~2 LOC
`server-http.js:278` → `app.listen(port, '127.0.0.1', …)`. Add a `verify` assertion that `:4711` is not reachable on a non-loopback address.

---

## 7. Edge cases — explicit decisions

- **IP-allowlist vs `/authorize`.** Decision: **do NOT** Anthropic-only-allowlist the data hostname in V1 — it would break browser-driven login (Sweep 7). Rely on host L3/4 scrubbing + per-tunnel bandwidth caps + the operator-password gate + (relay-side) connection rate limits. *Deferred hardening:* serve `/mcp` on a second SNI (`mcp.<host>`, Anthropic-allowlisted) and advertise `authorization_endpoint` on the open `<host>` — needs verification that better-auth can split resource vs. authorization host.
- **`publicBaseUrl` must precede first connect.** `--http` is (re)started with `MYCELIUM_BASE_URL=https://<publicHost>`. Changing the host later = re-add the connector in Claude (resource URL changes). Documented.
- **Mac sleeps.** `frpc` auto-reconnects on wake; DNS unchanged (points at relay) → connector URL stable. Add a keep-awake setting + a clear "offline" status. (FRP keepalive defaults.)
- **First-run provisioning latency.** DNS-01 + propagation takes seconds-to-minutes; show a "provisioning…" state; mark "ready" only when Caddy holds the cert **and** `frpc` is connected **and** a self-probe of `https://<publicHost>/mcp` returns 401 (auth challenge = end-to-end works).
- **Caddy listen.** Bind `127.0.0.1:8443` only (frpc connects locally); use the DNS-01 challenge so Caddy never needs inbound :80/:443. Set `storage file_system <dataDir>/caddy`.
- **Secret custody.** FRP token + acme-dns creds in auth.db (resolveAuthSecret pattern); materialized to `0600` config files by Node (which holds them). **Rust never sees secret values — only file paths.**
- **Relay ownership (operator decision 2026-06-02).** Three modes, auto-detected (§3.0): **Direct** when the Mac is reachable (no relay), **own-VPS** for NAT'd technical users, **mycelium relay** for the NAT'd majority. T3 ships **Direct + own-VPS** (zero mycelium infra); the **mycelium relay lands with the T4 fleet sweep** (multitenancy + DDoS) — this is where the operator's "Both" choice actually lands, since a production relay can't ship un-swept. The user's cert is theirs in every mode (relay can't MITM honestly).
- **Cloudflare-as-DNS for own-domain.** Must be **DNS-only (grey)** or CF terminates TLS. The UI must set/verify `proxied:false` if it ever automates CF DNS.

---

## 8. Test strategy

- **CI-able (pure JS, no network):** `verify:remote-runtime` — `renderFrpcToml`/`renderCaddyfile` produce expected configs from a fixture; `materializeRemoteConfigs` writes `0600`; `remoteMode` round-trips through config.js; secret resolvers are read-or-generate-once. Extend `verify:remote-config`.
- **CI-able (security):** `verify:loopback` — boot `--http`, assert it answers on `127.0.0.1:4711` and is **refused** on the host's LAN IP (T0).
- **Mac-only (cargo):** `cargo build` with the two sidecars bundled; assert both resolve + spawn (`frpc -h`, `caddy version` via the bundled paths).
- **Manual smoke (extends docs/SMOKE-TESTS.md):** stand up a dev `frps` on a $5 VPS; point a test domain at it (grey-cloud); complete `/connect/own-domain`; add the CNAME; confirm Caddy issues a cert; `curl https://<host>/mcp` from **off-network** → 401 (proves TLS terminates on the Mac through the passthrough). Then a real phone: add the connector, OAuth login, call a tool.
- **Cannot CI:** real relay, real cert issuance, real phone, the OAuth browser dance.

---

## 9. Implementation order (each independently shippable)

1. **T0 — loopback hardening.** `app.listen(127.0.0.1)` + `verify:loopback`. *Smoke:* LAN IP refused, loopback OK. *(Ships standalone; small security win.)*
2. **T1 — sidecar bundling spike.** Bundle `frpc` + custom `caddy` (one triple) via `externalBin`; spawn from Rust; confirm versions. *Smoke:* app launches both bundled binaries. *(Replaces the dead cloudflared 3b-0 spike.)*
3. **T2 — local TLS chain + reconcile (manual relay).** `runtime.js` renderers + `materializeRemoteConfigs`; `remoteMode` in config; Rust spawns `--http`(+BASE_URL)+`caddy`+`frpc` from `remote.json`. *Smoke:* hand-write configs pointing at a dev frps → `https://<host>/mcp` reachable off-network, 401.
4. **T3 — the managed stack (THE FOCUS).** **Run `/sweep-first-design` for `mycelium-managed` first.** Build the open-source, self-hostable stack: `frps` relay fleet + `acme-dns` server + control-plane (handle registry, ed25519 claims, DNS automation, per-tenant frps binding) + LE rate-limit strategy + DDoS hardening. Default connect UX = **one-click managed** (`<handle>.mycelium.id`, no domain). *Smoke:* click once → phone reaches the vault via the mycelium relay, ciphertext only. *(The Mac-side T0–T2 chain is identical for managed vs own-relay — only `relayAddr`/`controlPlaneUrl` differ.)*
5. **T4 — full-control options (mostly config + docs).** Own-relay (override `relayAddr`/`acmeDnsServer`/`controlPlaneUrl` → your self-hosted T3 stack) + Direct mode (reachability auto-detect, Caddy public on `:443`, DDNS, no frpc) + the **self-host guide** for running the whole stack from the repo. Reuses T0–T3 code; the work is the UX, the override fields, and documentation.

---

## 10. Decision criteria to proceed
- T1→T2: bundled `frpc`+`caddy` launch from the app on a clean machine (no system install).
- T2→T3: an off-network `curl https://<host>/mcp` returns 401 through the passthrough relay, with the cert key provably only on the Mac.
- T3→T4: a non-technical user completes own-domain connect with no terminal; *then* build managed.
- T4 gate: a user with no domain clicks once and reaches their vault from a phone, relay carrying ciphertext only.

---

## 11. Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| FRP `type=https` subtly terminates/forwards wrong | Low | High | T2 proves it end-to-end (off-network curl); gofrp docs explicit |
| Custom Caddy build (xcaddy) in the bundle pipeline | Med | Med | `scripts/fetch-sidecars.sh` builds it in CI; pin versions; T1 verifies |
| LE 50/week cap (managed) | High (managed) | High | own-domain ships first (no cap); managed → rate-limit increase / domain-shard; **decided in T4 sweep** |
| Relay is a SPOF / cost / DDoS target | Med | Med | host L3/4 scrubbing; per-tunnel caps; DNS-failover-ready; **decided in T4 sweep** |
| `/authorize` breaks under IP-allowlist | High (if allowlisted) | High | don't allowlist data host in V1; rate-limit + password gate; two-SNI split deferred |
| Mac uptime (sleep/offline) | Med | Med | keep-awake setting; auto-reconnect; clear offline status |
| Direct mode: CGNAT / ISP blocks inbound :443 | High (some ISPs) | Med | reachability probe auto-detects → fall back to relay; document plainly |
| Direct mode: home IP exposed, no scrubbing | Med | Med | offer relay for resilience; Direct is opt-in for sovereignty-max users |
| Direct mode: dynamic home IP breaks DNS | Med | Low | DDNS updater (`caddy-dynamicdns`/per-provider); static IP needs none |
| acme-dns server is new infra | Med | Med | tiny Go service; needed even for own-domain (universal CNAME); monitor |
| Managed rogue-cert MITM | Low | High | CAA + CT monitoring + own-domain escape hatch; disclose |

---

## 12. Open questions
**Resolved during sweep:** FRP `type=https` is passthrough (not terminate); cloudflared is out; Caddy DNS-01 needs xcaddy but acme-dns makes one build universal; Anthropic egress is stable `/21` but `/authorize` is browser-origin (so no naive allowlist); Tauri sidecars need explicit kill (use our existing `std::process::Command` set); `--http` already derives all OAuth URLs from `publicBaseUrl`; `:4711` currently binds all interfaces (T0 fixes).

**Deferred (named so they don't ambush T4):** managed relay ownership + cost model + pricing; the LE rate-limit strategy (increase vs domain-shard vs alt-CA); per-tenant frps hostname-binding security; relay-fleet HA + DDoS posture; the two-SNI split for IP-allowlisting; ECH for SNI privacy; certbot/lego decoupled-acquisition alternative if a custom Caddy build proves painful.

---

## 13. Verification table

| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | `remote.json` = 3 keys; `writeRemoteConfig` allowlist is exactly those (extend point) | **read:** config.js:39-63 |
| 2 | Secret-store precedent = auth.db read-or-generate-once (`resolveAuthSecret`) | **read:** config.js:71-95 |
| 3 | Control surface is loopback-only; routes mount at `/api/v1/remote` | **read:** router.js:31-35, 26-97 |
| 4 | All OAuth URLs derive from `baseURL = publicBaseUrl`; `resource:${baseURL}/mcp` | **read:** auth.js:35-36,55,67 + server-http.js:97,104 |
| 5 | MCP = stateful Streamable HTTP (session-keyed) — passthrough-safe | **read:** server-http.js:18-23,143-149 |
| 6 | `:4711` binds ALL interfaces (no host arg) → T0 must fix | **read:** server-http.js:278 |
| 7 | Master key reaches `--http` (Keychain→unlock→getMasterKey bridge) | **read:** key-source.js:89-110; **grep:** index.js:63-70 |
| 8 | Tauri children spawn into `Mutex<Vec<Child>>`, killed on Destroyed; `--http` spawn shape | **read:** main.rs:34,134-152,185-195 |
| 9 | identity.js ed25519 sign/verify from masterHex (managed claims) | **sweep-quoted** identity.js:29-78 — *re-verify in T4 sweep* |
| 10 | FRP `frps` HTTPS-vhost does NOT terminate TLS (SNI passthrough) | **EXTERNAL:** gofrp.org/en/docs/examples/vhost-http |
| 11 | LE = 50 certs/registered-domain/7d; eTLD+1; renewals not exempt | **EXTERNAL:** letsencrypt.org/docs/rate-limits |
| 12 | Caddy DNS-01 = custom xcaddy build; `caddy-dns/acmedns` + CNAME = universal | **EXTERNAL:** caddyserver.com/docs/automatic-https; github.com/caddy-dns/acmedns |
| 13 | acme-dns scopes credential to one `_acme-challenge` TXT | **EXTERNAL:** github.com/joohoi/acme-dns |
| 14 | Anthropic outbound `160.79.104.0/21`, stable; `/authorize` is browser-origin | **EXTERNAL:** platform.claude.com/docs/en/api/ip-addresses; modelcontextprotocol.io authz spec |
| 15 | Tauri externalBin per-triple; sidecars not auto-killed → own the Child | **EXTERNAL:** v2.tauri.app/develop/sidecar |
