// src/inference/token-budget.js — the shared token estimator + generation budgeter.
//
// ONE home for "how many tokens is this text" (previously `approxTokens`, duped
// in src/gateway/openai-compat.js, src/gateway/embeddings.js, src/claims/
// support-path.js) and for "how big should max_tokens / num_ctx be for THIS
// model + THIS prompt" (previously a one-off formula at src/claims/discovery.js).
//
// Model-aware: planGeneration() takes a ModelProfile (model-profile.js) so every
// generation caller sizes output + context to the model's REAL limits instead of
// the scattered magic numbers (1024 / 4096 / 700 / 1500 / 300 / 8192). Pure
// arithmetic — no I/O, no secrets, fail-safe (over-reserves, never under).
//
// See docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md.

/**
 * Cheap token estimate (~4 chars/token). v1 heuristic; a real tokenizer is a
 * precision upgrade, not a correctness fix — the MARGIN + 1024-rounding in
 * planGeneration absorb the imprecision by over-reserving. Matches the prior
 * `approxTokens` behaviour exactly (Math.ceil(len/4), floor of 1) so the dedupe
 * is value-preserving.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

// Per-task DEFAULT output sizing — a floor that is still clamped to the model's
// real maxOutputTokens in planGeneration. Replaces the per-caller magic numbers;
// callers may override via requestedMaxTokens.
export const TASK_OUTPUT_DEFAULTS = Object.freeze({
  classify: 64,
  summarize: 256,
  extract: 512,
  caption: 700,
  narrate: 1024,
  claims: 1500,
  chat: 4096,
  complex: 4096,
});

// Reserved headroom (tokens) so the chars/4 estimate's imprecision + chat
// templating overhead can't push prompt+output past the window.
export const BUDGET_MARGIN = 512;

/**
 * Plan a generation against a model's real limits.
 *
 * Returns the output cap (maxTokens), the local context-window size to request
 * (numCtx — local only; cloud sizes itself), the input token budget the caller
 * should trim to, and whether the input already overflows it. Does NOT truncate —
 * trimming stays with the caller, which alone knows what is droppable (system
 * preamble vs retrieval vs message history).
 *
 * @param {import('./model-profile.js').ModelProfile} profile
 * @param {object} [a]
 * @param {number} [a.inputTokens=0]        estimated tokens already in the prompt/messages
 * @param {string} [a.task='complex']       keys TASK_OUTPUT_DEFAULTS
 * @param {number} [a.requestedMaxTokens]   explicit caller override (still clamped)
 * @returns {{ maxTokens:number, numCtx:number|undefined, inputBudget:number, overBudget:boolean }}
 */
export function planGeneration(profile, { inputTokens = 0, task = 'complex', requestedMaxTokens } = {}) {
  // Defensive defaults so a malformed/partial profile can never NaN the math.
  const contextWindow = Number.isFinite(profile?.contextWindow) && profile.contextWindow > 0 ? Math.floor(profile.contextWindow) : 8192;
  const maxOutputTokens = Number.isFinite(profile?.maxOutputTokens) && profile.maxOutputTokens > 0 ? Math.floor(profile.maxOutputTokens) : 1024;
  const isLocal = !!profile?.isLocal;
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? Math.floor(inputTokens) : 0;

  const want = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? Math.floor(requestedMaxTokens)
    : (TASK_OUTPUT_DEFAULTS[task] ?? 1024);

  // Output can never exceed the model's hard cap, nor crowd out the whole window.
  const maxTokens = Math.max(1, Math.min(want, maxOutputTokens, Math.max(1, contextWindow - 256)));

  // What's left for input after reserving output + margin (floor of 256 so a tiny
  // window still leaves room for a question).
  const inputBudget = Math.max(256, contextWindow - maxTokens - BUDGET_MARGIN);

  // num_ctx: LOCAL only. Round UP to the next 1024 of what we actually need, capped
  // to the model's window. Generalizes src/claims/discovery.js's bespoke formula.
  // Cloud providers size their own context → undefined (the wire omits the field).
  const numCtx = isLocal
    ? Math.min(contextWindow, Math.max(1024, Math.ceil((Math.min(inTok, inputBudget) + maxTokens + BUDGET_MARGIN) / 1024) * 1024))
    : undefined;

  return { maxTokens, numCtx, inputBudget, overBudget: inTok > inputBudget };
}

/**
 * Trim a single text blob to a token budget (cheap char-proportional cut),
 * preserving a trailing marker. Convenience for the common single-string case
 * (e.g. portal-chat's system preamble); multi-part callers should budget each
 * part themselves. Returns { text, trimmed }.
 * @param {string} text
 * @param {number} budgetTokens
 * @param {string} [marker]
 */
export function trimToTokenBudget(text, budgetTokens, marker = '\n\n[context truncated for this model]') {
  const s = String(text ?? '');
  if (estimateTokens(s) <= budgetTokens) return { text: s, trimmed: false };
  const keepChars = Math.max(0, budgetTokens * 4 - marker.length);
  return { text: s.slice(0, keepChars) + marker, trimmed: true };
}

export default planGeneration;
