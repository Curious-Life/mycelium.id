# Federation (Tier-0 live + Tier-1 Matrix design) — Handoff

**Date:** 2026-06-16
**Audience:** the next Claude Code instance picking up this work.
**Companions:**
- [docs/FEDERATION-LIVE-TEST-RUNBOOK-2026-06-15.md](FEDERATION-LIVE-TEST-RUNBOOK-2026-06-15.md) — two-box bring-up + verification runbook
- [docs/DESIGN-matrix-cross-machine-bringup-2026-06-16.md](DESIGN-matrix-cross-machine-bringup-2026-06-16.md) — Tier-1 Matrix design (this session)
- [docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md](DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md) — Tier-1 deploy checklist (predecessor)
- [docs/DESIGN-federation-inter-instance-2026-06-05.md](DESIGN-federation-inter-instance-2026-06-05.md) — locked decisions D-FED-1..7

---

## TL;DR — current state

**Tier-0 federation works live between two real boxes.** A connection between `hi.example.com` and `lo.example.com` was established end-to-end this session. Five PRs merged to `main` fixing the bug chain that blocked it. Tier-1 (Matrix messaging) is designed but unbuilt.

| PR | squash SHA on main | What | State |
|---|---|---|---|
| #170 | `4d298d1` | F2 stranded-request re-deliver + `withdraw`; control-plane `:8443` default; two-pane Connections redesign | ✅ merged |
| #178 | `4e47a99` | route `/federation/*` through the on-Mac Caddy edge to `:4711` | ✅ merged |
| #179 | `62ce1d0` | accept 2-char (+ hyphenated) handles in the connect parser | ✅ merged |
| #180 | `8f93984` | real error messages + bare-handle entry + live-refresh/toasts | ✅ merged |
| #181 | `0e97bc2` | federation handle (not profile handle) for `from_handle`; match accept on verified host | ✅ merged |

**Two things still open (both small):**
1. **Finish the Tier-0 two-way handshake.** `hi` shows the connection as `pending`, `lo` shows it `accepted` (one-sided). Root cause was the `from_handle` bug, fixed in #181 — but **`hi` is still running a bundle built *before* #181**, so it hasn't taken effect. Needs: rebuild `hi`, clear the stuck rows, reconnect.
2. **Tier-1 Matrix** — wiring BUILT 2026-06-16 PM ([#182](https://github.com/Curious-Life/mycelium.id/pull/182)); real client + homeserver still deploy-bound. See the 2026-06-16 PM section below.

---

## 2026-06-16 PM session summary — Tier-1 Matrix wiring + Tier-0 state correction

### Tier-0 state correction (to the TL;DR above)
The TL;DR says #181 is "✅ merged" — **true on `origin/main` (`0e97bc2`, `selfHandle`×3 in connections.js)**, verified live this session. The earlier-session worry that "main might not have #181" was a **stale local checkout** (local `main` sat at #180 until `git fetch`). So: building any box from `main` (after `git pull`) **does** include the fix. The one stale artifact is the installed `/Applications/Mycelium.app` on `hi` — its bundled `connections.js` has `selfHandle`×0 → still pre-#181. **hi rebuild remains the only blocker for the two-way handshake.** Stuck row on hi to clear: connection `2d38a80f` (pending → lo); plus two ignorable junk rows (`4fb72464` rejected self-test, `aa0b40ac` 2026-04 foreign-ciphertext).

### What shipped — Matrix Tier-1 wiring (PR #182, branch `feat/matrix-tier1-bringup`, commit `9edd9e6`)
All **inert behind `matrixConfig()`-null** → safe to merge before any homeserver exists.
- **config** ([remote/config.js](../src/remote/config.js)): `matrixHomeserver`/`matrixUserId` in remote.json (validated) + `matrixConfig()` gate; access token in auth.db via `setRemoteSecret('matrix_access_token')`, never remote.json (§1/§4).
- **advertise** ([handlers.js](../src/federation/handlers.js) + [server-http.js:251](../src/server-http.js)): `getMatrixId` → did.json `#matrix` service (per-request read).
- **server-rest boot** ([server-rest.js](../src/server-rest.js)): `buildSpaceSync()` = client + egress + `resolveMxid` (peer did:web `#matrix`, SSRF-guarded) + selfMxid + MXID-bind + `onTimelineEvent`→`handleInbound`, threaded into `portalCompatRouter`.
- **createMatrixClient**: a throwing **deploy-session stub** (boot catches → stays inert). Real matrix-js-sdk+rust-crypto adapter NOT written blind (can't validate w/o live homeserver; would pull heavy crypto dep into the vault).

### What was learned
- **The consumer side was already wired.** `portalCompatRouter` already accepted `spaceSync` and already called `syncGrant`/`syncRevoke`/`mirrorKnowledge` — only the producer/instantiation was missing. The "180–240 LOC" estimate was high; the verifiable wiring was ~70 LOC + tests.
- **Pivot v2→v3 (design §3a):** "wire in `index.js` boot()" was wrong — `boot()` only builds the MCP surface; routers assemble in the **two server processes** (advertise → server-http :4711; client+sync → server-rest :8787). The split is intrinsic.

### Verification (this session)
`verify:federation` 12/12 · `verify:spaces` 32/32 (spawns the real REST server, exercises share grant/revoke over the new spaceSync path) · `verify:remote-config` RC11 · `verify:remote-runtime` · 57/57 federation unit tests. **PR #182 CI: in progress at handoff** — federation/config-adjacent diff → needs human review before merge (per /auto-merge-on-green security-sensitive rule).

### Pickup for the Matrix DEPLOY session (the real bring-up)
Per [DESIGN §8](DESIGN-matrix-cross-machine-bringup-2026-06-16.md): (1) stand up a shared Continuwuity homeserver, register `@hi`/`@lo`; (2) implement `createMatrixClient` ([matrix-client.js](../src/federation/matrix-client.js) — the stub documents the exact steps) against the live server: persistent crypto store, login from `matrixConfig()`, A1b first-send; (3) on each box set config (`matrixHomeserver`/`matrixUserId` + `setRemoteSecret` token), restart server-rest; (4) confirm did.json shows `#matrix`; (5) run the two-box E2E (share→grant→add knowledge on hi→assert on lo: decrypts once, `source_type='remote'`; revoke→kicked). That row on `lo` is the GO criterion.

---

## 2026-06-16 session summary — start here when picking up

### What shipped (all merged to `main`)
The bug chain that stood between "Tier-0 code exists" and "two real boxes connect," found by live-debugging `hi`↔`lo`:

1. **Stuck-pending delivery (#170).** A failed fire-and-forget connect POST left a `pending` row with no recovery (re-request no-op'd; `disconnect` required `accepted`). Fixed: re-request **re-delivers**; new `withdraw()` clears a stranded sent invite.
2. **Control-plane port (#170).** The managed-claim UI showed every handle "taken" because the app hit `connect.mycelium.id:443` (frps SNI-passthrough, no cert → TLS `unrecognized_name`). The control plane lives on **`:8443`**. Fixed the default + the false-"taken" label.
3. **Edge routing (#178).** The on-Mac Caddy proxied `/.well-known/*` to `:4711` but **not `/federation/*`** → inbound connect POSTs 404'd at the edge (hit `:8787` which doesn't mount federation). A peer could fetch your DID but not deliver a request. Added `/federation/*` to the `oauth` edge route.
4. **2-char handles (#179).** `HANDLE_LOCAL_PART_RE` required ≥3 chars; both boxes are named `hi`/`lo` → `requestConnection("lo@lo.example.com")` fell through to local lookup → "User not found." Relaxed to 2+ chars + hyphens.
5. **Profile-vs-federation handle mismatch (#181).** Outbound `from_handle` used `user_profiles.handle` (`person`) instead of the federation handle (`hi`, the subdomain that WebFinger/did:web publish). So the accepter's `connect-response` did `WebFinger acct:person@hi.example.com` → 404 → never sent → initiator stuck `pending`. Fixed: send the federation handle; match the inbound accept on the **verified host** (handle is cosmetic; host is the identity).
6. **UX (#180).** Real server error messages (not "failed (400)"), bare-handle entry (`lo` → `lo@lo.example.com`), 10s live-refresh + toasts on the Connections page, badge poll 60s→15s.

### What was learned (READ THIS — the most valuable lines)
- **The running app is the installed `Mycelium.app` bundle, NOT the source tree.** It runs `…/src-tauri/target/release/bundle/macos/Mycelium.app/Contents/Resources/app/`. Source edits/merges do nothing until a **`cargo tauri build`** rebuild. Every "still broken after the fix" this session traced to this.
- **The vault's profile handle (`person`) ≠ the federation handle (`hi`).** They're set independently (onboarding vs subdomain claim). `hi` and `lo` have **different keys** (different `did.json`), so they are genuinely separate vaults — not a clone. The "resolves as person over the wire" symptom was #181, now fixed.
- **Tailscale MagicDNS negative-caching is a real federation footgun.** Querying `lo.example.com` *before* it was registered cached NXDOMAIN in Tailscale's resolver (`100.100.100.100`); the box couldn't resolve `lo` even after it went live (macOS cache was empty — Tailscale is the caching layer; `dscacheutil` flush won't help). Resolved by **disabling Tailscale**. The app resolves federation hosts via the system resolver, so split-DNS interferes. (Possible future hardening: resolve federation lookups via a public resolver.)
- **`codesign` fails while the app is running** ("Operation not permitted" on the live binary). Quit the app before rebuilding. The rebuild also fails at the optional **DMG** step (`bundle_dmg.sh`) — that's harmless; the `.app` itself signs fine (`codesign --verify --deep --strict` → OK).
- **The live Caddyfile patch survives restarts but not re-provision.** I hand-patched `hi`'s materialized Caddyfile to add `/federation/*` + reloaded Caddy (backup at `…/id.mycelium.app/Caddyfile.bak-prefed`); `materializeRemoteConfigs` only re-runs on provision (`src/remote/router.js:229,291`), not boot. A from-`main` build makes it permanent.
- **The reservation-spam concern is real but control-plane-only.** Audited `mycelium-managed`: cert/CA side is well-protected (daily cap after entitlement), but the **namespace** is exposed — `claim()` reserves before payment, **no per-key cap**, and re-claim **refreshes the hold** → free squatting (gated only by Turnstile + per-IP). Cannot be fixed from this repo. Operator ruled out touching `mycelium-managed` for now → **accepted limitation**.

### Process gotcha (correction to my own work)
- **Path slip (2026-06-15):** I first edited the **main repo** checkout (`feat/narration-overhaul`) instead of the worktree. Caught it, `git restore`d the two files (the operator's narration WIP was untouched), and re-applied in the worktree. All five PRs are clean. Lesson: in a worktree session, use the **worktree** absolute paths, not the main-repo paths.

### Tier-1 Matrix design (this session, via /sweep-first-design)
- **Found:** Phase B (B1–B10) is **built, merged, unit-green** behind an injectable `MatrixClient` seam — `src/federation/{space-sync,matrix-egress,matrix-client,did}.js`. But **entirely UNWIRED** (no homeserver, no real `createMatrixClient`, no boot instantiation, no box MXID in `did.json`; `matrixClient` is null → all ops no-op).
- **Pivot (v1→v2):** locked D-FED-7 ("one Continuwuity per box") implies Matrix **S2S federation** (deferred/unproven). The design pivots the **bring-up** to a **shared homeserver (both boxes as clients)** — same Megolm E2EE, no S2S — and defers per-box+S2S. Full detail + verification table in the design doc.

---

## Production / live state (verify before picking up)

| Box | publicHost | remoteMode | reachable | can receive (`/federation/connect`) | running build |
|---|---|---|---|---|---|
| `hi` (this Mac) | `hi.example.com` | managed, `httpListening:true` | ✅ (did.json 200) | ✅ 401 (edge patched live) | **built ~02:03, PRE-#181** → from_handle bug still live |
| `lo` (other computer) | `lo.example.com` | managed | ✅ (verified via IP-pin) | ✅ 401 | from-`main` build (has fixes) |

Connection rows right now: `hi` has a `pending` sent to `lo` (`id 2d38a80f…`); `lo` shows it `accepted` (one-sided — the #181 bug, not yet live on `hi`).

**Verification commands (run on/from `hi`):**
```sh
# hi self-state — expect remoteMode:managed, publicHost:hi.example.com, httpListening:true, controlPlaneUrl …:8443
curl -s http://127.0.0.1:8787/api/v1/remote/status | jq '{remoteMode,publicHost,httpListening,controlPlaneUrl}'
# both boxes reachable + can receive — expect did.json 200, POST → 401 (unsigned)
for H in hi lo; do
  curl -s -o /dev/null -w "$H did.json %{http_code}\n" https://$H.mycelium.id/.well-known/did.json
  curl -s -o /dev/null -w "$H connect %{http_code}\n" -X POST -H 'content-type: application/json' -d '{}' https://$H.mycelium.id/federation/connect
done
# is the running bundle pre/post #181? (grep the bundle source)
grep -c selfHandle "$HOME/Documents/GitHub/mycelium.id/src-tauri/target/release/bundle/macos/Mycelium.app/Contents/Resources/app/src/db/connections.js"
#   0 = PRE-#181 (rebuild needed) · 3 = #181 is live
```

`main` HEAD should be `0e97bc2` (#181): `git -C ~/Documents/GitHub/mycelium.id log -1 --format=%h origin/main`.

---

## Open decisions for the operator

1. **Finish Tier-0 two-way now?** Recommended: **yes** — rebuild `hi` from `main` (gets #181), then clear the stuck rows + reconnect (steps below). Small, finishes the live test cleanly.
2. **Rebuild `lo` too?** For `hi → lo` alone, rebuilding `hi` suffices (`hi` sends the right handle; its relaxed match accepts `lo`'s response). For **bidirectional** (`lo → hi`) and full cleanliness, rebuild `lo` from `main` as well.
3. **Tier-1 Matrix bring-up** — when ready, it's a dedicated build session (homeserver + client adapter + two-box E2E). Topology decided in the design: **shared homeserver**, defer S2S.
4. **Reservation-spam** — accepted as a control-plane (`mycelium-managed`) limitation; not fixable here. Revisit if/when `mycelium-managed` is in scope.

---

## Pickup protocol (next session — execute in order)

1. **Read this handoff cold**, then the [runbook](FEDERATION-LIVE-TEST-RUNBOOK-2026-06-15.md) §2–§4.
2. **Verify live state** with the commands above. Confirm the `grep -c selfHandle` on the bundle = 0 (pre-#181) — that's why `hi` is one-sided.
3. **Finish Tier-0 two-way** (if the operator wants it):
   a. Quit `Mycelium.app` on `hi` (clean Cmd-Q — `codesign` fails on a running binary).
   b. Rebuild: `cd ~/Documents/GitHub/mycelium.id && cargo tauri build` (Rust cached; ignore the DMG-step failure — the `.app` signs fine). Confirm `grep -c selfHandle …/app/src/db/connections.js` = 3.
   c. Reopen `Mycelium.app`.
   d. **Clear the stuck rows:** on `lo`, disconnect the `hi` connection (deletes its accepted row); on `hi`, withdraw the pending (`POST /api/v1/portal/connections/<id>/withdraw`, id from `/connections/sent`).
   e. Reconnect: on `hi`, Connections → `lo` → accept on `lo` → confirm **both** sides show connected + `computeOverlap` returns.
4. **Tier-1 Matrix** (separate session): follow [DESIGN-matrix-cross-machine-bringup-2026-06-16.md](DESIGN-matrix-cross-machine-bringup-2026-06-16.md) §8 implementation order. Run **/sweep-first-design** before structural code, **/deploy-and-verify** after.
5. Branch note: this session's work was authored on `claude/hungry-merkle-b72539` and cherry-picked onto `feat/narration-overhaul` (the operator's active branch / what `hi` builds from). All 5 PRs are squash-merged to `main`.

---

## Gotchas + lessons (dated)

- **Running app = the bundle, not source (2026-06-15).** Rebuild (`cargo tauri build`) to pick up merged fixes.
- **Tailscale MagicDNS negative-caches federation hostnames (2026-06-16).** Disable Tailscale (or toggle its DNS) if a just-registered peer won't resolve; macOS flush won't help.
- **`codesign` fails while the app runs; DMG step fails harmlessly (2026-06-16).** Quit first; the `.app` still signs (`codesign --verify --deep --strict` OK).
- **Control plane is on `:8443`, not `:443` (2026-06-15).** `:443` is frps SNI-passthrough.
- **Live Caddyfile patch is not durable across re-provision (2026-06-16).** From-`main` build makes `/federation/*` routing permanent.
- **Profile handle ≠ federation handle (2026-06-16).** Federation uses the subdomain; `from_handle` must be the subdomain or the reverse WebFinger 404s (fixed #181).
- **Stray file:** `docs/FEDERATION-LIVE-TEST-RUNBOOK-2026-06-15 2.md` is a Finder-duplicate (note the " 2"); delete it — the canonical one has no suffix.

---

## Skills that fired this session
- **/sweep-first-design** → the Matrix design doc (3 parallel sweeps + firsthand code verification + v1→v2 pivot + verification table).
- **/handoff-discipline** → this doc.
- (Tier-0 fixes shipped via the standard merge-on-green gate; `verify:federation` GO 12/12 and `db-connections-federation` 24/24 on each.)
