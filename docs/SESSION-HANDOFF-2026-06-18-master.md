# Master Session Handoff — 2026-06-18

**Date:** 2026-06-18
**Audience:** the next Claude Code instance (likely on a NEW account) picking up this work.
**Why this doc:** continuation moves to a new instance/account, so the durable record must live in the repo (git carries across accounts; the local `~/.claude` memory may not). Read this cold, in full, before touching anything.

**Companion docs (on main):** `docs/AGENT-NARRATION-DESIGN-2026-06-18.md` (narration spec, PR #264), `docs/REALM-K-CLUSTERING-FIX-DESIGN-2026-06-17.md`, `docs/V1-BUILD-SPEC.md`, `docs/ARCHITECTURE.md`.

---

## TL;DR — what's done, what's live, what's parked

| Stream | State | Where |
|---|---|---|
| **Narration system (Phases 1–3 + v4 metrics + reflect-permission)** | ✅ MERGED to main | PRs #236 #240 #243 #245 (+ spec #264) |
| **Gift-phase removal (UI badge)** | ✅ MERGED + live vault scrubbed | PR #230 |
| **Measurement-only refresh (no re-cluster) + ` UTC` timestamp fix** | ✅ MERGED | PR #250 |
| **"Refresh analysis" UI button** | ✅ MERGED | PR #252 |
| **Pipeline-failure UX transparency (vault state, named stages)** | ✅ MERGED | PR #262 |
| **Narration design spec on main** | 🟡 PR #264 open (docs-only, awaiting CI) | `design/agent-narration` |
| **Live vault** | ⚠️ at-rest ENCRYPTED, app booting — recovery status UNCONFIRMED | see §Vault incident |
| **Re-enabling Generate / running the analysis engine live** | ⛔ PARKED (operator) — vault must open first | §Parked |
| **Native agent harness (Steps 1–4a)** | 🟡 pushed this session (was unpushed!), 4b–7 pending | `feat/native-agent-harness` |

**Everything this session built is merged and CI-green except the docs-only spec (#264).** The one operational risk that existed (an unpushed 85-commit harness branch) is now pushed. No uncommitted real work is at risk (the "dirty" worktree files are all build artifacts).

---

## 1. What shipped this session (all MERGED to main, CI green)

| PR | Commit theme | Scope |
|---|---|---|
| #230 | `fix(mindscape): remove legacy 'gift' phase` | schema default `'gift'`→NULL + idempotent migration 0020 + UI guards; **live vault scrubbed (309 rows gift→NULL)** |
| #236 | `feat(narration): Phase 1 — Context Capsule` | `pipeline/lib/narrate-context.js`: temporal coverage (new cols `described_period_start/end`, migration 0021) + activity histogram + connected-by-name. `verify:narrate-context` |
| #240 | `feat(narration): Phase 2 + v4 metrics` | `src/tools/narration.js` MCP domain (`getEntityContext` read + `describeEntity` write) reachable MCP+REST+harness; `src/agent/narration-walk.js` agent walk; capsule `metrics` block (vitality/phase/fisher/coherence). `verify:describe-entity-tool`, `verify:narration-walk` |
| #243 | `feat(narration): permission to reflect` | every prompt now lets the agent leave a description unchanged if nothing changed; walk counts described/reflected/skipped |
| #245 | `feat(narration): Phase 3 — UI control` | `narration_runs` table (migration 0022) + pausable job (`startNarrationWalkJob`) + routes + `NarrateControl.svelte`. `verify:narration-job` |
| #250 | `feat(pipeline): measurement-only refresh` | `MYCELIUM_MEASURE_ONLY=1` skips cluster/describe; `startMeasurementJob` (kill-switch-exempt); `POST /portal/mycelium/measure`; **fixed ` UTC`-timestamp crash** in harmonics/coherence/behavioral. `verify:measure-only` |
| #252 | `feat(mindscape): 'Refresh analysis' button` | `MeasureControl.svelte` |
| #262 | `feat(ux): transparent pipeline failures` | classified `bootError` (key_mismatch/at_rest_migration_failed/boot_failed) on `/account/status` + distinct 503 reason + setup-screen recovery banner; named stage failures ("Step 7/16 (Fisher) failed"); measure stall/done/error UX. `verify:vault-transparency` |

**Narration feature is COMPLETE** (P1 capsule + P2 tools/walk + P3 UI + v4 metrics + reflect). It is INERT until Generate runs with a configured narrate provider. New verify gates wired into the master chain: `narrate-context`, `describe-entity-tool`, `narration-walk`, `narration-job`, `measure-only`, `vault-transparency`.

---

## 2. ⚠️ Live vault — at-rest incident + recovery (READ BEFORE RUNNING THE APP)

**The finding (a real product gotcha, 2026-06-18):** the packaged Tauri build hardcodes `MYCELIUM_AT_REST=1` (`src-tauri/src/main.rs:275,340`), so on launch it **encrypts the whole vault to SQLCipher**, deriving the file-key from the **Keychain** master. But this vault's Keychain master **does not match** the vault's column data (the canonical-import re-key — `USER_MASTER KCV failed`). Result: the file got encrypted with the (wrong) Keychain-derived key while the columns are under the user's real key — a **contradictory key state** the single-key app model can't open. The user normally unlocks by pasting their recovery key (held in session memory only); the Keychain copy is stale/wrong.

**What happened this session:** rebuilding from main + relaunching the packaged app encrypted the live vault and then couldn't reopen it (showed "vault_not_initialized"). A full **plaintext backup** was auto-kept by the migration (`mycelium.db.pre-cipher-*`), verified intact (69,551 messages / 61,222 clustering points / 1,725 territories). A restore was **blocked by policy** (don't swap the user's vault autonomously). The operator chose to make at-rest work rather than revert.

**State as of this handoff (UNCONFIRMED — re-verify):** `~/Library/Application Support/id.mycelium.app/mycelium.db` is **2.6 GB, SQLCipher-encrypted** (header = random bytes, not `SQLite format 3`), with an active ~141 MB WAL; the app (`/Applications/Mycelium.app`, pid was 5993) is **running but the server on `:8787` was mid-boot / not responding** when last probed. The earlier `pre-cipher`/`failed-enc`/`at-rest-encrypted-*` backups are **no longer present** (likely cleaned after a recovery attempt). This looks like a recovery-in-progress; whether the vault now opens cleanly is **not confirmed**.

**The ONLY clean way at-rest works on this vault:** the Keychain must hold the **correct** master key (the user's recovery key). Sequence: (a) restore a plaintext vault (columns under the real key), (b) update the Keychain to the correct master, (c) relaunch so at-rest re-encrypts with the MATCHING key. Step (b) is an operator action (their credential — never handle it for them).

**Pickup verification (run first):**
```
curl -s --max-time 6 http://127.0.0.1:8787/api/v1/portal/mycelium/processing-status
#   real JSON {embedded,total,...}  → vault OPEN, recovery succeeded
#   {"error":"vault_locked","reason":"key_mismatch",...} → still broken (key mismatch)
#   timeout/empty → server still booting (index build); wait + retry
head -c 16 "$HOME/Library/Application Support/id.mycelium.app/mycelium.db" | xxd
#   "SQLite format 3" → plaintext;  random bytes → at-rest encrypted
```

---

## 3. Active branches / worktrees inventory (the landscape)

All branches below are **pushed to origin** unless noted. Local `main` worktree is behind origin/main (`196834e`) and contested by concurrent sessions — **always work in an isolated worktree, never the shared main tree** ([[concurrent-session-collision]]).

| Branch | Status | Notes |
|---|---|---|
| `design/agent-narration` | PR #264 open (docs-only) | the narration spec; merge when green |
| `feat/native-agent-harness` | **pushed this session** (was unpushed!) | Phase-5 harness Steps 1–4a built+gated; 4b–7 pending. Spec `docs/NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md` |
| `feat/at-rest-purge-backup` | PR #253 OPEN, **CONFLICTING/DIRTY** | purge plaintext pre-cipher backup after keyed reopen; needs rebase |
| `fix/at-rest-reap-plaintext-backup` | pushed, no PR | at-rest backup reaping |
| `claude/at-rest-cipher` | PR #188 OPEN (INERT) | whole-file SQLCipher groundwork; boot-wiring deferred |
| `fix/at-rest-migration-lock` (search-phase1 wt) | pushed | race-safe at-rest migration lock |
| `fix/document-search-encrypted-text` | pushed | doc-search encrypted-concat fix |
| `fix/single-portal-ui`, `fix/verify-nav-legacy-portal`, `fix/unify-settings-user-button`, `fix/prerelease-feedback` | pushed | prelaunch/UX/prerelease fixes (other sessions) |
| `claude/kokoro-auto-runtime`, `claude/local-tts`, `claude/prelaunch-ux-v2` | pushed | TTS / UX work (other sessions) |
| `docs/at-rest-perf-handoffs` | pushed (#263 merged) | at-rest perf handoffs |

**Other open PRs (not this session's, status noted):** #258 `fix/curious-life-link` (docs link), #253 (conflicting, above), #188 (inert, above). I did **not** merge these — they belong to other work streams and aren't clearly ready.

---

## 4. Remaining work (this session's threads)

**Narration — UX-audit follow-ups (deferred from #262, gap analysis in PR #262 body):**
- **Gap #3 — silent partial data:** JS measurement stages (cofire/vitality) `catch→log→continue→exit 0`, so a stage can half-fail and report "done." Add per-stage failure counting + surface "N scored, M skipped"; exit nonzero on high failure rate. Files: `pipeline/compute-cofire.js`, `pipeline/compute-vitality.js`.
- **Gap #4 (rest) — activity-feed transparency:** the `stalled` flag is set but not shown in the header chip; a finished job's chip just vanishes (no success confirmation). Files: `portal-app/src/lib/components/shell/Header.svelte`, `src/portal-activity.js`.

**Narration — implementation polish (designed, not built):** realm-level chronicles via the agent; the v4 **pipeline reorder** (run analysis stages BEFORE describe — specified in the spec, deferred to testing).

**Run the analysis engine live (the original goal):** once the vault opens, `POST /portal/mycelium/measure` (or click "Refresh analysis") refreshes vitality/phase/cofire/coherence on the current **21 realms / 50 themes / 372 territories** (realms currently unnamed — that's narration's job). Metrics were stale/misaligned (cofire from May-05, ~65% of edges on dead territories; `territory_neighbors` empty). NOTE: the running app's key lives in session memory; the measure job uses `getSessionKeys()`, so it must run **through the app**, not standalone ([[measure-only-and-key-blocker]]).

---

## 5. Parked work (from prior sessions, low urgency)

- **Embedding storage layout** — `embedding_768` stored at 2.43× (base64-on-base64); ~306 MB waste on the 69k vault. Fix = binary envelope; cross-language JS↔Python codec migration. Handoff `docs/EMBEDDING-STORAGE-LAYOUT-HANDOFF-2026-06-18.md`.
- **Parallel decrypt build** — proven 5.2× scan but bounded value; parked. `docs/PARALLEL-DECRYPT-BUILD-HANDOFF-2026-06-18.md`.
- **Touch ID / Secure Enclave unlock** — designed + decisions locked, NOT built (needs a real-Mac SE/LAContext session). `docs/DESIGN-touch-id-secure-enclave-unlock-2026-06-18.md`.
- **macOS signed distribution** — DMG CI + at-rest default-on merged (#228/#233); pending GH secrets + first `v*` tag + 2-Mac clean-install test.

---

## 6. Gotchas + lessons (dated 2026-06-18)

- **Packaged build forces at-rest ON** (`main.rs:275,340` `MYCELIUM_AT_REST=1`). On a vault whose Keychain key ≠ vault key, this **bricks open** (encrypts with wrong key). The `index.js` default is OFF, but the packaged env overrides it — don't trust the JS default when reasoning about the shipped app.
- **This vault's Keychain master ≠ vault master** — `resolveKeys({keychain})` → boot → `USER_MASTER KCV failed`. `deriveSystemKey(userHex)` is ALSO wrong (system key is stored independently, not HKDF-derived). Pipeline scripts can't boot standalone; the working key is in the running app's session memory only.
- **Building from the shared main tree compiled STALE code** — local `main` was 38 behind + diverged 25 ahead; a Tauri build staged it and shipped yesterday's code. **Always build from a fresh worktree at `origin/main`** with `npm ci` (root + portal-app) + copy `src-tauri/binaries/` sidecars; `cargo tauri build --bundles app` (skips the DMG step that hangs).
- **Tauri build:** `--no-bundle` does NOT produce the `.app`; use `--bundles app`. A partial `.build-cache` from a killed run makes the staging script's `rm` fail ("Directory not empty") — clear `.build-cache` + `build-staging` before retry.
- **GitHub Actions had an infra outage ~10:14–10:17** (2-second no-step failures across main + 4 branches). Re-running once it cleared went green. Don't chase 2s/no-step failures as code bugs.
- **The classifier (correctly) blocks autonomous vault swaps + keychain enumeration.** Vault-file restores and `security` key reads beyond the app's own boot path need explicit operator direction.
- **`gh pr merge --delete-branch` fails** when the branch is checked out in a worktree ("'main' is already used by worktree"); the merge still succeeds — just clean the worktree separately.

---

## 7. Open decisions for the operator

1. **Vault recovery (parked):** confirm whether the at-rest vault now opens (probe in §2). If not — restore plaintext + fix the Keychain master + relaunch. Decide: keep at-rest encryption (needs the Keychain-key fix) or run a build without forced at-rest.
2. **Merge #264** (narration spec, docs-only) once CI green.
3. **Other sessions' open PRs:** #253 (rebase the conflict), #188 (inert — close or wire?), #258 (docs link — merge?). Not this session's call to make.
4. **Narration go-live:** when the vault is healthy + a narrate provider is set, run a measure refresh, then a scoped narration walk on a copy to A/B the agent vs. deterministic describe before adopting.

## 8. Pickup protocol (execute in order)

1. Read this handoff cold. Don't skim §2.
2. `git fetch origin` → confirm `origin/main` and the branch table in §3.
3. **Verify the live vault** with the §2 probe before launching/relaunching the app. If it's mid-boot, wait; if `key_mismatch`, follow the recovery sequence (operator does the Keychain key).
4. Confirm this session's work is on main: `gh pr view 236 240 245 250 262 --json state` → all MERGED.
5. For any new structural work: `/sweep-first-design`. After any ship: `/deploy-and-verify` (run the `verify:*` gate for the changed surface). Before any delete/rename: `/pre-deletion-caller-audit`.
6. If picking up narration follow-ups: start with gap #3 (`pipeline/compute-cofire.js`/`compute-vitality.js` failure counting) — self-contained + gateable.
7. **Never edit the shared `mycelium.id` main tree directly** — make a worktree off `origin/main` (`git worktree add ... -b <branch> origin/main`), commit + push early.

---

*Skills that fired this session: `/sweep-first-design` (narration P1–3 designs), `/deploy-and-verify` (every PR gated), `/handoff-discipline` (this doc).*
