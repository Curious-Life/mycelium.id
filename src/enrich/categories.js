// src/enrich/categories.js — the per-message domain+register classifier (Context Engine L1).
//
// Pure orchestration over an injected infer(prompt)=>string. The HTTP/model choice lives at
// the injection site (the drainer wires it to the on-box model with format:'json'), so this
// module stays unit-testable with a stub. Foundations-first: this LLM pass is the labeler and
// the ground truth the Phase-3a centroid-compass is later validated against.
import { buildCategoryPrompt, parseCategoryResponse } from './categories-prompt.js';

/**
 * @param {object} o
 * @param {(prompt:string)=>Promise<string>} o.infer  text completion; THROWS on transport
 *        failure (a model outage). The classifier lets that throw propagate so the enrich
 *        stage can leave the row pending for retry — a parse failure is NOT an outage and
 *        resolves to null labels instead.
 * @returns {(content:string)=>Promise<{domain,register,subregister}>}
 */
export function createCategoryClassifier({ infer } = {}) {
  if (typeof infer !== 'function') throw new TypeError('createCategoryClassifier: infer(prompt) required');
  return async function classify(content) {
    const raw = await infer(buildCategoryPrompt(content)); // throw = transient outage → caller retries
    return parseCategoryResponse(raw);                     // parse never throws (null = unclassified)
  };
}

export default createCategoryClassifier;
