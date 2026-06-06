# Handoff — Local test session (run Mycelium V1 on your device)

**Date:** 2026-06-06
**For:** a session running on your own machine (Mac or Linux), not the web sandbox
**Branch to test:** `main` (everything below is merged: #112–#118)
**Prereq doc:** `docs/SETUP.md` is the canonical, step-verified install guide. This handoff does **not** repeat it — it tells you *what to run and what to look for*, with emphasis on this session's new work (federation Phase B, shared spaces, the connections hub, channels).

---

## TL;DR

The whole V1 vault runs locally today. Stand it up per `SETUP.md`, run `npm run verify` (the full gate chain) for a green baseline, then smoke the four surfaces. **One honest limit:** live cross-node Matrix delivery (Phase B *live*) is **not testable yet** — the real Matrix client (B11) isn't implemented, so Matrix is inert (grants/shares record locally, no peer invite fires). Everything *up to* that — the gate logic, the data model, the REST surface, the audit — is built and verifiable. If you want to go live, this handoff's Part C points you at the B11 deploy handoff.

## Part A — Stand it up (follow SETUP.md)

1. **Prereqs** — Node 22+, a build toolchain (`better-sqlite3` compiles native), Python 3.10+ only if you want semantic search. (`SETUP.md` §1)
2. **Install** — `npm install` (a committed `.npmrc` handles the peer tree). (`§2`)
3. **DB** — `npm run init-db` → creates `data/mycelium.db`. It applies the **whole** `migrations/*.sql` dir in order via `applyMigrations` (`scripts/init-db.mjs:14`), so `0011_space_matrix_rooms.sql` is included — the "3 migrations" line in `SETUP.md §3` is just stale example output. Quick sanity check the new table landed:
   ```bash
   node -e "const D=require('better-sqlite3');const db=new D('data/mycelium.db');console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='space_matrix_rooms'\").all())"
   ```
   (Expect `[ { name: 'space_matrix_rooms' } ]`.) (`§3`)
4. **Keys** — `npm run set-keys` (Keychain on Mac, or plain env vars). (`§4`)

## Part B — What to test (and the green you should see)

### B0. Baseline gate chain
```bash
npm run verify        # the full chain — every surface, must end clean
npm run verify:federation   # GO 9/9
npm run verify:spaces       # GO 32/32  (includes the Phase B space⇄room + MXID-bind round-trips)
npm run verify:mcp          # GO
```
All `verify:*` print `VERDICT: GO` and exit 0. A red one is a real regression — capture the output.

### B1. stdio MCP (the agent surface)
```bash
MYCELIUM_KEY_SOURCE=keychain npm start      # or plain env vars per SETUP.md §5
```
Wire it into Claude Desktop (`SETUP.md §7`) and exercise a few tools (store a thought, search, getContext). Confirm tools list + a round-trip write/read.

### B2. REST + portal (`:8787`) — the human surface, where the new UI lives
```bash
npm run portal:build
MYCELIUM_KEY_SOURCE=keychain npm run portal   # http://127.0.0.1:8787
```
Test the **federation/spaces work from this session**:
- **Connections page** — the management hub. Create/inspect a connection; the **"Shared with @X"** panel should list every space + mindscape facet granted to that peer, each **revocable inline** (#112).
- **Shared spaces** — create a space, share it with an accepted connection, add a knowledge entry. Grant/revoke should succeed and persist. (The Matrix invite/mirror behind these is **inert locally** — see the limit below; the local DB effects are what you're verifying.)
- **Channels** — if you set up Telegram/Discord (channel-daemon), exercise two-way send/receive.

### B3. Publish (`:8788`) and enrichment (`:8095`)
- Publish a document → `<handle>.mycelium.id/<slug>` path (local). (`SETUP.md` publish notes)
- Optional Tier-2: start the embed service (`:8091`) + enrichment (`npm run start:enrich`, `:8095`) and confirm semantic search returns results once something is embedded. (`§8`)

### What "Matrix inert" means locally (expected, not a bug)
At boot there is **no Matrix client** wired (B11 unbuilt), so `spaceSync` is null. Per the safe-degrade design: **share grants/revokes and knowledge adds all succeed and persist locally**, but no peer is invited and nothing mirrors to a room. This is correct behavior for the current build — do **not** file it as a defect. Live delivery is Part C.

### Screen wiring map (audited 2026-06-06)

Every view's `/portal/*` calls cross-referenced against what the V1 server actually mounts at `/api/v1/portal` (`api.ts:40` rewrites the prefix). **All portal routers are mounted; auth-redirect (M2 #1) is the only thing between you and these screens.**

🟢 **Live-wired (V1 backend served — exercise these first):**
- **ConnectionsView** — incl. the #112 "Shared with @X" panel (`/connections/:id/shared`) + inline revoke. Fully served.
- **ContextsView** — contexts list/create/grant/territory, all served.
- **SpacesView / SpaceDetailView** — list/create/knowledge/members/shares/seed/seed-cluster/cluster-hierarchy + the doc cover fetch (`GET /documents/(.+)` regex). Fully served.
- **TimelineView** (`/agents`,`/identity`,`/messages`), **LibraryView** (list/open/delete/move/pin/folders — only `POST /documents/export` is missing), **agents/+page**, **body/+page** (`/health/summary`).

🟡 **Partial (screen loads; specific sub-features 404):**
- **MindscapeView** — reads served (realms, territories, fingerprint, activations, complexity, noise-stats, exploration-status). **NOT served:** `/enrichment/status`, `/enrichment/trigger`, and the explore job flow (`/mindscape/explore`, `/explore/status/:id`, `/explore/report/:id`).
- **SettingsView** — providers/AI-connect, `/settings`, `/channels`, `/stats` served. **NOT served:** `/passkeys`, `/billing`, `/delete-account*`, `/export*`, `/integrations/linear`, `/master-key/restore`, `/channels/global` (cloud-product features).
- **ProfileView** — handle-check/stats/recompute served; `/avatar`, `/exlibris` not.
- **vitality/+page** — `/trajectory*` + `/vitality/snapshot` served; `/vitality/arc`, `/vitality/chronicle/by-window` not.
- **ImportView** — `/import/obsidian` served; `/connectors*` only when a connector runner is configured (conditional mount, `server-rest.js:141`).
- **agents/_AgentRow** — assignments/secret served; `POST /agents/:id/customize` not.

🔴 **No V1 backend (whole screen — must render graceful-empty, else it throws):**
- **cycles/+page** (`/cycles*`), **fleet/+page** (`/fleet/*`), **wealth/+page** (`/wealth/*`), **media/+page** (`/attachments*`, `/stream-token/*`).

**Implication for the device session:** the federation/spaces/connections work (this session's deliverable) is **fully live-wired** — test it directly once the app opens. The 🔴 screens are cloud-only features with no V1 backend; confirm they show an empty state rather than crash (M2 #3), and don't chase them as bugs.


## Part C — (Advanced/optional) Take Phase B live on your device

Your machine *can* run a homeserver, so it's a fine place to implement + test **B11**. This is a build task, not just a test task — follow `docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md`:
1. Run a homeserver locally (Continuwuity or Synapse in Docker).
2. Add `matrix-js-sdk` and implement `createMatrixClient()` in `src/federation/matrix-client.js` against the existing seam contract (the `MockMatrixClient` is the spec; the A1b spike in `spike/federation-a1b-matrix/` is the proven recipe, 7/7).
3. Wire at boot: construct `matrixClient` + `matrixEgress` + `spaceSync`, pass `spaceSync` into `portalCompatRouter`, register `onTimelineEvent → handleInbound`, bind your MXID.
4. **Two-box E2E:** two vaults + two homeserver accounts, mutual connection, share a space, add knowledge on A → assert it decrypts + persists once on B; revoke → assert kick. That's the proof the mock can't give.

## Reporting back
- For each surface: `[✓]`/`[✗]` + the command + what you saw (per the `deploy-and-verify` ledger style).
- Any red `verify:*` → paste the `VERDICT`/error block.
- Anything surprising in the portal (spaces/connections/channels) → screenshot + the steps.
- If you tackle Part C, note where the homeserver wiring or key-sharing (the A1b `getUserDeviceInfo` gotcha) tripped, so it can fold back into the B11 handoff.

## Pointers
- Setup: `docs/SETUP.md` · Architecture: `docs/ARCHITECTURE.md` · Phase B plan + as-built: `docs/DESIGN-federation-phaseB-BUILD-PLAN-2026-06-06.md` · B11: `docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md`
- Federation code: `src/federation/{matrix-client,matrix-egress,space-sync,lexicon,did}.js` · `src/db/{space-matrix-rooms,space-knowledge,identity-channels}.js` · `src/portal-compat.js` (share + knowledge hooks).
