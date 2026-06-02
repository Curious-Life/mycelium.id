# Remote Connect — Automatic "Get your address" provisioning (Design)

**One button in the app → a working public MCP URL. No terminal, no `cloudflared` install, no hostname typing.**

> Date: 2026-06-02 · Status: **DESIGN (sweep-first, pre-implementation)** · Builds on [REMOTE-CONNECT-DESIGN-2026-06-02.md](REMOTE-CONNECT-DESIGN-2026-06-02.md) (Phases 1–2 shipped in PRs #45/#46). Supersedes the **manual** Phase-3a (`scripts/tunnel.sh`) as the *user-facing* path — that stays as a dev/fallback tool.
> Sweep: 4 Explore agents (Tauri sidecar, Cloudflare tunnel-token API, relay alternatives, existing seam + identity) + backbone code read directly. Verification table at the end.

---

## 0. Headline

The provisioning step has exactly two viable shapes, surfaced as **one "Get your address" step** with two tabs:

- **Path A — `you.mycelium.id` (managed; the truly-easy default).** The app signs a handle-claim with its **ed25519 identity** (`identity.js`, derived from the master key) and calls a small **mycelium control-plane**, which provisions a **Cloudflare remotely-managed tunnel** (free, token-based) + a `<handle>.mycelium.id` DNS route, and returns a connector **token**. The app's bundled `cloudflared` runs with that token. Zero domain, zero CF account, **one click**.
- **Path B — your own domain (advanced; max sovereignty; ships first).** The app's bundled `cloudflared` runs `tunnel login` (a browser pop to *the user's* Cloudflare), auto-creates a named tunnel + routes `mycelium.<userdomain>`. **No mycelium backend** — fully client-side.

Both end the same way: `cloudflared` (a Tauri-managed sidecar) forwards `https://<host>` → `127.0.0.1:4711` (the Phase-1/2 OAuth server); the app shows the URL + a QR; Claude connects to `https://<host>/mcp`.

**The hard truth (unchanged):** a NAT'd Mac cannot be reached without *someone's* tunnel. "No domain + one click" therefore **requires** us to run the control-plane (Path A). There is no client-only way to achieve it.

---

## 1. Goal & non-goals

**Goal.** Replace the manual tunnel/hostname steps with in-app automation: `Settings → Connect → Get your address → [Use mycelium.id | Use my own domain]` → click → URL appears → paste into Claude. The bundled `cloudflared` + the existing operator-password gate (Phase 1) do the rest.

**Non-goals (this design).** End-to-end TLS (CF terminates it — documented trade-off; self-hosted FRP relay is the deferred sovereignty path). >1000 concurrent managed users (CF account-shard later). A full mycelium account system (we use ed25519-signed claims, not passwords/OAuth, for handle provisioning).

---

## 2. Revision history
- **v1 (this doc):** the automatic two-path flow. Pivots vs. the manual Phase-3a baseline:
  - **Relay = Cloudflare remotely-managed tunnels + per-user token.** (Sweep 3 disqualified Tailscale Funnel — no programmatic provisioning, no custom domain; ngrok too costly at scale. FRP/rathole deferred as the E2E-TLS option.)
  - **Managed auth = ed25519-signed handle claim, not a password account.** (Sweep 4: `identity.js sign()` proves key ownership; no account system exists or is needed.)
  - **`cloudflared` is spawned by Rust (Tauri), not Node** — to inherit the Phase-2 clean-teardown lifecycle (Node-spawned grandchildren orphan on the app's SIGKILL).

---

## 3. Sweep findings (consolidated, cited)

**Cloudflare (Sweep 2 — official docs):** remotely-managed tunnel via `POST /accounts/{id}/cfd_tunnel` (`config_src:"cloudflare"`) → connector token; `cloudflared tunnel run --token <token>` (no login) — [tunnel-tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/), [create-remote-tunnel-api](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/). Ingress via the tunnel "configurations" PUT; DNS CNAME `<handle>.mycelium.id → <uuid>.cfargotunnel.com` via `POST /zones/{id}/dns_records`. **Limit: 1000 tunnels + 1000 routes / account; free.** TLS terminated at CF edge (CF sees plaintext to origin) — [origin-parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).

**Alternatives (Sweep 3):** CF = best (no-ops, token-provisioned, free tier, SSE). Tailscale Funnel ✗ (no API provisioning, `*.ts.net` only). ngrok ✓ but ~$5k+/mo @1000. FRP/rathole = E2E-TLS but you operate servers — deferred.

**Tauri sidecar (Sweep 1):** no `externalBin`/`tauri-plugin-shell` today (`tauri.conf.json`, `Cargo.toml`). Convention: download `cloudflared` per-arch at build into `src-tauri/binaries/cloudflared-<target-triple>`, list in `bundle.externalBin`, launch via `tauri-plugin-shell` `Command::sidecar` (capability `shell:allow-execute`) or `std::process::Command` on the resolved path. **Live Tauri-v2 docs 404'd for the agent → verify exact API at build.**

**Existing seam (Sweep 4 — confirmed on `feat/remote-connect-phase2`):** `remote.json` = `{publicBaseUrl, remoteEnabled, operatorEmail}`; `config.js` (`readRemoteConfig/writeRemoteConfig/resolveAuthSecret/setOperatorPassword/operatorUserExists`); `router.js` (`/status,/password,/config,/local-config`, loopback-guarded); `auth.js` baseURL ← `readRemoteConfig().publicBaseUrl`, `trustedOrigins:[baseURL,claude.ai,claude.com]`; `main.rs remote_enabled()` + conditional `--http` spawn; `identity.js` ed25519 from master key with `sign()`. **No central registry/account — must build for Path A.**

---

## 4. Architecture

```
                       ┌─────────────────────── the app (Tauri) ───────────────────────┐
 user clicks           │  Settings → Connect → "Get your address"                       │
 "Use mycelium.id" ───▶│   A) sign handle-claim (identity.sign) ─┐                       │
 or "Use my domain" ─┐ │   B) cloudflared tunnel login (user CF) │                       │
                     │ │                                          ▼                       │
                     │ │   writes remote.json {remoteMode, publicBaseUrl} + token→Keychain │
                     │ │   main.rs spawns:  ① node --http :4711   ② cloudflared (sidecar)  │
                     │ └────────────────────────────────────────────────────────────────┘
   ┌─────────────────┘                                   │ token              │ forwards
   ▼                                                      ▼                    ▼
 mycelium control-plane (Path A only)            Cloudflare edge  ───────▶  127.0.0.1:4711
 provision.mycelium.id:                          https://<handle>.mycelium.id   (OAuth/MCP)
  verify ed25519 sig → reserve handle →                   ▲
  CF API: create tunnel + token + DNS  ──────────────────┘  Claude adds  …/mcp
```

`remote.json` gains **`remoteMode: 'off' | 'own-domain' | 'managed'`** (alongside the Phase-1 keys). `main.rs` reads it and, when not `off`, spawns **both** `--http` and `cloudflared` into the existing managed-child set. The cloudflared **token** is a credential → **Keychain** (Rust reads it via the `security` CLI, mirroring `key-source.js`); `remote.json` stays non-secret.

**Control-plane (Path A, the new service — lands in `mycelium-managed`):**
- `POST /provision { handle, publicKey, nonce, signature }` → verify `signature` over `handle|nonce` against `publicKey` (ed25519) → reserve `handle` (unique, first-claim-wins, keyed by publicKey) → CF API (create tunnel + ingress→`http://localhost:4711` + DNS CNAME) → `{ token, hostname: "<handle>.mycelium.id" }`.
- `GET /handle/:h/available`. Storage: a `handle → publicKey` registry (squat-prevention). Secrets: the CF API token (server-side only). Runs on the CF account holding `*.mycelium.id`.

---

## 5. Threat model & sovereignty

| Surface | Risk | Mitigation |
|---|---|---|
| Tunnel TLS termination | **CF sees tool traffic in transit** (both paths) | **Disclose in the UI**: storage stays encrypted+local; transport transits CF (as does Claude itself). E2E-TLS = the deferred self-hosted-FRP path. |
| Connector token leak | token lets an attacker run *a* connector for that tunnel (not decrypt the vault) | Keychain (not plaintext); rotateable (re-provision); vault key stays Keychain-only and never leaves. |
| Handle squatting (Path A) | someone claims `you.mycelium.id` | first-claim-wins bound to the box's **publicKey**; re-claim requires the same key (signature). |
| Control-plane abuse | spam tunnel creation | rate-limit per publicKey/IP; the 1000/account ceiling is a natural cap; require a signed claim (no anonymous create). |
| Operator-password gate | the only authz on `/mcp` | unchanged from Phase 1 (≥12 chars); the tunnel just makes it reachable. |
| `--http`/cloudflared bind | LAN exposure | `--http` stays `127.0.0.1`; only `cloudflared` egresses (outbound connection to CF — no inbound port opened). |

**Net sovereignty statement (for the UI):** *Your data stays encrypted on your Mac. With remote access on, the AI you connect (and the tunnel that carries it) see the tool results they request. For "nothing leaves," use a local model.*

---

## 6. Module shape

### Phase 3b — Own-domain, automated, client-only · ~260 LOC + bundled binary — **ships first**
- `src-tauri/` : `tauri.conf.json` `bundle.externalBin: ["binaries/cloudflared"]`; `build.rs` (or a `scripts/fetch-cloudflared.sh`) downloads `cloudflared` per target-triple (~40 LOC). `main.rs` (+~60): when `remoteMode != 'off'`, resolve the sidecar path + spawn `cloudflared tunnel run --token <token-from-Keychain>` into the child set; read the token via `Command::new("security")…`. Add `#[tauri::command] connect_own_domain()` that drives `cloudflared tunnel login` + `tunnel create` + `tunnel route dns` + writes `remote.json` + stores token.
- `src/remote/config.js` (+~15): `remoteMode` key in read/write.
- `src/remote/router.js` (+~30): `POST /provision/own-domain` (kick the Tauri command via a status file the app watches, *or* expose the command result) — **decision below**.
- `portal-app/.../ConnectSection.svelte` (+~120): the two-tab "Get your address" UI (own-domain tab live; managed tab "coming soon"), status, URL, QR (`qrcode` lib), Disconnect.

### Phase 5 — Managed `you.mycelium.id` · control-plane service + ~140 LOC client
- `mycelium-managed/` (new repo/service): `POST /provision`, `GET /handle/:h/available`, the CF-API client, the handle registry. ~300–500 LOC + deploy.
- App: `#[tauri::command] connect_managed(handle)` → `identity.sign` the claim → POST → store token → spawn. `src/remote/identity-claim.js` (~50) builds/signs the claim. UI managed tab goes live.

### Phase 5.x — scale/sovereignty (deferred)
- CF account-sharding > 1000 users; optional self-hosted FRP relay for E2E-TLS.

---

## 7. Edge cases — explicit decisions
- **Who spawns `cloudflared`?** Rust (Tauri), into the existing `Server(Mutex<Vec<Child>>)` → dies with the app. (Node-spawned would orphan on SIGKILL.)
- **Token storage** → Keychain (credential). Rust reads via `security` CLI. *Not* `remote.json` (which stays non-secret, plaintext).
- **App ⇄ Tauri-command bridge** → `portal-app` has **no `@tauri-apps/api`** (Phase-2 finding). Decision: the Settings UI writes intent to `remote.json` via the existing `/api/v1/remote/config` route; **Rust watches/polls `remote.json` on a timer** and reconciles (spawn/stop `cloudflared` + `--http`) — same "config-reconcile, not IPC" pivot as Phase 2. (Avoids adding the Tauri IPC bridge to the webview.) For `cloudflared tunnel login` (needs a foreground browser pop) the reconcile loop runs it when `remoteMode` flips to `own-domain` without a token yet.
- **Quick vs named tunnel** → **named** (stable hostname + SSE). Quick (`trycloudflare.com`) only as a throwaway "try it now" if ever needed.
- **URL stability** → both paths yield a stable hostname → no connector re-add on restart (unlike a quick tunnel).
- **Disconnect** → set `remoteMode:'off'` → reconcile stops `cloudflared` + `--http`; managed: optionally call control-plane to tear down the tunnel.
- **Sidecar API uncertainty** → spike `Command::sidecar` vs resolved-path `std::process::Command` against live Tauri-v2 docs as step 0 of Phase 3b.

---

## 8. Test strategy
- **CI-able (in-process):** `verify:remote-config` already covers config/secret/password. Add `verify:remote-mode` — `remoteMode` round-trips; reconcile *decision* logic (given a `remote.json`, decide spawn/stop) unit-tested as a pure JS function extracted from the Rust reconcile (mirror it in node for testability). Control-plane: a `verify:provision` against a **mocked CF API** (assert: signature verified, handle reserved, CF calls shaped right, token returned) — no real CF.
- **Mac-only (cargo):** `cargo build`; manual: toggle own-domain → app runs `cloudflared` → `:4711` reachable via the hostname.
- **Manual smoke (`docs/SMOKE-TESTS.md` extension):** real CF (own domain) → real phone, both paths. Real control-plane provision once deployed.
- **Cannot CI:** real tunnel, real CF account, real phone, real `cloudflared login` browser flow.

---

## 9. Implementation order (each shippable)
1. **3b-0 spike:** bundle `cloudflared` (one arch) + launch it from Tauri; confirm the sidecar API. *Smoke:* app spawns `cloudflared --version` via the bundled binary.
2. **3b-1:** `remoteMode` in config + the Rust reconcile (spawn `--http`+`cloudflared` from `remote.json`). *Smoke:* hand-write `remote.json` with a token → app brings the tunnel up.
3. **3b-2:** the `connect_own_domain` flow (login+create+route) + the two-tab UI (own-domain live). *Smoke:* click "use my domain" → URL appears → Claude connects → phone.
4. **5-1:** control-plane (`mycelium-managed`) + `connect_managed`. *Smoke:* click "use mycelium.id" → `you.mycelium.id` live → phone.
5. **5.x:** sharding / FRP sovereignty path.

## 10. Decision criteria to proceed
- 3b-0 → 3b-1: the bundled `cloudflared` launches + connects with a token on a clean machine (no system install).
- 3b → 5: a non-technical user completes own-domain connect with **zero terminal**; then build the managed service.
- 5 done: a user with **no domain** clicks once and reaches their vault from a phone via `you.mycelium.id`.

## 11. Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| Tauri sidecar API differs from inference | Med | Med | 3b-0 spike against live docs before building on it |
| 1000-tunnel/account ceiling | Low (V1) | Med | shard CF accounts; monitor count; documented |
| CF sees tool traffic (sovereignty) | High | Med | disclosed in UI; FRP E2E path deferred; local-model alternative |
| `cloudflared login` UX (browser pop from a sidecar) | Med | Med | reconcile loop runs it; clear in-app instructions; fallback to `tunnel.sh` |
| Control-plane is new infra to operate | Med | High | start tiny (one endpoint, CF API, a KV registry); Path B ships without it |
| Token in Keychain read from Rust | Low | Low | `security` CLI (proven pattern); fallback file (0600) if needed |

## 12. Open questions resolved during sweep
- *Is "no domain, one click" possible client-only?* **No** — needs the control-plane (NAT reality). Path B is the client-only best.
- *Relay tech?* Cloudflare remotely-managed tunnels (token). Not Tailscale (no API/custom-domain). FRP = deferred E2E option.
- *Managed auth without accounts?* ed25519-signed handle claim (`identity.sign`).
- *Who spawns cloudflared?* Rust (clean teardown), not Node.
- *Tauri IPC to the webview?* Avoid — reuse the config-reconcile pattern (no `@tauri-apps/api`).

## 13. Open questions deferred
- Exact Tauri-v2 sidecar API (verify in 3b-0).
- Control-plane hosting + the CF-account-sharding policy (>1000).
- Handle disputes/transfer policy; reserved handles.
- Self-hosted FRP E2E-TLS relay (full sovereignty tier).
- `cloudflared` auto-update / version pinning in the bundle.

## 14. Verification table
| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | `remote.json` = publicBaseUrl/remoteEnabled/operatorEmail; config fns shape | `src/remote/config.js` (read; Sweep 4) |
| 2 | `auth.js` baseURL ← `readRemoteConfig().publicBaseUrl`; trustedOrigins incl. claude.ai/.com | `src/auth.js` (read/edited) |
| 3 | `main.rs` spawns `--http` on `remote_enabled()`; child set killed on quit | `src-tauri/src/main.rs` (read/edited) |
| 4 | `identity.js` ed25519 from master key + `sign()`/`verify()` | `src/identity/identity.js:50-78` (read) |
| 5 | No central registry/account exists | grep src/ (Sweep 4 + prior sweeps) |
| 6 | No `externalBin`/`tauri-plugin-shell` today | `src-tauri/tauri.conf.json`, `Cargo.toml` (read) |
| 7 | CF remotely-managed tunnel + connector token (`--token`, no login) | CF docs (Sweep 2, cited) — **EXTERNAL** |
| 8 | CF 1000-tunnel/account limit; free | CF account-limits docs (Sweep 2) — **EXTERNAL** |
| 9 | CF terminates TLS at edge (sees plaintext) | CF origin-parameters docs (Sweep 2) — **EXTERNAL** |
| 10 | Tauri externalBin/target-triple/sidecar launch | Tauri docs (Sweep 1) — **EXTERNAL, UNCONFIRMED → spike 3b-0** |
