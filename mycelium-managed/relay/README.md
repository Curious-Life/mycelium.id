# Mycelium relay (frps) — self-host / deploy

The relay is a **dumb TLS-passthrough pipe**: it routes inbound HTTPS by SNI to each tenant's `frpc` and forwards ciphertext. It **never terminates TLS** (the user's Caddy does, on their Mac) and **never holds a cert key or vault plaintext** — it sees only the SNI hostname + traffic metadata. Authorization (which tenant may bind which `<handle>` host) is delegated to the control-plane's `NewProxy`/`Login` plugin.

## Files
- **`frps.toml`** — the FRP server config. SNI-passthrough (`vhostHTTPSPort`), no fixed `auth.token` (the plugin is the gate), `transport.tls.force`, plugin wired for **both** `Login` and `NewProxy`.
- **`nftables.conf`** — example L3/4 edge protection (per-source rate + concurrent-connection caps). Tune for your host.

## Threat-model notes (must-do on deploy)
1. **Host with free L3/4 scrubbing** — Hetzner or OVH (always-on, no extra cost, no TLS termination). Do **not** put Cloudflare's proxy in front (it terminates TLS).
2. **Keep the plugin endpoint private** — `frps.toml`'s `[[httpPlugins]] addr` points at the control-plane's `/frps/handler`. Firewall it to the relay host only (it answers allow/reject for tunnel registrations; it is not for the public).
3. **The relay can't decrypt** — but it *can* see SNI + timing + volume. That's the disclosed metadata residual; for "the operator sees nothing", a user brings their own domain + own relay.
4. **HA** — the relay is stateless (forwards by SNI), so run ≥2 behind a low-TTL DNS A-record for failover.

## Run
```sh
# 1. host firewall
sudo nft -f nftables.conf
# 2. control-plane (the auth plugin + provisioning) — see ../README.md
#    MYC_DNS_PROVIDER=... MYC_RELAY_IP=<this host> ... npm --prefix .. start
# 3. relay
frps -c frps.toml
```

> The relay multitenancy security rests on the plugin running for **both** ops and on per-tenant token secrecy. A leaked tunnel token impersonates only **that one handle** (the plugin pins token→handle); rotate by re-provisioning. Per-tenant connection caps live in `nftables.conf` (FRP clamps bandwidth; nftables clamps connections).
