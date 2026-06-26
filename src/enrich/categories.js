// src/enrich/categories.js — the per-message domain+register classifier (Context Engine L1).
//
// Pure orchestration over an injected infer(prompt)=>string. The HTTP/model choice lives at
// the injection site (the drainer wires it to the on-box model with format:'json'), so this
// module stays unit-testable with a stub. Foundations-first: this LLM pass is the labeler and
// the ground truth the Phase-3a centroid-compass is later validated against.
import { buildCategoryPrompt, parseCategoryResponse } from './categories-prompt.js';
import { labelingRecommendedModel } from '../inference/role-models.js';

// Default on-box model for L1 labeling. qwen3.5:4b beat llama3.1 decisively in a live
// 4-model eval (2026-06-21): balanced domain spread + clean register parsing (~2-5/50
// nulls vs llama3.1's ~27/50, which invents words like "Emotion" outside the 12-name
// list). Small + fast — fits "smaller compute" boxes. Overridable via
// settings.taskModels.categorize.model. See docs/MODEL-CURATION-* + the eval handoff.
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
  return classify;
}

export default createCategoryClassifier;
