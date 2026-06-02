# mycelium-managed

The **managed control-plane + relay** for Mycelium remote-connect. It is **open-source and self-hostable**: "managed" simply means mycelium operates an instance of *this*. A full-control user runs their own and points the app at it (`controlPlaneUrl` / `acmeDnsServer` / `relayAddr` in `remote.json`).

It provisions `<handle>.mycelium.id` for a user who proves they hold their vault's master key (an **ed25519 handle claim** — no password, no account), then authorizes that user's FRP tunnel so it can bind **only** its own hostname. It never sees the master key, the operator password, or any vault data — only `{handle, publicKey, nonce, signature}`, and it verifies with the public key alone.

> Design: [`../docs/REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md`](../docs/REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md)

## Pieces
- **`src/server.js`** — the control-plane API: `GET /v1/challenge`, `POST /v1/provision`, `GET /v1/handle/:h`, `POST /v1/release`.
- **`src/registry.js`** — the handle registry (sqlite): `handle → {publicKey, frpsToken, acmeSubdomain}`. Source of truth for both provisioning (writes) and the relay auth-hook (reads).
- **`src/nonce.js`** — single-use, short-TTL challenge nonces (replay protection).
- **`src/dns.js`** — apex DNS automation (2 records/handle: A→relay, `_acme-challenge`→acme-dns). Providers: `mock` / `cloudflare` (DNS-only) / `desec`.
- **`src/acmedns.js`** — registers a per-handle account with the self-hosted acme-dns server.
- **`src/relay-hook.js`** — the FRP `NewProxy` auth-hook (per-tenant hostname binding). *(added in the relay-hook phase)*

## Run (dev, mocked side-effects)
```sh
MYC_DNS_PROVIDER=mock MYC_ACME_DNS_MOCK=1 \
MYC_RELAY_ADDR=relay.mycelium.id:7000 MYC_ACME_DNS=https://acme-dns.mycelium.id \
PORT=8790 npm start
```

## Infra it talks to (self-host)
- A **relay VPS** running `frps` (vhostHTTPS, SNI passthrough) — pointed at this control-plane's `NewProxy` hook. Host with free L3/4 DDoS scrubbing (Hetzner/OVH).
- A **self-hosted acme-dns** (`disable_registration=true`) — only this control-plane registers.
- **Apex DNS** for the zone (deSEC / Cloudflare DNS-only) with an API token.

See the design doc §6/§9 and the deploy notes for the full self-host runbook.
