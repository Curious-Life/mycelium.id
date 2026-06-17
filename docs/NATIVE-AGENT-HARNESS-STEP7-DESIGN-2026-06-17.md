# Native Agent Harness — Step 7 Design: Circuit-Breaker + Provider-Fallback + Budget

**Date:** 2026-06-17
**Companions:** [`NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md`](NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md) · [`NATIVE-AGENT-HARNESS-BUILD-PLAN-2026-06-17.md`](NATIVE-AGENT-HARNESS-BUILD-PLAN-2026-06-17.md) · [`NATIVE-AGENT-HARNESS-HANDOFF-2026-06-17.md`](NATIVE-AGENT-HARNESS-HANDOFF-2026-06-17.md)
**Skill:** `/sweep-first-design` — 3 parallel sweeps (our fallback infra · loop/streamTurn injection points · reference-harness re-mine) + 2 own-eyes verifications.
**Status:** DESIGN LOCKED, not built. The final step: make autonomous turns resilient (survive a provider outage, bound runaway tool loops, honor a daily token budget) — mostly by WIRING infrastructure that already exists.

---

## 0. The load-bearing insight

A provider **cannot be swapped mid-stream** — both our own cascade (`cascade.js:12` "Streaming is single-provider … the cascade is the non-streaming path") and odysseus (`llm_core.py:2292` "pre-content failure → try next candidate; once real output starts, never switch") say the same thing. Switching after tokens have streamed would duplicate output into the same bubble.

`loop.run` is **already structured for exactly this**: it retries the whole turn while it has produced NOTHING (`assistantText.trim()` empty), and stops the moment any text streams (`loop.js:136`). So provider-fallback is not a new control flow — it's a refinement of the existing empty-retry: on a *retryable* provider error with *nothing streamed yet*, advance to the next provider before the next attempt. The no-duplication rule holds for free.

Below `loop.run`, `harness.js` already has a transient pre-token retry (`openStreamRetry`, 2× on 5xx, `harness.js:60`). Step 7's fallback sits ABOVE that: it engages only when those retries are exhausted and the error reaches `loop.js`.

---

## 1. Patterns adopted (reference re-mine)

| Pattern | Source (file:line) | What we adopt |
|---|---|---|
| **Pre-content fallback only** (swap before first token, never after) | odysseus `llm_core.py:2292` | The fallback trigger condition — gates on "no text streamed yet" |
| **Error taxonomy → retryable bool** | hermes `error_classifier.py:441` | `classifyProviderError` reason codes; fatal vs retryable split |
| **Fatal errors skip retry+fallback** (auth/billing) | hermes `conversation_loop.py:833` | Don't burn retries on a 401 — break immediately |
| **Jittered exponential backoff** (base→cap + ½ jitter, decorrelated) | hermes `retry_utils.py:19` | Replace the plain `2^n` backoff to avoid thundering-herd on a rate-limited provider |
| **Simple hard iteration cap** | odysseus `agent_tools:49` (`MAX_AGENT_ROUNDS=50`) | Keep `maxIterations=8` as the bulletproof outer bound |
| **Repeated-call / no-progress detection** | (our gap; hermes budget-exhaust analog) | Trip the breaker when the model calls the same tool+args N× — a wedged turn |
| **Per-task budget short-circuit before spend** | hermes `iteration_budget` / odysseus `max_steps` | Daily token budget gate before an autonomous turn |
| **Ordered provider chain (sovereign→frontier→local floor)** | OURS `resolve.js:107` `resolveProviderChain` | Reuse verbatim as the fallback chain |

We deliberately keep it SIMPLE (odysseus-style hard caps + a single classification helper) over clever (no thread-safe refundable budgets, no dead-host cooldown table — single-user, single-process).

---

## 2. Verified seams (own-eyes + sweep)

| Fact | Where |
|---|---|
| `loop.run` retries while empty; error caught (not rethrown) at the attempt catch; stops on `assistantText.trim() \|\| truncated \|\| attempt≥maxRetries` | `loop.js:129-136` (own-read) |
| Backoff today = `BACKOFF_BASE_MS * 2**(attempt-1)`, no jitter | `loop.js:108` (own-read) |
| `streamTurn` tool loop `for(i<maxIterations=8)`; tool dispatch `for(const tc of r.toolCalls){ toolsUsed.push; call(tc.name,tc.args) }`; final no-tools pass on exhaustion | `harness.js:394,414-424,427-434` (own-read) |
| Provider baked via `normalizeProvider(provider)` at streamTurn entry → swap = re-call streamTurn with a new provider (loop.js level) | `harness.js:366` (sweep) |
| `isRetryable(err)` already exists (5xx retryable, AbortError fatal, network default) | `harness.js:54` (own-read) |
| Inference errors carry `.status` + `.backend` | `inference/errors.js:9-17` (sweep) |
| `resolveProviderChain(db,userId,{sensitive})` → ordered `[eu-zdr…, us…, {jurisdiction:'local',localFallback:true}]` | `inference/resolve.js:107-122` (sweep) |
| `inferWithCascade` is PROMPT-ONLY (non-streaming) — NOT reusable for streaming fallback | `inference/cascade.js:12,29-46` (sweep) |
| `INFERENCE_TASKS=['chat','narrate']` (add 'harness') | `inference/resolve.js:67` (sweep) |
| `db.usage.summary(userId,{sinceDays:1})` → `{totals:{inputTokens,outputTokens,events}, byDay:[{key:'YYYY-MM-DD',…}]}` | `db/llm-usage.js:80-114` (sweep) |
| scheduler turn launch point (budget gate goes before it) | `agent/scheduler.js:111` (sweep) |
| `MYCELIUM_TOOL_OUTPUT_MAX` is the existing env-knob style | `harness.js:43` (own-read) |

---

## 3. Modules (signatures + LOC)

### 3.1 `src/agent/provider-errors.js` — classification (~35 LOC, pure)
```js
classifyProviderError(err) -> { retryable: boolean, reason: string }
```
Consolidates the scattered logic (harness `isRetryable` + probe.js codes + hermes taxonomy):
- `401|403` → `{retryable:false, reason:'auth'}` · `404` → `{false,'not_found'}` · `400` → `{false,'bad_request'}`
- `429` → `{true,'rate_limited'}` · `5xx` → `{true,'server_error'}`
- `err.cause?.name==='AbortError'` → `{false,'aborted'}` (our watchdog/cancel, not a provider fault)
- no status / network → `{true,'network'}` (default retryable, matching `isRetryable`)
Exported + unit-tested; `harness.js` keeps its local `isRetryable` (or re-exports this) — no behavior change to the adapter retry.

### 3.2 Provider-fallback in `loop.js` (~45 LOC)
`run({ ..., providerChain })` — NEW optional param (array of provider configs, e.g. from `resolveProviderChain`). When absent → today's single-provider behavior (interactive chat stays fail-fast; unchanged).
- Track `chainIdx` (start 0), `provider = providerChain?.[0] || provider`.
- In the attempt `catch`: `const { retryable, reason } = classifyProviderError(e)`.
  - **Fatal** (`!retryable`) → `break` immediately (don't waste empty-retries on a 401/aborted).
  - **Retryable + nothing streamed + a next provider exists** → `chainIdx++`, `provider = providerChain[chainIdx]`, `send({type:'fallback', reason, to: describeProvider(provider)?.label})` (odysseus visibility), continue WITHOUT counting this against `maxRetries` (the chain advance is the retry).
  - **Retryable, chain exhausted** → fall through to the existing empty-retry/backoff.
- Total attempts bounded by `maxRetries + (providerChain?.length||1)` so a long chain can't loop unbounded.
- Return adds `provider` actually used + `fellBack:boolean` for the caller's audit (counts only).

### 3.3 Jittered backoff in `loop.js` (~8 LOC)
Replace `BACKOFF_BASE_MS * 2**(attempt-1)` with hermes-style decorrelated jitter:
```js
const exp = Math.max(0, attempt - 1);
const d = Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_CAP_MS);   // BACKOFF_CAP_MS=30000
const backoff = d + Math.floor(Math.random() * 0.5 * d);          // +0–50% jitter
```
Knobs: `MYCELIUM_BACKOFF_BASE_MS` (1000), `MYCELIUM_BACKOFF_CAP_MS` (30000). (Regular runtime code — `Math.random` is fine here; the no-`Math.random` rule is workflow-script-only.)

### 3.4 Circuit-breaker in `streamTurn` (~20 LOC)
Inside the tool loop, before dispatching `r.toolCalls`, track a signature map across iterations:
```js
const sig = `${tc.name}:${JSON.stringify(tc.args)}`;
repeats.set(sig, (repeats.get(sig)||0)+1);
if (repeats.get(sig) >= REPEAT_LIMIT) { logger(`harness: breaker — '${tc.name}' repeated ${REPEAT_LIMIT}×; final pass`); break OUTER; }
```
On trip → `break` to the existing final no-tools pass (`harness.js:429-434`) so the user/channel still gets an answer. `maxIterations=8` stays the outer bound. Knobs: `MYCELIUM_MAX_ITERATIONS` (8), `MYCELIUM_TOOL_REPEAT_LIMIT` (3). Returns add `breaker:'repeat'` (counts/codes only).

### 3.5 `'harness'` in `INFERENCE_TASKS` (`resolve.js:67`, 1 line)
`['chat','narrate','harness']` — so autonomous turns honor a per-task model assignment (e.g. a cheaper local model for wake-cycles). `run-turn.js` already calls `resolveInferenceConfigForTask(db,userId,'harness')`; this activates the override.

### 3.6 Daily-budget gate in `scheduler.js runTask` (~20 LOC) + chain wiring in `run-turn.js` (~6 LOC)
- **run-turn.js:** alongside `resolveInferenceConfigForTask`, also `resolveProviderChain(db, userId, { sensitive:false })` and pass it as `loop.run({ providerChain })`. So scheduler + channel turns get fallback; interactive chat keeps its single provider (unchanged).
- **scheduler runTask (before the turn):** if a budget is configured (`MYCELIUM_DAILY_TOKEN_BUDGET`, 0/unset = unlimited), read `const { totals } = await db.usage.summary(tUser, { sinceDays: 1 })`; if `totals.inputTokens + totals.outputTokens >= budget` → `finishRun('skipped-budget')`, `advance(task,'skipped-budget')`, return (mirrors the `skipped-no-model` path). This is the piece deferred from Step 4b. Channel turns are user-facing replies → NOT budget-gated in v1 (note as optional).

---

## 4. Threat model / safety

- **Fail-closed on fatal:** auth/billing/bad-request errors STOP (no retry, no fallback) — a misconfigured key doesn't silently spend down the whole chain.
- **No double-send:** fallback only pre-content (gated on `!assistantText.trim()`), so a channel/chat reply is never delivered twice.
- **No plaintext (§1):** the `fallback` event carries a provider LABEL + reason CODE; the breaker/return carry codes only; the budget gate reads token COUNTS. Never message text.
- **Bounded:** total attempts ≤ `maxRetries + chain.length`; tool loop ≤ `min(maxIterations, repeat-trip)`. No unbounded loop survives.
- **Sovereignty preserved:** the chain's terminal element is the on-box local floor (`resolve.js:121`) — fallback always ends at local, never silently escalates a *sensitive* turn to a US provider (the chain already drops `us-*` when `sensitive`).

---

## 5. Edge cases (decided)

- **Local-only user (no cloud):** `resolveProviderChain` returns `[{localFallback:true}]` → chain length 1 → fallback is a no-op; behavior identical to today. ✓
- **Chain element itself fatal (bad stored key):** classified fatal → skip to next (we treat a fatal error on element K as "advance to K+1" too, since a different provider may work — refinement of §3.2: fatal advances the chain but does NOT count as an empty-retry; only a fully-fatal *last* element breaks).
- **Mid-stream provider death (post-token):** not retried/fallen-back (would duplicate); surfaces as a truncated/empty result like today. Accepted (matches odysseus).
- **Breaker false-positive** (a legitimately repeated search): `REPEAT_LIMIT=3` identical name+args is a strong wedge signal; the final pass still answers from accumulated context. Tunable via env.
- **Budget unset:** default unlimited → zero behavior change for users who don't opt in.

---

## 6. Build sub-steps + gates

| Sub-step | Modules | Gate |
|---|---|---|
| 7a | `provider-errors.js` + `loop.js` fallback + jittered backoff | `verify:harness-fallback` — taxonomy (fatal/retryable); fallback advances on retryable+no-text; fatal stops; single-provider unchanged; bounded; jitter in range |
| 7b | `streamTurn` repeat-call breaker + env knobs | `verify:harness-breaker` — repeated identical call trips → final pass; distinct calls don't; maxIterations still caps |
| 7c | `'harness'` task + `run-turn` chain wire + scheduler daily-budget | `verify:harness-budget` — over-budget → skipped-budget (counts only); under runs; unset = unlimited; `'harness'` in INFERENCE_TASKS |

Regression each step: `verify:harness-loop`, `-scheduler`, `-channel`, `-chat`. Full `npm run verify` before merge. `loop.js`/`harness.js` are hot paths shared with interactive chat → the gates must prove single-provider/no-chain behavior is byte-for-byte unchanged.

---

## 7. Verification table (own-eyes this session)

| Assumption | Verified at |
|---|---|
| loop.run retries-while-empty; catch not rethrown; stop condition | `loop.js:129-136` (own-read) |
| plain `2^n` backoff today | `loop.js:108` (own-read) |
| streamTurn tool loop + dispatch + final pass | `harness.js:394,414-424,427-434` (own-read) |
| `isRetryable` exists; AbortError fatal | `harness.js:54-59` (own-read) |
| provider normalized at entry (swap = re-call) | `harness.js:366` (sweep) |
| `resolveProviderChain` ordered + local terminal | `inference/resolve.js:107-122` (sweep) |
| cascade is non-streaming (can't reuse for streaming) | `inference/cascade.js:12` (sweep) |
| `INFERENCE_TASKS` content | `inference/resolve.js:67` (sweep) |
| `db.usage.summary` totals/byDay shape | `db/llm-usage.js:80-114` (sweep) |
| scheduler turn-launch point | `agent/scheduler.js:111` (sweep) |

---

## Revision history
- **v1 (2026-06-17)** — Step 7 design after a 3-sweep `/sweep-first-design` pass + 2 own-eyes verifications. Key decision: provider-fallback is a refinement of `loop.run`'s existing empty-retry (pre-content only — odysseus/our-cascade agreement), NOT a reuse of the non-streaming `inferWithCascade`. Adopts hermes error-taxonomy + jittered backoff and odysseus simple-cap + pre-content-swap. Sub-stepped 7a–7c, each gated; hot-path changes guarded by single-provider regression.
