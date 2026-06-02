# Remote Connect — Design (V1)

**Let a non-technical user, after install + data upload, securely connect Claude (mobile/web) — or any MCP client — to their self-hosted local vault, and test it from their phone.**

> Date: 2026-06-02 · Status: **DESIGN (sweep-first, pre-implementation)** · Companions: [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md), [`MCP-CONNECT-AND-TEST.md`](MCP-CONNECT-AND-TEST.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md) §11.
> Produced via `/sweep-first-design`: 8 Explore sweeps (7 code + 1 external) + backbone files read directly. Verification table at the end.

---

## 0. Headline

The **protocol is already done and proven** — `src/server-http.js` + `src/auth.js` implement exactly the OAuth-2.1 + DCR + PKCE-S256 + RFC 9728 remote-MCP surface Claude's custom connectors require (`verify:oauth` GO). What's missing is the **operational shell around it**: nothing persists the base URL / auth secret, setup never asks for the operator password, the Tauri app never launches `--http`, and there is **no tunnel and no `<handle>.mycelium.id` routing** (both doc-only).

Two hard truths the sweep surfaced:
1. **No tunnel option is truly zero-config.** A stable public HTTPS URL with SSE needs *either* a Cloudflare **account tunnel** (CF account + domain) *or* a **managed relay we run**. Quick tunnels are out (no SSE → CF 524). So genuine "non-technical one-click" requires central infra (deferred to V2); the **phone test now** uses a named tunnel the operator provisions once.
2. **Connecting to cloud Claude means Claude sees what it pulls.** Storage stays encrypted + local; tool *results* travel to Anthropic. True "nothing leaves" = a local model. This is the user-facing privacy decision, surfaced in setup — not hidden.

This design gets to a **working phone test by end of Phase 4** (Phases 1-2 backend+app, Phase 3a a manual named tunnel), then a one-click sidecar (3b), with managed `<handle>.mycelium.id` as the explicit V2 finish (Phase 5).

---

## 1. Goal & non-goals

**Goal.** After `install → upload data → set a password → enable remote access`, the user adds one URL in Claude, signs in once, and calls their 31 vault tools from their phone — over TLS, gated by their password, with the vault key never leaving the Mac.

**Non-goals (this design).**
- Managed `<handle>.mycelium.id` central routing (Phase 5 / V2 — no infra exists).
- Multi-device / multi-user.
- A local-model "nothing leaves" client (separate track; noted as the sovereignty alternative).
- Replacing the proven OAuth mechanics — we *wrap* them, not rewrite them.

---

## 2. Revision history

- **v1 (the ask):** "one-click remote exposure + `<handle>.mycelium.id` + QR, all in V1."
- **v2 (after sweep — this doc):** pivoted on three findings:
  - **Pivot A — `<handle>.mycelium.id` deferred.** Sweep 4: the URL is a hardcoded string (`documents.js:531`); there is **no DNS/registry/relay** ("DOES NOT EXIST"). Per-user public routing is central infra = V2. V1 uses the operator's own named-tunnel hostname.
  - **Pivot B — secrets to Keychain, not plaintext JSON.** Sweep 5 proposed `remote.json` holding the auth secret in plaintext. `MYCELIUM_AUTH_SECRET` is a token-**signing** secret; leaking it = forgeable tokens. Pivot: secrets (auth secret, operator password) live in the **Keychain** (existing `keystore.js` pattern); `remote.json` holds only non-secret config (publicBaseUrl, remoteEnabled, operatorEmail).
  - **Pivot C — phased tunnel.** No one-click tunnel exists. Phase 3a = manual named tunnel (unblocks the phone test); 3b = bundled `cloudflared` sidecar; managed relay = Phase 5.
- **v3 (during Phase 1 build — supersedes part of Pivot B):** the OAuth **signing secret** lives in **`auth.db`** (a `mycelium_app_secret` table), not the Keychain — it sits *with* the session tokens it already signs (no added blast radius; the vault master key stays Keychain-only) and is **CI-testable + portable** (the Keychain is neither). The **operator password** is stored by **better-auth** (hashed into `auth.db`) via `setOperatorPassword()`; we persist only the non-secret `operatorEmail` in `remote.json`. Built + green: `verify:remote-config` GO (RC1-6).

---

## 3. Sweep findings — built vs missing (file:line)

**Built + proven (reuse, don't rewrite):**
- OAuth 2.1 + DCR + PKCE + RFC 9728, Bearer-guarded `/mcp`, stateful sessions, `/ingest/*`. `server-http.js:46-269`, `auth.js:47-65`; `verify:oauth` GO.
- Per-OS durable data dir + per-item env overrides. `paths.js:32-56`.
- Localhost-only, pre-boot account ceremony (setup/restore/recovery). `account/router.js:26-107`.
- Keychain read/write discipline for key material. `account/keystore.js` (writeKeychain/readUserMaster/save…).
- Identity primitive (handle + ed25519, validated 2-32 chars). `identity.js:40-78`.
- Tauri child-process lifecycle (spawn on setup, kill on Destroyed). `main.rs:65-115,146-156`.

**Missing (what we build):**
- Base URL / auth secret / operator password are **env-only, never persisted/generated**. `auth.js:30-32`, `auth.js:81-97` (all "DOES NOT EXIST" for persistence).
- No redirect-URI allowlist, no CORS; only `trustedOrigins:[baseURL]`. `auth.js:53,55-63`.
- Setup never sets the operator password/email — only the recovery key. `account/router.js:42-56`.
- Tauri launches **only** `server-rest.js` (:8787); **never `--http`**; **zero `#[tauri::command]`**; **no sidecar/externalBin**. `main.rs:65-69` + (absence verified).
- No tunnel script/automation; `tunnel.sh` is referenced but absent. `V1-BUILD-SPEC.md:187,880-911` (doc-only).
- No central `<handle>.mycelium.id` routing. `documents.js:531` (hardcoded string).

**External (Sweep 7, cited):** Claude supports user remote-MCP connectors on web/desktop/**mobile** (mobile *uses* connectors added on web/desktop; in-mobile add is beta). Requires: reachable from Anthropic IPs `160.79.104.0/21`, **HTTPS, no localhost**, OAuth 2.1 + PKCE-S256, DCR (RFC 7591), RFC 9728 metadata. Redirect URIs must accept `https://claude.ai/api/mcp/auth_callback` + `https://claude.com/api/mcp/auth_callback`. Named tunnel required for SSE.

---

## 4. Architecture (end-to-end)

```
 SETUP (localhost, pre/post-boot)                 RUNTIME                              CLOUD
 ┌───────────────────────────┐    ┌──────────────────────────────────────┐   ┌──────────────────┐
 │ /setup  → recovery key     │    │ Tauri app                            │   │  Claude web/phone│
 │ /security/password → KC    │    │  ├─ node server-rest.js  :8787 (UI)  │   │  custom connector│
 │ remote toggle → remote.json│    │  ├─ node index.js --http :4711 (MCP) │◀──┤  OAuth 2.1+PKCE  │
 └───────────────────────────┘    │  └─ cloudflared (named) ─────────────┼──▶│  Bearer /mcp     │
        writes                     │       TLS, stable https://host       │   └──────────────────┘
   Keychain: USER_MASTER,          └──────────────────────────────────────┘
   AUTH_SECRET, OPERATOR_PW              vault key stays in Keychain; never on the wire
```

- The **vault key** unlocks the DB locally (Keychain). It never enters the auth DB, env on the wire, or the tunnel.
- The **operator password** is the OAuth gate (the only thing standing between a reachable URL and your tools).
- The **tunnel** terminates TLS and forwards to `127.0.0.1:4711`; the `--http` server stays bound to loopback (defence in depth — only the tunnel can reach it).
- `MYCELIUM_BASE_URL` = the tunnel's stable hostname; everything (metadata, resource, trustedOrigins) derives from it.

---

## 5. Threat model

| Surface | Adversary can… | Mitigation |
|---|---|---|
| Public `/.well-known/*` + DCR | enumerate metadata, register a client | harmless without a token; DCR is standard for public MCP |
| `/login` (the gate) | brute-force the operator password | **enforce strong password (≥12 ch)**; add basic rate-limit/backoff on `/login`; TLS-only |
| `/mcp` with stolen Bearer | call tools as the user | short token lifetime; **disconnect/revoke** control; tokens signed by the persisted secret (rotating it = revoke-all) |
| Tunnel URL discovery | reach the server | password still required; optionally **allowlist Anthropic IPs `160.79.104.0/21`** (opt-in — breaks other clients/devices) |
| Tool results in transit/at cloud | read pulled content | inherent to cloud AI; **surfaced to the user**; local-model alternative for full sovereignty |
| `--http` bound to 0.0.0.0 by mistake | LAN reach | **bind 127.0.0.1 only**; tunnel is the sole ingress |
| Secrets at rest | read auth secret/password | **Keychain**, not plaintext JSON (Pivot B); vault key already Keychain-only |

**Invariant preserved:** the auth DB stores no vault plaintext (`auth.js:10-13`); the vault's two hex keys never touch the OAuth path. New public attack surface is the password-gated `/mcp` + `/login`; accepted with the mitigations above.

---

## 6. Module shape (by phase)

### Phase 1 — Persistence + password seam (backend only) · ~280 LOC — **BUILT ✓ (`verify:remote-config` GO)**
- `src/paths.js` (+3): `remoteConfigPath()` → `<dataDir>/remote.json`. ✓
- `src/remote/config.js` (new, ~140): `readRemoteConfig()` (env > remote.json > defaults), `writeRemoteConfig()` (atomic, non-secret keys only), `resolveAuthSecret()` (env > `auth.db` `mycelium_app_secret`, generate-once-and-persist), `setOperatorPassword()` (≥12 ch → better-auth hashes into `auth.db`), `operatorUserExists()`. ✓ **(v3: secret in `auth.db`, NOT Keychain — see revision history.)**
- `src/auth.js` (mod): `baseURL` + `secret` now sourced via `config.js` (env still wins); `trustedOrigins` += `claude.ai`/`claude.com`. ✓
- `src/remote/router.js` (new, ~55) mounted at `/api/v1/remote` (loopback-only) in `server-rest.js`: `GET /status`, `POST /password`, `POST /config`. ✓
- `scripts/verify-remote-config.mjs` (new, ~150) + `package.json` chain (before `verify:oauth`). RC1-6 GO. ✓
- *Deferred to Phase 2:* changing an existing password (better-auth update API; `setOperatorPassword` is first-set only).

### Phase 2 — Tauri launches `--http` + IPC + Settings UI · ~210 LOC
- `src-tauri/src/main.rs` (+~60 Rust): when `remoteEnabled`, spawn a 2nd child `node src/index.js --http` with env `{ MYCELIUM_PORT=4711, MYCELIUM_KEY_SOURCE, MYCELIUM_DATA_DIR, MYCELIUM_BASE_URL, MYCELIUM_AUTH_SECRET, MYCELIUM_USER_PASSWORD, MYCELIUM_USER_EMAIL }` (read from remote-config/Keychain via a tiny node `--print-remote-env` helper, or pass-through). Add `#[tauri::command] enable_remote / disable_remote / remote_status`. Manage in the existing `Server(Mutex<Vec<Child>>)`.
- Portal Settings (+~120 Svelte): a "Remote access" panel — set password, toggle, show status + public URL + a "Disconnect" button.
- `GET /api/v1/.../remote/status` (+~30 node).

### Phase 3 — Tunnel · 3a ~0 code (manual) / 3b ~150 LOC + bundled binary
- **3a (unblocks phone test):** operator runs a named `cloudflared` tunnel → a stable host; app reads `publicBaseUrl` from `remote.json`. A `scripts/tunnel.sh` helper (the one V1-SPEC §187 promised) wrapping `cloudflared tunnel create/route/run`.
- **3b (one-click):** bundle `cloudflared` via Tauri `bundle.externalBin` (target-triple-named binary) + `tauri_plugin_shell` `Command::sidecar("cloudflared")`; capability `shell:allow-execute`; on enable, launch the tunnel, capture the hostname, write `publicBaseUrl`, restart `--http` with the new base URL.

### Phase 4 — Connect Claude + phone smoke · docs only
- `docs/SMOKE-TESTS.md`: the manual end-to-end (named tunnel up → add connector in Claude web → OAuth sign-in → tools appear → use from phone → restart preserves it).

### Phase 5 — Managed `<handle>.mycelium.id` (deferred / V2)
- Central tunnel relay (FRP/Cloudflare-for-SaaS/custom) + wildcard `*.mycelium.id` DNS + handle registry/reservation. The zero-config non-technical path. Large; out of scope here.

---

## 7. Edge cases — explicit decisions

- **Quick vs named tunnel →** named (stable URL + SSE; quick lacks SSE → CF 524). `V1-SPEC:884`.
- **Where secrets live →** Keychain (Pivot B). `remote.json` = non-secret config only.
- **Base-URL change after connect →** breaks the connector (metadata/resource mismatch). Decision: URL must be **stable before first connect**; if it changes, the user re-adds the connector. The named tunnel keeps it stable across restarts.
- **Auth secret →** generate **once**, persist in Keychain; never regenerate on restart (would log everyone out). Regeneration is the deliberate "revoke all" action.
- **`trustedOrigins` + Claude callbacks →** proactively add `https://claude.ai` + `https://claude.com` to `trustedOrigins` alongside `baseURL` (cheap; removes a likely failure). Validate exact behavior in the Phase-4 smoke.
- **`--http` binds →** `127.0.0.1` only; the tunnel is the sole ingress. Never 0.0.0.0.
- **Two vault handles (REST :8787 + HTTP :4711) →** each `boot()`s its own better-sqlite3 connection (WAL). Accepted for single-user low concurrency; revisit if write-contention (SQLITE_BUSY) appears under load.
- **Mac asleep / app closed →** server + tunnel die; phone can't reach it. Decision: show clear "remote is live / offline" status; optionally offer "prevent sleep while remote enabled". Document it.
- **Password strength →** enforce ≥12 chars at the set-password route; it is the only authorize gate.
- **Handle length mismatch →** `identity.js` allows 2-32 (`identity.js:22`), `portal-compat.js` profile allows 3-30. Not load-bearing for remote-connect (handle deferred), but flag to reconcile.

---

## 8. Test strategy

**CI-verifiable (in-process, no network) — new `scripts/verify-remote-config.mjs`:**
- **RC1** `readRemoteConfig()` round-trips `remote.json` (write → read → equal); env overrides file.
- **RC2** `ensureAuthSecret()` generates a 64-hex secret once, persists it, returns the **same** value on a second call (stability across "restart").
- **RC3** spawn `node src/index.js --http` (verify-oauth pattern) sourcing the **persisted** base URL + secret (not env); `GET /.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` reflect `publicBaseUrl`, and `resource` = `<publicBaseUrl>/mcp`.
- **RC4** set-password route: ≥12-char accepted, `<12` rejected; the secret/password are **never** returned in any response body (assert redaction).
- **RC5** end-to-end OAuth dance over the persisted config (extend verify-oauth) → token → `tools/call` → GO.

**Mac-only (cargo) — not on this CI runner:** `cargo build` of the new Rust; manual launch confirming `enable_remote` spawns `--http` and `remote_status` reports the URL.

**Manual smoke — `docs/SMOKE-TESTS.md` (cannot CI: real tunnel + TLS + phone):**
1. Named tunnel up → `curl https://<host>/.well-known/oauth-protected-resource` from the phone's network returns metadata with the public URL.
2. Add custom connector in Claude (web) → OAuth sign-in (email + operator password) → 31 tools appear.
3. From the **phone**, ask Claude to call `getContext` → real briefing.
4. Restart the app → connector still works (secret + base URL persisted).
5. "Disconnect" → token rejected (401).

**Wiring (`package.json`):** add `"verify:remote-config": "node scripts/verify-remote-config.mjs"` and insert into the `verify` chain **before** `verify:oauth`.

---

## 9. Implementation order (each step independently shippable)

| # | Step | Ship gate / smoke |
|---|---|---|
| 1 | Phase 1 backend (paths + keystore + remote/config + password route) | `npm run verify:remote-config` GO; `MYCELIUM_BASE_URL=https://x start:http` → `/.well-known` reflects it; restart → same secret |
| 2 | Phase 2 Tauri `--http` spawn + IPC + Settings panel | `cargo build`; in-app toggle → `curl 127.0.0.1:4711/.well-known/...` OK; status shows URL |
| 3 | Phase 3a manual named tunnel + `scripts/tunnel.sh` | `https://<host>/.well-known/...` reachable from the phone |
| 4 | **Phase 4 connect Claude + phone smoke** | **phone calls `getContext` through the tunnel; restart preserves it** ← the goal |
| 5 | Phase 3b bundled `cloudflared` sidecar (one-click) | in-app "Enable remote access" brings up the tunnel + URL/QR with no terminal |
| 6 | Phase 5 managed `<handle>.mycelium.id` | deferred — separate design |

---

## 10. Decision criteria to proceed

- **P1 → P2:** `verify:remote-config` GO **and** a kill-and-respawn of the `--http` child reuses the same auth secret (no re-login).
- **P2 → P3:** in-app toggle reliably starts/stops `--http`; `remote_status` truthful.
- **P3 → P4:** the public HTTPS URL serves RFC 9728 metadata from an off-network device.
- **P4 done (success):** a real phone completes OAuth and calls ≥2 tools (`getContext`, `searchMindscape`) through the tunnel, and an app restart keeps the connector working without re-setup.
- **P4 → P3b:** only after the manual path works end-to-end (don't automate an unproven flow).

---

## 11. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `trustedOrigins`/redirect rejects Claude's callback | Med | High (blocks connect) | add claude.ai/claude.com to trustedOrigins; validate in P4 smoke before P3b |
| Non-technical user can't set up a CF account/domain | High | High (no zero-config) | P3a is operator-run for the test; **Phase 5 managed relay** is the real fix — set expectation |
| `cloudflared` sidecar bundling per-arch (x86_64/aarch64) | Med | Med | target-triple binaries; CI/build step to fetch both; document |
| Auth secret regenerated → silent logout | Low (after P1) | Med | generate-once + Keychain; regeneration only via explicit "revoke all" |
| Two vault handles contend (SQLITE_BUSY) | Low | Low | single-user; monitor; serialize if observed |
| Tool results exposed to cloud surprises user | Med | High (trust) | explicit setup disclosure + local-model alternative documented |
| Mac sleeps mid-session | High | Low (recoverable) | status UX + optional keep-awake |

---

## 12. Open questions resolved during sweep

- *Could we store the auth secret in `remote.json`?* No — signing secret; Keychain (Pivot B).
- *Does `<handle>.mycelium.id` already route?* No — hardcoded string, no infra (`documents.js:531`); deferred.
- *Can the Tauri app already launch `--http`?* No — only `server-rest.js`; must add spawn + IPC (`main.rs:65-69`).
- *Is a quick tunnel enough?* No — no SSE → CF 524 (`V1-SPEC:884`).
- *Where does persisted config live?* `<dataDir>/remote.json` (kcv.json precedent) + Keychain for secrets (`paths.js:45-56`).

## 13. Open questions deferred

- Exact better-auth behavior for Claude's callback Origin/redirect (validate in P4 smoke; may need trustedOrigins additions).
- Tailscale Funnel viability (SSE + the 443/8443/10000 public-port mapping) as a cloudflared alternative — spike if CF account friction is a blocker.
- Managed relay architecture for `<handle>.mycelium.id` (Phase 5 / V2 — own design).
- Token lifetime / rotation policy + a real revoke-all UI.
- Optional Anthropic-IP allowlist as a hardening toggle.

---

## 14. Verification table

| # | Load-bearing assumption | Verified at (read directly) |
|---|---|---|
| 1 | `baseURL` from env only, drives metadata/resource/trustedOrigins/validation | `auth.js:30-31,53,57`; `server-http.js:96-104` |
| 2 | No persisted remote config exists; data-dir paths are the home | `paths.js:39-56` (dataDir/under/dbPath/kcvPath/authDbPath) |
| 3 | `MYCELIUM_AUTH_SECRET` env-only, mandatory, nothing generates/persists it | `auth.js:32-38` |
| 4 | Operator account seeded from env only; no in-app password path | `auth.js:81-97`; `server-http.js:46-57` |
| 5 | DCR open, PKCE required, no redirect allowlist, no CORS | `auth.js:55-63` |
| 6 | Setup provisions only the recovery key; localhost-only; pre-boot | `account/router.js:26-56` |
| 7 | Keychain write/read pattern exists for key material (extendable) | `account/keystore.js` (imported set, `router.js:10-14,48-52`) |
| 8 | Tauri spawns only `server-rest.js`; child lifecycle pattern; no commands/sidecar | `main.rs:65-69,84-115,146-156` |
| 9 | `<handle>.mycelium.id` is a hardcoded string; no central routing | `documents.js:528-531` |
| 10 | Identity = local ed25519 + validated handle (process-local) | `identity.js:40-78` |
| 11 | Named tunnel mandatory (SSE); `tunnel.sh` absent | `V1-BUILD-SPEC.md:880-911` (+ repo grep: no script) |
| 12 | Claude supports remote-MCP connectors web/desktop/mobile; reqs = HTTPS+OAuth2.1+PKCE+DCR+RFC9728; Anthropic IPs `160.79.104.0/21`; claude.ai/claude.com callbacks | Sweep 7 (support.claude.com, modelcontextprotocol.io, claude.com/docs/connectors) |
| 13 | `verify-oauth.mjs` is the reusable harness (spawn `--http`, drive dance, ledger) | `verify-oauth.mjs:75-110` (read directly) |
