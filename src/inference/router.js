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
import { isSensitiveTask } from "./sensitivity.js";
import { jurisdictionForBaseUrl } from "./presets.js";
import { localInfer, localStream, DEFAULT_OLLAMA_URL, DEFAULT_LOCAL_MODEL } from "./local.js";
import { cloudInfer, cloudStream } from "./cloud.js";
import { InferenceError } from "./errors.js";
import { planGeneration, estimateTokens } from "./token-budget.js";

export const LOCAL_TASKS = Object.freeze(["summarize", "classify", "extract"]);
export const CLOUD_TASKS = Object.freeze(["narrate", "complex"]);
export const TASKS = Object.freeze([...LOCAL_TASKS, ...CLOUD_TASKS]);

// Size a LOCAL Ollama context window to hold the prompt PLUS the output, so the
// model never silently truncates the INPUT at Ollama's ~4096 default (the tail
// of a long prompt is dropped before the model ever sees it — invisible, unlike
// the output cap). Used only when no profile-driven numCtx was supplied. Grows
// with the actual prompt (proportional, not a blanket large allocation) and is
// capped so a pathological prompt can't blow up the KV cache; Ollama itself
// clamps to the model's trained max. Floor at 4096 so we never SHRINK the window.
const NUMCTX_CEILING = Math.max(8192, Number(process.env.MYCELIUM_LOCAL_NUMCTX_CEILING) || 32768);
function autoNumCtx(prompt, maxTokens) {
  const out = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1024;
  const want = estimateTokens(String(prompt || "")) + out + 512; // prompt + output + margin
  const rounded = Math.ceil(want / 2048) * 2048;                  // round up to a clean window
  return Math.min(NUMCTX_CEILING, Math.max(4096, rounded));
}

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
 * @param {boolean} [opts.requireApprovedLocal=false]  CONSENT MODE (increment M, #148):
 *   treat `localModel` as an APPROVAL rather than a hint. When true, `localModel` is used
 *   verbatim with NO coalesce, and every local path refuses with a typed InferenceError
 *   (code 'no-approved-local-model') when it is null/empty. Default false → the coalesce
 *   below is unchanged, so existing callers behave byte-identically.
 */
export function createInferenceRouter({
  fetch = globalThis.fetch,
  ollamaUrl,
  localModel,
  requireApprovedLocal = false,
  anthropicApiKey,
  claudeOAuthToken,
  openaiApiKey,
  cloudModel,
  baseUrl,
  jurisdiction,
  sensitiveUsExempt = false,
  localFallback = false,
  onEgress,
  onUsage,
  onCloudFallback,
  cloudFallbackToLocal = true,
  timeoutMs = 60000,
  env = process.env,
} = {}) {
  // ⚠️ LOCAL-ONLY ROUTER (the cascade's guaranteed on-box floor, resolve.js#resolveProviderChain).
  // `localFallback` means "this element exists to run on-box, and MUST NOT egress". The env
  // coalescing below is the reason this flag has to exist: a chain element that merely OMITS
  // its key fields gets a stray process-env key promoted INTO it (`undefined ?? env.X` → env.X),
  // which silently turns the floor into a cloud provider. Note that supplying `null` keys would
  // NOT have helped — `??` coalesces on null too; only '' blocks it. So the floor cannot defend
  // itself with data alone, and the router must honour the flag structurally.
  const localOnly = localFallback === true;
  const cfg = {
    fetch,
    ollamaUrl: ollamaUrl || env.OLLAMA_URL || DEFAULT_OLLAMA_URL,
    // ⚠️ THIS COALESCE IS FAIL-OPEN, AND THAT IS WHY requireApprovedLocal EXISTS. `|| env
    // .LOCAL_MODEL || DEFAULT_LOCAL_MODEL` means a caller that passes localModel:null —
    // the shape a FAIL-CLOSED resolver returns for "the owner approved nothing" (#148's
    // defaultLabelModel) — silently gets llama3.1, a heavy 8B nobody approved. So "pass the
    // fail-closed resolver's null" is NOT, on its own, a fix at this seam: it converts an
    // unapproved qwen3.5:4b into an unapproved llama3.1. Consent-bearing callers set
    // requireApprovedLocal and get no coalesce + a refusal (runLocal below).
    //
    // This is not the only fail-open default on the local path: local.js also coalesces
    // `model = DEFAULT_LOCAL_MODEL`, so a null that got past assertLocalApproved() would
    // still land on llama3.1 down there. assertLocalApproved() is therefore the ONLY thing
    // standing between a null and an unapproved run — keep it at the head of every local
    // entry point rather than relying on a null propagating harmlessly. It would not.
    localModel: requireApprovedLocal ? (localModel || null) : (localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL),
    // Layer 1 of 2 (CLAUDE.md §2): a local-only router HAS no cloud credentials — not even a
    // promoted env one. Strips the CAPABILITY, so even a mis-routed call cannot reach a provider
    // (cloudInfer throws "no cloud provider configured" instead of dialling out).
    anthropicApiKey: localOnly ? "" : (anthropicApiKey ?? env.ANTHROPIC_API_KEY),
    claudeOAuthToken: localOnly ? "" : claudeOAuthToken, // Claude subscription OAuth token (sk-ant-oat…) — no env fallback (import-only)
    openaiApiKey: localOnly ? "" : (openaiApiKey ?? env.OPENAI_API_KEY),
    cloudModel: cloudModel || env.INFERENCE_CLOUD_MODEL, // undefined → backend default
    baseUrl: localOnly ? "" : (baseUrl ?? env.INFERENCE_BASE_URL), // OpenAI-compatible endpoint (Regolo/OpenRouter/Ollama/…)
    localOnly,
    jurisdiction, // 'local'|'eu-zdr'|'us-zdr'|'us-standard' — tag for the egress policy (§4g)
    // §4g exemption: ONLY set by resolve.js for the user's own Claude subscription
    // when they've explicitly opted in (allowSubscriptionSensitive). Lets sensitive
    // content reach THIS provider despite its US jurisdiction. Never set for a plain
    // US API key — so the §4g floor still holds for everything else.
    sensitiveUsExempt: sensitiveUsExempt === true,
    timeoutMs,
  };

  // Cloud is "available" when a key, a subscription token, OR an OpenAI-compatible
  // base_url is set (some local/self-hosted base_url servers are keyless).
  //
  // Layer 2 of 2 (CLAUDE.md §2): a local-only router never takes the cloud BRANCH. This is
  // deliberately independent of the credential-stripping above — that one removes the ability
  // to reach a provider, this one removes the decision to try. Either alone closes the hole;
  // both are kept so a future edit to one does not silently reopen it.
  const hasCloud = () => (cfg.localOnly ? false : Boolean(cfg.anthropicApiKey || cfg.claudeOAuthToken || cfg.openaiApiKey || cfg.baseUrl));

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

  // THE consent chokepoint. Local is reachable THREE ways — the cloud-failure fallback
  // (infer), the §4g sensitive-US block (infer), and "no cloud configured" (infer's tail) —
  // and only the first is governed by cloudFallbackToLocal. Gating them individually would
  // leave the other two open (the §4g block is the silent one: it does not even emit a
  // cloud-fallback notice). So the gate lives HERE, where all three converge: one function
  // every local execution must pass through. Defense in depth (CLAUDE.md §2), and fail-closed
  // (§3) — no model ⇒ refuse, never substitute a default.
  function assertLocalApproved() {
    if (!requireApprovedLocal) return;
    if (typeof cfg.localModel === "string" && cfg.localModel.trim()) return;
    throw new InferenceError(
      "infer: no on-box model is approved for this task — refusing to run an unapproved model",
      // status 503 (#169): a consent refusal is "not configured", not a server fault —
      // the REST layer renders an honest 503 instead of a generic 500.
      { backend: "local", code: "no-approved-local-model", status: 503 },
    );
  }

  async function runLocal({ prompt, maxTokens, numCtx, format, area, onTruncated }) {
    assertLocalApproved();
    let raw = null;
    const ctx = numCtx ?? autoNumCtx(prompt, maxTokens);   // never leave Ollama at its ~4096 default
    const text = await localInfer({ prompt, maxTokens, numCtx: ctx, format, model: cfg.localModel, baseUrl: cfg.ollamaUrl, fetch: cfg.fetch, timeoutMs: cfg.timeoutMs, onUsage: (u) => { raw = u; }, onTruncated });
    emitUsage({ prompt, text, raw, area, isLocal: true });
    return text;
  }

  async function runCloud({ prompt, maxTokens, area, onTruncated, noThink }) {
    let raw = null;
    const text = await cloudInfer({
      prompt, maxTokens,
      anthropicApiKey: cfg.anthropicApiKey,
      claudeOAuthToken: cfg.claudeOAuthToken,
      openaiApiKey: cfg.openaiApiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.cloudModel,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
      onUsage: (u) => { raw = u; },
      onTruncated,
      noThink,
    });
    emitUsage({ prompt, text, raw, area, isLocal: false });
    return text;
  }

  async function* runLocalStream({ prompt, maxTokens, numCtx, area, onTruncated }) {
    assertLocalApproved(); // same gate as runLocal — inferStream has the same three local paths
    let raw = null;
    const ctx = numCtx ?? autoNumCtx(prompt, maxTokens);   // size the window or Ollama silently truncates the prompt at ~4096
    // Accumulate the streamed deltas so the usage estimate has the real output text
    // to fall back on when the provider doesn't report counts (token-budget §12).
    let acc = "";
    for await (const delta of localStream({ prompt, maxTokens, numCtx: ctx, model: cfg.localModel, baseUrl: cfg.ollamaUrl, fetch: cfg.fetch, timeoutMs: cfg.timeoutMs, onUsage: (u) => { raw = u; }, onTruncated })) {
      acc += delta; yield delta;
    }
    emitUsage({ prompt, text: acc, raw, area, isLocal: true });
  }

  async function* runCloudStream({ prompt, maxTokens, area, onTruncated }) {
    let raw = null;
    let acc = "";
    for await (const delta of cloudStream({
      prompt, maxTokens,
      anthropicApiKey: cfg.anthropicApiKey,
      claudeOAuthToken: cfg.claudeOAuthToken,
      openaiApiKey: cfg.openaiApiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.cloudModel,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
      onUsage: (u) => { raw = u; },
      onTruncated,
    })) {
      acc += delta; yield delta;
    }
    emitUsage({ prompt, text: acc, raw, area, isLocal: false });
  }

  // Does a CLOUD call from this router go somewhere the 'local' tag can honestly describe?
  // Mirrors cloudInfer's own precedence (cloud.js: an Anthropic key/token WINS over baseUrl, so
  // a loopback baseUrl next to a key is NOT local) — the point is to answer the question the
  // WIRE answers, not the one the config claims. `''`/absent baseUrl + a key → a public API.
  //
  // ⚠️ It asks jurisdictionForBaseUrl — the SAME function that MINTED the tag — rather than
  // re-deciding "is this local?" with its own predicate. A first draft called isLoopbackUrl
  // directly and that was wrong: jurisdictionForBaseUrl grants 'local' on `isLoopbackUrl(url)
  // || host.endsWith('.local')`, so mirroring only the loopback half made every mDNS-addressed
  // LAN model (https://mymac.local:11434) disagree with its own tag — §4g refused the user's own
  // Ollama and audited that LAN box as us-standard (independent review, MED-1). Two predicates
  // deciding one fact will drift; asking the minting function makes divergence impossible
  // instead of merely fixed.
  //
  // NOTE this deliberately does NOT re-litigate whether '.local' should count as local — that
  // is presets.js's call, it applies to the tag everywhere, and changing it here would silently
  // fork the definition again. A LAN box is arguably not "on-box"; it is, however, definitely
  // not a US cloud, which is what §4g is about. Flagged for an explicit operator decision.
  const cloudDestinationIsOnBox = () => {
    if (cfg.anthropicApiKey || cfg.claudeOAuthToken) return false;            // → api.anthropic.com
    if (cfg.baseUrl) return jurisdictionForBaseUrl(cfg.baseUrl) === "local";  // → host-parsed (presets.js)
    return false;                                                             // → api.openai.com
  };

  // The active provider's effective jurisdiction (the privacy-relevant fact), set by the
  // resolver (resolve.js); default us-standard (fail-safe).
  //
  // ⚠️ THIS IS AN AUDIT-TRUTHFULNESS BOUNDARY, not a formatter. Every surface that reports the
  // jurisdiction OF A CLOUD CALL goes through here — emitEgress (§4e), emitUsage (§12, cloud
  // branch only), emitCloudFallback — and so does the §4g hard block below. One chokepoint, so
  // the property is enforced in a single place instead of re-asserted at each call site.
  //
  // ⚠️ SCOPE, stated precisely — this function does NOT make the tag universally true, and two
  // independent reviews caught an earlier comment here claiming that it did:
  //   · It validates a 'local' tag against the destination. It does NOT re-derive 'eu-zdr' /
  //     'us-zdr', which resolve.js sets from the base_url. A row lying in THAT direction is
  //     unreachable from any DB row today (mapRowToConfig's Anthropic branches force
  //     us-standard and require no base_url; the OpenAI-compat branch forces anthropicApiKey:'')
  //     — proven, not assumed. Generalising the check would also downgrade a legitimate 'us-zdr'
  //     to 'us-standard', trading one mislabel for another, so it is deliberately not done here.
  //   · It describes the FIRST HOP. A loopback base_url that 302s off-box still audits as
  //     'local' (base-url.js:74 trusts loopback and hands back a redirect-following fetch).
  //     PRE-EXISTING on main, needs an attacker-controlled on-box listener; noted, not fixed
  //     here — the honest scope of this fix is the tag, not the redirect chain.
  //
  // NOT `config.jurisdiction` (the diagnostics snapshot below), which deliberately reports the
  // RAW configured tag: it describes the config, not a call, and it has no consumers. Routing
  // it through here would be actively worse — a local-only router makes no cloud call at all,
  // so it would report the fail-safe 'us-standard' for a box that never dials out.
  //
  // The tag alone cannot be trusted: `{jurisdiction:'local'}` on a router that dials
  // api.anthropic.com made the egress row SAY 'local' while the prompt went to the US, and made
  // /^us/ fail so §4g never fired. A 'local' tag is therefore only honoured when the destination
  // really is on-box; otherwise we fail safe to us-standard (assume Cloud Act exposure).
  // This must NOT be a blanket "'local' → 'us-standard'": Ollama/LM Studio are legitimately
  // configured as `jurisdiction:'local'` WITH a loopback baseUrl (presets.js), and coercing
  // those would make §4g refuse the user's own on-box model — a false positive that pushes
  // sensitive work off the private path.
  const cloudJurisdiction = () => {
    const tag = cfg.jurisdiction || "us-standard";
    if (tag === "local" && !cloudDestinationIsOnBox()) return "us-standard";
    return tag;
  };

  function providerLabel() {
    if (cfg.anthropicApiKey || cfg.claudeOAuthToken) return "anthropic";
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

  // A cloud task the user EXPLICITLY routed to a provider failed → we're about to
  // fall back to on-box. Surface it (never silent): one content-free log line +
  // the onCloudFallback sink (the UI/activity-feed turns this into "Narration:
  // <provider>/<model> failed — used <localModel> instead"). cloudErr from cloud.js
  // is a status/type only (never prompt/content), so it is safe to log (CLAUDE.md §1).
  function emitCloudFallback(task, err) {
    const status = err && err.status != null ? err.status : null;
    const detail = String(err?.message || err || "cloud error").slice(0, 160);
    try {
      process.stderr.write(
        `[inference] cloud task '${task}' (${providerLabel()} · ${cfg.cloudModel || "default"}) failed${status ? ` ${status}` : ""}: ${detail} — falling back to on-box ${cfg.localModel}\n`,
      );
    } catch { /* logging must never break inference */ }
    if (typeof onCloudFallback !== "function") return;
    try {
      onCloudFallback({ task, provider: providerLabel(), model: cfg.cloudModel || null, jurisdiction: cloudJurisdiction(), localModel: cfg.localModel, status, error: detail });
    } catch { /* sink must never break inference */ }
  }

  /**
   * Route + run an inference task.
   * @param {object} req
   * @param {string} req.prompt
   * @param {'summarize'|'classify'|'extract'|'narrate'|'complex'} [req.task='summarize']
   * @param {number} [req.maxTokens]
   * @param {boolean} [req.sensitive=false]  §4g hard-block: sensitive content
   *   NEVER egresses to a US provider — it falls back to on-box local instead.
   * @param {(info:{reason:string})=>void} [req.onTruncated]  fires (additive,
   *   fail-soft, counts/category only) when the provider stopped at its OUTPUT
   *   CAP (max_tokens / finish_reason:'length' / done_reason:'length') so a caller
   *   can report truncation instead of a false clean stop.
   * @returns {Promise<string>}
   */
  // ⚠️ `sensitive` DEFAULTS FROM THE TASK (sensitivity.js), it is not `false`. It was a
  // per-call flag every caller had to remember, and the one caller that mattered —
  // pipeline/lib/narrate-infer.js, which narrates the user's mindscape — did not pass it, so
  // the §4g gate below never fired for the content it was written to protect. An explicit
  // argument still wins (the claims paths pass `true` for their own reasons).
  async function infer({ prompt, task = "summarize", maxTokens, sensitive = isSensitiveTask(task), numCtx, format, profile, onTruncated, noThink } = {}) {
    // Structured tasks (narrate → JSON names/chronicles) disable reasoning by default so a
    // thinking model returns the answer in `content` instead of burning the budget on hidden
    // reasoning_content (→ empty content → false failure). Callers may override per call.
    const wantNoThink = noThink ?? (task === "narrate");
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
      // denial. eu-zdr / local providers are unaffected. EXEMPTION: the user's own
      // Claude subscription when they've explicitly opted in (sensitiveUsExempt) —
      // never a plain US API key.
      if (sensitive && /^us/.test(cloudJurisdiction()) && !cfg.sensitiveUsExempt) {
        emitEgress(prompt, "denied", "sensitive_us_block");
        return runLocal({ prompt, maxTokens, numCtx, format, area: task, onTruncated });
      }
      try {
        emitEgress(prompt, "allowed");
        return await runCloud({ prompt, maxTokens, area: task, onTruncated, noThink: wantNoThink }); // cloud models carry large context; numCtx is local-only
      } catch (cloudErr) {
        // cloudFallbackToLocal:false (cascade mode) propagates the error so the
        // caller can try the NEXT provider; otherwise resilience → on-box local.
        if (!cloudFallbackToLocal) throw cloudErr;
        // Don't ANNOUNCE a fallback we won't actually perform. Under consent mode
        // (requireApprovedLocal) an unapproved on-box model refuses, so emitting
        // "cloud failed — used <local> instead" here would be a false notice for a
        // request that served nothing. Check the gate FIRST: if it refuses, surface the
        // refusal (the gateway turns it into an honest 503) with no fallback notice.
        // No-op when requireApprovedLocal is false → the notice path is unchanged.
        assertLocalApproved();
        // HONORED-SELECTION: the user explicitly routed this task to a cloud model.
        // We still fall back to on-box for resilience — but NEVER silently. Surface
        // it (content-free log + onCloudFallback sink) so the UI shows "your model
        // failed, a local one ran instead" rather than the wrong model running unseen.
        emitCloudFallback(task, cloudErr);
        try {
          return await runLocal({ prompt, maxTokens, numCtx, format, area: task, onTruncated });
        } catch (localErr) {
          throw new InferenceError("infer: cloud failed and local fallback failed", { cause: localErr, backend: "both" });
        }
      }
    }

    // Simple tasks, or complex with no cloud configured → local.
    return runLocal({ prompt, maxTokens, numCtx, format, area: task, onTruncated });
  }

  /**
   * Streaming variant of infer — yields text deltas. SAME routing + §4g sensitive
   * hard-block + egress-audit semantics as infer(): audits the egress ONCE before
   * the cloud attempt, falls back to local on a PRE-token cloud failure, and
   * (since a provider can't be swapped mid-stream) rethrows a post-token failure.
   * @param {object} req  same shape as infer()
   * @returns {AsyncGenerator<string>}
   */
  // Same task-derived default as infer() above — the §4g gate below is identical, so its
  // trigger must be too. A default that differs between the two is how one path stays
  // protected while its twin quietly does not (which is exactly what happened).
  async function* inferStream({ prompt, task = "summarize", maxTokens, sensitive = isSensitiveTask(task), onTruncated } = {}) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new InferenceError("inferStream: prompt must be a non-empty string");
    }
    if (!TASKS.includes(task)) {
      throw new InferenceError(`inferStream: unknown task ${JSON.stringify(task)} (valid: ${TASKS.join(", ")})`);
    }

    if (CLOUD_TASKS.includes(task) && hasCloud()) {
      if (sensitive && /^us/.test(cloudJurisdiction()) && !cfg.sensitiveUsExempt) {
        emitEgress(prompt, "denied", "sensitive_us_block");
        yield* runLocalStream({ prompt, maxTokens, area: task, onTruncated });
        return;
      }
      emitEgress(prompt, "allowed");
      let started = false;
      try {
        for await (const delta of runCloudStream({ prompt, maxTokens, area: task, onTruncated })) {
          started = true;
          yield delta;
        }
        return;
      } catch (cloudErr) {
        if (!started && cloudFallbackToLocal) { yield* runLocalStream({ prompt, maxTokens, area: task, onTruncated }); return; }
        throw cloudErr;
      }
    }

    yield* runLocalStream({ prompt, maxTokens, area: task, onTruncated });
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
