# Remote Connect — Managed Stack Deploy Runbook

**Date:** 2026-06-03
**Companions:** [HANDOFF](REMOTE-CONNECT-HANDOFF-2026-06-03.md) · [TRANSPORT-DESIGN](REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md) · [MANAGED-DESIGN](REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md) · `mycelium-managed/README.md` · `mycelium-managed/relay/README.md`
**Audience:** the operator standing up the managed relay + control-plane to run the **live-infra smoke** — the last critical-path gate. Every in-session-verifiable layer (transport, managed auth, packaging) is already proven (handoff TL;DR); this runbook covers only what needs real infra.
**Scope:** the **managed** path (`<handle>.mycelium.id`). Own-relay/Direct reuse the same stack pointed at the operator's own endpoints.

> Convention in this doc: `✦` = an exact command/record (verified against the code); `⚠` = an operator judgement call; `✅ verify` = the check + expected output before moving on.

---

## 0. What you're standing up

```
  Claude (phone/web)                                    YOUR Mac (Mycelium.app)
        │  https://<handle>.mycelium.id (TLS)                 │
        ▼                                                     │ loopback 127.0.0.1:4711
  ┌───────────┐   SNI passthrough    ┌──────────────┐  frpc   │  (--http OAuth/MCP)
  │  RELAY     │ ───ciphertext────▶  │  frpc tunnel │ ◀───────┤  Caddy 127.0.0.1:8443
  │  frps :443 │                     └──────────────┘         │  (terminates TLS; key
  └─────┬─────┘                                               │   never leaves the Mac)
        │ NewProxy/Login plugin (private)
        ▼
  ┌──────────────────┐   registers   ┌───────────┐   apex DNS  ┌───────────┐
  │  CONTROL-PLANE    │ ────────────▶ │ acme-dns  │  + records  │ DNS zone  │
  │  /v1/* (public)   │               │ (self-host│ ──────────▶ │ mycelium  │
  │  /frps/handler    │               │  disable_ │             │   .id     │
  │     (private)     │               │  reg.)    │             │ +CAA      │
  └──────────────────┘                └───────────┘             └───────────┘
```

**Four things to run/own:**
1. **Relay VPS** — `frps` (SNI passthrough) + nftables. Host with free L3/4 DDoS scrubbing (**Hetzner/OVH**); **no Cloudflare proxy in front** (it terminates TLS).
2. **acme-dns** — self-hosted, `disable_registration=true`. Authoritative for an `auth.` sub-zone.
3. **Apex DNS** — the `mycelium.id` zone via an API the control-plane can drive (**deSEC** free+DNSSEC, or **Cloudflare DNS-only**).
4. **Control-plane** — `mycelium-managed` (`/v1/*` public over TLS, `/frps/handler` private to the relay).

Plus: **your Mac** running the built `Mycelium.app`, and a **phone** to connect.

---

## 1. Prerequisites
- [ ] A VPS (Hetzner/OVH) — 1 vCPU/1 GB is plenty; the relay is a dumb pipe. Public IPv4.
- [ ] Control of the `mycelium.id` DNS zone **via API** (deSEC token, or Cloudflare token + zone id).
- [ ] `Mycelium.app` built on the target Mac: `bash scripts/fetch-sidecars.sh && (cd src-tauri && cargo tauri build --bundles app)` → `src-tauri/target/release/bundle/macos/Mycelium.app`. *(Both steps verified 2026-06-03.)*
- [ ] The vault **recovery key** (to restore/unlock on the Mac — **never paste it anywhere**).
- [ ] `frps`/`frpc` `v0.61.1` + `caddy` (+`caddy-dns/acmedns`) binaries (the app bundles its own; the relay needs `frps`).

### 1a. Dry-run first (no infra, already validated this session)
Before touching DNS, confirm provisioning + the auth hook with mocks — this is exactly the Tier-2 smoke that passed on 2026-06-03:
```sh
✦ cd mycelium-managed && MYC_DNS_PROVIDER=mock MYC_ACME_DNS_MOCK=1 \
    MYC_RELAY_ADDR=<relay-ip>:7000 MYC_ACME_DNS=https://auth.mycelium.id \
    PORT=8790 MYC_ZONE=mycelium.id MYC_REGISTRY_DB=./registry.db node src/server.js
```
✅ verify: `curl -s localhost:8790/v1/challenge` → `{"nonce":"…"}`. (Auth-matrix valid/forged/unowned-host already proven against a real frps — handoff §Tier-2.)

---

## 2. One-time apex DNS records
Set these **once** on the `mycelium.id` zone (the control-plane adds the *per-handle* records later, §6).

✦ **Relay address** (the control-plane's `MYC_RELAY_IP` / `relayAddr` host):
```
relay.mycelium.id.        A      <RELAY_VPS_IPV4>      ; (or point handles straight at the IP)
```
✦ **acme-dns delegation** — acme-dns is authoritative for an `auth.` sub-zone, so the user's Caddy DNS-01 lookups land there:
```
auth.mycelium.id.         NS     ns.auth.mycelium.id.
ns.auth.mycelium.id.      A      <ACME_DNS_SERVER_IPV4>
```
✦ **CAA** — pin issuance to LE + DNS-01 + your ACME account; forbid wildcards (from `mycelium-managed/src/ct-monitor.js` `caaRecords()`). Fill `<ACCT_ID>` after first LE registration (§6):
```
mycelium.id.   CAA 0 issue     "letsencrypt.org; validationmethods=dns-01; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<ACCT_ID>"
mycelium.id.   CAA 0 issuewild ";"
mycelium.id.   CAA 0 iodef     "mailto:security@mycelium.id"
```
✅ verify: `dig +short NS auth.mycelium.id` → your acme-dns NS; `dig +short CAA mycelium.id` → the three records.
⚠ **Do not** enable Cloudflare's orange-cloud (proxy) on `relay`/`<handle>` records — it terminates TLS. The DNS-client code enforces `proxied:false`, but verify in the dashboard too.

---

## 3. acme-dns server
On the acme-dns host (`joohoi/acme-dns`):
```sh
✦ # /etc/acme-dns/config.cfg essentials:
#   [general] domain = "auth.mycelium.id"  nsname = "ns.auth.mycelium.id"  nsadmin = "admin.mycelium.id"
#            records = ["auth.mycelium.id. A <ACME_DNS_IP>", "auth.mycelium.id. NS ns.auth.mycelium.id.", ...]
#   [api]     ip = "127.0.0.1"  port = "8081"  disable_registration = true   ← ONLY the control-plane registers
docker run -d -p 53:53 -p 53:53/udp -p 127.0.0.1:8081:8081 \
  -v /etc/acme-dns:/etc/acme-dns joohoi/acme-dns
```
⚠ `disable_registration = true` is **load-bearing** — otherwise anyone can register subdomains. The control-plane reaches `/register` over the **private** network (front it with the same private edge as the control-plane, or co-host).
✅ verify (from the control-plane host, registration enabled only transiently if you must test): a public `dig TXT _acme-challenge.<sub>.auth.mycelium.id` resolves once a cert run writes it.

---

## 4. Control-plane (`mycelium-managed`)
Run it on a private interface; expose **only** `/v1/*` publicly via a TLS edge.

✦ **Run** (real providers):
```sh
cd mycelium-managed
MYC_ZONE=mycelium.id \
MYC_RELAY_ADDR=relay.mycelium.id:7000 \
MYC_RELAY_IP=<RELAY_VPS_IPV4> \
MYC_ACME_DNS=https://auth.mycelium.id \
MYC_DNS_PROVIDER=desec   MYC_DNS_TOKEN=<token> \
#  …or: MYC_DNS_PROVIDER=cloudflare MYC_DNS_TOKEN=<token> MYC_CF_ZONE_ID=<zoneid>
MYC_REGISTRY_DB=/var/lib/mycelium/registry.db \
MYC_MAX_NEW_HANDLES_PER_DAY=40 \
PORT=8790 node src/server.js
```
⚠ **`/frps/handler` MUST stay private.** `app.listen(PORT)` serves *all* routes on one port and binds **all interfaces** (verified: an IPv4/IPv6 listen-all). So front it: a public edge (Caddy/nginx) that proxies **only** `/v1/*` for `connect.mycelium.id`, and let the relay call `/frps/handler` over the private network / loopback. Never expose `/frps/handler` to the internet (it's an allow/reject oracle for tunnel registration).

✦ **Public edge** (example Caddy on the control-plane host — its OWN cert, separate from tenant certs):
```
connect.mycelium.id {
    @v1 path /v1/*
    handle @v1 { reverse_proxy 127.0.0.1:8790 }
    handle { respond 404 }          # everything else (incl. /frps/handler) is not public
}
```
✅ verify: `curl -s https://connect.mycelium.id/v1/challenge` → `{"nonce":…}`; `curl -s https://connect.mycelium.id/frps/handler -X POST` → `404` (NOT reachable publicly).

---

## 5. Relay (`frps`)
On the relay VPS, from `mycelium-managed/relay/`:
```sh
✦ sudo nft -f nftables.conf                 # L3/4 per-source rate + conn caps (tune for host)
✦ # frps.toml: confirm vhostHTTPSPort=443, bindPort=7000, transport.tls.force=true,
#   and [[httpPlugins]] addr = "<control-plane private addr>:8790" path="/frps/handler"
#   ops=["Login","NewProxy","CloseProxy","Ping"]  — NO auth.token (plugin is the gate)
frps -c frps.toml
```
✅ verify: `frps` log → `frps started successfully`, `https service listen on 0.0.0.0:443`. The plugin addr resolves to the control-plane privately (NOT the public edge).
⚠ HA: the relay is stateless (routes by SNI) → run ≥2 behind a low-TTL `A` record for failover (relay README §4).

---

## 6. Let's Encrypt — validate on STAGING before prod
The app's Caddy issues against **LE production** by default. To avoid burning the **50-certs/registered-domain/week** cap on a misconfig, validate the **DNS-01 + acme-dns + CAA** chain against **LE staging** first with a throwaway issuance, then let the real app issue against prod.

✦ One-shot staging test (throwaway Caddy on any host, using a control-plane-issued acme-dns cred):
```sh
# obtain a cred by provisioning a test handle (§7 does this); then:
caddy run --config - <<'EOF'
{ acme_ca https://acme-staging-v02.api.letsencrypt.org/directory }
https://smoketest.mycelium.id { respond "ok"
  tls { dns acmedns { username <u> password <p> subdomain <sub> server_url https://auth.mycelium.id } } }
EOF
```
✅ verify: Caddy log → `certificate obtained successfully` from the **staging** CA. Then read `https://acme-v02.api.letsencrypt.org/acme/acct/<id>` from your prod account → put `<ACCT_ID>` in the CAA record (§2). Confirm renewals are ARI-exempt (Caddy logs `using ARI`).
⚠ Future nicety (not built): an app-side "LE staging" toggle would make this first-class instead of a manual side-test.

---

## 7. The Mac — connect
1. Install `Mycelium.app`; **restore the vault** with the recovery key (setup screen). *(Never paste the key.)*
2. Set the control-plane endpoint if not default-baked: `controlPlaneUrl=https://connect.mycelium.id` (own-relay also sets `relayAddr`/`acmeDnsServer`).
3. In Settings → Connect (managed): pick a handle, click **Connect** (operator-password gate). The app: `/v1/challenge` → signs the ed25519 claim → `/v1/provision` → writes `frpc.toml`+`Caddyfile` (0600) → spawns `frpc`+`caddy`.
✅ verify on the Mac: `frpc` log → `start proxy success`; `caddy` log → `certificate obtained` for `<handle>.mycelium.id`; the control-plane created `A <handle>` + `CNAME _acme-challenge.<handle>` (`dig +short <handle>.mycelium.id` → relay IP).

---

## 8. Smoke test — real device
✦ From **another network** (phone on cellular):
```
curl -s https://<handle>.mycelium.id/   # reaches the Mac's loopback server through the relay
```
Then in Claude (phone/web): add a **custom MCP connector** at `https://<handle>.mycelium.id/<mcp-path>`, complete OAuth (`/authorize` → operator-password gate), and run one tool call.
✅ verify: tool call returns vault data; the relay log shows only SNI (no plaintext); the Mac's Caddy shows the TLS termination. **This is the end-to-end "it works".**

---

## 9. Verification ledger
| Step | Check | Expected |
|---|---|---|
| 1a dry-run | `curl localhost:8790/v1/challenge` | `{"nonce":…}` |
| 2 apex | `dig +short CAA mycelium.id` | 3 CAA records |
| 2 deleg. | `dig +short NS auth.mycelium.id` | your acme-dns NS |
| 4 edge | `curl https://connect.mycelium.id/v1/challenge` | `{"nonce":…}` |
| 4 edge | `curl -X POST …/frps/handler` | `404` (private) |
| 5 relay | frps log | `https service listen on 0.0.0.0:443` |
| 6 LE | staging Caddy log | `certificate obtained` (staging) |
| 7 connect | frpc/caddy logs on Mac | `start proxy success` + cert obtained (prod) |
| 8 phone | MCP tool call | returns vault data; relay sees only SNI |

---

## 10. Rollback / teardown
- **Release a handle:** app → Disconnect (calls `/v1/release` with a `release`-action claim → tears down DNS, drops the registry row → invalidates the relay token). Or `POST /v1/release` with a signed release claim.
- **Stop:** quit the app (the Tauri reaper group-kills `frpc`+`caddy`); `systemctl stop` frps + control-plane.
- acme-dns accounts persist (no delete API) — releasing removes the `_acme-challenge` CNAME, orphaning the subdomain harmlessly (documented in `acmedns.js`).

---

## 11. Security checklist (do not skip)
- [ ] `/frps/handler` is **not** publicly reachable (§4 verify returns 404).
- [ ] acme-dns `disable_registration = true`.
- [ ] No Cloudflare orange-cloud on `relay`/`<handle>` records (TLS must not terminate at the edge).
- [ ] `nftables.conf` applied on the relay.
- [ ] CAA set with `accounturi` + `validationmethods=dns-01`; `issuewild ";"`.
- [ ] CT monitoring wired (`ct-monitor.js` → Cert Spotter) — **detection** of a rogue cert; CAA+CT are not *prevention* (a DNS-controlling operator can still MITM — own-domain is the cryptographic escape hatch; disclose this to managed users).
- [ ] Control-plane `auth.db`/registry on a `0700` dir; operator password set.

---

## 12. Known gotchas
- **LE 50 certs / registered-domain / week** — all `<handle>.mycelium.id` share `mycelium.id`. Renewals are ARI-exempt (Caddy default), so this caps only ~2,600 **new** handles/yr/domain. Beyond that: request a rate-limit increase, or add **Google Public CA** (per-project quotas). (Own-domain users are unaffected.)
- **caddy supply-chain** — `fetch-sidecars.sh` leaves caddy as documented-TOFU (caddyserver on-demand builds aren't byte-reproducible). For true integrity of the TLS terminator, build via `xcaddy` with pinned caddy+plugin versions and pin that. frpc is pinned.
- **Direct mode** (no relay) renders a bare-host Caddy site → binds `:443` (privileged); a non-root macOS app can't. Needs a high local port + the user forwarding `:443`, or elevation — unresolved, T4. Managed/own-relay are fine (Caddy on `127.0.0.1:8443`).
- **`:7000` on macOS** is Control-Center/AirPlay — irrelevant on a Linux relay, but bites local testing.
- **Control-plane binds all interfaces** (`app.listen(port)`); the private/edge split in §4 is mandatory, not optional.
