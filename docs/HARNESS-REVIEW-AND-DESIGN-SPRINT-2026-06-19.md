# Native Agent Harness — Review & Design Sprint (2026-06-19)

**Method:** `/sweep-first-design`. 1 self-inventory sweep of the live harness on the current
checkout (own-eyes file:line) + 3 reference sweeps of the engines the user named — OpenClaw
(`~/Developer/openclaw`), opencode (`~/Developer/openclaw/extensions/opencode` + upstream
`sst/opencode`), Hermes (`~/.hermes` + `hermes_agent` 0.16.0). Every load-bearing claim verified
at file:line.

**Why this exists (vs the prior doc):** `docs/HARNESS-STATE-AND-GAP-ANALYSIS-2026-06-18.md` is a
**static/architectural** comparison and frames most reference gaps as deliberate non-goals
(sub-agents, approval gates, planning). It predates the operator's report that the harness *"does
not function very well in usage."* This doc re-runs the comparison through a **lived-experience**
lens: it finds the concrete reasons the live chat *feels* forgetful and shallow, and ranks fixes by
felt quality rather than infra parity. It supersedes §4–§5 of the prior doc; §0–§3 of that doc
(merge state, LIVE/DORMANT table, security posture) remain accurate.

---

## 0. TL;DR

The harness is **wired but degraded**, not unbuilt. The in-app chat *is* the native harness
(`portal-chat.js:64,256`), so the user's complaint is about the live hot path, not dormant features.
Three root causes explain "doesn't function well," and all three are **wiring/UX gaps over machinery
that already exists**:

1. **Chat has no real conversation memory.** `portal-chat.js` calls `loop.run()` with no `history`
   and no `conversationId` (`portal-chat.js:256-261`). The history+compaction path
   (`runAgentTurn`, `history.js`, `compaction.js`) is wired **only** to scheduler/channel
   (`run-turn.js:74-87`), which chat bypasses. The conversation's prior turns survive only as a
   lossy side-effect of the `getContext` "recent messages" block (≤12 cloud / ≤5 local, blended
   with all other vault activity). → **Chat feels forgetful.**
2. **Autonomy is unreachable.** The scheduler runs at boot in the real app (`server-rest.js:477,552,562`),
   but there is **no UI and no chat path to create a scheduled task**: `schedule_task` is deliberately
   excluded from the chat tool domains (`tool-domains.js:9-19`) and there is no portal form. So the
   autonomous loop has nothing to run. → **"Autonomous" does nothing.**
3. **Retrieval is one-shot, not agentic.** `getContext` and `searchMindscape` are baked into the
   system preamble once per turn (`portal-chat.js:228-233`); they are **not** tools the model can
   call iteratively to dig. If the upfront search misses, the model can't refine. → **"It doesn't
   know things."**

Plus secondary degraders: no prompt caching (cost/latency), local models silently get **zero tools**
with no signal to the user, silent context truncation, and the channel native engine is still off by
default (channels run the Claude Agent SDK in the daemon).

The reference engines (OpenClaw/opencode/Hermes) converge on a small set of **perceived-quality
patterns** we lack: a three-tier cached prompt (stable identity / context / volatile memory tail),
compaction-as-handoff-doc, an outer-loop **execution-bias / planning-only breaker**, invisible-failure
→ model fallback, importance-aware tool-output truncation, a memory **durability taxonomy**, and a
**deferred tool catalog** for large tool sets. These are the design targets in §4–§5.

---

## 1. How the harness actually works (as-built)

```
ONE engine: streamTurn (harness.js:355) — single model exchange + INNER tool loop (≤8 iterations,
            3 adapters: Anthropic native / OpenAI-compat / Ollama, egress+usage sinks, output cap 32k)
  wrapped by: loop.run (loop.js:62) — watchdog (TTFB 45s / IDLE 60s) + retry-on-empty backoff +
            optional pre-content provider-fallback chain. NOT a multi-turn/steering loop.
  assembled by: runAgentTurn (run-turn.js:43) — provider resolve + role preamble + getContext +
            OPTIONAL history+compaction + model-aware budget + autonomyTools + in-proc call.

THREE surfaces:
  • chat      POST /chat/stream → builds system inline, calls loop.run DIRECTLY (bypasses runAgentTurn,
              so NO history, NO compaction)                                   portal-chat.js:144,256
  • scheduler setInterval tick → runScheduledTurn → runAgentTurn (history threaded)   scheduler.js
  • channel   /internal/agent/channel-turn (loopback-gated) → triage → runAgentTurn   channel-turn.js
              — but DORMANT: daemon defaults to the Claude Agent SDK backend, not this
                                                       channel-daemon/agent/runtime.js:46-69
State (encrypted at rest, migration 0019): scheduled_tasks · harness_runs · conversation_summaries
Narration (Phase 2, LIVE): narration-walk.js drives describeEntity over territories/realms,
              triggered by the clustering job, not by the user.            narration-runner.js
```

**Key structural fact:** the agentic capability is **`streamTurn`'s inner 8-iteration tool loop**.
`loop.run` adds reliability only; there is **no outer multi-turn continuation, no steering queue, no
planning loop**. This is adequate for "answer with a few tool calls" but not for "keep working a task."

---

## 2. LIVE / DORMANT / BUGGY (own-eyes)

| Subsystem | State | Evidence | User impact |
|---|---|---|---|
| In-app chat turn (streamTurn via loop.run) | **LIVE** | `portal-chat.js:256` | This *is* the agent the user talks to |
| Chat conversation history / threading | **MISSING** | no `history`/`conversationId` at `portal-chat.js:256-261` | Forgetful chat (#1 complaint) |
| Chat compaction | **MISSING** (never reached) | `compaction.js`/`history.js` called only by `run-turn.js:81` | Long chats degrade |
| Iterative retrieval (search/getContext as tools) | **MISSING in chat** | baked into system at `portal-chat.js:228-233`; not in granted tool set | "Doesn't know things" |
| Scheduler (autonomous wake-cycles) | **LIVE at boot** (real app) | `server-rest.js:477,552,562` — gated `!injectedKeys` | Runs, but nothing to run |
| Task-creation path (UI or chat) | **MISSING** | `schedule_task` excluded from chat (`tool-domains.js:9-19`); no portal form | Autonomy unreachable |
| Daily token budget | LIVE, **fail-open** (0 = unlimited) | `scheduler.js:113` | Runaway-bill risk if turned on |
| Channel native engine | **DORMANT** (opt-in) | `channel-daemon/agent/runtime.js:46`; default = Claude SDK | Channels not on our engine |
| Group triage (REPLY/NO_REPLY) | LIVE on native path only | `triage.js`, `channel-turn.js:61` | n/a until native channels on |
| Autonomy tools (schedule/cancel/list/reply) | Registered, **inert** until `enabledTools` | `autonomy-tools.js:30-49`, `mcp.js:139` | n/a until a task exists |
| Narration walk (describeEntity) | **LIVE**, clustering-triggered | `narration-runner.js`, `narration-walk.js:88-139` | Works; not user-initiated |
| Prompt/context caching | **NONE** | no `cache_control` in `harness.js:104` adapter | Slow/expensive repeats |
| Local-model degradation signal | **MISSING** | tools silently `[]` at `portal-chat.js:257`; no UI event | Confusing local UX |
| Context truncation signal | **MISSING** | silent slice at `portal-chat.js:240` | User over-trusts context |

---

## 3. Root-cause findings (ranked by felt impact)

### F1 — Chat is effectively single-shot (THE headline)
`portal-chat.js:256-261` passes only `{ system, userMessage }` to `loop.run`. There is no
`conversationId` assigned to a ChatFloat thread, and no `selectByConversation` hydration. The user's
prior turn is visible to the model only if it happens to fall inside `getContext`'s recent-messages
window — which is global vault activity, capped at 12/5, not a clean user/assistant turn array.
**Consequence:** follow-ups lose the thread; the model re-asks for context it was just given. The fix
machinery is *already built* and used by the other two surfaces (`run-turn.js:74-87`,
`history.js hydrateHistoryBlock`, `db.harness.get/putSummary`). Chat just doesn't call it.

### F2 — Autonomy has no on-ramp
Scheduler is live (`server-rest.js:552`) but `schedule_task` is intentionally absent from chat's
grant (`tool-domains.js:9-19`, by design H5) and there is no portal "Schedules" UI (confirmed: no
form in `portal-app`). Net: a user cannot create a recurring task by any means. The "autonomous loop"
is real code that never fires for lack of input.

### F3 — Retrieval is a one-shot preamble, not an agentic tool
`getContext` (`portal-chat.js:228`) and `searchMindscape` (`:229-233`) run once, before the model
starts, and are concatenated into `system`. The model cannot call them again to refine a search or
refresh state mid-turn (search/getContext are not in the granted tool list for chat in practice — the
grant is policy-domain filtered and the briefing is treated as the substitute). On a miss, the model
improvises rather than digging. Errors are swallowed (`catch { /* skip */ }`), so a failed search
silently yields empty retrieval.

### F4 — Local models are silently lobotomized
`tools: isLocal ? [] : grantedTools` (`portal-chat.js:257`) — on-box models get **no tools at all**
(rationale: tool-grammar TTFB blowup, real and measured) and a smaller briefing (`recentN=5`,
`sysCap=5000`). This is defensible, but there is **no UI signal** ("running local — tools off"), so a
user who switched to Ollama experiences a mysteriously dumber agent.

### F5 — No prompt caching
The Anthropic adapter sends a plain body with no `cache_control` (`harness.js:104`). The `getContext`
preamble is large and largely stable across turns in a conversation — the ideal cache prefix — so we
pay full input tokens and first-token latency every turn.

### F6 — Channels still run an external SDK
The daemon's `selectRuntime` defaults to the Claude Agent SDK / Ollama, not our `streamTurn`
(`channel-daemon/agent/runtime.js:46-69`); native is opt-in via `MYCELIUM_CHANNEL_ROUTER=native`.
So channel auto-reply doesn't share the engine, the sovereignty floor, or any fix we make to chat.

### F8 — The channel/autonomous agent CANNOT write to the vault (operator-observed)
The agent the user talks to on a channel reports exactly three tools: `getContext`,
`searchMindscape`, `reply`. Ground truth: the daemon's Claude SDK backend **hardcodes** that list
(`channel-daemon/agent/backends/claude-sdk.js:84-87`, comment: *"no write tools on an autonomous
reply turn"*). The **native** path has the same ceiling — `SAFE_AUTONOMOUS_TOOLS`
(`autonomy-tools.js:20-24`) is entirely read-only and the gated set
(`schedule_task`/`cancel_task`/`list_my_schedules`/`reply`/`describeEntity`,
`autonomy-tools.js:30-32`) contains **no** `remember`/`saveDocument`/`captureMessage`/`mark`/`link`/
`editMindFile`. So every autonomous + channel turn — SDK or native — is structurally read-only.
**Rationale (sound):** channel input is untrusted (injection defense §5.11); an untrusted-input write
could poison the vault. **But the felt cost is severe:** a vault assistant you message on Telegram
cannot capture "remember X" — it can only reply. The untrusted framing is load-bearing for *group /
forwarded* content; in a **1:1 DM from the vault owner** the input is as trusted as in-app chat.
**Consequence:** the assistant feels inert — it answers but never *grows the vault*, defeating the
core "AI that knows + grows with you" pillar.

### F7 — Honest but blunt failure UX
Silent context truncation (`portal-chat.js:240`), and an over-broad "didn't respond after several
tries" when `lastErr` is null/abort (`portal-chat.js:286-288`). The watchdog/retry is good; the
*explanation* to the user is thin.

---

## 4. What the reference engines do better (patterns to steal)

Each row: mechanism · reference file:line · why it lifts felt quality.

| # | Pattern | Reference | Why it helps |
|---|---|---|---|
| R1 | **Three-tier system prompt: stable / context / volatile** — cache the identity+tools prefix, append memory+profile+clock LAST, never cached | Hermes `agent/system_prompt.py:62-402`; OpenClaw cache-boundary `system-prompt-cache-boundary.ts:8` | Fresh "knows you now" every turn while the expensive prefix stays byte-stable → cache hits → faster = smarter-feeling |
| R2 | **Date/time as a tool, not a baked value** | OpenClaw `system-prompt.ts:1125`; opencode session_status | A static timestamp changes the prefix every turn (kills the cache) *and* lets the model cite a stale clock |
| R3 | **Compaction = structured handoff doc**, spliced as the lead message; protect recent ~20k tokens verbatim; never split a tool_use/result pair; "memory is ALWAYS authoritative over this summary" | OpenClaw `compaction.ts:439-470,308-349`; Hermes `context_compressor.py:1282-1398,37-61`; opencode Goal/Progress/Next schema | Post-compaction the agent *resumes mid-task* instead of vaguely "remembering we talked"; never hallucinates from a lossy summary |
| R4 | **Execution-bias + planning-only/empty-turn breaker** in an OUTER loop: detect "I'll first do X…" then-stop turns and re-dispatch "act now"; fail loud if it persists | OpenClaw `system-prompt.ts:447-462`, `incomplete-turn.ts:122-136,220` | Kills the canonical incompetent-feeling failure (all talk, no action). Highest ROI for a task-doing assistant |
| R5 | **Invisible-failure → fallback**: a run that produced *no visible reply* becomes a synthetic failover that advances the model chain | OpenClaw `result-fallback-classifier.ts:89-117` | The user never sees a blank turn; a silently-failing model is retried on another |
| R6 | **Importance-aware tool-output truncation (head+tail)**: detect error/result signals in the tail, preserve it, mark the omitted middle, hint "rerun with narrower args" | OpenClaw `tool-result-truncation.ts:43-133` | The stack trace / "Done." at the *end* is what the model needs; naive head-cut throws it away and the model hallucinates the result |
| R7 | **Memory durability taxonomy**: "injected every turn → keep compact; declarative facts not instructions; no SHAs/dates/task-state; stale-in-a-week ⇒ not memory" | Hermes `prompt_builder.py:143-164` | Makes always-on recall feel like it knows you without bloat. Directly fixes our 35KB-over MEMORY.md |
| R8 | **Memory prefetched on every turn in a `<memory-context>` fence + non-blocking background writes** | Hermes `memory_manager.py:373-390,429-512` | Recall is authoritative and free; capture never stalls the turn |
| R9 | **Deferred tool catalog (BM25)**: when tool schemas exceed ~10% of context, defer the long tail and let the model search for tools; core tools never deferred | Hermes `tools/tool_search.py:234-258,347-418` | With 34+ vault tools + MCP, fewer better-matched schemas per turn → sharper tool selection (this very session uses the same `ToolSearch` mechanism) |
| R10 | **Mid-run steering queue** with an `[OUT-OF-BAND USER MESSAGE]` marker the model is told to trust *only* in that exact form | Hermes `conversation_loop.py:522-571`, `prompt_builder.py:461-472`; OpenClaw `attempt.queue-message.ts` | User can course-correct a long turn without it being mistaken for injected text |
| R11 | **Autonomy that's surfaced, not silent**: cron with explicit `deliver: local\|telegram\|discord:<id>` routing; structured completion summaries; curator that **archives, never deletes**, reactivates on reuse | Hermes `cron/scheduler.py:426-509`, `curator.py:1817-1836` | Proactive reflections that always land in a named channel feel helpful, not spooky; recoverable GC preserves trust |
| R12 | **Repetition guardrails** (exact-call / same-tool / no-progress, warn→halt) | Hermes `tool_guardrails.py:224-376`; OpenClaw `tool-loop-detection.ts` | Breaks "search returns nothing → search again identically" death-loops on its own (we have a 3-repeat breaker in `streamTurn`; theirs is richer) |

**Parity / already-good (no action):** cron DSL expressiveness, decorrelated-jitter backoff,
error-class taxonomy, untrusted-input envelope, egress chokepoint — ours match or exceed the refs, and
our at-rest encryption + codes-only audit are *ahead* of all three dev-tool engines.

**Confirmed non-goals for V1 (keep deferred):** sub-agent spawning/delegation trees (single-user
vault; Claude-SDK guidance flags subagent sprawl/OOM as the top complaint), mid-turn human approval
gates (the user *is* the operator; allowlist is simpler+safer), full credential-pool multi-candidate
fallback (one user, few keys).

---

## 4.5 Agent identity & capability model (operator directive, 2026-06-19)

**Directive:** capability must be gated by **agent identity**, not by surface. The operator's *personal*
agent gets **full access** (read + write + memory + schedule + reply); *user-created* agents get
**scoped, fail-closed** access. This **supersedes the read-only-everywhere posture in F8/P0.5** and
reframes the grant logic.

**Why this is the right abstraction.** Today the grant is `f(surface)`: chat → domain policy, every
autonomous/channel turn → uniform read-only (`autonomy-tools.js:20-32`; `claude-sdk.js:84`). That
conflates two independent things — *who the agent is* (its authority) and *whether the input is
trusted* (injection risk). Separate them:
- **Capability** is a property of the **agent identity** (the personal agent is the operator; it has the
  keys to everything). 
- **Input trust** is a property of the **message** (a forwarded/group message is untrusted regardless
  of which agent reads it) → handled by the untrusted envelope (`untrusted.js`, §5.11) + the audited
  egress chokepoint, **not** by stripping capability.

So: grant = `f(agentId, inputTrust)`, where `inputTrust` fences *data*, and `agentId` sets the *ceiling*.

### Operator decisions (2026-06-19, LOCKED)
- **Created agents are for:** (1) **channel-bound personas** (a Telegram concierge, a Discord bot — a
  persona tied to a channel/account), and (2) **outward-facing / federated** agents (others / other
  instances interact with a scoped view of the vault). *Not* in scope: task sub-agents, in-app workspace
  switching.
- **Scope is expressed as:** **domains** (reuse `tool-domains.js`) **+ capability flags**
  (`write`/`egress`/`schedule`/`publish`).
- **Consequence:** scoped agents are **interacted with by other people**, so they need a **second scope
  axis — content visibility** (below). This is the security crux the operator's choice surfaces.

### Tiers & the two scope axes

A scoped agent's grant has **two independent axes**. Tool-scope says *what it can do*; content-scope
says *over what data*. Both fail-closed.

| Axis | Meaning | Primary agent | Channel-bound (owner's own) | Outward-facing / federated |
|---|---|---|---|---|
| **Audience** | who talks to it | the owner | the owner | other people / instances |
| **Tool scope** | domains + `write`/`egress`/`schedule`/`publish` | **all** | per-profile (often full) | fail-closed: typically read/search + `reply`/`publish` only |
| **Content scope** | which vault content it can read | **everything** | everything (it's the owner) | **only the explicitly-shared subset** — never the full private vault |
| **Input trust** | how its input is treated | fenced + audited | fenced + audited | **always untrusted** + fenced + audited |

- **Primary (personal)** — `is_primary=true`. FULL tools (`remember`, `saveDocument`, `editMindFile`,
  `mark`, `link`, `captureMessage`, `schedule_task`, `reply`), FULL content. Runs in-app chat, the
  owner's own channel DMs, owner-authored tasks. Untrusted input is still fenced + writes/egress
  audited; capability is unrestricted (single-user → the operator owns the vault; writes are
  versioned/recoverable).
- **Scoped (created)** — fail-closed on **both** axes. Tool scope = read-safe ∪ granted domains ∪
  enabled flags. Content scope = the **shared subset only** for any agent whose audience is *public*.
  The scope is the hard floor — an injection can't exceed it even if intent succeeds.

### Content scope = reuse the publish/share layer (do not invent a new one)
For outward-facing agents, "what content is visible" must reuse the **existing publish pipeline +
sharing mechanism** (published documents / explicitly-shared items) and the legacy federation design
(`docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` — SPARSE concept-aware privacy, shared spaces), not a
new mechanism. The agent's `call`/tool dispatch filters every read (`searchMindscape`, `getDocument`,
`getContext`, …) to the shared subset; anything outside it returns empty, fail-closed.
**Honest V1 limit:** in V1 (single process, one key) this content boundary is a **query-layer
allowlist, not a cryptographic isolation boundary** — the in-process code *could* read everything; the
scope is enforced in the read path + audited. True cryptographic per-agent isolation is V2/RLS
(`docs/REDESIGN-LIVING-SPEC.md`). For V1 single-user this is an acceptable defense-in-depth floor, but
it **must be stated** so no one mistakes a federated agent for a hard security boundary. This is the one
place the model touches the §⚠️ "tenant isolation is total" principle — treat its threat review as
load-bearing.

### Concrete shape (sketch — to be sweep-verified before build)
- **`agents` registry** (new table): `id, name, persona, is_primary, capability_scope (JSON:
  {domains:[...], write, egress, schedule, publish}), trust_tier, bindings, created_by, created_at`.
  Seed the **primary** row from today's single `db.users.getSettings().agent` identity
  (`run-turn.js:26`).
- **`resolveAgentGrant(agent, {inputTrust, surface})`** replaces the surface-uniform logic:
  `is_primary` → full registry; else read-safe ∪ scope. One function, used by **all** surfaces.
- **Each turn carries an `agentId`:** chat → primary (or a user-picked agent); channel → the agent
  **bound to that channel** (default = primary for the owner's own accounts); scheduler →
  `scheduled_tasks.agent_id`.
- **Rewires, not rebuilds:** the daemon SDK backend stops hardcoding `allowedTools`
  (`claude-sdk.js:84`) and asks the vault for the bound agent's grant; `autonomy-tools.js` becomes
  identity-aware; chat's domain policy becomes "the primary agent's full grant (or the selected
  agent's scope)." Each scoped agent also carries its own **persona** (SOUL-like) — the per-agent
  identity tier the reference engines use (R1).

### Scope note vs the deferred multi-agent non-goal
The prior gap doc deferred *sub-agents / delegation trees* (concurrency-bounded process spawning) as a
V1 non-goal. This is **lighter and different**: capability-**scoped identities** (a grant profile +
persona), all in-process, no spawn concurrency. V1 can ship "primary + named scoped agents bound to
channels/tasks" without any process-isolation machinery. It is, however, the clean substrate a later
delegation feature would sit on. **This expands the locked V1 D5/H-series scope — flag for the build
gate.**

### Resolved + remaining
- **Resolved (above):** purpose = channel-bound + outward-facing/federated; scope = domains + flags.
- **Remaining reconciliation (not a blocker, do at build):** lock the content-scope binding to the
  publish/federation layer — confirm the exact "shared subset" predicate (published docs only? shared
  spaces? per-agent allowlist of realms/tags?) against `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md`
  and the live publish pipeline before building outward-facing agents. Channel-bound *owner* agents can
  ship first (full content, no content-scope needed); outward-facing agents follow once the predicate
  is locked.

## 5. Design sprint — prioritized plan

Each item is independently shippable, sweep-first, behavior-preserving for unrelated paths, and has a
falsifiable gate. Chat must stay byte-identical where not explicitly changed (same discipline Step 7
used). Ordered by **felt-quality ROI / effort**.

### P0 — Restore basic competence (the "make it work" tier)

**P0.1 — Thread conversation history + compaction into chat.** *(F1; the headline)*
Route chat through the **existing** `runAgentTurn` history path, or pass `history` + `conversationId`
into chat's `loop.run` call. Assign a stable `conversationId` per ChatFloat thread; hydrate via
`db.messages.selectByConversation(userId, conversationId, {limit})`; reuse `hydrateHistoryBlock` +
`db.harness.get/putSummary` (all built — `run-turn.js:74-87`). Persist user+assistant turns with that
`conversationId` (today they save with no thread key — `portal-chat.js:279`).
*Gate:* a 5-turn chat where turn 5 correctly answers a question that depends only on turn 2; a synthetic
200-message thread compacts and rehydrates as summary+tail (mirror the spec's Step-3 test, §10).
*Risk:* hot path — gate behind `verify:chat` + live portal smoke.

**P0.2 — A task-creation on-ramp for autonomy.** *(F2)*
Pick one (see Decisions §6): (a) a portal "Schedules" panel (CRUD over `scheduled_tasks` via a small
REST surface + `db.harness`), and/or (b) a **separate, explicitly-gated** "agenda" chat affordance that
can call `schedule_task` only when `settings.autonomy.enabled` (preserving the chat-exclusion invariant
for the default chat domain). Set a **default `MYCELIUM_DAILY_TOKEN_BUDGET`** before any of this ships
(F-budget; `scheduler.js:113` is fail-open today).
*Gate:* user creates an `interval:2m` task from the UI; it fires twice in 5 min with correct `next_run`
and zero double-runs in `harness_runs`; output is delivered to the chosen target.

**P0.3 — Make retrieval agentic.** *(F3)*
Add `searchMindscape` (and optionally `getContext`) to the chat **tool** grant so the model can refine
a search or refresh state mid-turn, in addition to (or instead of) the one-shot preamble injection.
Surface the search-error path instead of swallowing it (`portal-chat.js:231`).
*Gate:* a question whose answer needs a second, differently-worded search succeeds where the one-shot
preamble fails today.

**P0.4 — Signal local-model degradation.** *(F4)*
Emit a UI event when `isLocal` strips tools / shrinks context ("Running on-box model — tools off for
speed"). No behavior change, just honesty. *(Tiny.)*

**P0.5 — Agent identity & capability tiers (the §4.5 model).** *(F8; operator directive)*
Implement the `agents` registry + `resolveAgentGrant(agent, {inputTrust, surface})` from §4.5. **Primary
agent → full grant** (read + write + schedule + reply) on every surface it runs (in-app chat, owner
channel DMs, owner-authored tasks); **scoped agents → fail-closed allowlist** per their profile. Rewire
the three grant sites to call one resolver: `autonomy-tools.js:20-49`, the daemon SDK `allowedTools`
(`claude-sdk.js:84`), and chat's domain filter (`portal-chat.js:150`). Untrusted input is still fenced
via the envelope (§5.11) + audited egress for **all** tiers — capability is the ceiling, the envelope
handles trust. Phase it: **(a)** seed the primary row + give it the full grant (unblocks "my agent can
write" immediately); **(b)** the scoped-agent registry + creation surface.
*Gate (a):* the primary agent, on an owner Telegram DM "remember I have a dentist appt Tuesday",
persists a fact via `remember` that survives a vault reopen; in-app chat unchanged.
*Gate (b):* a scoped read-only agent bound to a channel performs **zero** writes even when its input
contains an injected "save this" (verified in the audit + DB); a scoped agent can never exceed its
profile.
*Security note:* this *loosens* a fail-closed boundary for the primary tier — it gets its own
`/sweep-first-design` + threat review + a human approval before merge (security-sensitive diff). The
primary tier's safety rests on identity binding (it only runs for the owner) + audit + recoverable
versioned writes, not on capability removal.

### P1 — Make it feel smart (the "lift quality" tier)

**P1.1 — Three-tier cached prompt + prompt caching.** *(R1, R2, F5)*
Split the chat/`runAgentTurn` system into a **stable prefix** (identity + orientation + tool guidance)
and a **volatile tail** (`getContext` briefing + retrieval + clock). Mark the stable prefix
`cache_control: ephemeral` on the Anthropic adapter (`harness.js:104`); make "current time" a tool, not
a baked string (R2). Split `cacheRead`/`cacheWrite` into `harness_runs`/`llm_usage` (the prior doc's G3).
*Gate:* measurable cacheRead tokens on the 2nd+ turn of a conversation; no behavior change.

**P1.2 — Outer-loop execution-bias + planning-only/empty breaker.** *(R4, R5)*
Add an Execution-Bias section to the system prompt and an **outer** detector in `loop.run`/a thin wrapper
that classifies a finished turn as `planning_only` / `empty` / `reasoning_only` and either re-dispatches
once ("act now") or fails over the provider chain (we already have the chain — `loop.js:66-75`).
*Gate:* a "first I'll check X then fix Y"-style turn is detected and converted to an action or an honest
loud block; a model that returns nothing fails over instead of showing a blank bubble.

**P1.3 — Importance-aware tool-output truncation.** *(R6)*
Replace the flat 32k head-cut (`harness.js:436`) with head+tail preservation that detects error/result
signals in the tail and appends a "rerun with narrower args" notice.
*Gate:* a 100k-char tool result whose error is in the last 1k is preserved and the model acts on it.

**P1.4 — Compaction-as-handoff-doc + memory-authoritative guardrail.** *(R3)*
Upgrade the compaction summary prompt to the fixed Goal/Constraints/Progress(Done/InProgress/Blocked)/
Decisions/Next/Critical schema, protect the recent tail verbatim, never split a tool pair, and add the
"your durable memory is ALWAYS authoritative over this summary" line. (Compaction primitives exist;
this is a prompt + cut-point upgrade in `compaction.js`.)
*Gate:* post-compaction the agent resumes the exact open task, not a vague recap.

### P2 — Depth & reach (post-launch unless a need appears)

- **P2.1 Memory durability taxonomy** (R7) — encode the "declarative, durable, char-capped, no
  SHAs/dates/task-state" rules into the memory-write guidance and run a one-time consolidation
  (also fixes the 35KB-over MEMORY.md). Pairs with the Context Engine work already in flight.
- **P2.2 Deferred tool catalog (BM25)** (R9) — once chat exposes more tools (P0.3) + MCP, defer the
  long tail behind a tool-search bridge; never defer core tools.
- **P2.3 Channel native migration** (F6) — flip `MYCELIUM_CHANNEL_ROUTER=native` by default after a
  live Telegram round-trip smoke; channels inherit every P0/P1 fix.
- **P2.4 Autonomy surfaced + curator** (R11) — delivery routing for scheduled output + an
  archive-never-delete hygiene cycle.
- **P2.5 Mid-run steering queue** (R10) — only if interactive long-running turns become common.

**Decline for V1 (documented, not omissions):** sub-agents/delegation, human approval gates, full
credential-pool fallback. Revisit only on a concrete need.

---

## 5.5 Locked build plan (sweep-verified 2026-06-19)

Four parallel sweeps (frontend chat thread · backend history wiring · agent registry/grant · channel
grant + content-scope) verified every seam below at file:line. Net finding: **the architecture is
already partly multi-agent** (`messages.agent_id` + indexes `0001_init.sql:950,1831`;
`agent-id-aliases.js`; `mcp.js buildDomains({agentId,identity})` `:57-64`; agentId-aware mind-files;
`egress_audit.agent_id`). The backend simply **ignores `agentId`** (chat reads only `req.body.message`,
`portal-chat.js:144`) and stores one identity in `user.settings.agent`. So the work is small + additive.

### Workstream 1 — P0.1 chat history (Path B, behavior-preserving)
Hydrate a history block **inside `portal-chat.js`** (do NOT route through `runAgentTurn` — that drops
SSE streaming, the `searchMindscape` preamble, local-model heuristics, policy gating, and error
mapping). All primitives exist.
- Touch-points: import `hydrateHistoryBlock` (`portal-chat.js:17`); accept/derive a `conversationId`
  (`:144`); fetch `db.messages.selectByConversation(userId, conversationId, {limit:50})` → reverse →
  `[{role,content}]` (`messages.js:687`); append the hydrated block after `getContext`/before trim
  (`:228-240`, mirror `run-turn.js:74-87`); persist both turns with `conversationId` —
  `captureMessage` already accepts it (`capture.js:141`); pass `clientGoneCtrl.signal` into the
  `summarize` callback (**required** — a long summary otherwise stalls the SSE stream).
- Gates: 5-turn chat answers a turn-2-only fact; synthetic 200-msg thread compacts + rehydrates as
  summary+tail; `messages.conversation_id` populated on both rows. `verify:chat` + live portal smoke.
- **Open product decision (thread key — §6 #3):** the frontend already sends `agentId` + `spaceId`
  but no `conversationId`, and loads history per-agent (`chat.ts:44-61`). Recommended: a
  **client-generated `conversationId` per thread** (new id on "Clear"/new chat), sent on
  `/chat/stream` + history load. Modest frontend change in `ChatFloat.svelte`. (Alt: thread by
  `agentId` = one ever-growing thread — simpler, but no separable conversations.)

### ⚠ Build-time pivot (2026-06-19): W2 premise dissolved → fold into W3
On contact with the code, W2's premise ("primary = full grant unlocks chat writes") proved **void**:
`defaultPolicy()` already grants ALL domains (`tool-domains.js:72-74`) and chat's grant is
`toolsForDomains(tools, policy.domains)` (`portal-chat.js:150`) — so **in-app chat already has full
write access by default** on any cloud model. The read-only wall the operator hit was the *channel* SDK
backend (`claude-sdk.js:84`) = **W3**. So: forcing the primary past the user's AI-Access policy would
be wrong (the policy is the user's control); a standalone registry now has no live consumer (chat
already works) and would hit the encrypted-`settings` backfill landmine for no felt gain → premature
abstraction. **Decision:** build the `agents` registry + `resolveAgentGrant` **with W3**, where
owner-vs-scoped first does real work. W1 shipped standalone (PR `feat/native-chat-history-agent-identity`).

### Workstream 2 — P0.5(a) agent registry + primary = full grant  *(SUPERSEDED by the pivot above; merged into W3)*
Net-new (small): `agents` table (`id,user_id,name,personality,is_primary,capability_scope JSON,
created_by,created_at`); `db.agents` DAL (~50 LOC); `resolveAgentGrant(registry, agent, {surface,
inputTrust, policy, enabledNames})` (~30 LOC, **one** function replacing the three grant sites —
`portal-chat.js:150` chat, `autonomy-tools.js:40-49` autonomous, `claude-sdk.js:84` SDK); backfill
migration seeding the **primary** row from `user.settings.agent` (`JSON_EXTRACT(settings,'$.agent.*')`).
- Chat wiring: read `req.body.agentId || 'personal-agent'`; primary → registry ∪ write tools
  (`remember`/`saveDocument`/`updateDocument`/`editMindFile`/`writeMindFileWhole`/`mark`/`link`/
  `captureMessage`/`createTask`/`updateInternalModel`) regardless of policy toggles; scoped agents →
  fail-closed per `capability_scope`.
- Migration number: next free is **0028**, but a concurrent branch claims 0028 (cluster diagnostics)
  → use **0029** (confirm at merge).
- Gates: primary writes a fact via `remember` in chat that survives reopen; a scoped read-only agent
  cannot exceed its profile; existing single-agent UX unchanged.

### Workstream 3 — P0.5(b) owner channel = full access (COUPLED to native flip)
The daemon already computes `senderRole = fromId===ownerTelegramId ? 'owner':'other'`
(`inbound.js:115`) and persists it, but does **not forward it** to the turn. The clean fix is the
**native** channel path (3 files, ~10 LOC): forward `senderRole` in the native backend POST body
(`native.js:33-40`) + into `turnCtx` (`inbound.js:144-152`); in `channel-turn.js:70-74` resolve the
grant by role — **owner DM → primary's full grant (incl. write tools); other/group → read-safe + reply,
fail-closed**. Untrusted envelope (`untrusted.js`) still wraps all inbound; egress still chokepointed.
- **Dependency:** this requires `MYCELIUM_CHANNEL_ROUTER=native` (today the daemon defaults to the
  Claude SDK backend — `runtime.js:46-69`). So **fixing the channel-write complaint = flipping channels
  to the native engine (P2.3)**. The alternative (un-hardcode `claude-sdk.js:84`) is more work + splits
  grant logic across processes → rejected. Flip native after a live Telegram round-trip smoke.
- Gate: owner Telegram DM "remember dentist Tuesday" persists via `remember` + survives reopen; a
  group/forwarded message with an injected "save this" performs **zero** writes (audit + DB verified).
- **Security:** crosses a fail-closed boundary (write tools on a channel turn) → own threat review +
  human approval before merge. Safety rests on owner identity-binding + untrusted envelope + audit +
  recoverable versioned writes.

**AS-BUILT (2026-06-19, branch `feat/native-chat-history-agent-identity`):**
- `senderRole` forwarded: `inbound.js` turnCtx → `native.js` POST body → `channel-turn.js`.
- `channel-turn.js`: owner 1:1 DM (`senderRole==='owner' && !group`) → **trusted**: message passed
  verbatim (NO untrusted wrap), owner system preamble, full grant. Everyone else + every group →
  unchanged (untrusted-wrapped, read-safe ∪ `reply`).
- Grant seam `src/agent/resolve-grant.js` (`channelEnabledTools`/`isOwnerTrustedTurn`) — the
  identity→capability decision in one place. `autonomy-tools.js` gains `WRITE_AUTONOMOUS_TOOLS`
  (remember/saveDocument/mark/link/captureMessage/editMindFile/… — granted ONLY when named; egress
  tools like `publishDocument`/`forget` deliberately excluded).
- **Decision: scoped registry deferred.** No `agents` table built — owner-vs-other is binary and needs
  no named-agent rows yet; the table lands when the user can create + bind named agents (channel
  personas / federated). This keeps W3 focused + dodges the encrypted-`settings` backfill landmine.
- Gates GREEN: `verify:harness-channel` C10 (owner DM verbatim + write grant + owner preamble), C11
  (owner-in-group → still untrusted + reply-only — the security boundary), C12 (non-owner DM →
  reply-only); `verify:harness-tools` P2 (write granted only when named; truly-unlisted never granted);
  all 17 `verify:harness*` + `verify:chat` GO.
- **⚠ DORMANT until the operator flips the engine.** The fix lives on the native path; channels still
  default to the SDK backend (read-only `claude-sdk.js:84`). **Activation:** set
  `MYCELIUM_CHANNEL_ROUTER=native`, then live-smoke a real owner Telegram DM ("remember … Tuesday" →
  persisted fact) + an injection/group message (→ zero writes in the audit). Only after that smoke
  should the native default be flipped. Until then the owner channel agent remains read-only.
- **NOT auto-merge** — boundary-loosening diff → human security review (CLAUDE.md §6/§9).

### Workstream 4 — content-scope (DEFERRED, foundation only)
All reads already scope to `userId` (`documents.js:453-466`, `mindscape.js`, `context.js`) — no
cross-user risk. Outward-facing agents need a query-layer filter using the **existing** shared-content
predicate `published===1 ∨ shareLinks.hasActiveLinks(userId,path)` (`documents.js:104-118`, already
production-proven), injected as an optional `contentScope` into the read handlers (defaults null = no
change). No federation router exists yet, so this is **build-when-federated-agents-land**, not now.

### Recommended first slice
**W1 (P0.1 history) + W2 (primary registry + full chat write)** together — they share the `agentId`
read in `portal-chat.js` and fix *forgetful* + *inert-in-chat* in one sweep-first pass. **W3** (owner
channel write) follows, bundled with the native-channel flip + its security review. One isolated
worktree (main is contested). Each lands with `/living-docs` + `/deploy-and-verify` ledger.

## 6. Open decisions for the operator

1. **Autonomy at launch?** Turn the scheduler *on with a default daily budget* and ship a
   task-creation UI (P0.2), or keep it dormant and defer P0.2 post-launch? This gates whether F2/budget
   is launch-blocking. (Carried over from the prior doc's §5 open question — still unanswered.)
2. **Task-creation surface:** portal "Schedules" panel, a gated chat affordance, or both? (P0.2)
3. **Chat history scope:** does a ChatFloat thread get a durable `conversationId` (multi-session
   continuity) or per-session only? (P0.1 — affects whether history persists across app restarts.)
4. **Channel migration timing:** flip native channels now (one engine, sovereignty floor) or after the
   chat fixes land? (F6/P2.3)
5. **Owner-trusted writes:** the §4.5 directive resolves this — primary agent = full write everywhere
   it runs; scoped agents = profile floor. Confirmed direction; needs threat review at build. (F8/§4.5)
6. **RESOLVED (2026-06-19):** created agents = channel-bound personas + outward-facing/federated; scope
   = domains + capability flags. (§4.5)
7. **Content-scope predicate for outward-facing agents** (remaining): what exactly is the "shared
   subset" — published docs only / shared spaces / per-agent realm-tag allowlist? Reconcile with
   `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` + the publish pipeline at build. Not a blocker for
   primary + owner-channel agents. (§4.5)

---

## 7. Verification table (own-eyes, this sweep)

| Assumption | Verified at |
|---|---|
| Chat runs through the native loop, not dead code | `portal-chat.js:64,256` |
| Chat passes NO history / conversationId | `portal-chat.js:256-261` (read) |
| History+compaction wired only via runAgentTurn (scheduler/channel) | `run-turn.js:74-87`; chat does not call it |
| `loop.run` is reliability-only, no multi-turn/steering | `loop.js:62-109` header + signature (read) |
| Agentic capability = streamTurn inner loop (≤8) | `harness.js` (spec §16, `:350-355`) |
| Scheduler live at boot, gated `!injectedKeys` | `server-rest.js:477,552,562` |
| No task-creation UI; schedule_task excluded from chat | `tool-domains.js:9-19`; no portal form |
| Daily budget fail-open (0 = unlimited) | `scheduler.js:113` |
| Channel native router off by default | `channel-daemon/agent/runtime.js:46-69` |
| Narration walk live, clustering-triggered | `narration-runner.js`, `narration-walk.js:88-139` |
| No prompt caching in the adapter | `harness.js:104` (no `cache_control`) |
| Local models get zero tools, silently | `portal-chat.js:257` |
| Channel SDK backend hardcodes read-only tools (getContext/searchMindscape/reply) | `channel-daemon/agent/backends/claude-sdk.js:84-87` |
| Native autonomous grant is read-only; no write tools in SAFE or gated sets | `autonomy-tools.js:20-32` |
| Reference: three-tier cached prompt | Hermes `system_prompt.py:62-402`; OpenClaw `system-prompt-cache-boundary.ts:8` |
| Reference: planning-only breaker | OpenClaw `incomplete-turn.ts:122-136,220` |
| Reference: importance-aware truncation | OpenClaw `tool-result-truncation.ts:43-133` |
| Reference: memory durability taxonomy | Hermes `prompt_builder.py:143-164` |
| Reference: deferred tool catalog | Hermes `tools/tool_search.py:234-258` |
| Hermes is its own engine (not config over openclaw) | `hermes_agent` 0.16.0 ships loop/compressor/cron/pool |

---

## 8. Relationship to existing plans

- **Supersedes** `docs/HARNESS-STATE-AND-GAP-ANALYSIS-2026-06-18.md` §4–§5 (re-prioritizes from infra
  parity to felt quality). §0–§3 of that doc stay valid.
- **Builds on** `docs/NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md` (the locked subsystem spec) — P0.1 is
  literally "finish wiring §5.2/§5.3 into the chat surface," which the spec scoped but the build left
  chat-bypassed.
- **Converges with** the Context Engine work (`persona-transformation-redesign` memory): P1.1 (three-tier
  prompt) and P2.1 (memory taxonomy) are the same surface. Sequence so they don't collide.

## 9. Pickup protocol

1. Confirm worktree isolation before any edit (`git worktree list`) — the main tree is contested.
2. Resolve §6 decisions (esp. #1 autonomy-at-launch) — gates P0.2 + budget.
3. Build P0.1 first (highest ROI, lowest risk — reuses built machinery). Sweep-first its own pass;
   `verify:chat` + live portal smoke; behavior-preserving elsewhere.
4. Each item lands with `/living-docs` + `/deploy-and-verify` ledger.

## 10. Security audit — red team (2026-06-19)

Four parallel red teamers audited the branch (owner-trust chain · prompt-injection→writes ·
conversation/data-scoping · native-flip parity). Verdict: **owner-writes NOT acceptable as-built, and
the native-default flip is NO-GO as a blind flip.** Findings + remediation:

| # | Sev | Finding | Status |
|---|---|---|---|
| RT1 | **CRIT** | Owner-write authority rests on `isTrustedLoopback` + a caller-asserted `senderRole`; no daemon↔server auth → any local process can POST `senderRole:'owner'` and write the vault | **MITIGATED by default** — owner-write now gated OFF behind `MYCELIUM_CHANNEL_OWNER_WRITE` (`resolve-grant.js`); a forged owner claim grants only read+reply. **Proper fix (per-boot shared secret) REQUIRED before enabling the flag.** |
| RT2-H1 | HIGH | Destructive unversioned writes (`remember`/`saveDocument` overwrite; mind-file wipers) reachable from owner-forwarded content | **Partially fixed:** mind-model rewriters (`editMindFile`/`writeMindFileWhole`/`updateInternalModel`) + `forget`/`publish` EXCLUDED from the channel set (`resolve-grant.js`). `remember`/`saveDocument` overwrite-recoverability (versioning) **DEFERRED**. |
| RT2-H2 | HIGH | Channel vault writes are not audited (which tool/target/hash) | **DEFERRED** — required before enabling the flag. |
| RT2-H3 | HIGH | Owner DM ran verbatim with no injection-defense line | **FIXED** — defensive note added to `OWNER_SYSTEM` (forwarded/pasted = data, never write on its strength). |
| RT3-H1/M3/M4 | HIGH | Client-supplied `conversationId` flat keyspace → a chat turn could pull CHANNEL/third-party history into the cloud preamble; summary/persist under attacker-chosen key | **FIXED** — chat threads namespaced `chat:<id>` server-side (`portal-chat.js`); proven by `verify:chat` C11. |
| RT3-H2 | HIGH | Channel *history* replayed into the preamble without the untrusted envelope | **DEFERRED** — render non-owner history untrusted (`history.js`); bounded while writes are off (read+reply only). |
| RT4-B1 | HIGH | Native default = silent-green: `/healthz` reports `replies:'on'` while turns are no-model+silent | **OPEN — blocks the flip.** |
| RT4-B2 | HIGH | Flipping default breaks `selectRuntime` gate; no E2E parity gate exists | **OPEN — blocks the flip.** |
| RT1-M | MED | `group` re-derived by regex (`native.js /group/i`) diverges from authoritative DM/group → Discord guilds misclassify | **DEFERRED** (dormant while writes off) — forward authoritative `isDirect` from the daemon. |

**Fixed + verified this round (all gates GREEN):** owner-write gated OFF by default; write set trimmed
(no mind-model rewriters); injection-defense preamble; `conversationId` namespaced. Gates:
`verify:harness-channel` C10 (trimmed grant + exclusions + preamble), C13 (default-off = reply-only +
wrapped); `verify:chat` C11 (channel-history isolation). All 17 `verify:harness*` + `verify:chat` GO.

### Native-default flip — DEFERRED (NO-GO per RT4)
Not flipped. Blockers: **B1** (honest health — don't report `replies:'on'` for a native runtime with no
server-side model), **B2** (update `verify-harness-channel-native` N7 + add an E2E parity gate), and a
**live Telegram smoke** (media/voice/TTS/chunking/triage/provider-resolution) that cannot run headless.
Parity is otherwise intact (egress/chunking/TTS/media-as-text all chokepoint-side, preserved). The
operator may force native today via `MYCELIUM_CHANNEL_ROUTER=native` accepting the silent-green caveat.

### Enablement checklists (fail-closed prerequisites)
**Before `MYCELIUM_CHANNEL_OWNER_WRITE=1`:** (1) daemon↔server per-boot shared secret on
`/internal/agent/channel-turn` [RT1 CRIT]; (2) audit every channel vault write [RT2-H2]; (3)
overwrite-recoverability for `remember`/`saveDocument` [RT2-H1]; (4) authoritative `isDirect` from the
daemon [RT1-M]; (5) untrusted-frame channel history [RT3-H2]; then a live owner-DM smoke (write persists
+ injection/group → zero writes in the audit).
**Before flipping native default:** B1 + B2 + the live Telegram parity smoke.

### Remediation status — UPDATE (2026-06-19, this session) — supersedes the table statuses above
The prerequisites were implemented. **6 of 7 fixed + gated; native default FLIPPED.**

| Item | Was | Now |
|---|---|---|
| RT1 CRIT daemon↔server auth | mitigated-by-default | **FIXED** — per-boot `CHANNEL_TURN_TOKEN` (server→supervisor→daemon env→header); owner-write requires timing-safe token match; missing/invalid → read+reply. Gate `verify:harness-channel` C14. |
| RT1-MED authoritative isDirect | deferred | **FIXED** — daemon forwards `isDirect`; channel-turn prefers it over the regex. |
| RT2-H2 channel write-audit | deferred | **FIXED** — `channel_write_audit` (migration 0031) + `db.harness.recordWrite/listWrites`; `run-turn.js` audits write tools hash-only, fire-and-forget; owner turns wire the sink. Gate `verify:harness-state` S9 (structural-only, no plaintext). |
| RT2-H3 injection-defense preamble | fixed | FIXED (prior commit). |
| RT3-H1/M3/M4 conversationId namespace | fixed | FIXED (prior commit). |
| RT3-H2 untrusted channel history | deferred | **FIXED** — `history.js` untrusted banner via `hydrateHistoryBlock` flag threaded through `run-turn.js`; owner DMs unframed. Gate `verify:harness-channel` C7/C10. |
| RT4-B1 honest health | open (blocked flip) | **FIXED** — `native.probeHealth()` + loopback `GET /internal/agent/model-status`; daemon stays capture-only when the vault has no model (no silent green). |
| RT4-B2 native gate + flip | open (blocked flip) | **FIXED** — `selectRuntime` default = native; `verify-harness-channel-native` N7 updated. |
| **RT2-H1 overwrite recoverability** | deferred | **STILL DEFERRED** — the only remaining owner-write prerequisite. Spec: write a `document_versions` row in `documents.upsert`'s UPDATE branch (table exists) + a fact-version row before `facts.upsert` overwrite (needs a small migration). Touches the SHARED chat write path → its own sweep-first pass. Mitigated meanwhile by the tool-trim (no mind-file wipers), the write-audit (detection), and the default-off flag. |

**Net:** native default is live (honest health; live Telegram parity smoke still the operator's
final confirmation). The owner-write flag (`MYCELIUM_CHANNEL_OWNER_WRITE=1`) is now safe to enable
**after** RT2-H1 recoverability lands + a live owner-DM smoke (write persists; injection/group → zero
writes in `channel_write_audit`). All gates: 17 `verify:harness*` + `verify:chat` GO.
</content>
</invoke>
