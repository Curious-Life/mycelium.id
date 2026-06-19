# Native Agent Harness — Remaining-Steps Build Plan (4b → 7)

**Date:** 2026-06-17
**Companions:** [`NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md`](NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md) (authoritative) · [`NATIVE-AGENT-HARNESS-HANDOFF-2026-06-17.md`](NATIVE-AGENT-HARNESS-HANDOFF-2026-06-17.md) (read-first) · [`NATIVE-AGENT-HARNESS-DESIGN-2026-06-17.md`](NATIVE-AGENT-HARNESS-DESIGN-2026-06-17.md)
**Audience:** the next Claude Code instance building Steps 4b–7.
**Skills fired:** `/sweep-first-design` (5 parallel Explore sweeps + own-eyes verification, this session).
**Scope:** Steps 1–4a are shipped + gated (see handoff). This doc is the verified plan for the **remaining four steps**, written after a fresh 5-sweep pass against the worktree code.

> All work lives in the worktree `~/Documents/GitHub/mycelium-worktrees/native-agent-harness` (branch `feat/native-agent-harness`). Build + gate each step inside it. Run full `npm run verify` before any merge to main.

---

## 0. What this sweep confirmed (and two corrections)

The 5-sweep pass verified the seams every remaining step rests on. Two prior assumptions flipped under direct reading — recording them so they don't re-bite:

- **CORRECTION 1 — `db.harness` DOES exist.** A sweep reported "no `db.harness` namespace." Direct read disproves it: [`src/db/index.js:90`](../src/db/index.js#L90) wires `harness: createHarnessNamespace({ d1Query, d1QueryAdmin, randomUUID, now })`. Step 4b calls `db.harness.*` directly. (The sweep agent read a stale/main-tree view; **always own-eyes the in-progress files** — they are the ones that differ from main.)
- **CORRECTION 2 — headless `call` is a wrapper fn, not the handlers map.** `loop.run` passes `call` straight into `streamTurn` and wraps `send` as `sink` ([`loop.js:124-127`](../src/agent/loop.js#L124)). A headless turn passes `send: () => {}` and a `call(name,args)` *closure* that dispatches into `handlers` with a grant check — exactly the portal-chat wrapper ([`portal-chat.js:244-250`](../src/portal-chat.js#L244)), **not** the raw `handlers` object.

Everything else the steps assume held:

| Seam | Verified at | Consequence |
|---|---|---|
| `completeBoot(extraKeys)` + `injectedKeys` gate | `server-rest.js:322, :360` | Scheduler boots only on the real (vault-unlocked) path |
| Background-service start block | `server-rest.js:363-415, :438-439` | Mirror `connectorScheduler` start exactly |
| Unified `closeHandle` (per-service try/`.stop()`) | `server-rest.js:416-425` | Register `scheduler.stop()` here |
| SIGINT/SIGTERM → `close()` → `closeHandle()` | `server-rest.js:632-638` | Graceful stop wired for free once registered |
| `boot()` returns `{ tools, handlers, db, userId }` | `src/index.js:105-114` | Scheduler gets the SAME handlers portal-chat uses |
| `loop.run` headless contract (`send` no-op, `call` wrapper) | `loop.js:58-63, :124-127, :142-150` | One core serves chat + scheduler + channel |
| `resolveInferenceConfigForTask(db,userId,task)` | `inference/resolve.js:76`; `INFERENCE_TASKS=['chat','narrate']` `:67` | Add `'harness'` for autonomous routing (Step 7) |
| `resolveProviderChain` + `inferWithCascade` EXIST (non-streaming, unwired) | `inference/resolve.js:107`, `inference/cascade.js:1-48` | Step 7 wires them into the streaming loop |
| `streamTurn` bounds tool loop at `maxIterations=8` | `agent/harness.js:365, :394, :427-434` | Circuit-breaker partly exists; Step 7 adds repeat-call detection |
| `onUsage` → `db.usage.record` → `llm_usage` | `harness.js:380-385`, `db/llm-usage.js:53` | Usage already logged post-turn |
| `db.usage.summary(userId,{sinceDays})` → `{totals,byDay,...}` | `db/llm-usage.js:80` | Daily-budget gate reads this; no new DAL needed |
| `reply` tool registered ONLY when `AGENT_URL` set | `mcp.js:135-138`; `tools/reply.js:101-138` | Reactive reply reuses it; proactive channel send does NOT (see §Step 6) |
| `schedule_task`/`reply` EXPLICITLY excluded from `DOMAINS` | `agent/tool-domains.js:9-13` | Autonomy tools must bypass the chat-policy grant (see §Step 5) |
| Channel backend contract `runTurn({turnCtx,userMessage,signal})→{delivered,usedReplyTool,reason}` | `channel-daemon/agent/backends/claude-sdk.js:72-102`, `ollama.js:50-132` | Native backend is a drop-in (Step 6) |
| Daemon already has its own serial lane + active-turn registry | `channel-daemon/agent/lane.js:28-79`, `server.js:36-52` | Our `src/agent/lane.js` is for the SCHEDULER, not channels |
| `messages.conversation_id` exists; `selectTimeline` does NOT filter it | `db/messages.js:596` | Step 6 adds `selectByConversation` |
| Agent-source consent gate fail-closed (`isAgentSource`/`agentCapture.enabled`) | `ingest/capture.js:66-110` | Channel inbound (telegram/discord) is NOT agent-gated; flows normally |
| No `wrapUntrusted` helper anywhere | grep empty | Step 6 builds the untrusted envelope net-new |

---

## Step 4b — Scheduler runtime (~270 LOC)

**Goal:** a single-flight, dynamic-sleep loop that fires due `scheduled_tasks` as headless turns and advances their `next_run`. The DAL (`db.harness.*`) and time math (`scheduler-time.js`) are already built + gated; 4b is orchestration over them.

### Modules
1. **`src/agent/lane.js`** (~45 LOC) — `createLane()` → `{ enqueue(fn), size() }`, a `Semaphore(1)` serial promise-queue (odysseus `Semaphore(1)` pattern). Serializes autonomous turns so they never hammer the model/DB. **Do NOT lane interactive chat** — that would serialize concurrent tabs (behavior change). Used by the scheduler now; available to a future native-channel path.

2. **`src/agent/scheduler.js`** (~210 LOC) —
   `createScheduler({ db, userId, tools, handlers, readAgentIdentity, fetchImpl, logger })` → `{ start(), stop(), tickOnce() }`.
   - **tick():** `now = new Date()` → `due = await db.harness.dueTasks(now.toISOString())` → for each task not in the in-memory `executing` Set: add to set, `lane.enqueue(() => runTask(task))`.
   - **runTask(task):**
     - `openRun` (content-free; `prompt_hash` only) via `db.harness.openRun`.
     - **Dedup:** skip if `db.harness.wasRecentlyCompleted(prompt_hash)` (30s window) — guards double-fire across overlapping ticks/boots.
     - **Daily-budget gate (opt-in):** if the task/user has a daily token cap, read `db.usage.summary(userId,{sinceDays:1}).totals`; over budget → `finishRun(status:'skipped-budget')`, advance `next_run`, return. (Counts only; never logs content.)
     - **Build the headless turn** (replicates `portal-chat` assembly, no SSE):
       - `provider = await resolveInferenceConfigForTask(db, userId, 'harness')` (falls back to active/chat).
       - `ident = await readAgentIdentity()`; `system = identity-preamble + (await handlers.getContext({recentMessages:N}))`.
       - `grantedTools = autonomyTools(tools, task.enabled_tools)` — read-safe tools ∪ explicitly-enabled autonomy tools (see Step 5; this **bypasses the chat policy** so it never widens chat's grant).
       - `call = (name,args) => grant-checked dispatch into handlers` (the portal-chat wrapper).
       - `send = () => {}` (headless).
       - `result = await loop.run({ provider, system, userMessage: task.prompt, tools: grantedTools, call, send, signal: this.signal })`.
     - **Deliver** per `task.output_target`: `'chat'|null` → persist the assistant text as a message (conversation-scoped) via the existing capture/messages DAL; `'channel:*'` → **deferred to Step 6** (proactive send has no inbound active turn — see note). 4b ships `chat`/`none` delivery only.
     - `db.harness.markTaskRun(task.id, { last_status, next_run: computeNextRun(task.schedule, {after: now, tz: task.tz, scheduledAt: task.scheduled_at}) })`; `finishRun(...)`; remove from `executing`.
   - **start():** `reconcileOnBoot` already ran in boot wiring; schedule the first tick. Dynamic sleep: `delay = clamp(1s, 60s, nextDueMs - now)` (odysseus `_loop`), `setTimeout(...).unref()`.
   - **stop():** clear the timer, flip `stopped`, let the in-flight lane item finish (no force-kill mid-turn → no torn state).
   - **Vault-locked safety:** the scheduler only ever runs on the `!injectedKeys` path and reads/writes through the keyed `db`; if a decrypt throws inside a turn, `runTask` catches → `finishRun(status:'error', error:<code>)` (code only, never plaintext). **Fail-closed: never decrypt outside the keyed opener.**

3. **Boot wiring — `src/server-rest.js completeBoot`** (~12 LOC), behind the existing `if (!injectedKeys)` block, at the same site `connectorScheduler` is started (`:438`):
   ```js
   await db.harness.reconcileOnBoot();           // running → aborted (zombie clear)
   await db.harness.advanceOverdue(new Date().toISOString());  // skip missed fires, don't stampede
   scheduler = createScheduler({ db, userId: bootUserId, tools, handlers, readAgentIdentity });
   scheduler.start();
   ```
   Register `try { scheduler?.stop(); } catch {}` in the unified `closeHandle` (`:416-425`).

### Gate — `scripts/verify-harness-scheduler.mjs`
Boot an ephemeral vault (injected keys), seed a due task, drive `tickOnce()` with a **stubbed `loop.run`**, assert: (G1) the stub ran exactly once; (G2) `markTaskRun` advanced `next_run` via `computeNextRun`; (G3) single-flight — two overlapping ticks fire the task once (`executing` set + `wasRecentlyCompleted`); (G4) `advanceOverdue` skips a long-past `once` task without firing; (G5) a throwing turn → `finishRun(status:'error')` with a **code, no plaintext**; (G6) `reconcileOnBoot` flips a stranded `running` row to `aborted`; (G7) budget-over path → `skipped-budget`, no turn. Ledger + `VERDICT: GO/NO-GO` + exit code.

### Open decision (4b)
**Proactive channel delivery** (`output_target = channel:*`) has no inbound active turn, so it cannot reuse `reply.js`'s `/internal/inbound-context/current` path. Options: (a) defer all channel delivery to Step 6 and ship `chat`/`none` now **(recommended)**; (b) add a daemon `/{platform}/push` route for turn-less sends. Recommend (a) — keeps 4b small and the egress chokepoint invariant intact.

---

## Step 5 — Gated autonomy tools (~200 LOC)

**Goal:** give autonomous turns the ability to schedule follow-ups and (reactively) reply — **without ever exposing those tools to interactive chat.**

### The invariant (do not break)
`schedule_task` and `reply` are deliberately excluded from `DOMAINS` ([`tool-domains.js:9-13`](../src/agent/tool-domains.js#L9)). Chat grants via `toolsForDomains(registry, policy.domains)`, which can only surface domain-mapped tools. **Keep autonomy tools out of `DOMAINS`** so chat can never grant them. Autonomous turns instead receive an **explicit** tool list assembled by name, bypassing the chat-policy path.

### Modules
1. **`src/tools/schedule-tasks.js`** (~120 LOC) — `createScheduleTasksDomain({ db, userId })` → `{ tools, handlers }`:
   - `schedule_task` — `{ prompt, schedule (DSL), tz?, output_target?, enabled_tools?, scheduledAt? }`. Validate `schedule` with `parseSchedule` (reject → error string); compute first `next_run` with `computeNextRun`; `db.harness.createTask(...)` (prompt encrypted at rest). Soft-fail strings, never throw (mirrors `tools/tasks.js:58-74`).
   - `list_my_schedules` — `db.harness.listTasks(userId)` → compact summary (names/schedules/next_run; **never** dumps the encrypted prompt verbatim in a tool result unless the caller asked for that specific task).
   - `cancel_task` — `db.harness.setTaskStatus(id,'cancelled')` (or `enabled=false`).
2. **`src/agent/autonomy-tools.js`** (~50 LOC) — the explicit-grant helper:
   - `AUTONOMY_TOOLS = new Set(['schedule_task','list_my_schedules','cancel_task','reply'])`.
   - `autonomyTools(registry, enabledNames)` → read-safe tools (`getContext`, `searchMindscape`, …) ∪ the subset of `AUTONOMY_TOOLS` named in `enabledNames` AND present in `registry`. This is what the scheduler/channel pass as `grantedTools`. `reply` only appears when registered (i.e. `AGENT_URL` set).
3. **Registration — `src/mcp.js`** (~6 LOC): add `createScheduleTasksDomain({ db, userId })` to `buildDomains` (so handlers exist in the registry), **but do not add its keys to `DOMAINS`**. `reply` stays `AGENT_URL`-gated (`:135-138`).

### Gate — `scripts/verify-harness-tools.mjs`
(P1) `schedule_task` is ABSENT from any `toolsForDomains(registry, ALL_DOMAIN_KEYS)` result (chat can never grant it). (P2) `autonomyTools(registry, ['schedule_task'])` INCLUDES it. (P3) invalid DSL → error string, no DB write. (P4) valid `schedule_task` → `db.harness.getTask` roundtrips, `prompt` **ciphertext on raw read** (reuse the Step-2 raw-read proof). (P5) `reply` absent from autonomy grant when `AGENT_URL` unset.

---

## Step 6 — Channel adapter (H11) + history + untrusted envelope + triage (~450 LOC)

**Goal:** migrate channel auto-reply from the external Claude Agent SDK backend onto the native `streamTurn` engine (one engine, H11 core-as-library), add conversation-scoped history + cross-turn compaction, and harden inbound (untrusted) handling.

### Modules
1. **`src/db/messages.js` → `selectByConversation(userId, conversationId, {limit, before})`** (~15 LOC) — model exactly on `selectTimeline:596`, add `AND conversation_id = ?`; content/metadata auto-decrypt on read. Gate: returns only the target conversation, honors `before`/`limit`, newest-first.
2. **`src/agent/untrusted.js`** (~40 LOC) — `wrapUntrusted(text, { source })`: wrap inbound channel text in a delimited, instruction-neutralizing envelope (odysseus untrusted-context pattern) — e.g. a fenced `<<UNTRUSTED source=telegram>> … <</UNTRUSTED>>` block with a system note that content inside is data, not instructions. Defense-in-depth ON TOP of the existing tool-trimming (the daemon already restricts untrusted turns to read-safe tools — `SAFE_DEFAULT_TOOLS`).
3. **`packages/channel-daemon/agent/backends/native.js`** (~120 LOC) — `createNativeRuntime(cfg)` → `{ label:'native', async runTurn({ turnCtx, userMessage, signal }) }`. Internally calls our `loop.run` via the H11 **loopback-MCP `call`** (the daemon already holds an MCP client to the server — reuse it as the tool dispatcher), threads history via `selectByConversation`, runs cross-turn `compaction.compact()` when over budget, and maps the result to `{ delivered, usedReplyTool, reason }` (reply happens through the existing chokepoint, so `usedReplyTool` is read off the tool trace). Wire the daemon to select this backend (config flag; keep SDK/Ollama as fallbacks until soaked).
4. **Triage gate** (~80 LOC) — before spending a full turn on every group message, a cheap classifier (local, tools-off) decides addressed-to-me / needs-reply. Avoids a full turn per group message (spec §triage). Lives daemon-side, calls a minimal `loop.run` with `tools:[]` + a tiny prompt, or a heuristic pre-filter.
5. **Cross-turn compaction goes LIVE here** — this is where `loop.js` first threads a real multi-message history (channels are multi-turn), so `compaction.js` (built + gated in Step 3) gets wired: pre-prune tool results, protect system + recent tail, summarize into `conversation_summaries`, rehydrate as summary-block + verbatim tail.

### Gates
`verify-harness-channel.mjs` (native backend returns the contract shape; reply flows through the chokepoint with `x-egress-provenance: agent-explicit`; untrusted envelope present; triage skips a non-addressed message) + extend `verify-harness-compaction` to a cross-turn integration case + a `selectByConversation` DAL gate.

### Open decision (6)
Migrate BOTH daemon backends (SDK + Ollama) to native, or only SDK? **Recommend: replace both** so there is exactly one engine (the whole point of H11). Keep SDK behind a config flag for one release as a rollback.

---

## Step 7 — Circuit-breaker + provider-fallback (~180 LOC)

**Goal:** make autonomous turns resilient — bound runaway tool loops and survive a primary-provider outage by walking the existing provider chain.

### Work
1. **Provider-fallback in `loop.run`** (~90 LOC) — today the attempt loop only retries on **empty/stall** with backoff ([`loop.js:105-137`](../src/agent/loop.js#L105)); all provider errors bubble identically. Add error classification (reuse `inference/probe.js` patterns: `401/403`→fatal-auth, `404`→fatal, `429`/`5xx`→retryable) and, on a **retryable provider error**, walk `resolveProviderChain(db, userId, {sensitive})` — i.e. integrate the already-built `inferWithCascade`/chain semantics into the streaming path (currently non-streaming only, `cascade.js:1-48`). Distinguish provider-error fallback from empty-stall retry so the two don't double-count.
2. **Circuit-breaker** (~60 LOC) — `maxIterations=8` already caps the tool loop ([`harness.js:394`](../src/agent/harness.js#L394)). Add openclaw-style **repeated-identical-call detection** (same tool+args N× → break) and a per-turn tool-call ceiling, then force the existing final no-tools answer pass (`harness.js:427-434`). Prevents a wedged turn from burning the budget.
3. **`'harness'` task routing** (~10 LOC) — add `'harness'` to `INFERENCE_TASKS` ([`resolve.js:67`](../src/inference/resolve.js#L67)) so autonomous turns honor a per-task model assignment (e.g. a cheaper local model for wake-cycles).
4. **Daily token budget** — already feasible via `db.usage.summary` (no new DAL); the gate added in Step 4b's `runTask` reads it. Step 7 formalizes the threshold + the `skipped-budget` accounting.

### Gate — `scripts/verify-harness-resilience.mjs`
(R1) retryable provider error → falls back to the next chain provider, succeeds; (R2) fatal auth error → no fallback, surfaces cleanly; (R3) repeated-identical tool call → breaks and returns a final answer; (R4) tool-call ceiling enforced; (R5) `'harness'` task resolves its assigned model.

---

## Sequencing, LOC, and merge

| Step | LOC (est) | Touches live boot? | Depends on |
|---|---|---|---|
| 4b scheduler runtime | ~270 | YES (1 gated block) | db.harness, scheduler-time, loop (all built) |
| 5 autonomy tools | ~200 | No | mcp registry; 4b consumes them |
| 6 channel adapter | ~450 | daemon backend swap | loop, compaction, new DAL+untrusted |
| 7 breaker + fallback | ~180 | No (loop-internal) | resolveProviderChain, cascade (built) |

Build order **4b → 5 → 6 → 7** (4b proves the headless turn end-to-end; 5 gives it tools; 6 is the largest and reuses both; 7 hardens the lot). Each step: commit + its gate GREEN in the worktree. **Before any merge to main:** full `npm run verify` (~130 gates) + reconcile migration numbering with the federation branch (both add additive `CREATE TABLE`s — trivial). Security-sensitive diffs (egress, untrusted envelope, encrypted columns) require a human approval per `/auto-merge-on-green`.

---

## Verification table (own-eyes, this session)

| Load-bearing assumption | Verified at |
|---|---|
| `db.harness` namespace is wired | `src/db/index.js:90` (own-read) |
| Boot gate `injectedKeys` + service block | `src/server-rest.js:322, :360, :363-415, :438` (sweep, cited) |
| Unified `closeHandle` stop pattern | `src/server-rest.js:416-425` (sweep, cited) |
| SIGTERM → close → closeHandle | `src/server-rest.js:632-638` (sweep, cited) |
| boot returns `{tools,handlers,db,userId}` | `src/index.js:105-114` (own-read) |
| `loop.run` headless: `send` no-op, `call` passthrough, returns `{text,...}` | `src/agent/loop.js:58-63, :124-127, :142-150` (own-read) |
| portal-chat turn assembly (provider/system/getContext/call wrapper) | `src/portal-chat.js:150, :190, :224-250` (sweep, cited) |
| `schedule_task`/`reply` excluded from DOMAINS | `src/agent/tool-domains.js:9-13` (sweep, cited) |
| `toolsForDomains` only surfaces domain-mapped tools | `src/agent/tool-domains.js:59-69` (sweep, cited) |
| tool module shape `{tools,handlers}`, handler gets only `args`, deps via closure | `src/tools/reply.js:101-138`, `src/mcp.js:237-244` (sweep, cited) |
| DB-writing tool exemplar (tasks) | `src/tools/tasks.js:18-96` (sweep, cited) |
| `reply` AGENT_URL-gated registration | `src/mcp.js:135-138` (sweep, cited) |
| channel backend contract | `channel-daemon/agent/backends/claude-sdk.js:72-102`, `ollama.js:50-132` (sweep, cited) |
| daemon has its own lane + active-turn registry | `channel-daemon/agent/lane.js:28-79`, `server.js:36-52` (sweep, cited) |
| `messages.conversation_id` exists; `selectTimeline` ignores it | `src/db/messages.js:596` (sweep, cited) |
| agent-source consent gate fail-closed; channels not agent-gated | `src/ingest/capture.js:66-110` (sweep, cited) |
| no `wrapUntrusted` exists | grep empty (sweep) |
| `maxIterations=8` bounds tool loop + final answer pass | `src/agent/harness.js:365, :394, :427-434` (sweep, cited) |
| `resolveProviderChain` + `inferWithCascade` exist, unwired to streaming | `src/inference/resolve.js:107`, `src/inference/cascade.js:1-48` (sweep, cited) |
| error classification exists in probe.js (not wired to fallback) | `src/inference/probe.js:58-61` (sweep, cited) |
| `INFERENCE_TASKS=['chat','narrate']` | `src/inference/resolve.js:67` (sweep, cited) |
| `onUsage`→`db.usage.record`→`llm_usage`; `db.usage.summary` has `byDay` | `src/agent/harness.js:380-385`, `src/db/llm-usage.js:53, :80` (own-read) |

---

## Revision history
- **v1 (2026-06-17)** — initial build plan for Steps 4b–7, written after a 5-sweep `/sweep-first-design` pass with own-eyes verification. Two sweep claims corrected (`db.harness` exists; headless `call` is a wrapper). No pivots to the spec's step decomposition — the sweep confirmed the spec's 4b–7 shape is buildable as written.
