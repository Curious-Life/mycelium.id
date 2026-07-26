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
// contextWindow = total input tokens accepted; maxOutput = hard cap on a single
// SYNCHRONOUS generation.
//
// ⚠️ PROVENANCE IS STILL MIXED — do not read this header as "every number is current".
//   • CLOUD rows (claude-*, gpt-*, o3): verified against provider docs on 2026-07-26
//     (Anthropic models overview; OpenAI per-model pages). This is what the 2026-07
//     refresh covered, and it is what `verify:model-sizing`'s CLOUD_LIMITS table pins.
//     The mixed-provenance warning D-074 left here is retired FOR THESE ROWS ONLY —
//     the `-5` family no longer carries unverified sibling-guess values.
//   • LOCAL rows (llama*, gemma*, qwen*, phi4, mistral): NOT re-verified. They are
//     untouched by that refresh and remain best-effort fallbacks sourced from
//     src/hardware/catalog.json, not from any vendor doc. They only matter when the
//     /api/show probe is unreachable, and at least one is known-rounded: `gemma3`
//     says 128_000 where this very repo's probe fixture (verify-model-sizing.mjs P2)
//     uses the real 131_072. Correcting the local rows is outstanding work.
//
// ⚠️ SCOPE OF THE CLOUD NUMBERS — they are the model's documented limits on the
// provider's own API. They are NOT a per-deployment guarantee: a subscription tier, a
// Bedrock/Vertex region, or a batch-only beta can each cap lower or higher (e.g. the
// Batches API raises Opus/Sonnet output to 300k behind `output-300k-2026-03-24`, which
// this table deliberately does NOT encode — nothing here issues batch requests).
// NOTE there is currently NO narrowing layer: model-profile.js applies these rows to the
// subscription (OAuth) path identically to the API-key path. If a subscription tier turns
// out to enforce a narrower window, the failure moves from "safely under-sized" to a
// provider 400 — that would need a real per-provider clamp in model-profile.js, which
// does not exist today. Under-sizing was the old bug; this is the new exposure.

export const MODEL_REGISTRY = Object.freeze({
  // ── Anthropic (Claude) ──────────────────────────────────────────────────────
  // The whole current Opus/Sonnet generation is 1M window / 128k output. Only
  // Haiku 4.5 and the pre-4.6 Sonnet line remain at the old 200k/64k shape.
  // These rows ALL read 200_000/64_000 until 2026-07 — a carry-over from the 200k
  // era that survived because under-sizing fails safe: it never errored, it just
  // budgeted every cloud prompt against a fifth of the window the model actually
  // has, and tripped src/agent/compaction.js ~5× earlier than needed.
  //
  // The `-5` rows additionally serve D-074: `claude-sonnet-5` and `claude-fable-5`
  // were previously asserted ONLY by a roster hardcoded in AISettings.svelte, which
  // D-074 deleted. The subscription picker's OFFLINE fallback now derives from THIS
  // table (model-catalog.js fallbackModelsFor), so without these rows a vault whose
  // OAuth token cannot list models would be offered a SMALLER set than before that
  // fix — a user running Sonnet 5 could not re-select it. D-074 landed them with
  // conservative sibling values and flagged the refresh as outstanding; this is that
  // refresh, so they now carry their own verified figures. The LIVE list remains
  // authoritative for what a picker OFFERS; this table is authoritative for LIMITS.
  'claude-opus-5':      { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-sonnet-5':    { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-fable-5':     { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-opus-4-8':    { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-opus-4-7':    { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-opus-4-6':    { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-sonnet-4-6':  { contextWindow: 1_000_000, maxOutput: 128_000, family: 'claude' },
  'claude-sonnet-4-5':  { contextWindow: 200_000,   maxOutput: 64_000,  family: 'claude' },
  // Haiku 4.5 is the one current model still at 200k, and its output cap is 64k —
  // the 32_000 that was here understated it by half.
  'claude-haiku-4-5':   { contextWindow: 200_000,   maxOutput: 64_000,  family: 'claude' },
  // ── OpenAI ──────────────────────────────────────────────────────────────────
  'gpt-4o':             { contextWindow: 128_000, maxOutput: 16_384, family: 'gpt' },
  'gpt-4o-mini':        { contextWindow: 128_000, maxOutput: 16_384, family: 'gpt' },
  // 1_047_576 is the exact documented figure, not a rounded 1M (the old value here).
  'gpt-4.1':            { contextWindow: 1_047_576, maxOutput: 32_768, family: 'gpt' },
  'o3':                 { contextWindow: 200_000, maxOutput: 100_000, family: 'gpt' },
  // ── Common local families (FALLBACK ONLY — the /api/show probe overrides these
  //    with the model's real context_length when Ollama is reachable). Output has
  //    no separate cap on Ollama; a conservative ceiling is applied in profile.
  'llama3.1':           { contextWindow: 128_000, maxOutput: 4_096, family: 'llama' },
  'llama3.2':           { contextWindow: 128_000, maxOutput: 4_096, family: 'llama' },
  'gemma3':             { contextWindow: 128_000, maxOutput: 8_192, family: 'gemma' },
  'gemma2':             { contextWindow: 8_192,   maxOutput: 4_096, family: 'gemma' },
  // ⚠️ qwen3.5 MUST precede a qwen3 prefix-match: `qwen3.5:4b` starts with `qwen3`, so
  // WITHOUT this row lookupModel() resolves it to the qwen3 row (40960) — a 5× overstatement
  // of the catalog's real 8192 window (src/hardware/catalog.json), which oversizes num_ctx
  // for every prompt the moment the model loads on a runtime where the /api/show probe is
  // unreachable (the registry is the fallback). longest-prefix-wins picks `qwen3.5` (len 7)
  // over `qwen3` (len 5). Output mirrors the gemma2 8192-window row (half the window).
  'qwen3.5':            { contextWindow: 8_192,   maxOutput: 4_096, family: 'qwen' },
  'qwen3':              { contextWindow: 40_960,  maxOutput: 8_192, family: 'qwen' },
  'qwen2.5':            { contextWindow: 32_768,  maxOutput: 8_192, family: 'qwen' },
  'phi4':               { contextWindow: 16_384,  maxOutput: 4_096, family: 'phi' },
  'mistral':            { contextWindow: 32_768,  maxOutput: 8_192, family: 'mistral' },
});

export const REGISTRY_META = Object.freeze({ updated: '2026-07', count: Object.keys(MODEL_REGISTRY).length });

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
