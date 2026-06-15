# Handoff — Model-aware text generation + token-usage accounting (2026-06-15)

## TL;DR
Made Mycelium's text generation **model-aware** (works with any/local model, auto-adapts output length + context window) and added **token-usage accounting + a transparency UI**. Three phases, all built; 14 offline gates GO; portal `svelte-check` 0 errors; the **local path is live-smoked against real Ollama + a real vault**. Cloud path is unchanged (gate-covered). Branch `claude/gracious-shamir-d1d1f4`.

Design + verification tables: [TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md](TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md).

## What shipped

**Phase 1 — model-aware sizing layer**
- `src/inference/model-registry.js` — real per-model context/output limits (cloud source-of-truth; local fallback).
- `src/inference/model-profile.js` — `resolveModelProfile(cfg)`: probe Ollama `/api/show` for real `context_length`+caps → registry → conservative default. Fail-soft, cached (probe-only for local).
- `src/inference/token-budget.js` — `estimateTokens` (shared; deduped 2 gateway copies) + `planGeneration` (sizes `maxTokens`/`num_ctx`/input-budget) + `trimToTokenBudget`.
- `src/inference/router.js` — opt-in `profile` auto-sizes (back-compat: no profile = legacy).

**Phase 2 — token-usage accounting**
- `migrations/0014_llm_usage.sql` — counts + dimensions only, **no content** (gate-enforced). Plaintext metadata, same boundary as `audit_log`/`background_jobs`.
- `src/db/llm-usage.js` (`db.usage`: `record`/`summary`/`recent`) + `src/inference/usage.js` (`createUsageSink`).
- Capture threaded: provider actuals from `local.js`/`cloud.js` (`onUsage`) → `router.js` `emitUsage` (enrich + estimate-fallback) → `cascade.js` + `harness.js`. Sinks at **chat** (portal-chat), **gateway** (openai-compat), **enrichment** (narrate-infer).
- `src/portal-usage.js` — `GET /portal/usage?days=N` (registered in `server-rest.js`). UI: `portal-app/.../settings/UsageSection.svelte` + Settings **Usage** tab.

**Phase 3 — native local chat + enrichment sizing (the A7 pivot)**
- `src/agent/harness.js` — `ollamaNativeAdapter`: local chat over native `/api/chat` (text-only — local is tool-free) so `num_ctx` is sizable (the OpenAI-compat `/v1` surface ignores it). `streamTurn` threads `numCtx`. Cloud unchanged.
- `src/portal-chat.js` — resolves a `ModelProfile`, trims the system preamble to `inputBudget` **tokens** (killed the binary `5000/28000` char cap), passes `maxTokens`+`numCtx`.
- `pipeline/lib/narrate-infer.js` — local `/api/chat` path now sizes `num_ctx` via `planGeneration` (fixes a real silent-truncation bug).

## Verification
- **Gates (offline, all GO):** `model-sizing` · `usage` (18, incl. no-content invariant) · `harness-local` (11) · `harness` (H3 updated — tool-rejection fallback is now a cloud-openai concern since local is tool-free) · `chat` · `resolve` · `cascade` · `gateway` · `gateway-stream` · `gateway-tools` · `embeddings-gateway` · `leak` · `providers-leak` · `egress`. Portal `svelte-check` 0 errors. Migration idempotent under double-apply.
- **Live smoke (real Ollama 127.0.0.1:11434, llama3.1, real vault):** profile probe read the real **131072** window; native adapter streamed over `/api/chat` with `num_ctx=6144` sent; real usage `{34,15}` captured; narration persisted a real `llm_usage` row (`enrichment/narrate`, `{37,8}`, `estimated=0`) and `summary()` aggregated it.

## Pickup protocol / what's left
1. **Operator confirmations (low-risk):** a cloud-key chat (unchanged path); eyeball Settings → Usage in the running app after some activity.
2. **Deferred follow-ons** (design §11): capability-driven tool-gating in chat (`profile.capabilities.tools`); thread a profile into `describe-image.js` (vision/caption — the one enrichment path left untouched); cost-estimate column in the Usage pane; Scope B (router+harness unification — largest, lowest urgency).

## Notes
- Security: egress audit + §4g sensitive/jurisdiction hard-block are **independent of sizing+usage** (A9); `verify:leak`/`providers-leak`/`egress` GO. `llm_usage` stores **no prompt/response text**, ever (gate `A6`/`A7`).
- The live `:8787` serves the MAIN build, not this worktree — portal-UI live render is the one thing to check after merge/build.
