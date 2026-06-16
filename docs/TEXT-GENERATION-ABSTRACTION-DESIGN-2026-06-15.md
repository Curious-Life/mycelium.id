# Text-Generation Abstraction — Model-Aware Sizing Design (2026-06-15)

**Status:** PHASES 1–3 BUILT + verified. 14 offline gates GO; portal svelte-check 0 errors; **LIVE-SMOKED against real Ollama + a real vault** (local path). Remaining live checks need operator inputs only: a **cloud-key** chat (unchanged path, gate-covered) and eyeballing the **Usage pane** in the running app. Nothing committed yet. Scope **A** chosen (sizing layer only; stack-unification deferred).

**Live-smoke evidence (2026-06-15, real Ollama 127.0.0.1:11434):**
- Local chat — `model-profile` probe read llama3.1's **real 131072** context_length from `/api/show` (`source=probe`); `planGeneration` sized `num_ctx=6144`; the native adapter streamed a real reply over **`/api/chat`** with that `num_ctx` sent; usage captured `{in:34,out:15,estimated:false}`.
- Enrichment — `createNarrator` against real Ollama sized num_ctx, returned valid JSON, and **persisted a real `llm_usage` row** (`source=enrichment, area=narrate, is_local=1, in=37, out=8, estimated=0`); `summary()` aggregated it by area. (Throwaway smoke scripts removed post-run; gates `verify:harness-local`/`verify:usage` are the permanent equivalents.)

**Phase-2 verification ledger (all GO):** `verify:usage` (18 assertions incl. the no-content invariant) · `verify:leak` · `verify:providers-leak` · `verify:egress` · portal `svelte-check` 0 errors · migration idempotent under double-apply. Regression re-run after capture wiring: `verify:resolve/cascade/gateway/gateway-stream/gateway-tools/embeddings-gateway/harness/chat/model-sizing` all GO.

**Phase-2 as-built files:** `migrations/0014_llm_usage.sql` · `src/db/llm-usage.js` (+ wired in `src/db/index.js` as `db.usage`) · `src/inference/usage.js` (`createUsageSink`) · capture threaded through `local.js`/`cloud.js` (`onUsage`, real provider counts) → `router.js` (`emitUsage` enrich + estimate-fallback) + `cascade.js` + `harness.js` (chat) · sinks wired in `portal-chat.js` (source `chat`), `gateway/openai-compat.js` (source `gateway`), `pipeline/lib/narrate-infer.js` (source `enrichment`) · `src/portal-usage.js` (`GET /portal/usage`, registered in `server-rest.js`) · `portal-app/.../UsageSection.svelte` + Settings "Usage" tab.
**Author:** sweep-first-design pass (3 Explore sweeps + own-eyes verification).
**Goal (user ask):** "Abstract the text-generation section so it works with **any model**, including **local models**, and so it **automatically adapts the max length and things like that**."

---

## 0. Headline

The text-generation surface is **not** missing an abstraction — it has *two* (`src/inference/` router and `src/agent/harness.js`) plus a couple of ad-hoc bypasses. What it's missing is a **single source of truth for "what can THIS model do, and how big can the input/output be"**. Today every caller hardcodes `maxTokens` (six different magic numbers), almost nobody sizes the local context window (`num_ctx`), and "adapt to model" is a binary `isLocal ? small : big` char cap. The fix is a thin, fail-soft **Model Profile + Token Budget** layer that both existing stacks consume — not a rewrite.

The one genuine *structural* surprise the sweep caught (a real pivot): **the chat harness drives local models over Ollama's OpenAI-compatible `/v1` surface, which cannot set `num_ctx`** — so local chat physically cannot size its context window the way the design's naïve v1 assumed. That forces a branch (see §6, Pivot v1→v2).

---

## 1. Load-bearing assumptions (Step 1 inventory)

| # | Assumption the plan rests on | Category |
|---|---|---|
| A1 | There is one place that resolves the active provider+model. | Shape |
| A2 | Callers pass `maxTokens`/`numCtx` through to local/cloud backends. | Shape |
| A3 | The local catalog (`catalog.json`) carries a real per-model context window. | Shape |
| A4 | Ollama exposes a model's real context window + capabilities at runtime. | Lifecycle |
| A5 | Cloud chat models (claude-opus-4-8, gpt-4o…) are described somewhere with real limits. | Shape |
| A6 | A token estimator exists and is shared. | Shape |
| A7 | The chat harness can set `num_ctx` for local models. | Boundary |
| A8 | Truncation today is model-aware. | Shape |
| A9 | Egress audit / §4g jurisdiction gating is independent of sizing (so sizing can't weaken it). | Security boundary |

Verdicts after sweep in §7 verification table. Spoiler: **A3, A5, A6, A7, A8 are FALSE.**

---

## 2. Sweep findings (consolidated, with file:line)

### 2.1 Three generation stacks, no shared sizing

1. **`src/inference/` router** — `createInferenceRouter` → `infer`/`inferStream` → `localInfer`/`localStream` ([src/inference/local.js](../src/inference/local.js)) or `cloudInfer`/`cloudStream` ([src/inference/cloud.js](../src/inference/cloud.js)). Prompt-in / text-out, task-routed (`summarize|classify|extract` local; `narrate|complex` cloud). Used by enrichment, narration (cloud path), the OpenAI-compat gateway, and the cascade.
2. **`src/agent/harness.js`** — `streamTurn`, messages-in / streamed tokens-out, tool-calling, its own `anthropicAdapter`/`openaiAdapter`. Used **only** by chat ([src/portal-chat.js:210](../src/portal-chat.js)). Reuses `openStream`/`ssePayloads` from cloud.js but is otherwise a parallel stack.
3. **Ad-hoc bypasses** — `pipeline/lib/narrate-infer.js:35-58` builds a **native `/api/chat`** call by hand for local (to get `think:false` + `num_ctx`), bypassing the router entirely; `src/claims/discovery.js` does its own token budgeting.

### 2.2 `maxTokens` is hardcoded in six places, none model-aware

| Value | Site | What it caps |
|---|---|---|
| `1024` | [local.js:31](../src/inference/local.js), [cloud.js:43](../src/inference/cloud.js) | default output for *all* router inference |
| `4096` | [harness.js:261](../src/agent/harness.js) | chat output |
| `700` | narrate-infer.js:43/65, [describe-image.js:114](../src/enrich/describe-image.js) | narration + vision caption |
| `1500` | discovery.js:39 (`PROPOSAL_OUTPUT_TOKENS`) | claim proposals |
| `300` | pipeline/describe-clusters.js:83 | cluster naming |
| `8192` | [openai-compat.js:55](../src/gateway/openai-compat.js) (`MAX_OUTPUT_TOKENS`) | gateway clamp ceiling |

None is checked against the model's real max-output limit. A request for `8192` to an 8k-window local model overflows; a `1024` cap on Opus wastes capability.

### 2.3 The local-context-window (`num_ctx`) gap — the documented smoking gun

[src/inference/local.js:52-55](../src/inference/local.js) (verbatim):
> `// num_ctx: Ollama defaults to a SMALL context (~4096). A big prompt then`
> `// crowds out generation (prompt+output must fit num_ctx), silently truncating`
> `// the model's reply. Callers that send large prompts MUST size num_ctx to`
> `// hold the full prompt PLUS num_predict, or the JSON tail gets cut off.`

`numCtx` is plumbed through `infer → runLocal → localInfer` but **only ONE caller computes it**: [src/claims/discovery.js:180](../src/claims/discovery.js):
```js
const numCtx = Math.min(CTX_MAX, Math.max(4096,
  Math.ceil((approxTokens(prompt) + PROPOSAL_OUTPUT_TOKENS + 512) / 1024) * 1024));
```
This is exactly the formula the abstraction should generalize. Everyone else (`localInfer` default, narration, captioning) lets Ollama silently truncate at ~4096.

### 2.4 No real model registry

- [catalog.json](../src/hardware/catalog.json) carries `ctx` per model, but [catalog.js:33](../src/hardware/catalog.js) shows it's a **uniform `m.ctx || 8192`** placeholder — *all* models report 8192; it's a memory-fit input, not a real window. **No `maxOutput` field at all.**
- Cloud chat models live only as bare default strings: `claude-opus-4-8`/`gpt-4o` ([harness.js:33-34](../src/agent/harness.js)), `claude-sonnet-4-6`/`gpt-4o` ([cloud.js:20-21](../src/inference/cloud.js)). **No limits recorded anywhere.**
- `src/inference/presets.js` is **provider-level only** (endpoint + jurisdiction) — no per-model metadata.

### 2.5 Runtime introspection exists but throws away the useful field

[src/enrich/model-caps.js](../src/enrich/model-caps.js) already POSTs `/api/show` and reads the `capabilities[]` array (`vision`/`audio`/`tools`/`thinking`) for vision/audio model picking — **but never reads `model_info["<arch>.context_length"]`**, which `/api/show` returns. The runtime path to a model's *real* window already exists; it's just not consumed.

### 2.6 `approxTokens` (chars/4) duplicated 3× and capability heuristics are scattered

- `approxTokens` defined identically in [openai-compat.js:111](../src/gateway/openai-compat.js), [embeddings.js:31](../src/gateway/embeddings.js), [claims/support-path.js:17](../src/claims/support-path.js).
- Capability detection is a mix of name regex ([describe-image.js](../src/enrich/describe-image.js) `/llava|vision|moondream|.../`), `think:false` workarounds keyed off model class ([local.js:63-67](../src/inference/local.js)), and the partial `/api/show` probe (§2.5).

### 2.7 Truncation is binary + char-based, not model-aware

[portal-chat.js:166-183](../src/portal-chat.js): `isLocal ? 5000 : 28000` **characters**, then `slice()`. A 128k-window local model still gets 5000 chars; the cloud branch would overflow an 8k cloud model. Same pattern in [internal-router.js:315](../src/internal-router.js) (`MAX_INLINE_TEXT = 6000`) and [server-http.js:491](../src/server-http.js) (`/context` 4000/16000).

### 2.8 Security boundary is independent (good — sizing won't touch it)

Egress audit (sha256+len, never plaintext) and the §4g sensitive/jurisdiction hard-block live in [router.js:114-127/147-153](../src/inference/router.js), [harness.js:267-272](../src/agent/harness.js), and `resolveProviderChain` ([resolve.js:80-95](../src/inference/resolve.js)). Sizing changes `maxTokens`/`numCtx`/input-trim **only** — it never decides *where* a prompt goes, so it cannot weaken the egress gate.

---

## 3. Design — the Model Profile + Token Budget layer

Two new modules under `src/inference/`, consumed by both stacks. **No stack is removed.** Everything is fail-soft: a probe/registry miss degrades to a conservative default; generation never blocks on sizing.

### 3.1 `src/inference/model-registry.js` (~90 LOC, pure data + lookup)

A curated, dated table of **real** limits for the models the app actually uses (cloud frontier + known local families), the one place that "knows the numbers". Local per-model truth still comes from the runtime probe (§3.2); the registry is the fallback + the cloud source-of-truth.

```js
// id-prefix / family keyed. Numbers are real provider limits as of 2026-06.
export const MODEL_REGISTRY = Object.freeze({
  'claude-opus-4-8':   { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-sonnet-4-6': { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'gpt-4o':            { contextWindow: 128_000, maxOutput: 16_384, family: 'gpt' },
  // local families (override the catalog's uniform 8192 placeholder)
  'llama3.1':          { contextWindow: 128_000, maxOutput: 4_096,  family: 'llama' },
  'gemma3':            { contextWindow: 8_192,   maxOutput: 4_096,  family: 'gemma' },
  // …kept short + dated; unknowns fall through to class defaults.
});
export function lookupModel(modelId) { /* exact → family-prefix → null */ }
```
Staleness discipline mirrors `presets.js`: dated header, refreshed per release.

### 3.2 `src/inference/model-profile.js` (~130 LOC)

Resolves a `ModelProfile` for a provider config, **layered + cached + fail-soft**:

```js
/** @typedef {{
 *   model: string, isLocal: boolean, family: string,
 *   contextWindow: number,        // total tokens the model accepts
 *   maxOutputTokens: number,      // hard cap on generation
 *   capabilities: { tools:boolean, vision:boolean, thinking:boolean, jsonFormat:boolean },
 *   source: 'probe'|'registry'|'default'   // provenance, for diagnostics (no secrets)
 * }} ModelProfile */

export async function resolveModelProfile(cfg, { fetch, probe = true } = {});
```

Resolution order:
1. **Runtime probe (local only)** — extend `model-caps.js` to also read `model_info["<arch>.context_length"]` + the `capabilities[]` array from the SAME `/api/show` call it already makes. Real window, real caps, cached per `(baseUrl, model)`. `maxOutputTokens` for local = a fraction of the window (Ollama has no separate output cap) clamped to a sane ceiling.
2. **Static registry** (§3.1) — for cloud models and as the local fallback when the probe is unavailable (Ollama down / old Ollama with no `model_info`).
3. **Conservative class defaults** — `isLocal → {ctx 8192, out 1024}`, cloud-unknown → `{ctx 32768, out 4096}`. Capabilities default conservative (tools:false for local, true for cloud; jsonFormat:true for local).

Fail-soft: any error in 1/2 → next layer; never throws into the caller.

### 3.3 `src/inference/token-budget.js` (~100 LOC)

The shared estimator (kills the 3 `approxTokens` dupes) + the budget planner (generalizes claims/discovery.js:180).

```js
export function estimateTokens(text) { return Math.max(1, Math.ceil(String(text||'').length / 4)); }

export const TASK_OUTPUT_DEFAULTS = Object.freeze({
  classify: 64, summarize: 256, extract: 512, caption: 700,
  narrate: 1024, claims: 1500, chat: 4096, complex: 4096,
});

/**
 * @param {ModelProfile} profile
 * @param {object} a  { inputTokens, task, requestedMaxTokens }
 * @returns {{ maxTokens:number, numCtx:number|undefined, inputBudget:number, overBudget:boolean }}
 */
export function planGeneration(profile, { inputTokens = 0, task = 'complex', requestedMaxTokens } = {}) {
  const MARGIN = 512;
  const want = requestedMaxTokens ?? TASK_OUTPUT_DEFAULTS[task] ?? 1024;
  const maxTokens = Math.min(want, profile.maxOutputTokens);
  const inputBudget = Math.max(256, profile.contextWindow - maxTokens - MARGIN);
  // numCtx: local only — round up to next 1024 of what we actually need, capped to the window.
  const numCtx = profile.isLocal
    ? Math.min(profile.contextWindow, Math.ceil((Math.min(inputTokens, inputBudget) + maxTokens + MARGIN) / 1024) * 1024)
    : undefined; // cloud sizes itself
  return { maxTokens, numCtx, inputBudget, overBudget: inputTokens > inputBudget };
}
```

The planner returns `inputBudget` (a target token count) + `overBudget` — but **does not truncate**. Trimming stays with the caller because only the caller knows what's droppable (system preamble vs retrieval vs message history). The caller trims to `inputBudget` tokens using `estimateTokens`, replacing today's hardcoded char caps.

---

## 4. Wiring (who consumes the layer)

| Consumer | Change | LOC |
|---|---|---|
| [router.js](../src/inference/router.js) | accept an optional `profile`; when present, derive `numCtx`+clamp `maxTokens` via `planGeneration` before `runLocal`/`runCloud`. Back-compat: no profile → today's behaviour. | ~15 |
| [harness.js](../src/agent/harness.js) | `streamTurn` resolves a profile; `maxTokens` from `planGeneration(task:'chat')` instead of the 4096 default; **local branch → native `/api/chat` to set `num_ctx`** (see §6 pivot). | ~30 |
| [portal-chat.js:166-183](../src/portal-chat.js) | replace `isLocal ? 5000 : 28000` char cap with `inputBudget`-driven trim in tokens; keep the `[context truncated]` marker. | ~15 |
| narrate-infer.js / discovery.js / describe-image.js / describe-clusters.js | drop the local magic `maxTokens`; call `planGeneration(task)`; discovery.js's bespoke numCtx formula becomes a call to the shared planner. | ~40 |
| openai-compat.js / embeddings.js / support-path.js | import shared `estimateTokens`; delete the 3 dup defs. | ~10 |

**LOC budget:** new code ≈ **320 LOC** (registry 90 + profile 130 + budget 100); wiring edits ≈ **110 LOC**; tests ≈ **180 LOC**. Total ≈ **610 LOC ±20%**.

---

## 5. Edge cases — explicit decisions

- **Ollama down during probe** → `model-caps`-style: return null, fall to registry/default, cache nothing negative (the existing live-bit at model-caps.js:88-93). Generation still runs at default sizes.
- **Unknown cloud model id** (user typed a model not in the registry) → cloud-unknown default `{32768/4096}`. Conservative, never overflows a real frontier window, and cloud APIs reject an over-large `max_tokens` with a clean 400 we already surface.
- **`requestedMaxTokens` larger than model max** → clamped down + (optionally) one log line (no silent cap — CLAUDE.md discipline). The gateway's existing `MAX_OUTPUT_TOKENS` clamp becomes `min(8192, profile.maxOutputTokens)`.
- **Thinking models** (gemma/qwen) burning the budget on hidden reasoning → profile.capabilities.thinking gates the existing `think:false` workaround instead of name-regex.
- **Streaming cloud** can't be re-sized mid-stream → profile is resolved BEFORE the stream opens; unchanged.
- **`estimateTokens` is chars/4, approximate** → that's why `MARGIN=512` and `numCtx` rounds UP to 1024. We over-reserve, never under. Accepted: a real tokenizer is deferred (§9).

## 6. Pivot v1 → v2 (the sweep-forced change)

**v1 sketch (wrong):** "harness sets `num_ctx` for local chat like everyone else."
**Sweep refutation:** [harness.js:142-146](../src/agent/harness.js) builds the local body as an **OpenAI-compatible `/v1/chat/completions`** request (`openaiAdapter`, `resolveChatUrl(cfg.baseUrl)`), and that surface **ignores `num_ctx`** — only Ollama's native `/api/chat` honours `options.num_ctx`. This is exactly why [narrate-infer.js:35-58](../pipeline/lib/narrate-infer.js) hand-rolls a native `/api/chat` call for local. So local *chat* today **cannot** size its window and silently truncates on long briefings — the real bug behind the binary 5000-char cap.

**v2 decision:** add a **native-Ollama local chat adapter** to the harness (mirrors narrate-infer.js): when `local`, POST `/api/chat` with `options.num_ctx` from `planGeneration`, `think:false`, streaming NDJSON. Cloud + non-Ollama local keep the OpenAI-compat adapter. This is the single biggest correctness win and the reason this is a design, not a one-liner.

## 7. Verification table

| # | Assumption | Verdict | Verified at (read myself) |
|---|---|---|---|
| A1 | One place resolves active provider+model | TRUE | [resolve.js:57-63](../src/inference/resolve.js) `resolveInferenceConfig` |
| A2 | Callers pass maxTokens/numCtx to backends | PARTLY | plumbed [router.js:70-71](../src/inference/router.js)/[local.js:56-57](../src/inference/local.js); numCtx set by only [discovery.js:180](../src/claims/discovery.js) |
| A3 | catalog has real per-model context window | **FALSE** | [catalog.js:33](../src/hardware/catalog.js) uniform `m.ctx || 8192`; no maxOutput field |
| A4 | Ollama exposes real window+caps at runtime | TRUE (unused) | [model-caps.js:74-81](../src/enrich/model-caps.js) reads `capabilities` but not `model_info.context_length` |
| A5 | Cloud models described with real limits | **FALSE** | only bare default strings [harness.js:33-34](../src/agent/harness.js), [cloud.js:20-21](../src/inference/cloud.js) |
| A6 | A shared token estimator exists | **FALSE** | `approxTokens` duped at [openai-compat.js:111](../src/gateway/openai-compat.js), [embeddings.js:31](../src/gateway/embeddings.js), [support-path.js:17](../src/claims/support-path.js) |
| A7 | Harness can set num_ctx for local | **FALSE** | [harness.js:142-146](../src/agent/harness.js) uses OpenAI-compat /v1 → ignores num_ctx (→ §6 pivot) |
| A8 | Truncation is model-aware | **FALSE** | [portal-chat.js:168](../src/portal-chat.js) binary `isLocal ? 5000 : 28000` chars |
| A9 | Egress/§4g gating independent of sizing | TRUE | [router.js:147-153](../src/inference/router.js), [harness.js:267-272](../src/agent/harness.js) — sizing touches only maxTokens/numCtx/trim |

## 8. Test strategy

- `tests/model-registry.test.mjs` — exact + family-prefix + miss lookup; dated-table sanity.
- `tests/model-profile.test.mjs` — probe-success (mock `/api/show` with `model_info` + `capabilities`), probe-fail→registry, registry-miss→default; cloud path = registry only; **caching + no-negative-cache** (mirror model-caps live-bit).
- `tests/token-budget.test.mjs` — `estimateTokens` parity with old `approxTokens`; `planGeneration`: clamp to maxOutput, numCtx rounding/cap, `overBudget` flag, cloud `numCtx===undefined`; reproduce the claims/discovery.js:180 result exactly (regression lock).
- `tests/harness-local-native.test.mjs` — local provider → native `/api/chat` body carries `options.num_ctx`; cloud unchanged (OpenAI-compat).
- **Verify gate** `verify:model-sizing` → `VERDICT: GO` exercising profile resolution + budget planning offline (injected fetch), per `/deploy-and-verify`.

## 9. Implementation order (each independently shippable + smoke)

- [x] 1. `src/inference/token-budget.js` (estimateTokens + planGeneration) + dedupe the 2 **gateway** `approxTokens` copies (openai-compat.js, embeddings.js). support-path.js's copy left intact (different empty-string semantics in the claims hot path). → `verify:model-sizing` GO; `verify:gateway`/`verify:embeddings-gateway` GO (no regression).
- [x] 2. `src/inference/model-registry.js` → registry lookup tests (M1–M5) GO.
- [x] 3. `src/inference/model-profile.js` (probe Ollama /api/show for `model_info.<arch>.context_length` + capabilities → registry → default; fail-soft; cache probe-only for local, always for cloud) → profile tests (P1–P8) GO.
- [x] 4. Wire `router.js` **opt-in `profile`** — auto-sizes maxTokens+numCtx only when a profile is passed; explicit values still override; no profile = legacy. → router auto-size tests (R-AS1–3) GO; `verify:resolve`/`verify:cascade`/`verify:harness`/`verify:chat` GO.
- [x] 5. Enrichment model-aware sizing: `narrate-infer.js` local `/api/chat` path now sizes `num_ctx` via `planGeneration` (fixes the no-num_ctx truncation bug) + clamps output to the model; caller maxTokens preserved. `discovery.js` already sized numCtx (left as-is); describe-image deferred (§11). → `verify:chat`/`model-sizing` GO. **Offline-built; enrichment quality wants a live Generate smoke.**
- [x] 6. **Harness native-`/api/chat` local adapter (the A7 pivot)** — `ollamaNativeAdapter` (text-only, local is tool-free) routes local chat over `/api/chat` with sized `num_ctx`; `streamTurn` threads `numCtx`; cloud paths unchanged. **portal-chat** resolves a `ModelProfile` + `planGeneration` and trims the system preamble to `inputBudget` TOKENS (replacing the `5000/28000` char cap), passing `maxTokens`+`numCtx` to `streamTurn`. → `verify:harness-local` (11/11) GO; `verify:harness` GO (H3 updated — tool-rejection fallback is now a cloud-openai concern). **Built + offline-verified; STILL needs live smoke on a real local Ollama model + cloud key at :8787.**
- [x] 7. `verify:model-sizing` gate added to package.json + design/living-docs updated. (full living-docs sweep with step 5/6 lands with them.)

**Phase-1 verification ledger (all run, all GO):**
`verify:model-sizing` ✓ · `verify:resolve` ✓ · `verify:cascade` ✓ · `verify:gateway` ✓ · `verify:gateway-stream` ✓ · `verify:gateway-tools` ✓ · `verify:embeddings-gateway` ✓ · `verify:harness` ✓ · `verify:chat` ✓.

## 10. Decision criteria to proceed past design

Proceed to implementation when the operator confirms **scope**: (A) sizing layer only — recommended, both stacks consume shared profile/budget; or (B) also unify the router + harness into one stack (larger, deferred). This doc designs (A); (B) is noted in §11.

## 11. Deferred (out of scope, named so they don't ambush later)

- **Unifying the two stacks** into one generation API (router + harness). Real cleanup, but orthogonal to "adapt to the model" and much larger blast radius. Separate phase.
- **Real tokenizer** (vs chars/4). The `MARGIN`+round-up over-reserve makes the estimate safe; a tokenizer is a precision upgrade, not a correctness fix.
- **Per-model capability-driven tool gating** in chat (today local = zero tools, binary). Profile.capabilities.tools makes this principled — a fast follow once profiles exist.
- **Auto-refresh of the registry** from provider model-list endpoints. Keep it hand-curated + dated for now (matches `presets.js`).

---

## 12. Phase 2 — Token-usage accounting + transparency (added 2026-06-15)

**User ask:** "measure token usage for everything, a place to display it, categorized by source / by area, with transparency on input + output consumption."

### 12.1 What exists / what's missing (sweep)
- Real token counts ARE computed but **never persisted**: the harness streams a `usage` event ([harness.js:288/308](../src/agent/harness.js)) then drops it; the router/`localInfer`/`cloudInfer` discard provider counts entirely (string-only return).
- Plaintext-metadata boundary is established: `audit_log`, `background_jobs`, and the legacy `cycle_metrics` (which already has plaintext `input_tokens`/`output_tokens`/`cost_cents`, migrations/0001_init.sql:601) all store counts/timestamps in the clear. **Token counts are metadata, not content** — the egress audit already stores `content_length` plaintext. We store COUNTS ONLY, never prompt/response text (§1 preserved).
- No `llm_usage` table, namespace, endpoint, or UI exists.

### 12.2 Design
- **Schema** `migrations/0014_llm_usage.sql` — `llm_usage(id, user_id, at, source, area, provider, model, jurisdiction, is_local, input_tokens, output_tokens, estimated, duration_ms, created_at)`, all plaintext, indexed by `(user_id, at)`, `(user_id, area)`, `(user_id, model)`. CREATE TABLE IF NOT EXISTS (idempotent under the re-exec-every-boot migrator).
  - `source` = entry path (`chat` | `gateway` | `enrichment`). `area` = task (`chat`/`narrate`/`claims`/`describe`/`cluster`/`caption`/`summarize`/`classify`/`extract`/`complex`). `estimated` = 1 when counts are chars/4 fallbacks, 0 when provider-reported actuals.
- **Namespace** `src/db/llm-usage.js` (mirrors audit.js): `record(userId, event)` fire-and-forget insert (never throws into a generation path); `summary(userId,{sinceDays})` → totals + grouped-by area/provider/model/source/day; `recent(userId,limit)`.
- **Sink** `src/inference/usage.js` `createUsageSink(db, userId, {source})` → an `onUsage(e)` (mirrors egress.js) that calls `db.usage.record`. Undefined when db has no usage namespace → capture is skipped, never errors.
- **Capture** — provider-reported ACTUAL counts wherever available:
  - `localInfer`/`cloudInfer` gain an optional `onUsage` → read Ollama `prompt_eval_count`/`eval_count`, Anthropic `usage.input_tokens/output_tokens`, OpenAI `usage.prompt_tokens/completion_tokens`. Router enriches with provider/model/jurisdiction/area and forwards. Streaming (`localStream`/`cloudStream`, harness) reads counts off the final/`done` event. Fallback: `estimateTokens` of prompt+output, `estimated:1`.
  - String returns UNCHANGED — `onUsage` is additive, like `onEgress`.
- **Endpoint** `GET /portal/usage?days=N` (portal REST :8787, isTrustedLoopback-guarded, mirrors portal-activity.js) → `{ totals, byArea, byProvider, byModel, bySource, byDay, recent }`.
- **UI** a "Usage" pane in the Settings hub (`portal-app` SettingsView TABS) — totals (input/output), a by-area table with CSS bars (no chart lib in the portal — matches activity-chip bars), provider/model breakdown, last-N events. **UI live-smoke pending the portal dev build.**
- **Gate** `verify:usage` — temp vault + injected fetch: capture from router (local + cloud, actual + estimated fallback) and harness → assert rows persisted with correct dimensions → assert `summary()` aggregates by area/provider/model and splits input vs output → assert NO prompt/response text in any column.

### 12.4 Estimate fallback + content-flow (added 2026-06-15)
- **Per-call estimate, never an average.** When a provider omits counts, the router estimates from the ACTUAL text via `chars/4` (`estimateTokens`) and flags `estimated:1`. Real counts are used whenever the provider reports them (the normal case for Ollama/Anthropic/OpenAI).
- **Streaming hardened**: `runLocalStream`/`runCloudStream` now ACCUMULATE the streamed deltas and pass the joined text to `emitUsage`, so the output estimate is correct even when a streaming provider reports no usage (previously it passed `""` → ~1 token). Gate `A18`.
- **Content-flow for non-model areas** (`recordContentFlow`, `src/inference/usage.js`): bulk imports don't touch a model, but the user wants to see how much is flowing through each area. An import records an ESTIMATED row (`source:'ingest'`, `area:'import'`, `inputTokens=Σ chars/4`, `outputTokens:0`, `estimated:1`). Wired in `src/ingest/obsidian-import.js` (the portal Obsidian import delegates to it). Gates `A19`/`A20`. The DB-row importers (full-export/vault) carry ciphertext rows → estimating there needs plaintext; deferred as a follow-on (§11). `VALID_SOURCES` gains `ingest`.

### 12.3 Threat / privacy note
Counts per area reveal coarse activity signal (e.g. how much you journal), but this is the **operator's own single-user vault**, read only over loopback/bearer by the owner — same trust boundary + plaintext class as `background_jobs`/`audit_log`. Accepted (consistent with [[deployment-local-primary]]). Hard invariant the gate enforces: **no prompt or completion text ever enters `llm_usage`** — counts + dimensions only.

---

## 13. Phase 3 — steps 5 + 6 (sweep + design, 2026-06-15)

### 13.1 Sweep findings (file:line, verified)
- **Local chat is tool-free**: [portal-chat.js:211](../src/portal-chat.js) `tools: isLocal ? [] : grantedTools`. ⇒ the native local adapter only needs **text streaming** (no Ollama tool-call parsing). Major simplification.
- **Harness `streamOnce` param set is fixed** ([harness.js:85/142/283/316](../src/agent/harness.js)) `{cfg,system,messages,toolDefs,model,maxTokens,send,signal,fetch,timeoutMs,logger}` — adding `numCtx` is additive.
- **`normalizeProvider` routes local → openaiAdapter over `/v1`** ([harness.js:198-203](../src/agent/harness.js)) which **ignores `num_ctx`** (the A7 pivot). Fix: detect local and route to a new `ollamaNativeAdapter` over `/api/chat`.
- **`narrate-infer.js` local path sets NO `num_ctx`** ([narrate-infer.js:52](../pipeline/lib/narrate-infer.js) `options:{ num_predict }` only) → silent-truncation risk on long narration prompts (Ollama's ~4096 default). `createNarrator` already resolves `cfg` ([narrate-infer.js:33](../pipeline/lib/narrate-infer.js)) so a profile threads in cheaply.
- **portal-chat has `provider` cfg + `fetch` in scope** ([portal-chat.js:44/151](../src/portal-chat.js)) to resolve a `ModelProfile`.

### 13.2 Step 6 design (chat)
- New `ollamaNativeAdapter` (kind `ollama`) in harness.js: POST `${host}/api/chat` `{ model, stream:true, think:false, options:{ num_predict:maxTokens, num_ctx }, messages:[{role:'system',…}, …] }`; parse NDJSON (`message.content`→text_delta, `message.thinking`→thinking_delta, `done`→`prompt_eval_count`/`eval_count` usage). `mapTools:()=>[]` (local is tool-free). TTFB-only timeout, abort-aware, leak-safe (no prompt/response echo).
- `normalizeProvider`: `isLocal = jurisdiction==='local' || loopback(baseUrl)` → native adapter with `baseUrl` stripped of `/v1`. Cloud paths unchanged.
- `streamTurn` gains `numCtx`, threaded to every `streamOnce` (cloud adapters ignore it).
- **portal-chat**: resolve `ModelProfile(provider)`, `planGeneration({task:'chat'})` → trim system preamble to `inputBudget` **tokens** (replaces binary `5000/28000` chars), and pass `maxTokens`+`numCtx` to `streamTurn`. Fail-soft: profile null → the old char cap.

### 13.3 Step 5 design (enrichment)
- `narrate-infer.js`: resolve a `ModelProfile` once in `createNarrator`; the local `/api/chat` path sizes `options.num_ctx` via `planGeneration(task:'narrate', inputTokens=estimate(prompt), requestedMaxTokens=maxTokens)` and clamps `num_predict` to the model. Fixes the no-`num_ctx` truncation bug; caller-chosen small maxTokens (300/700) are preserved (clamped, never inflated). `discovery.js` already sizes numCtx → left as-is. describe-image (vision, small prompts) deferred (§11).

### 13.4 Verification table (Phase 3)
| # | Assumption | Verdict | Verified at |
|---|---|---|---|
| B1 | Local chat passes no tools → native adapter text-only | TRUE | [portal-chat.js:211](../src/portal-chat.js) |
| B2 | `streamOnce` param set fixed; `numCtx` additive | TRUE | [harness.js:85/142/283/316](../src/agent/harness.js) |
| B3 | Local routes over `/v1` (ignores num_ctx) today | TRUE | [harness.js:198-203](../src/agent/harness.js) |
| B4 | portal-chat has provider cfg + fetch to resolve a profile | TRUE | [portal-chat.js:44/151](../src/portal-chat.js) |
| B5 | narrate-infer local path sets no num_ctx (truncation risk) | TRUE | [narrate-infer.js:52](../pipeline/lib/narrate-infer.js) |
| B6 | Ollama `/api/chat` stream = NDJSON `{message,done,prompt_eval_count,eval_count}`, honors `options.num_ctx`+`think` | TRUE (Ollama API; mirrors [local.js localStream NDJSON](../src/inference/local.js) + [narrate-infer.js non-stream /api/chat](../pipeline/lib/narrate-infer.js)) |

### 13.5 Gate + smoke
- `verify:harness-local` (offline, injected fetch): local provider → POST `/api/chat` (NOT `/v1/chat/completions`), body carries `options.num_ctx`+`num_predict`+`think:false`+system message; NDJSON text streamed; usage captured; cloud provider still uses `/v1`/anthropic.
- **Live smoke (operator)**: chat against a real local Ollama model (long briefing → no mid-reply truncation; reply sizes to the window) AND a cloud key (unchanged); Generate → narration num_ctx sized; Usage pane populates.

---

### Revision history
- **v1** (sketch): a single `planGeneration` everyone calls; harness sets `num_ctx` like other local callers.
- **v2** (this doc): sweep refuted the harness `num_ctx` assumption (A7) — local chat runs over OpenAI-compat `/v1` which ignores `num_ctx`; added the native-`/api/chat` local adapter (§6). Also promoted the model **registry** to a first-class module after finding catalog `ctx` is a uniform placeholder (A3) and cloud limits are recorded nowhere (A5).
- **v3** (2026-06-16, token-limit unification): the output-cap *sizing* fix (registry 1M/128k; chat/complex expand to model max) left an orthogonal **detection** gap, now closed. The harness's three streaming adapters captured the provider stop reason but only compared it against the tool-use value, so the truncation reason (`stop_reason:'max_tokens'` / `finish_reason:'length'` / Ollama `done_reason:'length'`) was silently swallowed — a truncated tool-call argument parses to `{}` → a silent no-op write (the "model said it saved but nothing was written" failure). **Fix:** each adapter now returns `truncated`, `streamTurn` surfaces it and STOPS (never executes a possibly-truncated tool call), and the callers raise a visible state — portal-chat emits a `truncated` SSE event + `done{truncated:true}` (and does not retry a capped turn); the gateway threads an additive, fail-soft `onTruncated` callback through `cloud.js`/`local.js`/`router.js`/`cascade.js` and emits OpenAI-correct `finish_reason:'length'` (was hardcoded `'stop'`) so an external harness can detect the cut-off. Gates: `verify:harness` H8–H12 (incl. the truncated-tool-call no-op), `verify:chat` C9, `verify:gateway` G12 — all GO. (This was the "Not in this pass" item flagged in the v3 unification.)
