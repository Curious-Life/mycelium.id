# MCP Connection + Remote Connect — Handoff

**Date:** 2026-06-02
**Companions:** [REMOTE-CONNECT-DESIGN](REMOTE-CONNECT-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-AUTO-PROVISION-DESIGN](REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md) · [MCP-OVERVIEW](MCP-OVERVIEW.md) · [MCP-CONNECT-AND-TEST](MCP-CONNECT-AND-TEST.md) · [SMOKE-TESTS](SMOKE-TESTS.md)
**Audience:** the next Claude Code instance picking up the remote-connect epic.

---

## TL;DR — current state

| Thread | Where | Status |
|---|---|---|
| Search 81s→0.7s cold-start fix | **merged to `main`** (PR #43 = `1a8f525`) | ✅ shipped |
| Remote Phase 1 — persist baseURL + signing secret + operator-password seam | PR **#45** `feat/remote-connect-phase1` (`d40959e`, rebased on main) | ✅ open, green |
| Remote Phase 2 — app spawns `--http` + Connect panel + tunnel.sh + icons | PR **#46** `feat/remote-connect-phase2` (stacked on #45) | ✅ open, green |
| Auto-provision design (one-click "Get your address") | in PR #46 (`c52c009`) | ✅ design only |
| **Path B build** (own-domain, client-only cloudflared automation) | not started | ⬜ **next** |
| **Path A build** (managed `you.mycelium.id` control-plane) | not started | ⬜ needs its OWN sweep+design |
| Phone test (end-to-end) | **never completed** | ⬜ blocked on URL provisioning (the auto-provision design now addresses it) |

Verify open PRs (GraphQL is rate-limited — use REST):
```
gh api repos/Curious-Life/mycelium.id/pulls --jq '.[]|"#\(.number) \(.head.ref) \(.title)"'
git log --oneline -2 origin/main   # expect 1a8f525 (#43) over b622914 (#44)
```

---

## 2026-06-02 session summary — start here

### What shipped (commits)
| Commit | Branch / PR | What |
|---|---|---|
| `1a8f525` | main (#43, MERGED) | fix(search): load stored `embedding_768` on rehydrate — kills the 81s first-search (verified 81s→0.7s on real data). Adds `scripts/verify-search-rehydrate.mjs`. |
| `d40959e` | #45 | feat(remote) Phase 1: `src/remote/config.js` (remote.json + auth-secret-in-auth.db + setOperatorPassword), `src/remote/router.js` (`/status,/password,/config`), `auth.js` wiring + claude.ai/.com trustedOrigins, `paths.remoteConfigPath`, `scripts/verify-remote-config.mjs`. |
| `60fa2db` | #46 | feat(remote) Phase 2: `main.rs` spawns `node src/index.js --http` on `remote_enabled()`; `RemoteAccessSection.svelte`; `/status` `httpListening` probe. |
| `940ee66` | #46 | `scripts/tunnel.sh` (cloudflared named tunnel) + `docs/SMOKE-TESTS.md`. |
| `4ca1e82` | #46 | Connect panel: `LocalConnectSection.svelte` (.mcp.json helper + Copy + live check), `/local-config` route, Disconnect button. |
| `006e9b5` | #46 | fix(tauri): commit app icons (only README.md was tracked → clean builds failed). |
| `c52c009` | #46 | docs: auto-provisioning design. |

### What was learned (the important lines)
- **The whole product hinges on URL provisioning.** A NAT'd Mac can't be reached without a tunnel+hostname. "One click, no domain" REQUIRES us to run a tunnel control-plane (Path A). There is no client-only path to it.
- **Cloudflare remotely-managed tunnels solve the managed path:** `POST /accounts/{id}/cfd_tunnel {config_src:"cloudflare"}` → connector token → `cloudflared tunnel run --token` (no user CF login). Free, **1000 tunnels/account** ceiling, CF terminates TLS (sees tool traffic).
- **`identity.js` ed25519 (from master key) can authenticate handle claims** — no password/account system needed for Path A.
- **Search cold-start was a dropped read path**, not a perf mystery: `d1-loader` re-embedded every message instead of loading the stored `embedding_768`. Fix reused `decryptVector` (already in the tree, "reserved for when encrypted vector-at-rest lands").
- **Sovereignty model** (see design §5 + the explanation captured in the open decision below): cloud AI sees pulled results in EVERY path; the tunnel adds CF (own-domain = your CF, managed = ours) as a transit party; at-rest + key sovereignty always intact.

### Operator's directional calls (2026-06-02)
- Build **both** B and A, **properly** — start B; **A needs its own sweep + design** before code.
- "These steps should happen automatically in the app" → the auto-provision design is the response (no terminal/cloudflared-install/hostname-typing).
- Throwaway vault → test freely. Always `/sweep-first-design` before code changes (followed).

---

## Production / repo state
- **main**: `1a8f525` — has #43 (search fix) + #44 (fresh-user provisioning, landed by the OTHER session).
- **PR #45** open (Phase 1), rebased clean onto main, green (`verify:remote-config/oauth/foundation/mcp` GO).
- **PR #46** open (Phase 2 + Connect + tunnel + icons + auto-provision design), stacked on #45 (base = `feat/remote-connect-phase1`); auto-retargets to main when #45 merges. Green (cargo build + portal build + verify GO).
- **Isolated worktree** `/tmp/myc-phase2` on `feat/remote-connect-phase2` — where Phase 2 was built and the **app currently runs from** (`src-tauri/target/debug/mycelium`). `node_modules` is a **symlink** to the Documents clone's (same arch — better-sqlite3 works).
- **Running app**: launched from the worktree in **setup/restore mode** (vault locked — see gotcha). May be pid ~79920 (could change). `:8787` REST, `:4711` only when remote enabled.
- **Real vault** `~/Library/Application Support/id.mycelium.app`: `kcv.json` rewritten **19:21**, `mycelium.db` **19:37** — re-set-up mid-session.

---

## Gotchas + lessons (2026-06-02)
- **The Documents clone (`~/Documents/GitHub/mycelium.id`) is shared with another LIVE session** — it `checkout main`/pulls/switches branches under you. **Re-check `git branch --show-current` immediately before ANY git op there.** (It yanked a sibling off `feat/remote-connect-phase1` mid-commit once; recovered because work was pushed.) Build in the **worktree** to stay isolated.
- **`gh` GraphQL is rate-limited** for this account (`gh pr create`/`gh pr list` fail). Use REST: `gh api -X POST repos/Curious-Life/mycelium.id/pulls -f ...`.
- **App icons were not in git** (only `src-tauri/icons/README.md`) → `cargo build`/`tauri dev` failed on a clean checkout (`generate_context!()` needs them). Fixed in `006e9b5`. The PNGs lived only in `~/mycelium.id/src-tauri/icons/`.
- **`cargo tauri dev`'s file-watcher rerun drops the launch env** (`MYCELIUM_KC_*`) → vault came up locked. Launch the **built binary directly** with the full env, or re-assert env on rerun.
- **`portal-app` has no `@tauri-apps/api`** → drive the app from the webview via **config-reconcile** (write `remote.json`, Tauri reads it at startup), NOT Tauri IPC. (Both Phase 2 and the auto-provision design use this.)
- **Cloudflare quick tunnels lack SSE** (→ CF 524 on the MCP stream) → **named tunnels only**.
- **Real vault re-keyed ~19:21**: neither `mycelium-firsttest*` nor default keychain items unlock it (KCV fails) — the running app is in restore mode. **User has the recovery key**; restore via the app's setup screen (the key must NOT be pasted into any chat/log — master-key discipline).
- **node_modules symlink** into a worktree avoids a reinstall (same-arch native binding loads fine).

---

## Open decisions for the operator
1. **Managed-path sovereignty (CF sees tool traffic in transit).** Recommended **acceptable WITH UI disclosure** — at-rest + key sovereignty is intact, the cloud AI sees pulled data regardless, so the tunnel operator seeing it in transit is marginal; keep own-domain (your-CF) + local-model (nothing-leaves) as the sovereign alternatives. **Operator to ratify** before the managed launch. (Full reasoning in the session transcript + design §5.)
2. **Path A scale:** the 1000-tunnel/CF-account ceiling — fine for V1 (2–20 users); needs an account-sharding policy before mass scale. Deferred.
3. **E2E-TLS option:** self-hosted FRP relay (origin holds cert; tunnel can't see plaintext) — only matters if you distrust the tunnel operator (Claude still sees results). Deferred; decide if it's a launch requirement.

---

## Pickup protocol (next session)
1. **Read this handoff cold**, then both design docs (REMOTE-CONNECT-DESIGN + AUTO-PROVISION), then `MCP-OVERVIEW`.
2. **Re-check git state** (REST `gh api .../pulls`); main = `1a8f525`. **Before any git op in the Documents clone, re-check its current branch** (shared session).
3. **Build Path B (own-domain, client-only)** per AUTO-PROVISION §6/§9:
   - **3b-0 spike FIRST:** bundle `cloudflared` (one arch) + launch it from Tauri, **verifying the sidecar API against LIVE Tauri v2 docs** (the design's `externalBin`/`Command::sidecar`/capability is best-practice *inference* — the agent's docs 404'd). This is the riskiest unknown — de-risk before building on it.
   - then 3b-1 (`remoteMode` + Rust reconcile spawns `--http`+`cloudflared` from `remote.json`), 3b-2 (`connect_own_domain` flow + the two-tab Connect UI).
4. **Path A**: run **`/sweep-first-design`** for the `mycelium-managed` control-plane (provision endpoint + CF API client + handle registry + ed25519-claim auth) before any code. Don't skip — it's a new service.
5. **Verify each change** with `/deploy-and-verify` (run the `verify:*` gate; add `verify:remote-mode` / `verify:provision`-against-mocked-CF per the design's test plan).
6. **Resume the app/phone test** only after the vault is restored (operator's recovery key) OR point at an isolated test vault (`sqlite3 .backup` of the real db + its kcv + the matching keys).
7. **Get from the operator:** ratify decision #1 (managed sovereignty); confirm whether to finish the manual phone test (own domain + `scripts/tunnel.sh`) or wait for the in-app Path-B flow.

---

## Glossary
- **Path A / B** — A = managed `you.mycelium.id` (we run the tunnel control-plane); B = own-domain (user's Cloudflare, client-only).
- **`--http`** — the OAuth/MCP Streamable-HTTP server (`src/server-http.js`) on `:4711`; the tunnel forwards to it.
- **config-reconcile** — the app/Tauri reads `remote.json` (not Tauri IPC) and spawns/stops `--http`+`cloudflared` accordingly; the webview only writes config via `/api/v1/remote/config`.
- **remotely-managed tunnel** — a Cloudflare tunnel created via API that runs from a token (`cloudflared tunnel run --token`), no interactive login.
