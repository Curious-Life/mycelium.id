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

import { createHash } from "node:crypto";
import { localInfer, localStream, DEFAULT_OLLAMA_URL, DEFAULT_LOCAL_MODEL } from "./local.js";
import { cloudInfer, cloudStream } from "./cloud.js";
import { InferenceError } from "./errors.js";
import { planGeneration, estimateTokens } from "./token-budget.js";

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
  onEgress,
  onUsage,
  cloudFallbackToLocal = true,
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

  // §12 token-usage accounting — enrich a backend's raw {inputTokens,outputTokens}
  // with provider/model/jurisdiction/area + an estimate fallback, then forward to
  // the user's onUsage sink. Counts only, never content. Fail-soft.
  function emitUsage({ prompt, text, raw, area, isLocal, model, provider }) {
    if (typeof onUsage !== "function") return;
    try {
      const inOk = Number.isFinite(raw?.inputTokens) && raw.inputTokens > 0;
      const outOk = Number.isFinite(raw?.outputTokens) && raw.outputTokens > 0;
      onUsage({
        area, isLocal,
        provider: provider || (isLocal ? "local" : providerLabel()),
        model: model || (isLocal ? cfg.localModel : cfg.cloudModel) || null,
        jurisdiction: isLocal ? "local" : cloudJurisdiction(),
        inputTokens: inOk ? raw.inputTokens : estimateTokens(prompt),
        outputTokens: outOk ? raw.outputTokens : estimateTokens(String(text ?? "")),
        estimated: !(inOk && outOk),
      });
    } catch { /* accounting must never break inference */ }
  }

  async function runLocal({ prompt, maxTokens, numCtx, format, area }) {
    let raw = null;
    const text = await localInfer({ prompt, maxTokens, numCtx, format, model: cfg.localModel, baseUrl: cfg.ollamaUrl, fetch: cfg.fetch, timeoutMs: cfg.timeoutMs, onUsage: (u) => { raw = u; } });
    emitUsage({ prompt, text, raw, area, isLocal: true });
    return text;
  }

  async function runCloud({ prompt, maxTokens, area }) {
    let raw = null;
    const text = await cloudInfer({
      prompt, maxTokens,
      anthropicApiKey: cfg.anthropicApiKey,
      openaiApiKey: cfg.openaiApiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.cloudModel,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
      onUsage: (u) => { raw = u; },
    });
    emitUsage({ prompt, text, raw, area, isLocal: false });
    return text;
  }

  async function* runLocalStream({ prompt, maxTokens, area }) {
    let raw = null;
    // Accumulate the streamed deltas so the usage estimate has the real output text
    // to fall back on when the provider doesn't report counts (token-budget §12).
    let acc = "";
    for await (const delta of localStream({ prompt, maxTokens, model: cfg.localModel, baseUrl: cfg.ollamaUrl, fetch: cfg.fetch, timeoutMs: cfg.timeoutMs, onUsage: (u) => { raw = u; } })) {
      acc += delta; yield delta;
    }
    emitUsage({ prompt, text: acc, raw, area, isLocal: true });
  }

  async function* runCloudStream({ prompt, maxTokens, area }) {
    let raw = null;
    let acc = "";
    for await (const delta of cloudStream({
      prompt, maxTokens,
      anthropicApiKey: cfg.anthropicApiKey,
      openaiApiKey: cfg.openaiApiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.cloudModel,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
      onUsage: (u) => { raw = u; },
    })) {
      acc += delta; yield delta;
    }
    emitUsage({ prompt, text: acc, raw, area, isLocal: false });
  }

  // The active provider's effective jurisdiction (the privacy-relevant fact),
  // set by the resolver (resolve.js); default us-standard (fail-safe).
  const cloudJurisdiction = () => cfg.jurisdiction || "us-standard";

  function providerLabel() {
    if (cfg.anthropicApiKey) return "anthropic";
    if (cfg.baseUrl) { try { return new URL(cfg.baseUrl).hostname; } catch { return "custom"; } }
    return "openai";
  }

  // §4e egress audit — fire-and-forget; sha256 hash + length ONLY, NEVER the
  // prompt. An onEgress/audit failure must never break or block inference.
  function emitEgress(prompt, decision, reason) {
    if (typeof onEgress !== "function") return;
    try {
      onEgress({
        provider: providerLabel(),
        jurisdiction: cloudJurisdiction(),
        model: cfg.cloudModel,
        contentHash: createHash("sha256").update(String(prompt)).digest("hex"),
        contentLength: String(prompt).length,
        decision,
        reason,
      });
    } catch { /* audit must never break inference */ }
  }

  /**
   * Route + run an inference task.
   * @param {object} req
   * @param {string} req.prompt
   * @param {'summarize'|'classify'|'extract'|'narrate'|'complex'} [req.task='summarize']
   * @param {number} [req.maxTokens]
   * @param {boolean} [req.sensitive=false]  §4g hard-block: sensitive content
   *   NEVER egresses to a US provider — it falls back to on-box local instead.
   * @returns {Promise<string>}
   */
  async function infer({ prompt, task = "summarize", maxTokens, sensitive = false, numCtx, format, profile } = {}) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new InferenceError("infer: prompt must be a non-empty string");
    }
    if (!TASKS.includes(task)) {
      throw new InferenceError(`infer: unknown task ${JSON.stringify(task)} (valid: ${TASKS.join(", ")})`);
    }

    // Model-aware auto-sizing (opt-in): when the caller passes a ModelProfile and
    // leaves maxTokens/numCtx unset, size both to the model's real limits +
    // this prompt. Back-compat: no profile, or explicit values, → unchanged.
    if (profile) {
      const plan = planGeneration(profile, { inputTokens: estimateTokens(prompt), task, requestedMaxTokens: maxTokens });
      if (maxTokens == null) maxTokens = plan.maxTokens;
      if (numCtx == null) numCtx = plan.numCtx;
    }

    if (CLOUD_TASKS.includes(task) && hasCloud()) {
      // §4g sensitive hard-block: sensitive content must not leave to a US
      // provider. Fail closed to on-box local (the private path) + audit the
      // denial. eu-zdr / local providers are unaffected.
      if (sensitive && /^us/.test(cloudJurisdiction())) {
        emitEgress(prompt, "denied", "sensitive_us_block");
        return runLocal({ prompt, maxTokens, numCtx, format, area: task });
      }
      try {
        emitEgress(prompt, "allowed");
        return await runCloud({ prompt, maxTokens, area: task }); // cloud models carry large context; numCtx is local-only
      } catch (cloudErr) {
        // cloudFallbackToLocal:false (cascade mode) propagates the error so the
        // caller can try the NEXT provider; otherwise resilience → on-box local.
        if (!cloudFallbackToLocal) throw cloudErr;
        try {
          return await runLocal({ prompt, maxTokens, numCtx, format, area: task });
        } catch (localErr) {
          throw new InferenceError("infer: cloud failed and local fallback failed", { cause: localErr, backend: "both" });
        }
      }
    }

    // Simple tasks, or complex with no cloud configured → local.
    return runLocal({ prompt, maxTokens, numCtx, format, area: task });
  }

  /**
   * Streaming variant of infer — yields text deltas. SAME routing + §4g sensitive
   * hard-block + egress-audit semantics as infer(): audits the egress ONCE before
   * the cloud attempt, falls back to local on a PRE-token cloud failure, and
   * (since a provider can't be swapped mid-stream) rethrows a post-token failure.
   * @param {object} req  same shape as infer()
   * @returns {AsyncGenerator<string>}
   */
  async function* inferStream({ prompt, task = "summarize", maxTokens, sensitive = false } = {}) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new InferenceError("inferStream: prompt must be a non-empty string");
    }
    if (!TASKS.includes(task)) {
      throw new InferenceError(`inferStream: unknown task ${JSON.stringify(task)} (valid: ${TASKS.join(", ")})`);
    }

    if (CLOUD_TASKS.includes(task) && hasCloud()) {
      if (sensitive && /^us/.test(cloudJurisdiction())) {
        emitEgress(prompt, "denied", "sensitive_us_block");
        yield* runLocalStream({ prompt, maxTokens, area: task });
        return;
      }
      emitEgress(prompt, "allowed");
      let started = false;
      try {
        for await (const delta of runCloudStream({ prompt, maxTokens, area: task })) {
          started = true;
          yield delta;
        }
        return;
      } catch (cloudErr) {
        if (!started && cloudFallbackToLocal) { yield* runLocalStream({ prompt, maxTokens, area: task }); return; }
        throw cloudErr;
      }
    }

    yield* runLocalStream({ prompt, maxTokens, area: task });
  }

  return {
    infer,
    inferStream,
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
