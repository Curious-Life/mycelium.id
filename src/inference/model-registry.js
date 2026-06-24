// src/inference/model-registry.js — curated, dated table of REAL per-model limits.
//
// The catalog (src/hardware/catalog.json) reports a uniform `ctx: 8192` placeholder
// for every local model and carries no max-output field; cloud model limits live
// nowhere. This is the one place that knows the actual numbers. For LOCAL models the
// runtime probe (model-profile.js → /api/show) is authoritative when reachable and
// this table is only the fallback; for CLOUD models this table IS the source of truth.
//
// 🚩 Staleness: provider limits drift — keep this dated + refreshed per release, the
// same discipline as presets.js. An UNKNOWN model falls through to the class default
// in model-profile.js (never an over-large guess), so a missing row degrades safely.
//
// Numbers verified against provider docs as of 2026-06. contextWindow = total input
// tokens accepted; maxOutput = hard cap on a single generation.

export const MODEL_REGISTRY = Object.freeze({
  // ── Anthropic (Claude) ──────────────────────────────────────────────────────
  'claude-opus-4-8':    { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-opus-4-7':    { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-opus-4-6':    { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-sonnet-4-6':  { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-sonnet-4-5':  { contextWindow: 200_000, maxOutput: 64_000, family: 'claude' },
  'claude-haiku-4-5':   { contextWindow: 200_000, maxOutput: 32_000, family: 'claude' },
  // ── OpenAI ──────────────────────────────────────────────────────────────────
  'gpt-4o':             { contextWindow: 128_000, maxOutput: 16_384, family: 'gpt' },
  'gpt-4o-mini':        { contextWindow: 128_000, maxOutput: 16_384, family: 'gpt' },
  'gpt-4.1':            { contextWindow: 1_000_000, maxOutput: 32_768, family: 'gpt' },
  'o3':                 { contextWindow: 200_000, maxOutput: 100_000, family: 'gpt' },
  // ── Common local families (FALLBACK ONLY — the /api/show probe overrides these
  //    with the model's real context_length when Ollama is reachable). Output has
  //    no separate cap on Ollama; a conservative ceiling is applied in profile.
  'llama3.1':           { contextWindow: 128_000, maxOutput: 4_096, family: 'llama' },
  'llama3.2':           { contextWindow: 128_000, maxOutput: 4_096, family: 'llama' },
  'gemma3':             { contextWindow: 128_000, maxOutput: 8_192, family: 'gemma' },
  'gemma2':             { contextWindow: 8_192,   maxOutput: 4_096, family: 'gemma' },
  'qwen3':              { contextWindow: 40_960,  maxOutput: 8_192, family: 'qwen' },
  'qwen2.5':            { contextWindow: 32_768,  maxOutput: 8_192, family: 'qwen' },
  'phi4':               { contextWindow: 16_384,  maxOutput: 4_096, family: 'phi' },
  'mistral':            { contextWindow: 32_768,  maxOutput: 8_192, family: 'mistral' },
});

export const REGISTRY_META = Object.freeze({ updated: '2026-06', count: Object.keys(MODEL_REGISTRY).length });

/**
 * Look up a model's limits by id. Tries the exact id, then a family-prefix match
 * (so `gemma3:27b`, `gemma3:12b-it-q4_K_M`, `gemma3-custom` all resolve to the
 * `gemma3` row), longest-prefix-wins. Returns null on no match.
 * @param {string} modelId
 * @returns {{contextWindow:number, maxOutput:number, family:string}|null}
 */
export function lookupModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const id = modelId.toLowerCase().trim();
  if (MODEL_REGISTRY[id]) return MODEL_REGISTRY[id];
  // family-prefix: strip an Ollama tag (`:8b`, `:q4`) and match the longest key
  // that the id starts with — avoids `gpt-4` shadowing `gpt-4o` by preferring length.
  let best = null, bestLen = -1;
  for (const key of Object.keys(MODEL_REGISTRY)) {
    if ((id === key || id.startsWith(key)) && key.length > bestLen) { best = MODEL_REGISTRY[key]; bestLen = key.length; }
  }
  return best;
}

export default MODEL_REGISTRY;
