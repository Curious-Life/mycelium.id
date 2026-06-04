# Mycelium relay — secure Hetzner deploy

A complete **single-box** managed stack (relay + control-plane + acme-dns + TLS edge)
on one Hetzner Cloud server. Secure-by-default: non-root, key-only SSH, two firewall
layers, unprivileged hardened services, secrets loopback-only. Split the roles across
boxes + add a 2nd relay for HA later (the relay is stateless).

> Drop-in files in this dir: `cloud-init.yaml`, `frps.service` (in cloud-init),
> `control-plane.service`, `control-plane.env.example`, `Caddyfile.edge`,
> `acme-dns.config.cfg`. Companion: `../../../docs/REMOTE-CONNECT-DEPLOY-RUNBOOK.md`.

You need: a domain whose DNS you control via API (**deSEC** free, or Cloudflare
DNS-only), and a scoped DNS-edit **token**. Handles become `<handle>.yourdomain.com`.

## Port map (one box, one IP)
| Port | Service | Exposure |
|---|---|---|
| 22 | SSH | your IP only (Hetzner FW) |
| 53 tcp+udp | acme-dns (authoritative for `auth.<domain>`) | public |
| 443 | **frps** tenant SNI passthrough | public |
| 7000 | frps control (frpc dials in) | public |
| 8443 | Caddy edge → control-plane `/v1/*` + acme-dns `/update` | public |
| 8790 control-plane · 8081 acme-dns API | **loopback only — never opened** | private |

---

## 1. Hetzner console (the screen you're on)
- **Type:** `cpx22` (2 vCPU / 4 GB, €7.99/mo) — ample; the relay is a dumb pipe.
- **Location:** pick the one nearest **you/your Mac** (lower tunnel latency) — Falkenstein/Nuremberg/Helsinki for EU.
- **Image:** Ubuntu 24.04.
- **Networking:** keep **IPv4** (handles get an A record to it); IPv6 optional.
- **SSH keys:** **add one** (don't accept a root password email). Generate locally:
  ```sh
  ssh-keygen -t ed25519 -C mycelium-relay -f ~/.ssh/mycelium_relay
  pbcopy < ~/.ssh/mycelium_relay.pub   # paste into Hetzner → Add SSH key
  ```
- **Firewall:** create one now (or attach after) — **Inbound allow only:**
  `22/tcp` (Source = *your IP/32*), `53/tcp`, `53/udp`, `443/tcp`, `7000/tcp`, `8443/tcp`. Deny the rest. (This is the edge layer; `cloud-init` adds host nftables as the second.)
- **Backups:** optional. The only stateful bits are `registry.db` + acme-dns accounts; for a test, skip (re-provisioning rebuilds them).
- **Cloud config:** paste the entire contents of **`cloud-init.yaml`** (edit `linux_amd64`→`linux_arm64` only if you chose an ARM `CAX` box). Then **Create**.

The box boots hardened (no root login, key-only SSH, nftables, auto-updates, fail2ban) with **frps already running** (it just rejects logins until the control-plane is up — expected).

✅ `ssh ops@<ip>` works; `ssh root@<ip>` is refused; `sudo nft list ruleset` shows the table; `systemctl is-active frps` → active.

---

## 2. DNS (at deSEC / your registrar)
```
connect.yourdomain.com.        A     <BOX_IP>      ; control-plane API (edge :8443)
acme.yourdomain.com.           A     <BOX_IP>      ; acme-dns /update (edge :8443)
auth.yourdomain.com.           NS    ns.auth.yourdomain.com.   ; acme-dns delegation
ns.auth.yourdomain.com.        A     <BOX_IP>      ; acme-dns server (:53)
```
Plus **CAA** on the apex (fill `<ACCT_ID>` after the first cert — see runbook §6):
```
yourdomain.com.  CAA 0 issue     "letsencrypt.org; validationmethods=dns-01; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<ACCT_ID>"
yourdomain.com.  CAA 0 issuewild ";"
```
> Cloudflare: every record **DNS-only (grey cloud)** — an orange-cloud record terminates TLS at CF and breaks the privacy guarantee.

---

## 3. acme-dns
```sh
sudo install -d -m 700 /etc/acme-dns /var/lib/acme-dns
sudo cp acme-dns.config.cfg /etc/acme-dns/config.cfg   # edit yourdomain.com + <BOX_IP>
# :53 published to the world; API stays on loopback (127.0.0.1:8081).
sudo docker run -d --name acme-dns --restart=always \
  -p 53:53 -p 53:53/udp -p 127.0.0.1:8081:8081 \
  -v /etc/acme-dns:/etc/acme-dns -v /var/lib/acme-dns:/var/lib/acme-dns \
  joohoi/acme-dns
```
✅ `dig +short NS auth.yourdomain.com @<BOX_IP>` → `ns.auth.yourdomain.com`.

## 4. Control-plane
```sh
sudo useradd --system --home /opt/mycelium-managed --shell /usr/sbin/nologin mycelium || true
sudo git clone <repo> /opt/mycelium-managed   # or rsync the mycelium-managed/ dir
sudo chown -R mycelium:mycelium /opt/mycelium-managed
sudo -u mycelium bash -lc 'cd /opt/mycelium-managed && npm ci --omit=dev'
sudo install -d -m 700 /etc/mycelium
sudo cp control-plane.env.example /etc/mycelium/control-plane.env   # fill MYC_* incl. the DNS token
sudo chmod 600 /etc/mycelium/control-plane.env && sudo chown mycelium:mycelium /etc/mycelium/control-plane.env
sudo cp control-plane.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now control-plane
```
✅ `curl -s localhost:8790/v1/challenge` → `{"nonce":…}`. `frps` log now authorizes (plugin reachable).

## 5. Caddy edge (TLS for the two public APIs)
```sh
# caddy + the deSEC DNS plugin (Cloudflare: swap p=github.com/caddy-dns/cloudflare):
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/caddy-dns/desec" -o /usr/local/bin/caddy && sudo chmod +x /usr/local/bin/caddy
sudo cp Caddyfile.edge /etc/caddy/Caddyfile.edge   # edit yourdomain.com
# run it with the DNS token in env (systemd unit or):
sudo DESEC_TOKEN=<token> /usr/local/bin/caddy run --config /etc/caddy/Caddyfile.edge --adapter caddyfile
```
✅ `curl -s https://connect.yourdomain.com:8443/v1/challenge` → nonce; `curl -s -X POST https://connect.yourdomain.com:8443/frps/handler` → **404** (the auth oracle is private); `curl -s https://acme.yourdomain.com:8443/register -X POST` → **404** (register is private).

---

## 6. Point the Mac + connect
Per `../../../docs/REMOTE-CONNECT-DEPLOY-RUNBOOK.md` §6–8: validate a cert on **LE staging** first, then on the Mac set `controlPlaneUrl` in `remote.json` to `https://connect.yourdomain.com:8443`, set the operator password, pick a handle → **Connect** → restart → connect your phone to `https://<handle>.yourdomain.com/mcp`.

## Security checklist
- [ ] `ssh root@<ip>` refused; only `ops` with a key; `22` restricted to your IP in the Hetzner FW.
- [ ] `curl -X POST …:8443/frps/handler` and `…:8443/register` → **404** (both private).
- [ ] `sudo ss -ltnp` shows `8790` + `8081` on `127.0.0.1` only.
- [ ] `/etc/mycelium/control-plane.env` is `0600`, owner `mycelium`; the DNS token is **only** here (never in cloud-init / git).
- [ ] DNS token is **scoped** to this one zone, DNS-edit only.
- [ ] No Cloudflare orange-cloud on any record.
- [ ] CAA set (`accounturi` + `dns-01`); CT monitoring wired (`ct-monitor.js`).
- [ ] `frps.toml` has **no** `auth.token` (the plugin is the gate).

## Threat notes
- The relay sees SNI + timing + volume, never plaintext (Caddy terminates on the Mac). Disclosed metadata residual; own-domain + own-relay removes the operator from the picture entirely.
- The DNS token is the box's crown jewel (it can rewrite your zone). It lives only in the control-plane env, loopback-bound service. For production, split the control-plane onto its own box so a relay compromise can't reach it.
