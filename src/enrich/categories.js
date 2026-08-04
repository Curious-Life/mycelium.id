// src/enrich/categories.js — the per-message domain+register classifier (Context Engine L1).
//
// Pure orchestration over an injected infer(prompt)=>string. The HTTP/model choice lives at
// the injection site (the drainer wires it to the on-box model with format:'json'), so this
// module stays unit-testable with a stub. Foundations-first: this LLM pass is the labeler and
// the ground truth the Phase-3a centroid-compass is later validated against.
import { buildCategoryPrompt, parseCategoryResponse, buildCategoryBatchPrompt, parseCategoryBatchResponse } from './categories-prompt.js';
import { labelingRecommendedModel } from '../inference/role-models.js';

// Default on-box model for L1 labeling. qwen3.5:4b beat llama3.1 decisively in a live
// 4-model eval (2026-06-21): balanced domain spread + clean register parsing (~2-5/50
// nulls vs llama3.1's ~27/50, which invents words like "Emotion" outside the 12-name
// list). Small + fast — fits "smaller compute" boxes. Overridable via
// settings.taskModels.categorize.model. See the model-curation notes + the eval handoff.
//
// Single-sourced from role-models.js ROLE_RECOMMENDATIONS.labeling so the "Recommended
// for labeling" badge and this default can never drift (verify-enrich-categories pins them equal).
export const DEFAULT_LABEL_MODEL = labelingRecommendedModel();

/**
 * @param {object} o
 * @param {(prompt:string)=>Promise<string>} o.infer  text completion; THROWS on transport
 *        failure (a model outage). The classifier lets that throw propagate so the enrich
 *        stage can leave the row pending for retry — a parse failure is NOT an outage and
 *        resolves to null labels instead.
 * @param {string} [o.model]  the model label that backs `infer` (e.g. 'llama3.1'), recorded
 *        as per-row provenance (categories_model, 0041) so the UI can show "tagged by X" and a
 *        future re-cut can target rows tagged by an older model. Exposed as `classify.model`.
 * @returns {((content:string)=>Promise<{domain,register,subregister}>) & {model?: string}}
 */
export function createCategoryClassifier({ infer, model } = {}) {
  if (typeof infer !== 'function') throw new TypeError('createCategoryClassifier: infer(prompt) required');
  async function classify(content) {
    const raw = await infer(buildCategoryPrompt(content)); // throw = transient outage → caller retries
    return parseCategoryResponse(raw);                     // parse never throws (null = unclassified)
  }
  classify.model = model;                                  // provenance label; undefined → not recorded
  /**
   * D-132 (U-C) — K messages in ONE model call. Returns an array aligned with
   * `contents`: labels for items the STRICT batch parser matched, null for the
   * rest (the caller falls back to the single path for those — one bad reply
   * costs a retry, never a wrong label). Output/context budgets scale with K
   * via the second infer arg; a single-arg infer (tests, older wirings) simply
   * ignores it and relies on its own caps — truncation then falls out as an
   * unparseable array → all-null → full single-path fallback. Throw = outage,
   * propagated like classify()'s.
   * ACCEPTED RESIDUAL (round-1 review): on a model whose real context window
   * binds BELOW the computed need (the wiring clamps to the catalog ctx), every
   * pass burns one truncated batch call before falling back per-row — K is not
   * auto-shrunk to fit. Bounded (one wasted call/pass), self-evident in the
   * measured rate, and the revert lever (MYCELIUM_L1_BATCH=1) removes it.
   * @param {string[]} contents
   */
  classify.batch = async function classifyBatch(contents) {
    const items = (contents || []).map((content, idx) => ({ i: idx + 1, content }));
    const prompt = buildCategoryBatchPrompt(items);
    // ~3.2 chars/token heuristic + the scaled reply budget, rounded up to the
    // 2048 grid, floor 2048 — the model catalog caps the real ceiling at the
    // wiring site (drainer clamps to the catalog ctx; 8192 for the default).
    const maxTokens = 48 * items.length + 16;
    const numCtx = Math.max(2048, Math.ceil((prompt.length / 3.2 + maxTokens) / 2048) * 2048);
    const raw = await infer(prompt, { maxTokens, numCtx });
    const matched = parseCategoryBatchResponse(raw, items.map((x) => x.i));
    return items.map((x) => matched.get(x.i) || null);
  };
  return classify;
}

export default createCategoryClassifier;
