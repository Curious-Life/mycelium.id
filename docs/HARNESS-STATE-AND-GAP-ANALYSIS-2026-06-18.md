# Native Agent Harness — Current State + Gap Analysis (2026-06-18)

**Method:** `/sweep-first-design`. 1 self-inventory sweep of the harness on `main` + 3 parallel
reference-harness sweeps (OpenClaw / Hermes / OpenCode), each file:line-cited, plus own-eyes
verification of every load-bearing claim. This is a **requirements/findings** doc, not a locked
build design — the build target is the open decision in §5.

---

## 0. TL;DR — the handoff was stale; the harness is already merged

The prior handoff (`NATIVE-AGENT-HARNESS-HANDOFF-2026-06-17.md`) says "Steps 1–4a shipped, 4b–7
pending." **That is obsolete.** Ground truth from git:

- **All 7 steps are built AND merged to `main`** via squash-merge `20fe589`
  ("merge: native agent harness (Phase 5) into main"), parent `d7f5cf8` (#221). Every harness file
  (`loop.js`, `harness.js`, `scheduler.js`, `run-turn.js`, `channel-turn.js`, `triage.js`,
  `compaction.js`, `history.js`, `provider-errors.js`, `autonomy-tools.js`, `untrusted.js`,
  `lane.js`, `scheduler-time.js`, `db/harness.js`, `tools/schedule-tasks.js`) is on `main`, plus
  `migrations/0019_harness.sql` and all **17 `verify:harness*` gates**.
- The branch `feat/native-agent-harness` is now **stale**: 88 "ahead" / 25 behind `origin/main`,
  but the "ahead" is just main's 25 later PRs missing from the branch. It differs from main in only
  **2 harness files**, and on **both, main is newer** (narration #240 opted `describeEntity` /
  `getEntityContext` into the autonomy sets). **The branch has nothing main lacks.** → retire it.
- Migration renumbered cleanly: branch used `0018_harness.sql`; main absorbed it as
  `0019_harness.sql` (main's `0018` is `streams_feed_indexes`). No collision outstanding.

**So "complete the harness" is not a build-the-remaining-steps task.** What remains is (a) branch
hygiene, (b) the never-done operator live-smoke, (c) optional gap-fill vs reference harnesses (§4).

---

## 1. What is LIVE vs DORMANT on main

| Subsystem | State on `main` | Evidence |
|---|---|---|
| Scheduler (autonomous wake-cycles) | **LIVE at boot** — starts in real app, gated like the drainer | `server-rest.js:550-560` `createScheduler(...).start()` behind `!injectedKeys` |
| Scheduler dispatch / lane / dedup / recovery sentinel | LIVE | `scheduler.js`, `lane.js`, `db.harness.reconcileOnBoot()` |
| Gated autonomy tools (`schedule_task`/`cancel_task`/`list_my_schedules`/`reply`) | LIVE but **inert until a task exists** | `autonomy-tools.js`, `tools/schedule-tasks.js`, registered in `mcp.js` (out of chat DOMAINS) |
| Daily token budget | LIVE but **fail-open** (unset = unlimited) | `scheduler.js:113` `MYCELIUM_DAILY_TOKEN_BUDGET` |
| Channel native turn engine (server-side `/internal/agent/channel-turn`) | **DORMANT** — default OFF | `channel-daemon/.../select-runtime.js:44-46` `MYCELIUM_CHANNEL_ROUTER=native` default OFF; channels still on SDK/Ollama |
| Group model-triage | DORMANT (off by default; heuristic only) | `triage.js:33` `groupModelTriage=false` |
| Auto-compaction (in-turn cap + cross-turn summaries) | LIVE in the engine; cross-turn used by channel/scheduler turns | `compaction.js`, `history.js` |

**Net:** the harness ships **wired but unexercised**. The scheduler will fire if a task is seeded,
but nothing has been live-smoked end-to-end (operator items 2–3 below).

---

## 2. What remains (concrete)

**A. Branch hygiene (trivial, do first)**
- Delete `origin/feat/native-agent-harness` (superseded — main is ahead on both differing files).
- Delete local `harness-merged-into-main` (its tip `20fe589` *is* main now) and the stale local
  `recovered/feat/chat-agent-harness`.
- No open PR exists for the harness → nothing to close.

**B. Operator live-smoke (never done — needs a running app; no code)**
1. **Scheduler:** seed/`schedule_task` a due wake-cycle → confirm it fires on the lane, delivers to
   chat via `captureMessage(source:'scheduler')`, and `markTaskRun` advances `next_run`.
2. **Channel native backend:** set `MYCELIUM_CHANNEL_ROUTER=native`, send a Telegram DM → confirm the
   round-trip daemon→`/internal/agent/channel-turn`→`reply`→chokepoint→TTS.
3. **Budget/limits tuning:** decide a default for `MYCELIUM_DAILY_TOKEN_BUDGET` (currently unlimited)
   before any autonomous turn can "run away with the bill" (the code's own words, `scheduler.js:110`).

**C. Optional gap-fill vs reference harnesses → §4 (the part needing a decision).**

---

## 3. Architecture recap (as-built, for the next reader)

```
loop.run (loop.js)              multi-turn driver: TTFB+IDLE watchdog · empty-retry w/ decorrelated
  └─ over ─┐                    jittered backoff · pre-content provider-fallback over providerChain
streamTurn (harness.js)         single exchange + internal tool-call loop · maxIterations=8 ·
                                repeated-call breaker (TOOL_REPEAT_LIMIT=3) · tool-output cap 32k ·
                                3 adapters (Anthropic native / OpenAI-compat / Ollama) · egress+usage sinks
Three surfaces, one engine via runAgentTurn (run-turn.js):
  • chat        → portal-chat.js (interactive; NOT laned)
  • scheduler   → scheduler.js (serial lane · dedup · recovery sentinel · budget · output_target)
  • channel     → channel-turn.js (loopback, isTrustedLoopback-gated) → triage → untrusted envelope
State (encrypted at rest, migration 0019): scheduled_tasks · harness_runs · conversation_summaries
Autonomy grant (autonomy-tools.js): SAFE (read-only, always) ∪ AUTONOMY (opt-in per task); fail-closed.
```

**Security posture (where the vault harness is AHEAD of the dev-tool references):** encrypted-at-rest
task/summary state; error CODES only (never `e.message`) in `harness_runs.last_error`; untrusted-input
envelope on channel text; egress chokepoint for all channel sends; chat-exclusion invariant (chat can
never grant `schedule_task`/`reply`); single egress audit sink (hash+length, no plaintext).

---

## 4. Gap analysis vs OpenClaw / Hermes / OpenCode

> Note: the three "reference repos" largely resolve to **one ecosystem** —
> `~/Developer/openclaw` is the engine (`src/`), `extensions/opencode` is its `packages/agent-core`,
> and `~/.hermes` is a config/persona (`SOUL.md` + `config.yaml`) over the same runtime. The patterns
> below are their union.

| # | Pattern | Mycelium native harness | Reference (file:line) | Call |
|---|---|---|---|---|
| G1 | **Lifecycle hook bus** | ❌ only `onStall`/`onHeartbeat` leaf callbacks (`loop.js:55-56,105-107`); no pre/post-tool, no compaction hooks | 21–40+ typed hooks: `before_tool_call`/`after_tool_call`/`before_compaction`/`model_call_started`/`session_start`… (`openclaw/src/plugins/hook-types.ts:72-162`) | **REAL GAP — highest leverage.** Enables approval gates, audit, plugins, custom compaction without core rewrites |
| G2 | **Prompt/context caching** | ❌ no `cache_control`/ephemeral anywhere in `src/agent/` (verified) | deterministic cache key on job/agent/provider/model; `cacheRead`/`cacheWrite` accounting (`agent-core/.../types.ts:111-112`, `run-executor.ts:63-86`) | **REAL GAP — high $ leverage.** The `getContext` preamble is large + stable → ideal Anthropic prompt-cache target |
| G3 | **Cost accounting depth** | ⚠️ token *counts* only (`harness_runs`, `llm_usage`) | per-msg input/output/cacheRead/cacheWrite **cost** + daily buckets + version-gated cost cache (`openclaw/src/infra/session-cost-usage.ts:993-1432`) | **PARTIAL.** We have counts + a usage pane; cost-dollarization + cache-token split is the delta |
| G4 | **Cost-aware / health-checked model routing** | ⚠️ fixed jurisdiction chain (sovereign→frontier→local), no preflight | candidate chain + model preflight (available/degraded/unavailable, skip unreachable) + cooldown (`openclaw/src/cron/isolated-agent/model-preflight.runtime.ts`, `run-fallback-policy.ts:12-42`) | **PARTIAL.** Preflight health-check would cut a dead-provider stall before the watchdog |
| G5 | **Checkpoint / resume** | ⚠️ running→aborted sentinel only; half-streamed turn not resumable | session-as-immutable-tree (JSONL append-only, branch nav, resume-from-leaf) + pre-run state snapshot + usage-family lineage (`agent-core/.../session/jsonl-storage.ts`, `openclaw/src/cron/isolated-agent/run-session-state.ts:29-114`) | **DESIGN CHOICE.** Our turns are single-message-in; full resume is large. Sentinel is adequate for v1 |
| G6 | **Sub-agent spawning / delegation** | ❌ D5-deferred; `delegate_to_agent` exists but is the **legacy company-team HTTP relay** (Ada/Rex/Noa), not in-process spawn (`src/tools/delegation.js`) | concurrency-bounded spawn (max 3, depth 1, 600s), ancestry tracking, multi-child synthesis, kanban auto-decompose (`openclaw/.../subagent-followup.ts`, `~/.hermes/config.yaml:334-346,441-451`) | **DELIBERATE NON-GOAL for V1** (single-user vault). Revisit only if a real multi-agent need appears |
| G7 | **Mid-turn approval gates** | ❌ allowlist-only (fail-closed) | `before_tool_call` → allow-once/allow-always/deny/timeout w/ severity+UX (`openclaw/src/plugins/hook-before-tool-call-result.ts`) | **MOSTLY NON-GOAL.** User *is* the operator; allowlist is simpler + safer. Becomes relevant only with G1 + a UI |
| G8 | **In-turn planning / todo tracking** | ❌ | ❌ (both NOT FOUND) | **NOT A GAP** — neither side has it |
| G9 | **Cron expressiveness** | ✅ DSL: daily/weekly/monthly/every/interval/once/cron + IANA tz + DST (`scheduler-time.js:21-34`) | Croner full-cron + LRU cache (`openclaw/src/cron/schedule.ts:10-40`) | **PARITY** (ours is arguably cleaner for the use case) |
| G10 | **Resilience taxonomy + backoff** | ✅ `provider-errors.js` classify + decorrelated jitter (`loop.js`) | careful regex taxonomy (rejects "5xx" in prose) + jittered backoff (`openclaw/src/cron/retry-hint.ts:21-53`, `infra/backoff.ts:17-20`) | **PARITY** — we adopted these patterns in Step 7 |

---

## 5. Recommended requirements (prioritized) — the decision

Ordered by value/effort. Items B (live-smoke) gate everything; G1/G2 are the only **real** code gaps
worth building; the rest are deliberate non-goals or parity.

1. **P0 — Branch hygiene** (§2A). 10 min, no risk.
2. **P0 — Live-smoke the scheduler + channel native backend** (§2B). This is the actual "completion"
   of Phase 5 — proves the autonomous loop runs end-to-end against the live app. No code; needs the app.
3. **P1 — G2 prompt caching** on the Anthropic adapter for the stable `getContext`+system preamble.
   Highest $/effort: large stable prefix, marked `cache_control`, measurable token savings. Pairs with
   G3 (split cacheRead/cacheWrite into `harness_runs`/`llm_usage`).
4. **P1 — G1 a minimal hook bus** (`before_tool_call`/`after_tool_call`/`before_compaction`). Not the
   full 40-hook system — just enough to make egress-audit, approval gates (later), and custom compaction
   pluggable instead of hard-coded. Sweep-first its own design; touches the hot path.
5. **P2 — G4 model preflight** (cheap health-check before a scheduled turn; skip a dead local provider
   before the 45s watchdog fires).
6. **Explicitly DECLINE for V1:** G6 sub-agents, G7 approval gates, G8 planning — documented non-goals,
   not omissions. Revisit post-launch if a concrete need appears.

**Open question for the operator:** do we want the harness to actually *do* anything autonomously at
launch (scheduler on, with a default daily budget), or ship it **dormant** (built, gated off, proven by
gates) and turn it on post-launch? That single call decides whether B2/B3 + a budget default are
launch-blocking or deferred.

---

## 6. Verification table (own-eyes)

| Assumption | Verified at |
|---|---|
| Harness fully merged to main (not "4b–7 pending") | `git merge-base --is-ancestor 20fe589 origin/main` = true; all harness files `git cat-file -e origin/main:…` present |
| Branch is stale; main ahead on both differing files | `git diff origin/main origin/feat/native-agent-harness` = only `autonomy-tools.js`+`db/harness.js`; last-touch dates main newer (`2185324` 06-18 vs `fc89ac7` 06-17) |
| Migration absorbed as 0019, no collision | `migrations/0019_harness.sql` header "0018 — Native agent harness"; main 0018 = streams_feed_indexes |
| Scheduler starts live at boot, gated | `server-rest.js:550-560` read |
| Channel native router default OFF | `channel-daemon/agent/select-runtime.js:44-46` read |
| Daily budget fail-open (unset=unlimited) | `scheduler.js:110-118` read |
| No hook bus (only onStall/onHeartbeat) | `loop.js:55-56,105-107`; `harness.js` has no pre/post-tool hook (grep) |
| No prompt caching in agent layer | grep `cache_control|cacheRetention|ephemeral` over `origin/main:src/agent/` = empty |
| `delegate_to_agent` is legacy team-relay, not in-proc spawn | `src/tools/delegation.js:1-75` read |
| 17 verify:harness* gates on main | `git show origin/main:package.json | grep verify:harness` |

---

## 7. Pickup protocol

1. `git pull` (local `main` is 3 docs-commits behind origin) before anything.
2. Branch hygiene (§2A).
3. Decide §5 open question (autonomous-at-launch vs dormant). This gates the live-smoke + budget work.
4. If building G1/G2: each gets its own `/sweep-first-design` pass (hot-path changes; chat must stay
   byte-for-byte unchanged — same regression discipline Step 7 used).
5. Reference engine for any pattern: `~/Developer/openclaw/src` (+ `extensions/opencode` = agent-core).
</content>
</invoke>
