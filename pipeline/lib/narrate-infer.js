// pipeline/lib/narrate-infer.js — the inference seam for the describe pipeline
// (naming realms/territories + chronicling them).
//
// THE selected provider names things. resolveInferenceConfig() returns the row the
// user activated in Settings → Intelligence (gemma / Regolo / Claude / …); the
// describe scripts call THIS, never the Claude CLI (the old describe-clusters.js
// shelled out to `claude -p`, which fails on any box without an authed CLI → every
// realm fell back to "Realm N").
//
// Speed: a LOCAL Ollama provider is reached over its NATIVE /api/chat with
// think:false + format:'json'. Measured on gemma4:12b: native think:false = ~4s with
// zero reasoning vs ~36s over the OpenAI-compatible /v1 surface (which ignores both
// think:false AND response_format for reasoning models). Cloud providers go through
// the existing inference router (audited egress).

import { resolveInferenceConfig } from '../../src/inference/resolve.js';
import { createInferenceRouter } from '../../src/inference/router.js';
import { createEgressAuditSink } from '../../src/inference/egress.js';
import { createUsageSink } from '../../src/inference/usage.js';
import { resolveModelProfile } from '../../src/inference/model-profile.js';
import { planGeneration, estimateTokens } from '../../src/inference/token-budget.js';
import { DEFAULT_LOCAL_MODEL } from '../../src/inference/local.js';

const LOCALHOST_RE = /(?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/;

/**
 * Build a narrator bound to the user's ACTIVE provider.
 * @param {object} a
 * @param {object} a.db        assembled vault db (needs db.providers)
 * @param {string} a.userId
 * @param {typeof fetch} [a.fetch]
 * @returns {Promise<{ infer:(prompt:string,opts?:{maxTokens?:number})=>Promise<string>, label:string, local:boolean }>}
 */
export async function createNarrator({ db, userId, fetch = globalThis.fetch }) {
  const cfg = await resolveInferenceConfig(db, userId);
  const onUsage = createUsageSink(db, userId, { source: 'enrichment' });
  const isLocal = cfg.jurisdiction === 'local' || (!!cfg.baseUrl && LOCALHOST_RE.test(cfg.baseUrl));
  const label = cfg.label || (isLocal ? 'local model' : cfg.anthropicApiKey ? 'Claude' : cfg.baseUrl ? 'custom' : 'local model');

  // ── Local Ollama: native /api/chat, think OFF, JSON-constrained — fast + reliable.
  if (isLocal && cfg.baseUrl) {
    const host = cfg.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, ''); // strip the OpenAI-compat /v1 suffix
    // cloudModel = the user's model_preference on the ACTIVE provider (Settings →
    // Intelligence) — the same value chat resolves. The shared constant keeps the
    // no-preference fallback in lockstep with chat instead of drifting separately.
    const model = cfg.cloudModel || DEFAULT_LOCAL_MODEL;
    // Model-aware sizing: resolve the model's real window so we can size num_ctx to
    // hold prompt + reply. Without it Ollama defaults to ~4096 and a long narration
    // prompt silently truncates the JSON reply → a lost run. Fail-soft (cached).
    const profile = await resolveModelProfile({ ...cfg, baseUrl: host, jurisdiction: 'local' }, { fetch, defaultModel: model }).catch(() => null);
    const infer = async (prompt, { maxTokens = 700 } = {}) => {
      const plan = profile ? planGeneration(profile, { task: 'narrate', inputTokens: estimateTokens(prompt), requestedMaxTokens: maxTokens }) : null;
      const options = { num_predict: plan ? plan.maxTokens : maxTokens };
      if (plan?.numCtx) options.num_ctx = plan.numCtx;
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,          // skip the reasoning preamble (9× faster on gemma/qwen)
          format: 'json',        // constrain decoding to valid JSON — no prose, no fences
          options,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`ollama /api/chat ${res.status}`);
      const d = await res.json();
      // §12 token-usage accounting — Ollama /api/chat reports real counts. Counts only.
      if (typeof onUsage === 'function') { try { onUsage({ area: 'narrate', isLocal: true, provider: 'local', model, jurisdiction: 'local', inputTokens: d?.prompt_eval_count, outputTokens: d?.eval_count, estimated: false }); } catch { /* never break narration */ } }
      return d?.message?.content || '';
    };
    return { infer, label, local: true };
  }

  // ── Cloud / remote: the audited inference router (anthropic or openai-compatible).
  const router = createInferenceRouter({ ...cfg, onEgress: createEgressAuditSink(db, userId), onUsage });
  const infer = (prompt, { maxTokens = 700 } = {}) => router.infer({ task: 'narrate', prompt, maxTokens });
  return { infer, label, local: false };
}

export default createNarrator;
