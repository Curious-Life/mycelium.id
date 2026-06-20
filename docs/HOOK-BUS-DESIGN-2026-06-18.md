# Native Agent Harness — Lifecycle Hook Bus (G1) — Design (2026-06-18)

**Status:** ✅ BUILT (Steps 1–4 of 5) on branch `feat/hook-bus` — 2026-06-19. Step 5 = operator live-smoke. Originally LOCKED (sweep-first: 4 parallel Explore sweeps + own-eyes verification of every load-bearing file).

> **Build log (branch `feat/hook-bus`, worktree `mycelium-worktrees/hook-bus`):**
> - **Step 1** (`src/agent/hooks.js` + `verify:harness-hooks` U1–U8) — fire helpers (fail-CLOSED block + timeout, fail-OPEN observers) + `createAgentHooks` tool-guard factory.
> - **Step 2** (`harness.js` streamTurn wiring, K1–K6) — `beforeToolCall`/`afterToolCall` at the single dispatch chokepoint; no-hooks path byte-for-byte unchanged.
> - **Step 3** (`history.js` + `run-turn.js`, K7) — `before/after_compaction` (autonomous-only).
> - **Step 4** (`scheduler.js`, `server-rest.js`+`channel-turn.js`, `narration-runner.js`+`narration-walk.js`, W1–W3) — `createAgentHooks` + `autonomousToolGuard()` env denylist (`MYCELIUM_AUTONOMOUS_TOOL_DENY`) wired into the 3 autonomous surfaces; chat untouched (seam present, no guard).
>
> **Gate `verify:harness-hooks`: 47/47.** Regression GREEN + UNCHANGED: all 18 `verify:harness*`, `verify:chat`, `verify:narration-walk`/`-job`, plus `gating/leak/providers-leak/egress/resolve/cascade/mcp/rest/control-loopback/gateway*/channel-presence`. Full `npm run verify` ran its 11 JS gates green then halted at the Python-venv parity gate (`verify:nomic-embedding-encryption`) — a worktree environment gap (no provisioned `pipeline/.venv`; symlink fails — venvs are path-anchored), NOT a regression: that gate is cross-language measurement-pipeline parity and imports none of the changed files. A true full-chain green needs the real app env (venv + embed-service + network).
>
> **Step 5 (operator, needs the running app):** set `MYCELIUM_AUTONOMOUS_TOOL_DENY=<tool>` → run an autonomous turn (scheduled task or a native-router channel DM) → confirm a `tool_blocked` event + a `tool-guard` audit row (name only) + the turn still completes. Security-sensitive diff (runtime tool gate + plaintext hook surface) → **human approval** before merge per `/auto-merge-on-green`.
**Scope:** G1 from [`HARNESS-STATE-AND-GAP-ANALYSIS-2026-06-18.md`](HARNESS-STATE-AND-GAP-ANALYSIS-2026-06-18.md). Adds a **minimal** lifecycle hook seam to the native agent engine so tool-call gating/observation and compaction become pluggable, instead of the only seams being `onEgress`/`onUsage`/`onStall`. G2 (prompt caching) is a **separate** next-session pass.
**Principle anchors:** CLAUDE.md §1 (zero plaintext leakage), §2 (defense in depth), §3 (fail closed), §8 (audit, no PII), §11 (explicit-send egress chokepoint untouched). Decision context: autonomous-at-launch (operator chose the scheduler runs live), so a runtime tool-call guard is launch-relevant defense-in-depth, not a future nicety.

---

## 0. The decision in one paragraph

Mycelium already has a hook idiom — **dependency-injected sinks** (`onEgress`, `onUsage`, `onStall`, `onHeartbeat`, `send`) handed to `createAgentHarness`/`loop.run`. There is **no** EventEmitter/registry/middleware bus anywhere in `src/` (verified: grep empty). Per `/sweep-first-design`'s "no fourth pattern" rule, we **extend the injected-sink idiom** rather than introduce a global registry: one optional `hooks` object, **single function per event** (not arrays/priority — that's OpenClaw's 40-hook scale we deliberately skip), fired at the two code layers that own the relevant lifecycle. Default (no `hooks`) is **byte-for-byte the current behavior** — the chat regression guarantee.

---

## 1. Revision history

- **v1 (gap-analysis sketch):** "a minimal hook bus (`before_tool_call`/`after_tool_call`/`before_compaction`) so egress-audit/approval/compaction become pluggable."
- **v2 (this doc) — three sweep-driven corrections:**
  1. **Egress-audit is ALREADY pluggable** (`onEgress`, `harness.js:384`, `createEgressAuditSink` `inference/egress.js:20`). "Migrate egress onto the bus" is **moot** — the real new value is the *tool-call* seam (no runtime per-call gate exists today — verified NOT FOUND) and the *compaction* seam. So v2 keeps `onEgress`/`onUsage` exactly as-is (security-critical + gated; minimize blast radius) and adds the genuinely-missing seams.
  2. **Hooks fire at TWO layers, not one.** Tool hooks belong in `streamTurn` (`harness.js`, the single dispatch chokepoint at `:434`, reached by all 4 surfaces). Compaction runs **above** `streamTurn` in `history.js:65` (autonomous-only; chat never compacts). One `hooks` object, two fire-sites.
  3. **Single fn per event, not a registry.** OpenClaw's `before_tool_call` uses a priority-ordered multi-handler registry with `{block, blockReason, requireApproval}` + per-hook fail-closed timeouts (`openclaw/src/plugins/hook-types.ts:524`, `hooks.ts:1268`, `hook-runner-global.ts` `before_tool_call: "fail-closed"`). We **adopt** the `{block, reason}` return + **fail-CLOSED timeout**; we **skip** the registry, priority ordering, and `requireApproval` machinery (YAGNI for a single-user, first-party-only vault).

---

## 2. Consolidated sweep findings (file:line)

**Wiring map (Sweep A).** `createAgentHarness` is constructed **per-surface, 4 sites**, each wiring `{onEgress, onUsage}` identically (only the usage `source` label differs):

| Surface | Harness ctor | loop.run / runAgentTurn |
|---|---|---|
| Chat (interactive) | `portal-chat.js:60` | `loop.run` direct `portal-chat.js:256`; `call` built inline `:244` |
| Channel (auto-reply) | `server-rest.js:327` | `runAgentTurn` via `channel-turn.js:44` |
| Scheduler (wake-cycle) | `scheduler.js:66` | `runAgentTurn` `scheduler.js:86` |
| Narration walk | `narration-runner.js:24` | `runAgentTurn` via `narration-walk.js:120` |

- `runAgentTurn` (`run-turn.js:43`) **receives** `loop` as a dep — it does **not** construct the harness. So a hook attached at `createAgentHarness` reaches every surface, including chat (which bypasses `runAgentTurn`). **The harness is the universal tool-hook attach point.**
- The tool dispatch chokepoint is a **single** line: `out = await call(tc.name, tc.args)` (`harness.js:434`), bracketed by the circuit-breaker (`:429-431`) and `send({type:'tool_start'/'tool_complete'/'tool_error'})` (`:432, :437`). All surfaces' tools execute here regardless of how each built its `call`.

**Compaction (Sweep B).** `hydrateHistoryBlock` (`history.js:46`) → `compact()` (`history.js:65`), persisted via `putSummary` (`:67`). Invoked **only** from `run-turn.js:81` (autonomous, when `history[]` is threaded); **chat never compacts** (single-message-in, no history — `portal-chat.js` passes a `userMessage` string only). No existing sink in `compaction.js`/`history.js`. `before_compaction` sees `{messages: neutral, contextWindow, maxOutputTokens}` (`history.js:50-52`); `after_compaction` sees `{summary, compacted, savedRatio}` (`compaction.js:184-187`).

**Security (Sweep C).** `autonomyTools(registryTools, enabledNames)` (`autonomy-tools.js:40`) is a **grant-time** filter (decides what's in the `tools[]` array), fail-closed. **No runtime per-call gate exists** beyond the wedge circuit-breaker (`harness.js:429`) — `before_tool_call` is the **first** runtime authorization seam; it composes orthogonally (grant-time ∩ run-time). `onEgress` carries **sha256 + length only** (`egress.js:20-39`, `harness.js:381-386`) — the model for a clean observer. The egress **chokepoint** (`reply.js:115` `x-egress-provenance: agent-explicit`) is the only agent→channel path (§11) — hooks must not become a bypass. Redaction helpers exist: `redactSecrets`/`redactDeep` (`crypto/guardians/scrubbers.js:34,41`). No-leak gates to keep green: `verify-harness.mjs` **H5** ("err.message never surfaced", `:136`) and **H6** ("audit carries hash+length, never plaintext" + `SENSITIVE-XYZ` canary, `:147`).

**Reference contract (Sweep D).** OpenClaw `before_tool_call`: returns `{block?, blockReason?, params?, requireApproval?}`; **fail-CLOSED** on throw/timeout (`before_tool_call: "fail-closed"`); per-hook timeout w/ `timeoutBehavior` default `"deny"`; multi-handler first-block-wins by priority; `after_tool_call` is **void/observe-only** (no result mutation). **Adopt:** `{block, reason}` + fail-closed timeout. **Skip:** registry, priority, `requireApproval`, result mutation.

---

## 3. Threat model

| New surface | Risk | Mitigation |
|---|---|---|
| `beforeToolCall`/`afterToolCall` payloads carry **raw `{name, args, output}`** — PLAINTEXT vault data (unlike `onEgress`'s hash) | A hook that logs/forwards args leaks plaintext (§1) | **Trust boundary documented**: hooks are first-party only; built-in hooks log **names + decisions only, never args/output**; `redactDeep` available for any hook that must serialize. The harness can't police a hook's body — so we ship only clean built-ins + a gate canary that fails if a built-in leaks. |
| A blocking `beforeToolCall` that hangs/throws | Could wedge a turn, or (if fail-open) silently allow a tool an approval policy meant to deny | **Fail-CLOSED** + **15s per-hook timeout** → treated as `block`. Observer hooks (`afterToolCall`/compaction/egress) **fail-OPEN** (swallow, like `onEgress`). |
| Hook becomes a second egress path | Bypass the `reply.js` chokepoint / §11 | Hooks never send; an audit hook hashes before any off-box write. Chokepoint code untouched. |
| Double-gating confusion vs `autonomyTools` | A reviewer mistakes runtime gate for grant gate, or they conflict | Documented as **orthogonal layers**: grant-time decides availability; `beforeToolCall` is per-call. A tool not granted is never offered, so `beforeToolCall` only ever sees granted calls — it can only *further* restrict, never re-open. |
| Behavior drift in chat (security-gated hot path) | Regression in the most-used surface | **Default no-hooks = byte-for-byte identical** (every fire-site guards on hook presence); existing H1–H8 gates must stay green unchanged. |

---

## 4. Module shape (exact signatures + LOC budget)

### 4.1 `src/agent/hooks.js` (NEW, ~120 LOC)

```js
/** @typedef {object} AgentHooks
 *  @property {(e:{name,args,surface})=>Promise<{block?:boolean,reason?:string}|void>} [beforeToolCall]  BLOCKING · fail-CLOSED · 15s
 *  @property {(e:{name,args,output,isError,durationMs})=>Promise<void>|void}          [afterToolCall]   observe · fail-OPEN
 *  @property {(e:{messages,contextWindow,maxOutputTokens,conversationId})=>Promise<void>|void} [beforeCompaction] observe · fail-OPEN
 *  @property {(e:{summary,compacted,savedRatio,conversationId})=>Promise<void>|void}  [afterCompaction] observe · fail-OPEN
 */

const HOOK_TIMEOUT_MS = Number(process.env.MYCELIUM_HOOK_TIMEOUT_MS) || 15000;

// fail-CLOSED: throw/timeout → {block:true,reason:'hook-error'|'hook-timeout'}; missing hook → undefined (allow)
export async function fireBeforeToolCall(hooks, evt) { … }
// fail-OPEN: throw/timeout swallowed (logged by caller's logger). Never blocks the turn.
export function fireAfterToolCall(hooks, evt, logger) { … }
export async function fireBeforeCompaction(hooks, evt, logger) { … }
export function fireAfterCompaction(hooks, evt, logger) { … }

// withTimeout(promise, ms) → races a timeout; used only by the blocking fire.

/** Factory: one place builds the standard hooks for a surface (replaces the duplicated
 *  observer wiring is OUT OF SCOPE — onEgress/onUsage stay as-is). Bundles the optional
 *  runtime tool guard (first consumer, §6) so all autonomous surfaces share it. */
export function createAgentHooks({ db, userId, source, toolGuard } = {}) { … }  // → AgentHooks | undefined
```

### 4.2 `src/agent/harness.js` (EDIT, ~18 LOC)
- `createAgentHarness({ onEgress, onUsage, hooks, fetch, timeoutMs, logger })` — add `hooks`.
- In the tool loop (`:425-439`), per tool call, **after** the circuit-breaker (`:431`), **before** `send({type:'tool_start'})`:
  ```js
  const block = await fireBeforeToolCall(hooks, { name: tc.name, args: tc.args, surface });
  if (block?.block) {
    send({ type: 'tool_blocked', name: tc.name });           // no plaintext (name only)
    toolsUsed.push(tc.name);
    results.push(adapter.toolResult(tc, `blocked: ${block.reason || 'policy'}`, true));
    continue;                                                 // do NOT execute call()
  }
  ```
  The model receives the denial as a tool-result and re-plans (parity with OpenClaw's `deny_message`).
- **After** `out = capToolOutput(out)` (`:436`): `fireAfterToolCall(hooks, { name: tc.name, args: tc.args, output: out, isError: isErr, durationMs }, logger);`
- `surface` (a short string: `'chat'|'channel'|'scheduler'|'narration'`) is an optional new `streamTurn` arg, defaulted from the harness ctor — enables a guard to gate by surface.

### 4.3 `src/agent/history.js` (EDIT, ~10 LOC)
- `hydrateHistoryBlock({ …, hooks, logger })` — add `hooks`.
- Before `compact()` (`:65`): `await fireBeforeCompaction(hooks, { messages: neutral, contextWindow, maxOutputTokens, conversationId }, logger);`
- After `compact()` returns (`:65-69`): `fireAfterCompaction(hooks, { summary: res.summary, compacted: res.compacted, savedRatio: res.savedRatio, conversationId }, logger);`

### 4.4 `src/agent/run-turn.js` (EDIT, ~4 LOC)
- Accept `hooks` in deps; forward to `hydrateHistoryBlock({ …, hooks })` (`:81`). (The harness it receives was already built with `hooks` at the surface — no change to its `loop.run` call.)

### 4.5 Four surface ctors (EDIT, ~2 LOC each)
- `portal-chat.js:60`, `server-rest.js:327`, `scheduler.js:66`, `narration-runner.js:24`: build `const hooks = createAgentHooks({ db, userId, source, toolGuard })` and pass `hooks` to `createAgentHarness(...)` **and** (autonomous three) into the `runAgentTurn` deps. Chat passes `hooks` to the harness only (it doesn't compact).

**Total product code ≈ 160 LOC.** Gate ≈ 190 LOC.

---

## 5. Edge cases — explicit decisions

| Case | Decision | Why the alternative loses |
|---|---|---|
| No `hooks` provided | Every fire-site is a no-op; path is byte-for-byte the current code | The chat regression guarantee; Step-7 discipline. |
| `beforeToolCall` throws / times out | **Block** the call (`{block:true,reason:'hook-error'/'hook-timeout'}`) | A security gate that fails open is not a gate (§3). |
| `afterToolCall` / compaction hook throws | Swallow + `logger` note; turn proceeds | Observers must never break a turn (matches `onEgress`/`recordUsage` `:385,:394`). |
| Multiple behaviors wanted on one event | Compose inside the single fn | A registry+priority is OpenClaw-scale; first-party single-user doesn't need it. |
| Blocked tool — what does the model see? | A tool-result `"blocked: <reason>"` flagged `isError` + a `tool_blocked` event | Silent drop confuses the model; the denial lets it re-plan (OpenClaw `deny_message` parity). |
| `args`/`output` are sensitive | Hook payload IS plaintext by necessity (a guard must see args to decide); documented trust boundary; built-ins never log them | Hashing args (like `onEgress`) would make a guard useless — it must read args. |
| Chat (no compaction) | Compaction hooks simply never fire there | Correct — chat has no cross-turn history. |
| `summarize`'s internal `loop.run` (`run-turn.js:78`, tools:`[]`) | `beforeToolCall` can't fire (no tools); `onEgress` still audits the summary model call | No special-casing needed. |

---

## 6. First consumer (proves the seam end-to-end)

A **built-in runtime tool guard** wired into `createAgentHooks` for the **autonomous** surfaces (scheduler/channel/narration), since autonomous-at-launch is the operator's choice:

- `beforeToolCall` guard: a small defense-in-depth denylist — block a configurable set of high-impact tools at runtime as a **second** layer under the grant-time allowlist (e.g. belt-and-suspenders that `reply`/`schedule_task` only run on surfaces that should). Logs **name + decision only** (no args). Default: allow-all (so default behavior is unchanged) — the guard is opt-in via config/env.
- Proves: block path, fail-closed, surface gating, no-plaintext, model re-plan.

Interactive chat gets the **seam** (so a future approval-prompt UI can plug in) but **no guard by default** — the user is the operator; allowlist suffices (gap-analysis G7 non-goal).

---

## 7. Test strategy — `scripts/verify-harness-hooks.mjs` (NEW gate `verify:harness-hooks`)

Mirrors the `createAgentHarness(...)→streamTurn(...)` + canary pattern of `verify-harness.mjs:139-149`.

| ID | Asserts |
|---|---|
| K1 | No `hooks` → events/result identical to baseline (byte-for-byte; reuse H1 fixture) |
| K2 | `beforeToolCall` returning `{block:true}` → `call()` NOT invoked; `tool_blocked` event; model gets `blocked:` tool-result; loop continues to a final answer |
| K3 | `beforeToolCall` **throws** → tool blocked (fail-CLOSED), turn still completes |
| K4 | `beforeToolCall` **times out** (>15s stub) → blocked (fail-CLOSED) — uses a small `MYCELIUM_HOOK_TIMEOUT_MS` |
| K5 | `afterToolCall` throws → turn unaffected (fail-OPEN); fires once per executed tool with `{name,output,isError}` |
| K6 | **No plaintext leak**: with a `SENSITIVE-HOOK-XYZ` canary in args, the *built-in guard's* audit rows + any event never contain it (mirrors H6) |
| K7 | `beforeCompaction`/`afterCompaction` fire in `hydrateHistoryBlock` over-budget path; fail-OPEN on throw; `afterCompaction` sees a non-null `summary` |
| K8 | Grant∩runtime composition: a tool denied at grant-time is never seen by `beforeToolCall`; a granted tool the guard blocks is not executed |
| Regression | `verify:harness`, `-loop`, `-state`, `-compaction`, `-schedule`, `-scheduler`, `-tools`, `-channel*`, `-triage`, `-fallback`, `-breaker`, `-budget`, `verify:chat`, `keysource/account/backup` all GO unchanged |

---

## 8. Implementation order (each step independently shippable + gated)

1. **`hooks.js`** — fire helpers + timeout + factory (no wiring yet). Unit-test the fire semantics in isolation. Smoke: `node -e` import.
2. **`harness.js`** — wire `beforeToolCall`/`afterToolCall` at `:432/:437`. Add K1–K6 to a new `verify-harness-hooks.mjs`. Run `verify:harness` (must stay GO unchanged) + new gate.
3. **`history.js` + `run-turn.js`** — wire compaction hooks. Add K7. Run `verify:harness-compaction` + `-channel-compaction`.
4. **4 surface ctors + the built-in guard** (`createAgentHooks`). Add K8. Run the **full** `npm run verify` chain (CLAUDE.md "no hot-fixes" — full green before merge, not a subset).
5. **Live-smoke** (operator, autonomous-at-launch): seed a scheduled task with the guard denylisting a tool → confirm `tool_blocked` + the task still completes.

---

## 9. Decision criteria → proceed / done

- **Done when:** new gate `verify:harness-hooks` GO (K1–K8) **and** the full `verify` chain green unchanged (proves no behavior drift), **and** a live autonomous turn shows a guarded tool blocked + audited (name only) with the turn completing.
- **Roll back if:** any existing H-gate flips (means the no-hooks path drifted) — the fix is to restore the hook-presence guard, never to weaken H5/H6.

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A hook leaks plaintext args to a log | Med | High (§1) | Built-ins log names only; K6 canary; `redactDeep` for any serializer; documented trust boundary |
| Fail-open mistake on the blocking hook | Low | High | K3/K4 assert fail-CLOSED explicitly; the fire helper defaults to block on any non-`{block:false}` outcome |
| Chat hot-path drift | Low | High | K1 byte-for-byte + unchanged H1–H8 gates |
| Per-hook timeout hangs the turn anyway | Low | Med | `withTimeout` races a real timer; the watchdog in `loop.js` is the outer backstop |
| Scope creep into a 40-hook registry | Med | Med | Design caps at 4 single-fn hooks; registry explicitly out of scope (§1 v2.3) |

---

## 11. Open questions — resolved during sweep

- *Is there an existing bus to reuse?* No registry/emitter — but the **injected-sink** idiom is the pattern; we extend it (avoids a "fourth pattern").
- *Where does the tool hook reach all surfaces from?* `createAgentHarness` → `streamTurn:434` (single chokepoint; all 4 surfaces construct the harness).
- *Does chat compact?* No — compaction hooks are autonomous-only; no chat wiring needed for them.
- *Does `before_tool_call` duplicate `autonomyTools`?* No — grant-time vs run-time, orthogonal; documented.

## 12. Deferred (named, out of scope)

- **G2 prompt caching** — separate next-session pass (already scoped in the gap-analysis doc).
- **Approval-prompt UI** for chat `beforeToolCall` — needs the portal; the seam ships now, the UI later (G7 was a documented non-goal for V1).
- **Folding `onEgress`/`onUsage`/`onStall` into the `hooks` object** — cosmetic unification; deferred to avoid churning the security-gated egress path.
- **Multi-handler/priority registry** — only if a real second first-party consumer appears.

---

## 13. Verification table (own-eyes)

| Assumption | Verified at |
|---|---|
| No existing EventEmitter/registry/middleware bus in `src/agent` | grep empty (`EventEmitter\|\.emit(\|addHook\|middleware`) |
| Injected-sink idiom is the existing pattern (`onEgress`/`onUsage`/`onStall`/`send`) | `harness.js:355,384,390`; `loop.js:55-56,105-107` (read) |
| Single tool-dispatch chokepoint, all surfaces | `harness.js:434` `out = await call(tc.name, tc.args)` (read) |
| Circuit-breaker precedes dispatch; `tool_start/complete/error` bracket it | `harness.js:429-431,432,437` (read) |
| `onEgress` already = hash+length-only egress hook | `harness.js:381-386` + `egress.js:20-39` (read via sweep quote) |
| `runAgentTurn` receives `loop`, does not build the harness | `run-turn.js:43-47,103` (read) |
| All 4 surfaces construct `createAgentHarness` (so harness hooks reach all) | `portal-chat.js:60`, `server-rest.js:327`, `scheduler.js:66`, `narration-runner.js:24` (sweep, file:line) |
| Chat bypasses `runAgentTurn`; builds `call` inline | `portal-chat.js:244,256` (sweep) |
| Compaction runs above streamTurn, autonomous-only | `history.js:65`; called from `run-turn.js:81`; chat passes no history (`portal-chat.js`) (read) |
| `before/after_compaction` payload shapes | `history.js:50-52` (pre), `compaction.js:184-187` (post) (read history.js; compaction via sweep) |
| `autonomyTools` is grant-time, not runtime | `autonomy-tools.js:40-49` (sweep quote) |
| No runtime per-call gate exists today | grep NOT FOUND beyond `harness.js:429` breaker (sweep) |
| No-leak gates to mirror/keep green: H5 err.message, H6 hash+len canary | `verify-harness.mjs:127-137,139-149` (read) |
| Redaction helpers exist | `crypto/guardians/scrubbers.js:34,41` (sweep) |
| OpenClaw `before_tool_call` = `{block,reason}` + fail-closed timeout; `after_tool_call` void | `openclaw/src/plugins/hook-types.ts:524`, `hook-before-tool-call-result.ts:12`, `hooks.ts:1268` (sweep) |

---

## 14. Pickup protocol

1. `git pull` (local main behind origin) + work in an isolated worktree off `origin/main` ([[concurrent-session-collision]]).
2. Build in the order of §8; gate each step; **full** `npm run verify` before merge (no subset — [[no-hotfixes-production-ready]]).
3. Security-sensitive diff (tool gate + plaintext surface) → **human approval** per `/auto-merge-on-green`.
4. Reference engine for the contract: `~/Developer/openclaw/src/plugins/`.
</content>
