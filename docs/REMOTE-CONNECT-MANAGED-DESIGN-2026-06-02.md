# Remote Connect — Managed Stack (`mycelium-managed`) Design

**One-click `<handle>.mycelium.id` for the non-technical majority — and the exact same open-source stack a full-control user self-hosts. mycelium operates an instance; it never holds a cert key, a master key, or a byte of plaintext.**

> **Date:** 2026-06-02 · **Status:** DESIGN (sweep-first, pre-implementation)
> **Companions:** [REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md](REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md) (the Mac-side transport this plugs into — §6.5 there is the seed of this doc) · [REMOTE-CONNECT-AUTO-PROVISION](REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md) (data plane superseded) · [REMOTE-CONNECT-DESIGN](REMOTE-CONNECT-DESIGN-2026-06-02.md)
> **Sweep:** 6 cycle-1 agents (FRP multitenancy · acme-dns · apex DNS · LE rate-limit · relay DDoS/cost · our identity/seam) + 2 cycle-2 (read `identity.js` by hand · Caddy ARI). Verification table at the end.
> **Audience:** the next Claude Code instance building the managed control-plane + relay fleet.

---

## 0. TL;DR

The managed stack is **four cooperating, self-hostable services** + the Mac-side transport already designed:

1. **Control-plane API** — verifies an ed25519 handle claim (`identity.verifyWithPublicKey`), reserves the handle, drives DNS + acme-dns + a per-tenant relay credential, writes a **registry DB** row.
2. **frps relay fleet + a `NewProxy` auth-hook** — the hook authorizes *every* tunnel registration against the registry DB so a tenant can bind **only** its `<handle>.mycelium.id`. No frps restart per user.
3. **acme-dns server** (`disable_registration=true`) — the control-plane registers on each user's behalf; the Mac's Caddy answers DNS-01 with a scoped credential. **The cert key is born on and stays on the Mac.**
4. **DNS automation** for the `mycelium.id` apex — two records per handle (A→relay, `_acme-challenge`→acme-dns).

**The make-or-break facts the sweep nailed down:** (a) FRP's `NewProxy` HTTP hook gives us per-tenant hostname binding with zero restarts; (b) **Let's Encrypt exempts ARI renewals from all rate limits**, and Caddy does ARI by default — so the 50-cert/week/`mycelium.id` cap throttles only *new signups* (~2,600/yr/domain), not active users, with **Google Public CA** (per-project quotas) as the scale-out fallback. The managed path is viable.

---

## 1. Goals & non-goals

**Goal.** A control-plane + relay that a non-technical user reaches in one click, where mycelium operates the stack but is **cryptographically excluded** from reading traffic (TLS terminates on the Mac) and from impersonating-without-detection (cert key on the Mac; CT-monitored). Everything OSS + self-hostable; the app's `relayAddr`/`acmeDnsServer`/`controlPlaneUrl` point at mycelium by default and override to a self-hosted instance.

**Non-goals.** The Mac-side transport (done — transport design). Billing/pricing (separate). >10k-user sharding (deferred; the design notes the lever). A mycelium account system (we use ed25519 claims, not passwords). ECH/SNI-hiding (metadata residual, accepted).

---

## 2. Revision history
- **v1 (this doc).** First managed design. Pivots from the auto-provision sketch (§6.5 of the transport doc): the relay is **FRP passthrough with a `NewProxy` auth-hook** (not Cloudflare tunnels); cert provisioning is **acme-dns + per-Mac Caddy/ARI** (not CF-held certs); the control-plane is a **registry-DB-backed** service whose liveness does **not** gate tunnel reconnections (pressure-test catch, §7).

---

## 3. Architecture

```
  app (Mac, loopback router)                         mycelium-managed (or self-hosted)
  ──────────────────────────                         ─────────────────────────────────
  1. GET  controlPlaneUrl/v1/challenge ───────────▶  issue single-use nonce (TTL ~5m)
  2. sign "<handle>|<nonce>" with identity (ed25519, in-process master key)
     POST controlPlaneUrl/v1/provision ───────────▶  verifyWithPublicKey(pub, "<handle>|<nonce>", sig)
        { handle, publicKey, nonce, signature }         + nonce fresh + isValidHandle + free/owned
                                                        → REGISTRY DB: handle→{publicKey, frpsToken, acmeSub}
                                                        → DNS: <handle> A→relay, _acme-challenge CNAME→acme-dns
                                                        → acme-dns /register (server has disable_registration)
  3. ◀─────────────────────────────────────────────  { host, relayAddr, relayToken, acmeDns{user,pass,sub,url} }
  4. store relayToken + acmeDns creds → auth.db (secret); remoteMode=managed, publicHost, relayAddr → remote.json
  5. Tauri reconcile spawns:  caddy (DNS-01 via acme-dns, ARI renew)  +  frpc (subdomain=<handle>, metas.token)
                                                        │
   Claude ──https://<handle>.mycelium.id/mcp──▶ frps (vhostHTTPS, SNI route, NO decrypt)
                                                        │  NewProxy hook ▶ registry DB: token→handle, allow iff subdomain==handle
                                                        ▼
                                              frpc ▶ Caddy(:8443 TLS terminate) ▶ 127.0.0.1:4711 (--http)
```

**Two services can be one process for V1:** the control-plane API and the frps `NewProxy` auth-hook both read/write the **same registry DB**, so ship them together (the hook is one extra HTTP route). The relay (`frps`), acme-dns, and the apex DNS are separate processes/infra.

---

## 4. Sweep findings (consolidated, cited)

**FRP multitenancy (M1).** `frps` server plugin exposes HTTP hooks `Login/NewProxy/CloseProxy/Ping/NewWorkConn/NewUserConn` (`doc/server_plugin.md`). `NewProxy` payload (`pkg/plugin/server/types.go`, `pkg/msg/msg.go`) carries `UserInfo{User,Metas,RunID}` + `custom_domains`, `subdomain`, `proxy_name`, `bandwidth_limit`; the hook returns `{reject}` / `{unchange:true}` / `{unchange:false,content:{…}}` (clamp). **No hot-reload and no add-proxy API on frps** (`server/api_router.go` is read-only + `DELETE`), so the hook is THE dynamic-authorization path — exactly what we want (zero restarts). Per-tenant secret rides in `metadatas`; bandwidth via `transport.bandwidthLimit` + `bandwidthLimitMode=server` (clampable by the hook). No per-proxy connection cap (do it at the edge/nftables).

**acme-dns (M2).** Self-host (binary/Docker), authoritative DNS :53 + HTTP API; delegate `auth.mycelium.id` via NS. Source-confirmed credential isolation (`pkg/api/auth.go`: `user.Subdomain == postData.Subdomain`; DB update `WHERE Subdomain=$3`). `allowfrom` empty = open (leave open — the Mac's renewal IP is variable). **No built-in `/register` rate-limit** → run with `disable_registration=true` and register **only** via the control-plane. HA = single instance + DB backup (or Postgres-backed; multi-instance unofficial).

**Apex DNS (M3).** deSEC (free, mandatory DNSSEC, TXT-scoped tokens) or Cloudflare (most write headroom; **must be grey-cloud `proxied:false`** or CF terminates TLS). **2 records per handle is the realistic minimum**: a wildcard `*.mycelium.id` A→relay can't also serve the `_acme-challenge` TXT, and the per-handle `_acme-challenge` CNAME (required by acme-dns) creates an RFC 4592 node that *stops* the wildcard from covering `<handle>` — so each handle needs an explicit A **and** the CNAME. (A central `*.mycelium.id` wildcard *cert* would be zero-DNS but = one shared key → breaks key-on-Mac → rejected.)

**LE rate-limit (M4) — the defuser.** "Certificates per Registered Domain" = 50 / 7 days, eTLD+1, shared across accounts. **Renewals are EXEMPT** — ARI renewals "exempt from all rate limits"; LE's stated goal: renewals "almost never hit a rate limit." So the 50/week caps only **new** handles ≈ **2,600 new signups/yr/domain**; active renewing users are unbounded. Override: per-registered-domain request form (weeks; use one logical issuance identity). **Google Public CA** quotas are **per-project, not per-domain** (≈100 newOrder/hr) → removes the eTLD+1 bottleneck entirely as a fallback.

**Caddy ARI (cycle-2).** CertMagic "full support for RFC 9773 (ARI)", **default-ON** since v0.21.0 (`config.go` only has a `DisableARI` flag; `maintain.go` drives renewal off ARI). Caddy reuses its ACME account across renewals (CertMagic storage). LE→ZeroSSL fallback built-in; **Google Public CA** via `acme_ca` + `acme_eab`. DNS-01 for a **non-owned** domain works purely via the delegated `_acme-challenge` CNAME → acme-dns (no apex control, no HTTP-01).

**Relay DDoS/cost (M5).** Hetzner + OVH = free, always-on **L3/4** scrubbing (network-layer; no TLS termination) — OVH cites 17 Tbps filtering. CF-in-front would terminate TLS (passthrough only on paid Spectrum/Magic Transit). Per-source caps via nftables (`ct count`, `meter`/`limit rate`, `synproxy`) — no decryption; per-*tenant* needs SNI-keyed L4 limiting (HAProxy TCP `req.ssl_sni`, SNI is cleartext). Stateless relay → DNS-failover HA (~€8/mo for 2 Hetzner CX22, 20 TB each). Avoid hyperscaler egress ($0.09/GB).

**Our identity + seam (M6 + read).** `identity.js` (read by hand, lines 29-89): deterministic ed25519 from `USER_MASTER` via HKDF info `"mycelium-identity-v1"`; `sign(str)→base64url`; **`verifyWithPublicKey(pubB64, data, sig)` exported** (control-plane verifies with public key only); `isValidHandle` regex `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`. The running REST/`--http` process already holds the master key (`server-rest.js:152-156` → `resolveKeys()`/`getMasterKey()`; `publish/public-server.js:62` derives identity in-process), so `connect_managed` signs locally. No outbound HTTP client in `src/` yet → use Node global `fetch`. Secrets → `auth.db` (the `resolveAuthSecret` pattern, `config.js:71-95`). Control-plane receives **only** `{handle, publicKey, nonce, signature}`.

---

## 5. Threat model

| Boundary | Who can see plaintext | Verdict |
|---|---|---|
| At rest (vault) | only the Mac (master key in Keychain) | unchanged |
| In transit | nobody — relay forwards ciphertext (SNI + metadata only) | TLS terminates on the Mac |
| At endpoint | the AI provider | inherent; accepted |

**What the control-plane sees:** `{handle, publicKey, nonce, signature}` — never the master key (the ed25519 *public* key is one-way), never vault data, never the operator password. It can authenticate a claim but cannot act as the user.

**Per-tenant isolation (the multitenancy gate):** the `NewProxy` hook rejects any tunnel whose `metas.token` → handle ≠ the requested `subdomain`/`custom_domains`. Tenant A cannot bind `victim.mycelium.id`.

**Rogue-cert residual (managed only):** mycelium owns the apex DNS, so a *malicious* mycelium could issue a rogue cert for `<handle>.mycelium.id` and MITM. **Mitigations:** CAA records on `mycelium.id` (restrict issuers) + CT-log monitoring (rogue issuance is publicly visible) + the **own-domain escape hatch** (the user's own DNS → mycelium can't get a cert). Disclosed in the UI. On the honest path, the cert key is on the Mac → mycelium can't passively read anything.

**Availability coupling (pressure-test catch):** the `NewProxy` hook MUST read a **local/replicated registry DB**, not call the provisioning API per connection — else a control-plane outage breaks every tunnel reconnection. Provisioning (writes) and authorization (reads) are decoupled.

**New attack surface:** control-plane API (rate-limit `/challenge` + `/provision`; nonce single-use), acme-dns (`disable_registration=true`, control-plane-only), the relay (L3/4 scrubbing + nftables). All carry no plaintext.

---

## 6. Module shape (`mycelium-managed/`, new OSS service — ~600–750 LOC + infra)

- **Control-plane API** (~280 LOC, Express): `GET /v1/challenge`→`{nonce,expiresAt}` (single-use, TTL ~5m, stored); `POST /v1/provision {handle,publicKey,nonce,signature}`→ verify (`verifyWithPublicKey`) + nonce + `isValidHandle` + availability (first-claim-wins keyed by publicKey; same key may re-provision) → DNS + acme-dns register + mint `relayToken` → registry row → `{host,relayAddr,relayToken,acmeDns}`; `GET /v1/handle/:h`→availability; `POST /v1/release {handle,nonce,signature}`→ release/rotate.
- **frps NewProxy auth-hook** (~100 LOC): `POST /frps/handler` (frps plugin protocol) → on `NewProxy`, look up `metas.token`/`user` in the **registry DB**, `reject` unless `subdomain==handle` (and clamp bandwidth); on `Login`, validate the token exists. Reads the DB locally.
- **Registry DB** (~40 LOC, sqlite/Postgres): `handles(handle PK, public_key, frps_token, acme_subdomain, created_at)`.
- **DNS-provider client** (~80 LOC): deSEC or Cloudflare(grey) — create/delete `<handle>` A + `_acme-challenge` CNAME.
- **acme-dns client** (~50 LOC): `POST /register` (server-side, since `disable_registration`), return scoped creds.
- **Client seam** (~120 LOC, in `src/`): `src/remote/managed-claim.js` (build/sign the claim from in-process identity) + `POST /api/v1/remote/connect-managed` in `router.js` (loopback) → fetch `/challenge`, sign, `/provision`, store secrets (auth.db) + write remote.json + materialize frpc.toml/Caddyfile (transport `runtime.js`).
- **Infra (config, not LOC):** `frps` (vhostHTTPS, server plugin → the hook), acme-dns (`disable_registration=true`), the apex DNS account, the relay VPS (Hetzner/OVH) + nftables rules. **All documented in a self-host guide.**

---

## 7. Edge cases — explicit decisions
- **Replay:** nonce is single-use + short-TTL, issued by `/challenge`, marked used on `/provision`. A captured claim can't be replayed.
- **Handle squat:** first-claim-wins keyed by `publicKey`; re-claim requires the same key (signature). Reserved/blocklist for impersonation-prone names (e.g. `anthropic`, `admin`).
- **Master-key-loss recovery:** the handle is bound to the ed25519 *public* key, which is deterministic from the master key. **BIP-39 recovery key → same master → same ed25519 → re-claim the same handle.** If the key is truly lost (no recovery phrase), the handle is stranded; offer a manual, audited release after out-of-band proof. (Decision: acceptable; document.)
- **Control-plane outage:** authorization reads a local registry replica → existing tunnels reconnect fine; only *new* provisioning is blocked. (Pressure-test catch.)
- **acme-dns registration owner:** the **control-plane** registers (server `disable_registration=true`) and mints the CNAME atomically → no public registration abuse; the app only stores + uses the returned creds.
- **`allowfrom`:** left open (the Mac's renewal IP is residential/variable); security rests on the bcrypt credential + per-subdomain isolation.
- **DNS writes:** exactly 2 per handle; well under any provider limit (deSEC 300/day, CF 1,200/5min) given ~7 new signups/day at the LE ceiling.
- **CA strategy:** Caddy → Let's Encrypt with **ARI** (renewals exempt); request a per-registered-domain override before approaching ~2,600 new signups/yr; **Google Public CA** (`acme_ca`+`eab`) is the per-project-quota scale-out if the eTLD+1 ceiling is ever hit.
- **Cloudflare-as-apex-DNS:** records MUST be `proxied:false` (grey) — verified/enforced by the DNS client.

---

## 8. Test strategy
- **CI-able (pure):** `verify:managed-claim` — sign a claim, `verifyWithPublicKey` accepts it, a tampered handle/nonce/sig is rejected, nonce single-use. `verify:newproxy-auth` — the hook's allow/reject logic given a registry fixture (allow own handle, reject cross-tenant, clamp bandwidth) as a pure function.
- **Against mocked infra:** `verify:provision` — `/provision` against a mocked DNS client + mocked acme-dns + in-mem registry: asserts signature verified, handle reserved, DNS calls shaped right (2 records), creds returned. No real network.
- **Staging:** the whole flow against **Let's Encrypt staging** + a real test relay + real acme-dns + a throwaway apex/subdomain. Assert: cert issued for `<handle>`, frpc authorized, off-network `curl https://<handle>…/mcp` → 401, **renewal recognized as ARI-exempt** (force a renewal, watch the LE order carry the `replaces` field).
- **Manual smoke:** real phone via `<handle>.mycelium.id`; tenant-isolation probe (a second box tries to bind the first's handle → rejected).
- **Cannot CI:** real LE prod issuance/exemption at scale, real DDoS, real CT-monitoring alerts.

---

## 9. Implementation order (after transport T0–T2; each shippable)
1. **M-0 — infra skeleton (manual).** One relay VPS: `frps` (vhostHTTPS) + a stub `NewProxy` hook (allow-all) ; acme-dns (`disable_registration`); apex DNS account (deSEC/CF-grey). *Smoke:* hand-register a handle, point DNS, a test Mac's Caddy gets a staging cert, connects through frps. *(Proves the whole passthrough+cert chain end-to-end with no control-plane code.)*
2. **M-1 — control-plane API + registry + DNS/acme-dns automation** (LE staging). *Smoke:* `curl` the `/challenge`+`/provision` flow with a signed claim → 2 DNS records + creds returned; registry row written.
3. **M-2 — `NewProxy` auth-hook backed by the registry DB.** Per-tenant binding; reject cross-tenant; clamp bandwidth; reads local DB (decoupled from provisioning). *Smoke:* tenant A cannot bind B's host; A's own host works.
4. **M-3 — client `connect-managed` + one-click UX.** Sign+POST+store+reconcile; the managed tab in the Connect panel. *Smoke:* click once → phone reaches the vault via `<handle>.mycelium.id`, ciphertext through the relay.
5. **M-4 — hardening + self-host.** LE prod + ARI verified (staging→prod); per-registered-domain override request; DNS-failover 2nd relay; nftables DDoS rules; CAA + CT-monitoring; **the self-host guide** (run the whole stack from the repo). 

---

## 10. Decision criteria to proceed
- M-0→M-1: a test Mac gets a staging cert for `<handle>.mycelium.id` and serves `/mcp` through frps passthrough (off-network 401).
- M-1→M-2: a signed claim provisions DNS+creds+token end-to-end against mocked-then-staging infra.
- M-2→M-3: a cross-tenant bind attempt is rejected; same-tenant works; reconnection survives a control-plane API stop.
- M-3→M-4: a non-technical click yields a working phone connection; renewal is observed ARI-exempt on LE staging.
- M-4 (launch gate): CAA+CT-monitoring live; a per-registered-domain LE override granted (or Google CA wired); 2-relay DNS-failover proven.

---

## 11. Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| FRP `NewProxy` hook semantics differ from sweep | Low | High | M-0/M-2 prove against real frps; source-cited types |
| LE exemption not honored (no ARI / not recognized) | Low | High | Caddy ARI default-on; verify on LE **staging** in M-3; Google CA fallback |
| New-signup burst > 50/wk/domain | Med | Med | per-registered-domain override (early request); domain-shard; Google CA |
| Control-plane outage breaks reconnects | Low | High | hook reads local registry replica (decoupled) — designed in |
| Rogue-cert MITM (managed) | Low | High | CAA + CT-monitoring + own-domain escape hatch; disclose |
| Relay SPOF / flood | Med | Med | Hetzner/OVH L3/4 scrubbing + nftables + DNS-failover 2nd relay |
| acme-dns single instance | Med | Med | DB backups; Postgres-backed multi-instance later |
| Handle disputes/impersonation | Med | Low | reserved-name blocklist; signed first-claim-wins; manual dispute process |

---

## 12. Open questions
**Resolved during sweep:** FRP per-tenant binding (NewProxy hook); dynamic provisioning without restart (hook, not config-reload); acme-dns isolation + control-plane registration; 2-DNS-records-per-handle (wildcard can't cover the challenge); **LE renewals exempt via ARI** (the scaling defuser); Caddy ARI default-on + non-owned-domain DNS-01; free L3/4 host scrubbing; identity verifiable by public key alone.

**Deferred (named):** pricing/billing; >10k-user multi-relay sharding + the per-registered-domain shard policy; acme-dns true HA; geo-distributed relays / anycast; abuse/quotas policy for free-tier handles; whether to co-locate or split the control-plane and the frps hook at scale; CT-monitoring implementation (crt.sh poll vs a log-watcher).

---

## 13. Verification table

| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | frps `NewProxy` hook can reject/allow/clamp; payload has `custom_domains`/`subdomain`/`user`/`metas` | **EXTERNAL:** fatedier/frp `pkg/plugin/server/types.go`, `pkg/msg/msg.go`, `doc/server_plugin.md` (M1) |
| 2 | frps has NO hot-reload / NO add-proxy API → hook is the dynamic path | **EXTERNAL:** frp `server/api_router.go` (M1) |
| 3 | frps server-enforced per-proxy bandwidth; clampable | **EXTERNAL:** frp `pkg/config/types`, gofrp.org (M1) |
| 4 | acme-dns credential touches only its own subdomain TXT | **EXTERNAL:** acme-dns `pkg/api/auth.go`, `pkg/database/db.go` (M2) |
| 5 | acme-dns `disable_registration`; no `/register` rate-limit | **EXTERNAL:** acme-dns README/source (M2) |
| 6 | 2 DNS records/handle (wildcard can't cover `_acme-challenge`) | **EXTERNAL:** RFC 4592; LE challenge-types; acme-dns README (M3) |
| 7 | Cloudflare apex must be grey (`proxied:false`) or it terminates TLS | **EXTERNAL:** developers.cloudflare.com/dns/proxy-status (M3) |
| 8 | LE renewals EXEMPT (ARI); 50/wk caps only new certs; eTLD+1 | **EXTERNAL:** letsencrypt.org/docs/rate-limits (M4) |
| 9 | Caddy/CertMagic ARI default-on (v0.21.0+); reuses account | **EXTERNAL:** caddyserver/certmagic README/`config.go`/`maintain.go` (cycle-2) |
| 10 | Caddy issues for a NON-owned domain via acme-dns DNS-01 only | **EXTERNAL:** caddyserver.com/docs/automatic-https; caddy-dns/acmedns (cycle-2) |
| 11 | Google Public CA per-project (not per-domain) quotas = scale-out | **EXTERNAL:** cloud.google.com certificate-manager quotas (M4) |
| 12 | Hetzner/OVH free always-on L3/4 scrubbing (no TLS termination) | **EXTERNAL:** hetzner.com/ovhcloud anti-ddos (M5) |
| 13 | per-source caps via nftables (`ct count`/`synproxy`) no-decrypt | **EXTERNAL:** nftables wiki (M5) |
| 14 | identity: deterministic ed25519; `verifyWithPublicKey` (pubkey-only); `isValidHandle` | **read:** identity.js:29-37,50-89 |
| 15 | running process holds master key → can sign a claim in-process | **read/cited:** server-rest.js:152-156, publish/public-server.js:62 (M6) |
| 16 | `connect-managed` fits loopback router; secrets via auth.db pattern; no HTTP client in src | **read:** router.js:26-97, config.js:71-95 (M6) |
| 17 | control-plane receives ONLY {handle, publicKey, nonce, signature} | **design** + identity.js:82-89 (`verifyWithPublicKey`) |
