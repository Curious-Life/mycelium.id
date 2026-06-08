# Channel Daemon Reliability — Design (2026-06-08)

**Goal:** make Telegram/Discord channels work **out of the box in the packaged app**, reliably, for new users — not via a manual dev workaround. Today they are 100% non-functional in `Mycelium.app`.

**Status:** ✅ **BUILT + VERIFIED IN THE PACKAGED APP** (branch `feat/channels-reliable`). Design locked after sweep-first-design (5 parallel Explore sweeps + load-bearing code read directly); implemented + gated; proven in a freshly-built `Mycelium.app`.

## As-built verification (2026-06-08)

- `scripts/verify-channel-supervisor.mjs` — **18/18 GO**: supervisor enable-gating, keyless child env, adopt-vs-spawn, reload/stop; loopback `/internal/mcp` serves `reply` + rejects proxied (403).
- No regressions: `verify:{rest,mcp,secrets,channel-egress,channel-egress-e2e,channel-inbound,channel-agent,channel-settings,channel-access}` GO; `portal:check` 0 errors. `verify:mcp` confirms the injected-keys tool surface is unchanged (no stray `reply`).
- **Packaged-app smoke (the real proof):** rebuilt `Mycelium.app` → `Resources/app/packages/channel-daemon/` present; on launch the app's `server-rest.js` **auto-spawned** the daemon (`…/Mycelium.app/Contents/Resources/app/node packages/channel-daemon/index.js`, parent = the app's server-rest) on `:3010` `/healthz` with **zero manual processes**; `:8787/internal/mcp` served 32 tools incl `reply` and returned **403** for a proxied (`X-Forwarded-For`) request.
- Build hygiene: `build-app-bundle.sh` now strips xattrs before signing (fixes a `codesign` "resource fork … detritus" failure from npm `com.apple.provenance` xattrs) + a deps-completeness preflight (catches the `@better-auth/passkey` declared-but-uninstalled class).

---

## Root cause (verified)

The channel daemon (`packages/channel-daemon/`) is a **separate Node process** that polls Telegram, runs the agent turn, and owns the egress chokepoint. In the packaged app it **never runs**, for three independent reasons — each alone fatal:

1. **Not bundled.** `scripts/build-app-bundle.sh:93-103` stages `src/ migrations/ pipeline/ portal-app/build/ node_modules/` — **not** `packages/`. `Mycelium.app/Contents/Resources/app/packages/` does not exist (confirmed on disk).
2. **Never spawned.** The Rust shell (`src-tauri/src/main.rs:225-336`) spawns only `src/server-rest.js` (+ `--http`/caddy/frpc when remote). Nothing runs `packages/channel-daemon/index.js`. `CHANNEL_ENABLED` is a stored flag nobody reads to start polling (`src/portal-channels.js:58`, `src/internal-router.js:200`).
3. **No reply-capable MCP.** The agent turn must call the `reply` MCP tool, which is registered **only when `AGENT_URL` is set** (`src/mcp.js:130-138`). The packaged app's running server (`server-rest.js`, :8787) is booted **without** `AGENT_URL`, and there is no loopback MCP endpoint for the daemon's turn to reach. (The `--http` :4711 server is OAuth-gated and heavy.)

Secondary gaps found:
- **`@better-auth/passkey`** is declared (`package.json:150`) + lockfile-pinned but was **absent from `node_modules` and the built bundle** → the app's remote/OAuth `--http` mode crashes on boot. Independent of channels under this design, but a real latent bug → fold a **bundle deps-completeness check** into the fix.
- **Daemon reads config only at boot** (`packages/channel-daemon/index.js` → `applyChannelConfigToEnv`); a Settings change needs a daemon restart (no hot-reload).
- **No daemon running-state** in the Channels UI; copy says "next start" (ambiguous).
- **No verify gate** exercises the spawn/supervision path — every `verify-channel-*.mjs` boots the daemon in-process or via REST, none assert "the daemon actually starts when the app launches."

---

## Decision — architecture

**"Bundled, co-managed daemon + app-hosted loopback MCP."** The app (`server-rest.js`, always running, single vault holder) becomes the daemon's tool host over loopback; the daemon stays **keyless** (its existing design) and is **supervised** by the app exactly like the embed service.

Why this over the alternatives (sweep 3):
- **Daemon spawns its own stdio MCP child** (what the cloud backend does): the **ollama backend has no stdio path** (`agent/backends/ollama.js:76-85` — only `StreamableHTTPClientTransport`), and `mcpStdioEntry='src/index.js'` is a **relative path that breaks in the bundle** (`config.js:30`). Also spawns a full vault process per turn. ✗
- **`--http` :4711 OAuth MCP**: heavy (better-auth, passkey, bearer), double vault boot. ✗
- **App-hosted loopback MCP** (chosen): reuses `createMcpServer({tools, handlers})` over the **already-open vault** (`src/mcp.js:229` opens no db), no OAuth (loopback-trusted, same posture as the existing `/api/v1/*` + `internalRouter`), and **both** daemon backends work **unchanged** (they already do http-MCP via `cfg.mcpUrl`). ✓

### Components

1. **Bundle `packages/`** — `build-app-bundle.sh`: add `rsync -a "$REPO/packages/" "$STAGE/packages/"`. Daemon's only npm dep is `express` (already in the wholesale `node_modules` rsync, line 98); `@anthropic-ai/claude-agent-sdk` (cloud, lazy-loaded) must also be present. Add a **deps-completeness preflight**: fail the build if any `package.json` dependency is missing from `node_modules` (catches the passkey-class bug).

2. **`AGENT_URL` on the app** — in `server-rest.js`, set `process.env.AGENT_URL ||= 'http://127.0.0.1:3010'` **before `boot()`** (line 242) so `reply` is wired into `tools/handlers`. The reply tool **soft-fails `no-active-turn`** when there is no channel turn (`src/mcp.js:133`), so wiring it always is inert and safe. The daemon's port (3010) is fixed (`config.js:18`).

3. **Loopback MCP endpoint** — new `src/mcp-loopback.js` mounting `POST/GET/DELETE /internal/mcp` in `buildVaultSubApp` (has `tools, handlers`), using `createMcpServer({tools, handlers})` + `StreamableHTTPServerTransport` with a session map. Lifted from `server-http.js:240-372` **minus** auth (loopback-only via `isTrustedLoopback`, reject otherwise — fail closed) and **minus** per-session `boot()` (reuse the open vault's `tools/handlers`). Bind is inherited (server already 127.0.0.1).

4. **Channel-daemon supervisor** — new `src/channels/supervisor.js`, mirroring `src/embed/supervisor.js` (adopt-or-spawn, capped backoff restart, health surface, `nudge()`, `stop()`). Started in the `!injectedKeys` block (`server-rest.js:263-286`) **only when `CHANNEL_ENABLED='1'` AND a token is present**. Spawns `node packages/channel-daemon/index.js` with env: `MYCELIUM_API_URL=http://127.0.0.1:<restPort>`, `MYCELIUM_MCP_URL=http://127.0.0.1:<restPort>/internal/mcp`, `CHANNEL_MCP_MODE=http` (no bearer — loopback), **no vault keys** (keyless allowlist like `supervisor.js:100-105`). `stop()` added to `closeHandle` (line 278). Reaped via process group on app exit (`main.rs:110-132` — grandchildren inherit pgid).

5. **Activation without app restart** — `portalChannelsRouter` gets a `channelSup` ref; `PUT /channels` calls `channelSup.reload()` after saving: start if now enabled+token, stop if disabled, restart to pick up token/model changes. (Mirror of the `drainer.nudge()` pattern, `server-rest.js:269`.)

6. **UI + onboarding honesty** — `GET /channels` returns `daemon: { running, status, detail }` from `channelSup.getHealth()`. `ChannelsSection.svelte` shows the live state and, when no AI is configured, "Two-way replies need an assistant — pull a local model (Hardware) or add a cloud key; without one the bot captures messages but won't reply." Onboarding `ConnectionsChecklist.svelte` gains the same note. (The app already auto-manages a local Ollama daemon — `server-rest.js:146`, `createOllamaDaemon` — so a sovereign local model is reachable in-app.)

7. **New verify gate** — `scripts/verify-channel-supervisor.mjs`: boot a vault with `CHANNEL_ENABLED=1` + a fake token, assert the supervisor spawns the daemon, the daemon connects to `/internal/mcp` and sees `reply` in its tool list, then assert disabling stops it. Closes the supervision-path gap. Add to the `verify` chain + `verify:channel-supervisor` script.

8. **Fix `@better-auth/passkey`** — ensure it installs (it's declared + locked); the deps-completeness preflight (component 1) makes a future omission fail the build instead of shipping a boot-crash.

---

## Security / invariants preserved (CLAUDE.md)

- **Egress chokepoint (#11) unchanged.** The daemon's loopback chokepoint (`packages/channel-daemon/egress/send-handler.js:52-161`, 7 gates) and the `reply` tool's POST to `AGENT_URL/<platform>/send` (`src/tools/reply.js`) are untouched. The new MCP endpoint only **lists/calls** tools; egress still flows agent→`reply`→chokepoint→Telegram.
- **Loopback-only / fail-closed (#3).** `/internal/mcp` rejects non-loopback (`isTrustedLoopback`, `src/http/loopback.js`) — same boundary as measurement/claims/account. No OAuth weakening: the OAuth `--http` `/mcp` is unchanged; this is a *separate* loopback path that never binds publicly.
- **Keyless daemon / master-key discipline (#4).** The daemon env carries **no vault keys** (keyless allowlist); it reaches plaintext only by calling the app's loopback tools, exactly as the in-app chat does (`server-rest.js:156`).
- **No plaintext in logs (#1).** Daemon logs are metadata-only (`preview()` = first 12 chars + length; audit = sha256 + length) — verified `send-handler.js`, `inbound.js`. Supervisor logs process lifecycle only.
- **Validate every operation (#10).** Supervisor surfaces actionable health; no fire-and-forget spawn (that was the original embed bug this pattern fixed).

New attack surface: a loopback MCP endpoint exposing the full tool surface without OAuth. Accepted — identical trust to the existing loopback `/api/v1/*` tool router (`src/api.js`) and `internalRouter`; both already serve the vault to any loopback caller in single-user V1.

---

## Module shape (LOC budget ±20%)

| File | Change | ~LOC |
|---|---|---|
| `scripts/build-app-bundle.sh` | rsync `packages/` + deps-completeness check | +15 |
| `src/mcp-loopback.js` (new) | loopback Streamable-HTTP MCP mount | ~70 |
| `src/channels/supervisor.js` (new) | adopt-or-spawn + restart + health (mirror embed) | ~150 |
| `src/server-rest.js` | set AGENT_URL; mount `/internal/mcp`; start supervisor; stop in closeHandle; pass `channelSup` to portalChannels | +25 |
| `src/portal-channels.js` | `channelSup.reload()` on PUT; `daemon` in GET | +15 |
| `packages/channel-daemon/index.js` | preflight checks `/internal/mcp` (not `/api/v1/tools`) when mode=http | +6 |
| `portal-app/.../ChannelsSection.svelte` | daemon running-state + AI-required note | +25 |
| `portal-app/.../ConnectionsChecklist.svelte` | AI-required note on Telegram step | +6 |
| `scripts/verify-channel-supervisor.mjs` (new) | supervised-spawn gate | ~120 |
| `package.json` | `verify:channel-supervisor` + add to chain | +2 |

---

## Test strategy

- `scripts/verify-channel-supervisor.mjs` (new) — supervisor spawns on enable, daemon reaches `/internal/mcp` + sees `reply`, stops on disable. **Exercises the previously-untested spawn path.**
- Existing `verify:channel-*` must stay green (egress, inbound, agent-e2e, settings, access).
- `verify:rest` + `verify:portal*` green (server-rest changes).
- `portal:check` 0 errors (Svelte changes).
- **Packaged-app smoke** (manual, per BUILD-MAC): fresh `.app` → Settings → Channels → enable + token → send Telegram message → reply delivered, with **no manual `npm run` processes**. Replace `.app` → vault + channel config persist.

## Implementation order (each independently shippable)

1. `src/mcp-loopback.js` + mount + `AGENT_URL` in server-rest → assert daemon (workaround) connects to `/internal/mcp`. 
2. `src/channels/supervisor.js` + start/stop wiring → daemon auto-starts from the app (kill the manual processes, confirm).
3. `build-app-bundle.sh` (bundle `packages/` + deps check).
4. `portal-channels.js` activation (`reload()`) + `daemon` status.
5. UI: ChannelsSection + ConnectionsChecklist.
6. `verify-channel-supervisor.mjs` + chain.
7. Rebuild `.app` → packaged smoke.

---

## Verification table (assumptions verified by reading code)

| Assumption | Verified at |
|---|---|
| `packages/` not staged into bundle | `scripts/build-app-bundle.sh:93-103` (read) |
| daemon's only npm dep is express; node_modules rsynced wholesale | sweep1 + `build-app-bundle.sh:98` |
| nothing spawns the daemon | `src-tauri/src/main.rs:225-336` (read), `server-rest.js` imports (read) |
| `reply` wired only when AGENT_URL set; soft-fails when inert | `src/mcp.js:130-138,133` (read) |
| embed supervisor pattern (adopt/restart/health/nudge/stop) | `src/embed/supervisor.js` (read in full) |
| supervisor hook point + closeHandle + injectedKeys guard | `src/server-rest.js:263-286,278,301` (read) |
| `boot()` returns `{tools,handlers}`; reply included | `src/index.js:96-105` (read) |
| `createMcpServer({tools,handlers})` opens no vault db | `src/mcp.js:229-250` (read) |
| Streamable-HTTP transport + session-map pattern to lift | `src/server-http.js:240-372` (read) |
| ollama backend uses `StreamableHTTPClientTransport(cfg.mcpUrl)` | `packages/channel-daemon/agent/backends/ollama.js:76-85` (read) |
| server-rest does NOT import auth.js (no passkey) | `src/server-rest.js:1-36` (read) |
| process-group reap covers grandchildren | `src-tauri/src/main.rs:110-132,394-399` (sweep, cited) |
| concurrent SQLite WAL already relied on (clustering child) | `src/adapter/d1.js:33`, `src/jobs.js` (sweep) |
| egress chokepoint = 7 gates, loopback-only, hash-only audit | `packages/channel-daemon/egress/send-handler.js:29-161` (sweep) |
| daemon reads config only at boot (no hot-reload) | `packages/channel-daemon/index.js`, `config.js` (sweep) |
| PUT /channels nudges nothing | `src/portal-channels.js:55-96` (read) |
| no verify gate exercises spawn/supervision | all `scripts/verify-channel-*.mjs` (sweep) |
| `@better-auth/passkey` declared+locked but was uninstalled | `package.json:150`, observed on disk |

## Open questions deferred

- **Two-way replies for a brand-new user with neither Ollama nor a cloud key**: capture-only by design; the UI now says so + points to in-app local-model pull / cloud key. Auto-pulling a model on channel-enable is out of scope (bandwidth/consent).
- **Discord**: same supervisor path (the daemon already builds Discord when its token is present); covered by bundling + supervision, smoke deferred to when a Discord token is configured.
- **`--http`/remote passkey crash**: the deps-completeness check prevents shipping it; a full remote-mode smoke is separate (REMOTE-CONNECT runbook).
