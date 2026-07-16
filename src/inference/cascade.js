// src/inference/cascade.js — the §4g multi-provider cascade (opt-in).
//
// Tries a jurisdiction-ordered chain of providers (resolveProviderChain) until
// one succeeds: EU-sovereign → frontier → on-box local. The cascade lives ABOVE
// the router — it builds a fresh single-provider router per chain element and
// reuses the router's UNCHANGED audited gate (each attempt emits its own egress
// row via onEgress, and the router's own sensitive hard-block is a second line of
// defence behind resolveProviderChain's us-* drop).
//
// Off by default; the gateway enables it with MYCELIUM_INFER_CASCADE. Streaming
// is single-provider (a provider can't be swapped mid-stream) — the cascade is
// the non-streaming path. Prompt-only, like the router.

import { isSensitiveTask } from './sensitivity.js';
import { createInferenceRouter } from './router.js';
import { InferenceError } from './errors.js';

/**
 * Run an inference over a provider chain, failing over on each error.
 * @param {object} opts
 * @param {Array<object>} opts.chain   ordered router-opts (resolveProviderChain)
 * @param {string} opts.prompt
 * @param {string} [opts.task='complex']
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.sensitive=false]
 * @param {Function} [opts.onEgress]   per-attempt egress audit sink
 * @param {typeof fetch} [opts.fetch]
 * @param {boolean} [opts.requireApprovedLocal=false]  CONSENT MODE (increment M, #148):
 *   forwarded to every router so the trailing on-box floor refuses (typed
 *   'no-approved-local-model') instead of running an unapproved default. The floor is
 *   ALWAYS the last chain element, so its refusal is the cascade's `lastErr`; the final
 *   throw re-carries that code so a caller can surface it honestly rather than as a
 *   generic outage. A sensitive request drops all US providers straight onto this floor.
 * @param {string|null} [opts.localModel]  the owner-approved on-box model name (or null);
 *   used verbatim by the floor when requireApprovedLocal is set.
 * @returns {Promise<string>}
 */
export async function inferWithCascade({ chain, prompt, task = 'complex', maxTokens, sensitive = isSensitiveTask(task), onEgress, onUsage, onTruncated, fetch, requireApprovedLocal = false, localModel } = {}) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new InferenceError('inferWithCascade: empty provider chain');
  }
  let lastErr;
  for (const cfg of chain) {
    // cloudFallbackToLocal:false → a cloud failure PROPAGATES (so we try the next
    // chain element) instead of the router silently serving local from this one.
    // The trailing local element has no cloud, so it runs on-box Ollama directly.
    // localModel/requireApprovedLocal go AFTER the spread so they win over the chain
    // element (cloud elements ignore them; only the local floor consults them).
    const router = createInferenceRouter({ ...cfg, onEgress, onUsage, fetch, cloudFallbackToLocal: false, requireApprovedLocal, localModel });
    try {
      return await router.infer({ prompt, task, maxTokens, sensitive, onTruncated });
    } catch (err) {
      lastErr = err; // try the next provider in the chain
    }
  }
  // Re-carry a consent refusal from the on-box floor so the caller (gateway) can answer
  // honestly ('no approved model') rather than collapse it into a generic upstream outage.
  throw new InferenceError('inferWithCascade: all providers in the chain failed', {
    cause: lastErr,
    code: lastErr?.code === 'no-approved-local-model' ? 'no-approved-local-model' : undefined,
  });
}

export default inferWithCascade;
