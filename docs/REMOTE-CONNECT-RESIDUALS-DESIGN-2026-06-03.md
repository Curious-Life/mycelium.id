# Remote Connect — Residual-Fix Design (post-adversarial-review)

**Properly close the five documented residuals from the 2026-06-03 red-team, each verifiable here (unit/mock); live-infra parts run as operator smoke.**

> **Date:** 2026-06-03 · **Status:** DESIGN (sweep-first) · **Branch:** feat/remote-connect-phase2
> **Companions:** [REMOTE-CONNECT-TRANSPORT-DESIGN](REMOTE-CONNECT-TRANSPORT-DESIGN-2026-06-02.md) · [REMOTE-CONNECT-MANAGED-DESIGN](REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md). Follows the adversarial review (5 fix commits `27f939e..9d51ba9`).
> **Sweep:** 3 external agents (FRP CloseProxy/run_id/manage-API; crt.sh/CAA; macOS reaping) + our code read directly. Verification table at the end.

---

## 0. The five residuals → the fix
| # | Residual | Fix |
|---|---|---|
| R-A | Nonce store in-memory (no HA / lost on restart) | back it with the registry sqlite DB (single-use via `DELETE … RETURNING`) |
| R-B | Real-provider DNS create/delete untested | `verify:dns` stubs `fetch`, asserts the Cloudflare(grey)/deSEC request shapes |
| R-C | Hard-crash sidecar orphan | `process_group(0)` + group-kill at `RunEvent::Exit` + PID-reuse-safe pidfile reaper at launch |
| R-D | Stolen FRP token → concurrent tunnel for a handle | registry `active_run_id`+`active_at`; NewProxy set-or-reject, CloseProxy **compare-and-clear**, Ping refresh, TTL |
| R-E | Managed rogue-cert MITM undetected | ship CAA guidance (`accounturi`+`validationmethods`) + a minimal CT-monitor (crt.sh, Cert-Spotter-ready) |

## 1. Sweep findings (consolidated, cited)

**FRP (Sweep A — fatedier/frp source).** `CloseProxy` IS fired on proxy/control teardown with `CloseProxyContent{User{User,Metas,RunID}, proxy_name}` — but it's **notification-only** (`Reject` ignored; `manager.go`) and dispatched in a **detached goroutine** (`server/control.go`), so a stale `CloseProxy(R1)` can land *after* `NewProxy(R2)` on a fast reconnect → **clear MUST be conditional on run_id**. `run_id` rides under `user.run_id` in Login/NewProxy/CloseProxy/Ping, is per-frpc-connection, and is **new on reconnect** (so a stolen token reconnecting gets a different run_id). `DELETE /api/proxies` is **`status=offline` only** (`server/http/controller.go` → 400 otherwise) — **cannot evict an active tunnel**; eviction is at admission (Login/NewProxy reject). The plugin gets only an `X-Frp-Reqid` header — **no auth** → `/frps/handler` is a token oracle to anyone who can reach it → **network isolation required** (already in `relay/frps.toml` + README).

**CT/CAA (Sweep B).** crt.sh: `?q=<name>&output=json` → `[{issuer_name, common_name, name_value(SANs), id, not_before, serial_number, …}]`; `%.mycelium.id` for the wildcard sweep. **60 req/IP/min, frequent 502s, no SLA** → use **Cert Spotter** (`api.certspotter.com/v1/issuances?domain=&include_subdomains=true`, cursor `after=`) for real monitoring, crt.sh as cross-check. ROGUE = issuer ∉ allowlist **OR** issuer allowed but serial ∉ our known-set (catches a real LE cert *we didn't request*). CAA (RFC 8659) **tree-climbs** (apex covers subdomains); LE honors `issue "letsencrypt.org; validationmethods=dns-01; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<id>"`. **Honest limit:** CAA+CT = detection + bar-raising, NOT prevention — a DNS-controlling attacker rewrites CAA + passes DNS-01. True MITM prevention = out-of-band key pinning (not available for a cloud client).

**macOS reaping (Sweep C).** `CommandExt::process_group(0)` → child is a group leader (`pgid==pid`); `libc::kill(-pgid, SIG)` reaps the group incl. grandchildren that didn't `setsid` (frpc/caddy don't). **No `PR_SET_PDEATHSIG` on macOS.** Reap at **`RunEvent::Exit`** (fires on close/Cmd-Q/`app.exit()`; panic/SIGKILL fire neither → the pidfile reaper is the backstop). PID-reuse guard: `ps -p <pid> -o comm=` must match the sidecar name before killing.

## 2. Module shape

### R-A — registry-backed nonces (`nonce.js` +~25, `registry.js` +1 table) ~26 LOC
`createNonceStore({ db, ttlMs, now })`: when `db` is given, `CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER)`; `issue()` = INSERT; `consume(n)` = `DELETE FROM nonces WHERE nonce=? RETURNING expires_at` (atomic single-use, works across instances sharing the DB) → valid iff a row returned and unexpired; `sweep()` = `DELETE WHERE expires_at < now`. No `db` → the existing in-memory path (tests/dev). `server.js main()` passes `{ db: registry.db }`.

### R-B — `verify:dns` (new) ~70 LOC
Stub `globalThis.fetch`, record calls. `createDnsClient({provider:'cloudflare', token, zone, relayIp})` + `MYC_CF_ZONE_ID` → assert `createHandleRecords` POSTs 2 records to `/zones/{id}/dns_records` with **`proxied:false`** (A→relayIp, CNAME→fulldomain); `deleteHandleRecords` GETs by name then DELETEs by id (×2). Repeat for `desec` (POST/DELETE `/rrsets/`). Restore `fetch`.

### R-C — crash-safe reaping (`main.rs` ~+70, `Cargo.toml` +libc)
`Cargo.toml`: `[target.'cfg(unix)'.dependencies] libc = "0.2"`. `main.rs`: `.process_group(0)` (#[cfg(unix)]) on every spawned `Command`; append `pid\tname` to `<dataDir>/sidecars.pids` per spawn; `reap_stale_pids()` at `setup()` start (read pidfile → for each, `ps -p <pid> -o comm=` matches name → `kill(-pid, SIGKILL)`); restructure to `.build(generate_context!())?.run(|h,e| if RunEvent::Exit { reap_all() })` where `reap_all` group-kills (`libc::kill(-pgid, SIGTERM)` then `SIGKILL`) + clears the pidfile. Keep the `Destroyed` kill as a redundant guard.

### R-D — single-active-proxy (`registry.js` +~30, `relay-hook.js` +~35, `frps.toml` ops)
`registry`: add cols `active_run_id TEXT, active_at INTEGER` (CREATE + idempotent `ALTER`); `setActiveProxy(handle,runId,now)`, `clearActiveProxyIf(handle,runId)` (compare-and-clear), `refreshActiveProxy(handle,runId,now)`, `getActiveProxy(handle)`. `relay-hook`: NewProxy — after the host check, if `getActiveProxy(handle)` has a *different* run_id and `now-active_at < TTL(300s)` → **reject** "another tunnel is active"; else `setActiveProxy`. Add `authorizeCloseProxy` (compare-and-clear) + Ping refresh. `createRelayHook` dispatches `CloseProxy`+`Ping`. `frps.toml` ops `["Login","NewProxy","CloseProxy","Ping"]`.

### R-E — CT-monitor + CAA (`mycelium-managed/src/ct-monitor.js` ~70 + docs)
`checkHandle({ handle, zone, issuerAllow=['Let's Encrypt'], knownSerials, fetchImpl=fetch })` → query crt.sh JSON → flag certs whose `issuer_name` ∉ allowlist OR `serial_number` ∉ knownSerials → `{ rogue:[…], checked }`. `caaRecords({zone, accountUri})` → the recommended record strings. Cert-Spotter adapter noted (cursor API) for production. CAA guidance added to `mycelium-managed/README` + `relay/README`.

## 3. Edge cases — explicit decisions
- **CloseProxy race** → compare-and-clear on run_id (never clear another run_id's active slot); TTL(300s) refreshed by Ping covers a crashed frpc (no CloseProxy) so the legit owner can re-bind after ~5 min.
- **Eviction on /release** → can't force-kill via the API (prune-offline-only); rely on admission-reject + the row deletion (token invalidated; the existing tunnel drops on its next reconnect/heartbeat-fail). Documented.
- **Reaper PID-reuse** → only kill if `ps comm` matches the sidecar name; clear the pidfile after reap. Never blind-kill a recorded pid.
- **CAA is not prevention** → ship it + CT-monitor as detection; keep own-domain as the cryptographic escape hatch. Stated plainly in docs.
- **crt.sh unreliability** → the monitor tolerates non-200/empty (returns `checked:0`, never throws); Cert-Spotter is the production source.
- **Nonce DB growth** → `consume` deletes on use; periodic `sweep()` + the rate-limiter bound it.

## 4. Test strategy
- `verify:provision` — extend: a nonce issued via one control-plane object is consumed (once) via a SECOND object sharing the registry DB (HA proof); replay across both fails.
- `verify:dns` (new) — CF/deSEC request shapes for create + delete (stubbed fetch).
- `verify:newproxy-auth` — NA7 concurrent-reject, NA8 clean-reconnect (CloseProxy clears → re-allow), NA9 crash-TTL re-allow, NA10 stale-CloseProxy doesn't clear the new run.
- `verify:ct-monitor` (new) — mocked crt.sh JSON: legit (LE+known serial) passes; wrong-issuer + LE-unknown-serial flagged.
- `cargo check` (Rust + libc, with sidecar stubs). `portal build` unaffected. Full remote gate must stay all-GO.
- **Operator smoke (cannot CI):** real CF/deSEC DNS; a real frpc reconnect/crash exercising CloseProxy/TTL; a real SIGKILL leaving orphans the launch-reaper cleans; crt.sh/Cert-Spotter against the live zone; LE honoring the CAA record.

## 5. Implementation order
1. **R-A + R-D** (registry/control-plane): nonces table + active-proxy cols + hook + frps.toml; `verify:provision` (HA) + `verify:newproxy-auth` (NA7-10).
2. **R-B**: `verify:dns`.
3. **R-E**: ct-monitor + CAA docs; `verify:ct-monitor`.
4. **R-C**: Rust reaping; `cargo check`.
5. Full remote gate + cargo check + portal build; wire new verifies into the chain; update living docs.

## 6. Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| CloseProxy race clears legit slot | Med | Med | compare-and-clear on run_id (designed); NA10 test |
| Ping write churn (DB) | Low | Low | one tiny UPDATE / ~30s / tenant; throttle if needed |
| Reaper kills innocent reused PID | Low | High | `ps comm` image match before kill |
| libc/process_group breaks non-unix build | Low | Med | `#[cfg(unix)]` gate; cargo check |
| CT-monitor false sense of security | Med | Med | docs state detection-not-prevention; Cert-Spotter for prod |

## 7. Verification table
| # | Load-bearing assumption | Verified at |
|---|---|---|
| 1 | CloseProxy fires w/ `user.run_id`, notification-only, async | **EXTERNAL:** frp `pkg/plugin/server/types.go`,`manager.go`,`server/control.go` (Sweep A) |
| 2 | run_id new on reconnect; in Login/NewProxy/CloseProxy/Ping | **EXTERNAL:** frp `pkg/msg/msg.go`,`plugin.go` (Sweep A) |
| 3 | `DELETE /api/proxies` prune-offline-only (no force-kill) | **EXTERNAL:** frp `server/http/controller.go` (Sweep A) |
| 4 | frps plugin endpoint unauthenticated → isolate | **EXTERNAL:** frp `pkg/plugin/server/http.go` + doc (Sweep A) |
| 5 | crt.sh JSON fields + 60/min/502; Cert-Spotter cursor API | **EXTERNAL:** crt.sh + sslmate docs (Sweep B) |
| 6 | CAA tree-climbs; LE honors accounturi+validationmethods | **EXTERNAL:** RFC 8659 + letsencrypt.org/docs/caa (Sweep B) |
| 7 | process_group(0)+kill(-pgid) reaps group; no macOS PDEATHSIG; reap at RunEvent::Exit | **EXTERNAL:** Rust std + Apple kill(2)/setpgid(2); man7 PDEATHSIG; Tauri RunEvent (Sweep C) |
| 8 | registry handles table + claim/finalize/release + `db` exposed | **read:** mycelium-managed/src/registry.js |
| 9 | nonce store interface (issue/consume/sweep/startSweeper) | **read:** mycelium-managed/src/nonce.js |
| 10 | relay-hook authorizeLogin/NewProxy + createRelayHook dispatch | **read:** mycelium-managed/src/relay-hook.js |
| 11 | server.js wires nonces + hook + rate-limit + reserved | **read:** mycelium-managed/src/server.js |
| 12 | dns.js createHandleRecords/deleteHandleRecords (cf/desec) | **read:** mycelium-managed/src/dns.js |
| 13 | main.rs child set + spawns + Destroyed + `.run(generate_context!())` | **read:** src-tauri/src/main.rs |
