// src/inference/router.js — the inference router (Component 6).
//
// Routes a generation task between the local Ollama backend (free, private,
// on-box) and BYOK cloud (powerful, costs money, plaintext egress). The policy,
// per the V1 spec's ~80/20 split:
//   - "simple" tasks (summarize / classify / extract) → ALWAYS local.
//   - "complex" tasks (narrate / complex) → cloud IF a key is configured,
//     else local. Cloud failures fall back to local for resilience.
//
// Privacy default is local. Cloud only fires for complex tasks when the user
// has opted in by configuring ANTHROPIC_API_KEY / OPENAI_API_KEY (see cloud.js
// for the egress-boundary note). API keys are never exposed on the returned
// router object, never logged, and never appear in errors.
//
// Factory / DI style: callers inject `fetch` and config in tests; production
// reads from process.env. No internal caller yet — this is infrastructure the
// model-backed enrichment seam and topology description can adopt.

import { localInfer, DEFAULT_OLLAMA_URL, DEFAULT_LOCAL_MODEL } from "./local.js";
import { cloudInfer } from "./cloud.js";
import { InferenceError } from "./errors.js";

export const LOCAL_TASKS = Object.freeze(["summarize", "classify", "extract"]);
export const CLOUD_TASKS = Object.freeze(["narrate", "complex"]);
export const TASKS = Object.freeze([...LOCAL_TASKS, ...CLOUD_TASKS]);

/**
 * Create an inference router.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @param {string} [opts.ollamaUrl]
 * @param {string} [opts.localModel]
 * @param {string} [opts.anthropicApiKey]
 * @param {string} [opts.openaiApiKey]
 * @param {string} [opts.cloudModel]      overrides the provider default model
 * @param {number} [opts.timeoutMs=60000]
 * @param {object} [opts.env=process.env]  env source (injectable for tests)
 */
export function createInferenceRouter({
  fetch = globalThis.fetch,
  ollamaUrl,
  localModel,
  anthropicApiKey,
  openaiApiKey,
  cloudModel,
  baseUrl,
  jurisdiction,
  timeoutMs = 60000,
  env = process.env,
} = {}) {
  const cfg = {
    fetch,
    ollamaUrl: ollamaUrl || env.OLLAMA_URL || DEFAULT_OLLAMA_URL,
    localModel: localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL,
    anthropicApiKey: anthropicApiKey ?? env.ANTHROPIC_API_KEY,
    openaiApiKey: openaiApiKey ?? env.OPENAI_API_KEY,
    cloudModel: cloudModel || env.INFERENCE_CLOUD_MODEL, // undefined → backend default
    baseUrl: baseUrl ?? env.INFERENCE_BASE_URL, // OpenAI-compatible endpoint (Regolo/OpenRouter/Ollama/…)
    jurisdiction, // 'local'|'eu-zdr'|'us-zdr'|'us-standard' — tag for the egress policy (§4g)
    timeoutMs,
  };

  // Cloud is "available" when a key OR an OpenAI-compatible base_url is set (some
  // local/self-hosted base_url servers are keyless).
  const hasCloud = () => Boolean(cfg.anthropicApiKey || cfg.openaiApiKey || cfg.baseUrl);

  function runLocal({ prompt, maxTokens }) {
    return localInfer({ prompt, maxTokens, model: cfg.localModel, baseUrl: cfg.ollamaUrl, fetch: cfg.fetch, timeoutMs: cfg.timeoutMs });
  }

  function runCloud({ prompt, maxTokens }) {
    return cloudInfer({
      prompt, maxTokens,
      anthropicApiKey: cfg.anthropicApiKey,
      openaiApiKey: cfg.openaiApiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.cloudModel,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
    });
  }

  /**
   * Route + run an inference task.
   * @param {object} req
   * @param {string} req.prompt
   * @param {'summarize'|'classify'|'extract'|'narrate'|'complex'} [req.task='summarize']
   * @param {number} [req.maxTokens]
   * @returns {Promise<string>}
   */
  async function infer({ prompt, task = "summarize", maxTokens } = {}) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new InferenceError("infer: prompt must be a non-empty string");
    }
    if (!TASKS.includes(task)) {
      throw new InferenceError(`infer: unknown task ${JSON.stringify(task)} (valid: ${TASKS.join(", ")})`);
    }

    if (CLOUD_TASKS.includes(task) && hasCloud()) {
      try {
        return await runCloud({ prompt, maxTokens });
      } catch (cloudErr) {
        // Resilience: a cloud failure falls back to on-box local.
        try {
          return await runLocal({ prompt, maxTokens });
        } catch (localErr) {
          throw new InferenceError("infer: cloud failed and local fallback failed", { cause: localErr, backend: "both" });
        }
      }
    }

    // Simple tasks, or complex with no cloud key → local.
    return runLocal({ prompt, maxTokens });
  }

  return {
    infer,
    runLocal,
    runCloud,
    hasCloud,
    // Config snapshot for diagnostics — keys are deliberately redacted.
    config: {
      ollamaUrl: cfg.ollamaUrl,
      localModel: cfg.localModel,
      cloudModel: cfg.cloudModel,
      timeoutMs: cfg.timeoutMs,
      anthropicConfigured: Boolean(cfg.anthropicApiKey),
      openaiConfigured: Boolean(cfg.openaiApiKey),
      baseUrl: cfg.baseUrl,
      jurisdiction: cfg.jurisdiction,
    },
  };
}

export default createInferenceRouter;
