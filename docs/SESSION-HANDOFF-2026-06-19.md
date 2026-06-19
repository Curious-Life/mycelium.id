# Session Handoff — 2026-06-19 (key-handling hardening · at-rest boot fix · federation audit start)

**Date:** 2026-06-19
**Audience:** the next Claude Code instance (likely a fresh/compacted context) picking up this work.
**Companions:** memories [[at-rest-boot-congestion-collapse]], [[key-handling-security-audit]]; predecessor `docs/SESSION-HANDOFF-2026-06-18-master.md`; `docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md`; federation design `docs/FEDERATION-SHARING-DESIGN-2026-06-17.md`.

---

## TL;DR — what shipped, what's live, what's next

| Stream | State | Where |
|---|---|---|
| **At-rest boot hang FIXED** | ✅ MERGED `#270` (`39777b7`) + **rebuilt + installed + LIVE-CONFIRMED** | `embedBacklog` SWR cache |
| **Key-handling hardening + pipeline at-rest keying** | ✅ MERGED `#267` (`13b6373`) | adapter guard, pipeline `getDb`+`dbKeyHex`, recovery-key no-store, generic 500s, backup 0600 |
| **Dead System-B passkey/PRF code removed** | ✅ MERGED `#269` (`0ff3273`) | login + SettingsView + 2 server namespaces + passkey-prf.ts |
| **App rebuilt from main + deployed** | ✅ installed `/Applications/Mycelium.app` (built 2026-06-19 01:21 from `39777b7`) | boots responsive: `:8787` up t+76s, idle/instant by t+129s |
| **Federation security audit** | 🟡 1 of 3 slices done (signing/DID core = PASS); space-access + Matrix/egress QUEUED | this doc §Federation audit |
| **#269 live login/settings browser smoke** | ⏳ pending (svelte-check+build passed; real-browser pass not done) | needs portal running |
| **Residual boot blips** | ⏳ follow-up (minor, non-blocking) | maintained counter / partial index |

**The app is usable again.** Everything this session is on `main` (which has since advanced to `89e3325` via another session's #271 measurement/narration hardening — unrelated; not in the installed build, comes in the next rebuild).

---

## What shipped this session (all MERGED to main, CI green)

| PR | Commit | Scope |
|---|---|---|
| **#269** | `0ff3273` | Remove dead "System-B" WebAuthn-PRF/URK/master-key-restore code (~2033 deletions). Routes had NO server handler (inert); latent footgun = a client path that POSTed the raw master key to a non-existent route. Deleted `src/db/passkeys.js`, `src/db/step-up-tokens.js`, `portal-app/src/lib/passkey-prf.ts` (+2 tests); excised System-B fns/markup from `login/+page.svelte` + `SettingsView.svelte`. **Relocated the LIVE recovery (`goto('/setup')`) + Telegram buttons into the operator block** (they shared markup with dead branches — the trap). Live System-A (better-auth passkey, operator/telegram login, `/api/v1/account/*`) untouched. |
| **#267** | `13b6373` | (a) `adapter/d1.js` **fail-closed guard**: refuse to open an at-rest vault unkeyed (clear error vs deep SQLITE_NOTADB). (b) **6 pipeline stages keyed**: `getDb`+`loadKey`+`resolveDbKeyHex` (discover-claims, describe-clusters, describe-chronicles, snapshot-entities, sync-clustering-points, local-write-bridge) — fixes the boot-time `SQLITE_NOTADB` crashes. (c) `run-clustering.sh` starts `vault-bridge` + exports `MYCELIUM_DB_BRIDGE_URL` for the Python stages when at-rest. (d) `GET /recovery-key` + `/setup` `Cache-Control: no-store` + reveal audit line. (e) 500s no longer echo raw `err.message` (`sanitizeErr`). (f) backup temp snapshot `chmod 0600`. |
| **#270** | `39777b7` | Boot hang fix. `embedBacklog()` stays **pure** (preflight + onboarding `showWelcome` + tests need fresh); new `embedBacklogCached()` (serve-stale-while-revalidate + single-flight) for the POLLED surfaces (activity feed @2.5s, processing-status, compat, boot-warm). |

---

## What was LEARNED (the most valuable lines — corrections to the prior diagnosis)

1. **The boot hang was NOT the search index build** (the 2026-06-18 master handoff + `at-rest-search-build-perf` blamed it). **VERIFIED FALSE** by live instrumentation: `corpus_built=TRUE`, the on-disk backend is selected and SKIPS the build. Also REFUTED: "key_mismatch" (vault opens fine), "in-RAM fallback", "dual-boot search race".
2. **The real cause = event-loop congestion collapse.** The activity feed polls `/portal/activity` **every 2.5s** → `embedBacklog`, a full-table COUNT/SUM scan over the encrypted `messages` table = **6.1s of SQLCipher page-decrypt that blocks the single Node thread**. 6s service time × 2.5s arrival → unbounded queue. Smoking gun: identical `secrets` query (6 rows) climbing 4.6s→43s as the queue grew. Mindscape's 16–42s "decrypt" was congestion *inflation*, not real cost (it's flag-guarded one-time, not polled).
3. **Caching the count primitive was wrong** — `embedBacklog` also gates correctness (Generate preflight, onboarding `showWelcome: total===0`). First attempt cached it directly → broke `verify:portal-tps` O1 (stale count after import). Fix: pure primitive + a separate cached accessor for polled callers only.
4. **`boot()` is the wrong opener for spawned pipeline stages.** First #267 attempt converted them to `boot()` (matching the compute-* stages) → broke `verify:describe-gating` (G1–G6): `boot()` runs `initVaultStorage` (schema + cross-process migration LOCK) + builds domains, which deadlocks/alters state when a parent (the test, or the live app) already holds the vault. Correct minimal fix = `getDb`+`loadKey`+`resolveDbKeyHex` (behavior-preserving, just adds the cipher key).
5. **Key-handling audit verdict: the LIVE V1 path has NO vault-key leak.** Strong discipline (keys via child env not argv, `timingSafeEqual`, hash-prefix-only logging, fail-closed). Accepted boundaries (single-user local): master key pinned to `process.env` (`#4`, documented), `vault-bridge` loopback-only no peer-uid token (`#7`), `security -w` argv (`#8`). See [[key-handling-security-audit]].

---

## Operator's directional calls this session
- **Multi-user direction = FEDERATION ONLY** (sovereign vaults connecting cross-instance via Matrix E2E + signed surfaces), NOT multi-tenant shared-host. So #7/#8 stay accepted local boundaries; the security work is federation hardening (this is what the queued audit covers).
- **Merge to main + rebuild from main** (chosen over hot-patch). Done.
- **Do the federation audit** — but write this handoff + compact first; resume the audit in the fresh session.

---

## Federation security audit — STARTED, 1 of 3 slices done

Read-only audit of the federation/shared-spaces surface (the real "multi-user" security work). Surface on main: `src/federation/{did,sign,handlers,router,lexicon,ssrf,matrix-client,matrix-egress,space-sync}.js` + `src/db/{connections,spaces,space-access,space-*}.js` + `src/tools/{federation,spaces}.js`. Built: did:web/WebFinger + ed25519 signing/verify + signed inbound `/federation/connect` + SSRF guard + connection/space storage. **Matrix E2E client = inert STUB** (MockMatrixClient; real client wired at deploy). **Phase-3 signed CONTENT serve + SMPC matching = design-only (not built).**

**SLICE 1 — signing / DID / inbound-connect = ✅ PASS (verdict: the trust core is sound).** Findings (all LOW/MED, none HIGH):
- **F1 (MED):** `handlers.js:81` verifies over a re-`canonicalize()`d JSON, not the raw received bytes; `sign.js:25-30` `canonicalize` is not RFC-8785 JCS (would mis-handle floats/`1e3`/`-0`/dup keys). Not exploitable with current integer/string payloads, but a latent footgun → verify over raw body or use real JCS.
- **F2 (LOW):** `seenNonces` is in-memory (`handlers.js:46`); a process restart within the 5-min ts window lets a replay through. Bounded + idempotent.
- **F3 (LOW):** no domain-separation prefix in signed bytes; same USER_MASTER-derived ed25519 key signs federation + publish-links + managed-claim (distinct framing today, add a `myc-fed-v1` prefix).
- **F4 (LOW):** did:web resolution honors only `verificationMethod[0]` (`did.js:191`); fine for self-issued single-key docs.
- **F5 (CHECK):** body cap enforced after `express.json()` parse — confirm the JSON mount has a `limit`.

**SLICE 2 — space access-control + revocation = QUEUED (not run).** Audit `src/db/space-access.js`, `spaces.js`, `space-knowledge.js`, `space-conversations.js`, `space-room-documents.js`, `space-rooms.js`, `connections.js`, `tools/spaces.js`, `federation/space-sync.js`. Questions: server-side membership/role check before serve (fail-closed?), revocation actually stops serving (leakage-guard like publish S15?), cross-space isolation (IDOR on space_id/room_id?), the Phase-3 "signed content serve" gap (is cross-instance content currently authenticated?).

**SLICE 3 — Matrix E2E seam + egress + SSRF = QUEUED (not run).** Audit `matrix-client.js` (is the stub safe to ship inert? does the real-client contract mandate Megolm + device verification?), `matrix-egress.js`, `ssrf.js` (every outbound fetch IP-pinned + redirect-revalidated?), the explicit-send egress chokepoints (CLAUDE.md §11 — does shared content egress go through a chokepoint, not free-form agent output?).

---

## Production / deploy state

- **Installed app:** `/Applications/Mycelium.app` rebuilt 2026-06-19 01:21 from main `39777b7` (has #267/#269/#270; NOT #271). Old bundle backed up at `/Applications/Mycelium.app.pre-bootperf-*`.
- **Vault:** `~/Library/Application Support/id.mycelium.app/mycelium.db` — at-rest SQLCipher, OPEN, 69,454 messages intact, `corpus_built=true`.
- **Live boot result (monitored):** `:8787` first responds t+76s, fully responsive + idle (0.002s, CPU~0) by t+129s. `/portal/activity` 1.9ms. account/status `open:true bootError:null`.

**Verify the live app (run first on pickup):**
```
curl -s --max-time 8 http://127.0.0.1:8787/api/v1/account/status        # {"open":true,...,"bootError":null}
curl -s -o /dev/null -w "%{time_total}s\n" http://127.0.0.1:8787/api/v1/portal/activity   # should be ~ms, not seconds
git -C /Users/altus/Documents/GitHub/mycelium.id log --oneline origin/main -4   # 89e3325 / 39777b7(#270) / 13b6373(#267) / 0ff3273(#269)
```

---

## Gotchas + lessons (2026-06-19)
- **`ensure-portal-built.mjs` can SKIP a stale build** → the bundle ships a STALE UI (it shipped a 19:31-yesterday build over today's source). **FORCE `npm --prefix portal-app run build` before `cargo tauri build`.** (Same class as `portal-fresh-install-old-ui`.)
- **`cargo tauri build --bundles app` did NOT skip the DMG** in tauri-cli 2.11.2 (config `bundle.targets` won); the DMG step (`bundle_dmg.sh`) can hang. **Set `tauri.conf bundle.targets: ["app"]` for the build, revert after** (the `.app` is the deliverable; build it app-only).
- **`nohup cargo tauri build &` inside a Bash wrapper got killed** when the wrapper returned. Use the harness `run_in_background: true` for long builds.
- **Build from a fresh `origin/main` checkout** (the master-handoff lesson). The main tree was reset `--hard origin/main` (no tracked changes lost; only untracked docs). `.build-cache/runtime-arm64` reused → fast (~3-5 min).
- **`verify:account`/`backup`/`vault-transparency` SKIP in CI** (no Keychain on Linux) → #267's account/router + backup changes aren't CI-tested; rely on local `verify:account` 18/18 + `verify:backup` 30/30 (Keychain present on the Mac).
- **macOS `date +%N` unsupported** — boot-monitor v1 failed on it; use `curl -w "%{time_total}"`.

---

## Open decisions / threads for the operator
1. **Resume the federation audit** (slices 2 + 3 above). Recommendation: run both as parallel read-only agents like slice 1, then synthesize + fix the F1 (canonicalize/raw-bytes) MED in the signing core.
2. **#269 live login/settings browser smoke** — confirm System-A passkey + recovery-key reveal + backup still work in a real browser (the deploy-and-verify auth rule). Best done against the running portal.
3. **Residual boot blips (minor):** the ~per-60s `embedBacklogCached` revalidate + the 15s pollers' other counts cause occasional 2-3s hitches (recover to instant, not a hang). A maintained O(1) embed counter (on insert/embed/forget) or a partial index removes even those. Low priority.
4. **Cleanup owed:** 3 merged worktrees can be removed — `mycelium-worktrees/{boot-perf, key-hardening, systemb-removal}` (+ their local branches). Other-session open PRs (#272 hook-bus, #273 stage-names, #258 link, #253 at-rest-purge, #188 inert) are not this thread's.

---

## Pickup protocol (execute in order)
1. Read this handoff cold. `git fetch`; confirm `origin/main` has #267/#269/#270 (hashes above).
2. Verify the live app with the §Production probes (account/status open, /portal/activity in ms). If the app isn't running, `open -a Mycelium` and re-probe (expect responsive by ~t+130s).
3. **Resume the federation audit** — fan out slices 2 (space access-control) + 3 (Matrix/egress/SSRF) as read-only general-purpose agents (slice 1 = signing core, already PASS; findings above). Synthesize → fix F1 + any HIGH/MED found.
4. For any structural change: `/sweep-first-design`. After any ship: `/deploy-and-verify` (run the changed-surface `verify:*` gate to GO before merge — never on a subset). Before any delete: `/pre-deletion-caller-audit`.
5. Skills that fired this session: `/handoff-discipline` (this doc). The 3 fixes used live instrumentation + before/after benchmarks on the real vault as the evidence standard.
