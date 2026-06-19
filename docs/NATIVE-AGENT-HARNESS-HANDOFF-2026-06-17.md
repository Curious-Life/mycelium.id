# Native Agent Harness — Handoff Doc

**Date:** 2026-06-17
**Companions:** [`docs/NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md`](NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md) (authoritative spec, 13 subsystems, verification table) · [`docs/NATIVE-AGENT-HARNESS-DESIGN-2026-06-17.md`](NATIVE-AGENT-HARNESS-DESIGN-2026-06-17.md) (v1 design summary)
**Audience:** the next Claude Code instance picking up this work.
**Skills fired this session:** `/sweep-first-design` (3 sweep cycles → the spec), `/handoff-discipline` (this doc).

---

## ⚠️ READ FIRST — where the work lives

All harness code is in an **ISOLATED GIT WORKTREE**, NOT the main tree:

```
~/Documents/GitHub/mycelium-worktrees/native-agent-harness   ← branch feat/native-agent-harness
```

The main tree (`~/Documents/GitHub/mycelium.id`) is on `main`. **Why:** a concurrent Claude session sharing the main tree clobbered uncommitted edits mid-session (see [[concurrent-session-collision]]). The worktree isolates this work. `node_modules` is symlinked from the main tree. **Run all gates + edits inside the worktree.** Branch is based on `ead54c9` (federation-sharing Phase 1, the prelaunch lineage — so it has migrations through 0017).

---

## TL;DR — current state

Spec → 7 build steps. **Steps 1–4a shipped, committed, gated. 4b → 7 remain.**

| Step | Commit | Status | What |
|---|---|---|---|
| 1 | `15ca725` + `51d70b1` | ✅ | `loop.js` turn-driver; portal-chat rewired onto it (behavior-preserving, −34 LOC) |
| 2 | `84adb2d` | ✅ | `0018_harness.sql` + `db/harness.js` DAL (tasks/runs/summaries + recovery/dedup); prompt+summary **encrypted at rest** |
| 3 | `16f2a14` | ✅ | `compaction.js` (full algo) + odysseus tool-output cap in streamTurn |
| 4a | `28fd16a` | ✅ | `scheduler-time.js` — DSL parse + `computeNextRun` (tz/cron/clamp) |
| 4b | `391599c` | ✅ | scheduler **runtime**: `scheduler.js` tick + `lane.js` Semaphore(1) + boot start + delivery |
| 5 | `fc89ac7` | ✅ | gated autonomy tools (`schedule_task`/`list_my_schedules`/`cancel_task`) + `autonomy-tools.js` opt-in grant; wired into the scheduler |
| 6 | `f5a30d1`·`378741e`·`39b9e67`·`ae622da`·`485c526`·`f8bed2d` | ✅ | channel adapter (H11 server-side turn): DAL+untrusted → `runAgentTurn` refactor → loopback endpoint → cross-turn compaction live → triage → daemon native forwarder |
| 7 | `2e2120c`·`2b9a610`·`ebb66eb` | ✅ | resilience: provider-fallback + jittered backoff → tool-loop circuit-breaker → `'harness'` task + chain wire + daily-budget gate |

**🎉 ALL 7 STEPS COMPLETE — the native agent harness is feature-complete.** 29/29 harness + neighbour gates GO. Remaining work is operator live-smoke (not code): activate the channel native backend + the scheduler against the running app.

**Gates (ALL GREEN, run in the worktree):** `verify:harness` · `verify:harness-loop` (16/16) · `verify:harness-state` (S1–S8, encryption-at-rest proven via raw reads) · `verify:harness-compaction` (K1–K10) · `verify:harness-schedule` (T1–T10) · `verify:chat` (C1–C9) · `verify:keysource` · `verify:account` · `verify:backup`.

---

## 2026-06-17 session summary — start here when picking up

### What shipped
| Commit | Scope | Description |
|---|---|---|
| `15ca725` | docs + `src/agent/loop.js` + `scripts/verify-harness-loop.mjs` | The locked design + full verified spec; the transport-agnostic turn-driver core. |
| `51d70b1` | `src/portal-chat.js` | Rewired the chat route onto `loop.run` (watchdog + retry now in the loop). Behavior-preserving. |
| `84adb2d` | `migrations/0018_harness.sql`, `src/crypto/crypto-local.js`, `src/db/harness.js`, `src/db/index.js`, `scripts/verify-harness-state.mjs` | State layer + DAL + recovery + encryption-at-rest. |
| `16f2a14` | `src/agent/compaction.js`, `src/agent/harness.js`, `scripts/verify-harness-compaction.mjs` | Auto-compaction module + in-turn tool-output cap. |
| `28fd16a` | `src/agent/scheduler-time.js`, `scripts/verify-harness-schedule.mjs` | Wake-cycle DSL + next-run math. |

### What was learned (most important lines)
- **The egress chain is ALREADY fully wired + operational in V1.** Channel auto-reply runs its own agent loop **inside `packages/channel-daemon`** on the **Claude Agent SDK** (`agent/backends/claude-sdk.js:72`), with `/{platform}/send` + `/internal/inbound-context/current` + active-turn registry served by the daemon (`channel-daemon/server.js:36-52`), `AGENT_URL` auto-set to the daemon (`server-rest.js:335-337`), reply tool registered when set (`mcp.js:135-138`). So `reply.js` reuse is REAL — and Step 6 is a *reconciliation* (swap the daemon's engine), not a from-scratch build. **Decision H11 (locked):** core-as-library — one `streamTurn` engine + MCP registry as the universal tool contract + pluggable `call` (in-proc server / loopback-MCP daemon); migrate channels off the SDK.
- **`selectTimeline` does NOT filter by `conversation_id`** (`db/messages.js:596`). History hydration needs a NEW DAL method `selectByConversation(userId, conversationId, {limit, before})` — NOT yet built. Cross-turn summary-compaction wiring waits on it (Step 6).
- **`captureMessage` already gates agent sources** (`capture.js:103`) — channel persistence wiring is known and fail-closed on `agentCapture.enabled`.
- **Compaction reality vs spec:** the spec models compaction on a conversation message history. The as-built `streamTurn` is single-message-in (history rides the getContext preamble), and owns the adapter-specific message array internally. So Step 3 shipped the compaction *module* (pure, tested, neutral message model) + the in-turn tool-output cap; the LIVE cross-turn summary wiring lands when `loop.js` gains multi-turn history threading in Step 6.

### Operator's directional calls
- "Adopt all the good patterns from alternatives — parity or better." Each step's commit message lists which reference patterns it adopted (odysseus/hermes/openclaw/opencode/canonical).
- Build in the isolated worktree; commit + gate each step.
- H11 = core-as-library (migrate channels to the native engine), sequenced as Step 6.

### Pickup protocol for next session
1. Read this handoff cold, then the **spec** (`docs/NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md`) — esp. §5.5 (lane), §5.6 (scheduler), §5.4 (recovery).
2. `cd ~/Documents/GitHub/mycelium-worktrees/native-agent-harness` and confirm branch: `git branch --show-current` → `feat/native-agent-harness`.
3. Re-confirm green: run the five harness gates (commands in "Deploy/verify runbook" below).
4. Build **Step 4b** (the scheduler runtime — see "Next step in detail").
5. Commit + add a `verify:harness-scheduler` gate. Run full `npm run verify` before ANY merge to main.

### Open decisions for the operator
- **None blocking.** H11 is locked. Minor: when Step 6 lands, confirm whether to also migrate the daemon's *Ollama* backend or only the Claude-SDK one (recommendation: replace both with the native streamTurn backend so there's one engine).

---

## 2026-06-17 (later) — Step 4b shipped

**What shipped** (`391599c`): the autonomous scheduler runtime + serial lane, fully gated.
- `src/agent/lane.js` — `createLane()`, a `Semaphore(1)` serial promise-queue (odysseus pattern). A throwing thunk is isolated (settles its own promise, next still runs). NOT used by chat.
- `src/agent/scheduler.js` — `createScheduler({db,userId,tools,handlers,deliver,runTurn?,...})`. `tick()` → `db.harness.dueTasks(now)` → in-memory `executing` set + 30s `wasRecentlyCompleted` dedup (belt-and-suspenders single-flight) → `lane.enqueue(runTask)`. `runTask` opens a run, calls the turn executor (real `buildAndRunTurn` replicates chat's provider/getContext/`call` assembly headlessly with `send:()=>{}` and a **read-safe tool set only**; tests inject a `runTurn` stub), then `finishRun` + `markTaskRun(computeNextRun)` + `deliver`. **Fail-closed:** any throw → `finishRun('error', <code>)` — CODE only, never plaintext/`e.message`. `'once'` past → `completed`. `tickOnce()` is the gate entry point (drains the lane).
- `src/server-rest.js` — boot wiring behind `!injectedKeys`: `reconcileOnBoot()` + `advanceOverdue()` + `scheduler.start()`; `scheduler.stop()` in `closeHandle`. `schedulerDeliver` persists `'chat'`-target output via `captureMessage` (source `'scheduler'`); `'channel:*'` deferred to Step 6.
- `src/db/llm-usage.js` — `'scheduler'` added to `VALID_SOURCES` (was coerced to `'enrichment'`) for honest token attribution.

**Gate** `verify:harness-scheduler` **GO** (L0 + G1–G9, 16/16): serial lane, due-dispatch, single-flight (overlapping ticks fire once), dedup window, once-complete, delivery sink, fail-closed error-codes + no plaintext leak, no-model skip, boot-reconcile, future/paused guard. Regression GREEN: `verify:chat` + `harness/-loop/-state/-compaction/-schedule` + `keysource/account/backup`. All harness step-gates now registered as npm scripts.

**Decisions made this step:**
- Step 4b grants **read-safe tools only** — no `reply`/`schedule_task` (those land in Step 5 via the explicit autonomy-grant helper that bypasses the chat policy). Fail-closed default.
- The **daily-budget gate moved wholly to Step 7** (the build plan floated it in 4b; kept 4b focused on dispatch). `db.usage.summary(...).byDay`/`totals` is the read it will use — no new DAL needed.
- `runTask` uses **fixed-interval ticking** (`setTimeout` recursion, 30s, `.unref()`), matching the drainer/connector supervisors, rather than a dynamic sleep — simpler and the gate drives `tickOnce()` directly. Dynamic-sleep is an optional refinement.

**Next: Step 5** — see the build plan §Step 5. Build `src/tools/schedule-tasks.js` (`createScheduleTasksDomain`) + `src/agent/autonomy-tools.js` (the `AUTONOMY_TOOLS` set + `autonomyTools(registry, enabledNames)` explicit-grant helper) + register in `mcp.js` (handlers exist but keys stay OUT of `DOMAINS`) + `verify:harness-tools`. Then wire `autonomyTools(...)` into the scheduler's `buildAndRunTurn` grant so a task's `enabled_tools` can include `schedule_task`/`reply`.

## 2026-06-17 (later still) — Step 5 shipped

**What shipped** (`fc89ac7`): gated autonomy tools + the opt-in grant, fully gated.
- `src/agent/autonomy-tools.js` — the single source of truth for what an autonomous turn may use. `SAFE_AUTONOMOUS_TOOLS` (read-only) always granted; `AUTONOMY_TOOLS` (`schedule_task`/`list_my_schedules`/`cancel_task`/`reply`) granted only when a task names them. `autonomyTools(registry, enabledNames)` — **fail-closed**, a tool in neither set is never granted. The two sets are disjoint and cover the gated names (asserted in the gate).
- `src/tools/schedule-tasks.js` — `createScheduleTasksDomain({db,userId})`. `schedule_task` validates the cadence DSL (`parseSchedule`) + computes `next_run` + persists (prompt **encrypted at rest**); `list_my_schedules` **never reveals the prompt** (structural fields only — so a compromised reader turn can't exfiltrate other tasks' instructions); `cancel_task`. All soft-fail strings.
- `src/mcp.js` — registers the domain (so handlers exist) but its names stay **out of `DOMAINS`** (tool-domains.js) — registration ≠ grantability; the grant is the control.
- `src/agent/scheduler.js` — `buildAndRunTurn` now grants via `autonomyTools(tools, task.enabled_tools)`; removed the duplicate read-safe set (sourced from `autonomy-tools.js`). A task can opt into `schedule_task`/`reply`; chat can do neither.

**Gate** `verify:harness-tools` **GO** (P1–P7, 18/18): the **chat-exclusion invariant** (chat with ALL domains still cannot grant the schedule tools), opt-in autonomy grant, DSL validation (no write on bad input), encrypted-at-rest (raw-read proof), prompt-safe listing, cancel, once-guard. Regression GREEN: `verify:mcp` (registry builds, no dup names) + `harness-scheduler` + `chat` + `harness` + `gating` + `leak` + `keysource`.

**Decision:** kept the `reply` tool registry-gated by `AGENT_URL` (unchanged) — so even an opted-in scheduled task only gets `reply` when the daemon is present. Proactive channel send still lands in Step 6.

**Next: Step 6** (the big one) — **DESIGN LOCKED** in [`NATIVE-AGENT-HARNESS-STEP6-DESIGN-2026-06-17.md`](NATIVE-AGENT-HARNESS-STEP6-DESIGN-2026-06-17.md) after a 3-sweep pass + 4 own-eyes verifications. **Architecture pivot:** the native channel turn runs ON THE SERVER (new loopback endpoint `POST /internal/agent/channel-turn`, `isTrustedLoopback`-gated), NOT in the daemon (Option A rejected — daemon has no keyed DB, would duplicate the whole inference stack). The daemon's native backend (`createNativeRuntime`) becomes a ~45-LOC HTTP forwarder; the active-turn registry + egress chokepoint + TTS stay untouched. Reuses the Step 4b/5 turn assembly via a factored `runAgentTurn`. Sub-stepped 6a–6f (each gated): `selectByConversation` + `untrusted.js` → `run-turn.js` refactor → `channel-turn.js` endpoint → cross-turn compaction live → `triage.js` → daemon `native.js` backend.

## 2026-06-17 (later still×2) — Step 6 shipped (all of 6a–6f)

The channel adapter, built per the locked Step-6 design (server-side turn, H11). Six sub-steps, each gated:
- **6a** `f5a30d1` — `db.messages.selectByConversation` (conversation-scoped history) + `src/agent/untrusted.js` `wrapUntrusted` (prompt-injection envelope). Gate `verify:harness-channel-dal` (14/14).
- **6b** `378741e` — factored the scheduler's `buildAndRunTurn` into shared `src/agent/run-turn.js` `runAgentTurn`. Behavior-preserving (scheduler gate still GO).
- **6c** `39b9e67` — `src/agent/channel-turn.js` + `POST /internal/agent/channel-turn` (isTrustedLoopback-gated, mounted in `buildVaultSubApp`). Hydrates history, wraps untrusted, grants read-safe+`reply`, soft-fails. Gate `verify:harness-channel` (11/11).
- **6d** `ae622da` — cross-turn compaction LIVE via `src/agent/history.js` `hydrateHistoryBlock` (cheap-path no-call when it fits; summarize+store+prefer-stored-summary when over budget). Gate `verify:harness-channel-compaction` (8/8).
- **6e** `485c526` — `src/agent/triage.js` (DM-always · addressed-group · name-mention fallback · optional model-triage off-by-default · fail-safe skip). Gate `verify:harness-triage` (10/10).
- **6f** `f8bed2d` — `packages/channel-daemon/agent/backends/native.js` forwarder + `selectRuntime` opt-in wire (`MYCELIUM_CHANNEL_ROUTER=native`, default OFF). Gate `verify:harness-channel-native` (10/10).

**Architecture (as-built):** the native channel turn runs ON THE SERVER. The daemon's native backend POSTs the inbound message to `/internal/agent/channel-turn` while holding the active-turn registry open, so the server-run `reply` tool still resolves the target through the daemon's egress chokepoint. One engine (the server's `runAgentTurn`), used by both scheduler and channels.

**Pivots found mid-build (corrections to the design doc):**
- `conversation_id` is the **bare chatId** (`inbound.js:124`, `send-handler.js:172`), NOT `channel:<platform>:<chatId>`. The forwarder + history hydration use the bare chatId so they match persisted data.
- Compaction wiring lives in an injectable `history.js` (not inline in `run-turn`) so it's unit-testable without a configured provider.

**Decisions:** native backend default OFF (SDK/Ollama remain default + rollback); group `addressed` derived as `!group` at the daemon (groups rely on the server triage's name-mention) since the daemon has no mention detector yet; daily-budget gate still deferred to Step 7.

**Regression after Step 6:** all 20 harness + neighbour gates GO (`harness*`, `portal-chat`, `mcp`, `control-loopback`, `channel-presence`, `keysource`, `account`, `backup`).

**Open for the operator (live smoke, needs a running app + daemon):** set `MYCELIUM_CHANNEL_ROUTER=native`, send a Telegram DM, confirm the reply flows through the chokepoint. Headless gates prove the mechanics; the real cross-process round-trip (daemon→server→reply→daemon/send→TTS) needs a live env.

**Next: Step 7** — **DESIGN LOCKED** in [`NATIVE-AGENT-HARNESS-STEP7-DESIGN-2026-06-17.md`](NATIVE-AGENT-HARNESS-STEP7-DESIGN-2026-06-17.md) after a 3-sweep pass + 2 own-eyes verifications. **Key decision:** provider-fallback is a refinement of `loop.run`'s EXISTING empty-retry (pre-content only — a provider can't be swapped mid-stream; odysseus + our `cascade.js:12` agree), NOT a reuse of the non-streaming `inferWithCascade`. Adopts hermes error-taxonomy + jittered backoff and odysseus simple-cap + pre-content-swap. Sub-steps 7a–7c (each gated): `provider-errors.js` + loop.js fallback + jitter → `streamTurn` repeat-call breaker → `'harness'` task + `run-turn` chain wire + scheduler daily-budget. Hot-path (`loop.js`/`harness.js`) changes guarded by single-provider regression (chat must be byte-for-byte unchanged).

## 2026-06-17 (final) — Step 7 shipped; harness feature-complete

The resilience layer, built per the locked Step-7 design. Three sub-steps, each gated:
- **7a** `2e2120c` — `src/agent/provider-errors.js` (`classifyProviderError`) + `loop.js` pre-content provider-fallback over an optional `providerChain` + decorrelated jittered backoff. Chain absent → single-provider behavior byte-for-byte unchanged (chat fail-fast). Gate `verify:harness-fallback` (8/8).
- **7b** `2b9a610` — `streamTurn` repeated-identical-call circuit-breaker (`TOOL_REPEAT_LIMIT=3` → final answer pass; `maxIterations=8` stays the outer cap). Adjusted `verify-harness` H4 fixture to distinct args (its identical-repeat fixture now correctly trips the new breaker). Gate `verify:harness-breaker` (5/5).
- **7c** `ebb66eb` — `'harness'` in `INFERENCE_TASKS` + `run-turn.js` resolves+passes a `providerChain` (primary-first, local-floor-last; every element normalizes in streamTurn) + scheduler daily-token-budget gate (`MYCELIUM_DAILY_TOKEN_BUDGET`, unset = unlimited; `db.usage.summary(sinceDays:1)`). Gate `verify:harness-budget` (8/8).

**Patterns adopted:** odysseus pre-content-only fallback + simple hard cap; hermes error-taxonomy + jittered backoff. Reused our `resolveProviderChain` (sovereign→frontier→local) verbatim.

**The harness is now feature-complete.** 16 harness gates + 13 neighbours = **29/29 GO**. The whole engine: `loop.js` (watchdog + retry + fallback) over `streamTurn` (tool loop + breaker + output cap), three surfaces (chat / scheduler / channel) via the shared `runAgentTurn`, encrypted state (`scheduled_tasks`/`harness_runs`/`conversation_summaries`), auto-compaction, gated autonomy tools, untrusted envelope, triage.

### What remains is OPERATOR work, not code
1. **Merge to main:** run full `npm run verify` (~140 gates) in the worktree; reconcile migration numbering (0018) with the federation branch (trivial — additive). Security-sensitive diffs (egress, untrusted envelope, loopback endpoint, encrypted columns) need a human approval per `/auto-merge-on-green`.
2. **Live-smoke the channel native backend:** `MYCELIUM_CHANNEL_ROUTER=native` + send a Telegram DM → confirm the reply round-trips daemon→server→reply→chokepoint→TTS.
3. **Live-smoke the scheduler:** create a `schedule_task` (or seed `scheduled_tasks`), confirm a wake-cycle fires + delivers to chat.
4. **Optional tuning:** `MYCELIUM_DAILY_TOKEN_BUDGET`, `MYCELIUM_TOOL_REPEAT_LIMIT`, `MYCELIUM_MAX_ITERATIONS`, `MYCELIUM_BACKOFF_*`.

## Remaining-steps build plan (4b → 7)

A dedicated, sweep-verified plan for ALL remaining steps now lives in [`docs/NATIVE-AGENT-HARNESS-BUILD-PLAN-2026-06-17.md`](NATIVE-AGENT-HARNESS-BUILD-PLAN-2026-06-17.md) — written after a fresh 5-sweep `/sweep-first-design` pass against the worktree. It carries: per-step module shape + LOC budget + gate, a 23-row own-eyes verification table, and two sweep corrections (`db.harness` DOES exist at `db/index.js:90`; headless `call` is a wrapper fn, not the handlers map). Build order **4b → 5 → 6 → 7**. Read it alongside the spec before building. The summary below is the Step-4b detail it expands on.

## Next step in detail — Step 4b (scheduler runtime)

Build these, all inside the worktree:
- **`src/agent/lane.js`** (~50 LOC) — a `Semaphore(1)` serial promise-queue. Used by scheduler + (later) channel turns so autonomous turns don't hammer the model/DB. **Do NOT lane interactive chat** (would serialize concurrent tabs — a behavior change).
- **`src/agent/scheduler.js`** (~200 LOC) — a dynamic-sleep tick (odysseus `task_scheduler._loop`: sleep `clamp(1s,60s, next_run−now)`), `tick()` = `db.harness.dueTasks(now)` → in-memory `executing` set dedupe → enqueue on the lane → run the turn via `loop.run` → `db.harness.markTaskRun` with `computeNextRun` → deliver per `output_target`. Energy gating opt-in. `start()`/`stop()` lifecycle.
- **Boot wiring** in `src/server-rest.js completeBoot`, behind the existing `if (!injectedKeys)` gate (alongside the enrich drainer / connector scheduler): `db.harness.reconcileOnBoot()` + `db.harness.advanceOverdue(now)` on boot, then `scheduler.start()`; `scheduler.stop()` in the close sequence. **This is the one place Step 4b touches live boot — keep it minimal + gated.**
- **`scripts/verify-harness-scheduler.mjs`** — boot a vault, seed a due task, drive one tick, assert it ran (a `loop.run` stub), `markTaskRun` advanced `next_run`, single-flight no double-fire, and a vault-locked path skips.

The DAL (`db.harness.*`) and the time math (`scheduler-time.js`) it needs are **already built + gated**. Step 4b is mostly orchestration over them.

---

## Gotchas + lessons (2026-06-17)

- **Concurrent-session collision (2026-06-17):** two Claude sessions in the same `~/Documents/GitHub/mycelium.id` tree clobber each other's uncommitted edits + switch branches. My portal-chat wiring was wiped once. Defense: commit early + work in an isolated worktree. See [[concurrent-session-collision]].
- **Migration number is 0018, not 0017** — the prelaunch lineage already has `0017_inbound_shares.sql`. The federation session may also be adding migrations; if both branches add the same number, resolve at merge (trivial — both are additive `CREATE TABLE`).
- **Encrypted-INSERT VALUES-paren caveat (`crypto-local.js`):** the auto-encrypt INSERT parser truncates VALUES at the first `)`, so any `datetime('now')`/`randomblob()` literal corrupts param mapping. **Rule:** INSERTs touching an encrypted column must bind EVERY value as `?` (compute id + timestamps in JS). `db/harness.js` does this. UPDATE is paren-safe (can use literals).
- **`now` returns a `Date`, not an ISO string** in this codebase's db adapter — never bind it raw to SQLite. `db/harness.js` coerces to ISO (`iso()` helper). Watch for this in `scheduler.js`.
- **Flaky-window test (fixed):** a `wasRecentlyCompleted(hash, 1ms)` assertion was flaky because the whole op sequence is sub-millisecond — the run genuinely finished within 1ms of "now". Fixed by inserting a real 25ms sleep + a 10ms window. Time-sensitive assertions need real elapsed gaps.
- **Compaction message model is NEUTRAL** (`{role,content,name}`), not adapter-specific — it composes above streamTurn's adapters. The live wiring needs `loop.js` to thread a neutral history (Step 6).

---

## Deploy / verify runbook

Run inside the worktree:
```bash
cd ~/Documents/GitHub/mycelium-worktrees/native-agent-harness
for g in verify-harness verify-harness-loop verify-harness-state verify-harness-compaction verify-harness-schedule verify-portal-chat; do
  node scripts/$g.mjs >/dev/null 2>&1 && echo "$g GO" || echo "$g FAIL"
done
# crypto safety (Step 2 touched crypto-local.js):
for g in verify-keysource verify-account verify-backup; do node scripts/$g.mjs >/dev/null 2>&1 && echo "$g GO" || echo "$g FAIL"; done
```
Before merging to main: `npm run verify` (full chain, ~140 gates) + reconcile migration numbering with the federation branch.

**Full-chain caveat (2026-06-17):** the full chain was run in this worktree and is GREEN through every JS gate, but it STOPS at `verify:nomic-embedding-encryption` (the 8th gate) — a cross-language parity gate that shells out to `pipeline/.venv/bin/python3` (`PY` in the script). That venv is NOT provisioned in this worktree (only `node_modules` is symlinked from main), so the Python parity gates (`nomic-embedding-encryption`, `fisher`, `pipeline-cli-encryption`, `harmonics-encryption`, etc.) can't run here. This is an ENVIRONMENT gap, NOT a harness regression — the harness changes are JS-only and the 8th gate runs before any harness code. **To get a true full-chain green, run `npm run verify` in the real app environment (or `python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt` in the worktree first).** All 16 harness gates + 13 JS neighbours = 29/29 GO headlessly.

---

## Glossary (session-specific)
- **streamTurn** — the existing provider-agnostic single-exchange engine (`src/agent/harness.js`); runs one model call + an internal tool-call loop. The native harness wraps it; does NOT replace it.
- **loop.run** — the new multi-turn/watchdog driver over streamTurn (`src/agent/loop.js`).
- **active-turn registry** — the daemon's `/internal/inbound-context/current` state that `reply.js` reads to target a channel reply.
- **core-as-library (H11)** — one streamTurn engine consumed three ways via a pluggable `call`: in-process (server) · loopback-MCP (daemon channels) · MCP/HTTP (external harnesses).
- **VALUES-paren caveat** — the encrypted-INSERT rule above.
