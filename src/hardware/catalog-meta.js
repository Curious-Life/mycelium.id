// src/hardware/catalog-meta.js — the CURATED, reviewed-in-repo judgment that the
// generated catalog can't get from Ollama: companion-quality priors, the
// exclusion rules that keep this a *companion* picker, and the EQ-Bench alias
// map. Data only (no I/O), so it's auditable and unit-testable.
//
// WHY this is hand-curated: Ollama's library/registry exposes size, params,
// quant, popularity, recency — but NO emotional-intelligence / warmth signal.
// Companion-suitability for personal growth is fundamentally a human judgment;
// we encode it here (reviewed in PR diffs) and let objective signals only adjust.
// See docs/DYNAMIC-CATALOG-DESIGN-2026-06-05.md §3.

// ── Family-prior warmth (0..1): the dominant companion-quality signal ─────────
// Higher = warmer / more emotionally attuned for a personal companion & self-
// development guide (grounded in EQ-Bench + community consensus, 2026-06).
export const FAMILY_PRIOR = Object.freeze({
  gemma: 0.92,          // warmest; gemma derivatives top EQ-Bench creative writing
  'mistral-nemo': 0.82, // community warm/creative favourite
  nemo: 0.82,
  'command-r': 0.80,    // "optimised for conversational interaction"
  command: 0.80,
  hermes: 0.78,         // OpenHermes — warm, easygoing
  'mistral-small': 0.74,
  llama: 0.72,          // balanced, slightly assistant-coded
  mistral: 0.62,        // dry-ish base
  qwen: 0.60,           // smart but cooler/technical
  yi: 0.60,
  phi: 0.48,            // clinical/STEM, low warmth
});
export const DEFAULT_PRIOR = 0.55; // unknown family — neutral cold-start

// Derive a family key from an Ollama name (`ns/family:tag` → `family`), matched
// against FAMILY_PRIOR by longest prefix so `mistral-nemo` beats `mistral`.
export function familyOf(name) {
  const base = String(name || '').split('/').pop().split(':')[0].toLowerCase();
  let best = null;
  for (const key of Object.keys(FAMILY_PRIOR)) {
    if (base.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best || base;
}
export function familyPrior(name) {
  const key = familyOf(name);
  return FAMILY_PRIOR[key] ?? DEFAULT_PRIOR;
}

// ── Exclusions — keep it a COMPANION picker (hard ×0, not a penalty) ──────────
// Matched against the full lowercased name (incl. namespace + tag).
export const EXCLUDE_PATTERNS = Object.freeze([
  // embeddings / rerankers — not chat
  /embed/, /\bbge\b/, /mxbai/, /minilm/, /arctic-embed/, /\brerank/,
  // code-specialised
  /coder/, /codestral/, /codegemma/, /codellama/, /starcoder/, /-code\b/, /deepseek-coder/,
  // reasoning-trace (visible <think> hurts a chat companion)
  /deepseek-r1/, /\bqwq\b/, /marco-o1/, /-thinking\b/, /reasoning/,
  // base / NSFW-RP / uncensored
  /:base\b/, /uncensored/, /abliterated/, /\bnsfw\b/, /\berotic\b/, /\blewd\b/, /-rp\b/, /\bdolphin\b/,
  // domain-specialist / safety-classifier (not general companions)
  /shield/, /guard\b/, /(?:^|[^a-z])med[a-z]*gemma/, /translate/, /function[a-z]*gemma/, /\bocr\b/, /classifier/,
]);

// NOTE: `vision` is deliberately NOT a disqualifier — strong general chat models
// (gemma3, llama3.2-vision, qwen-vl) carry a vision badge but converse fine, and
// the library's capability badges are sparse (often just one). We only exclude on
// a POSITIVE non-chat signal: the `embedding` capability, plus the name patterns
// above. Absence of a 'completion' badge is NOT treated as exclusion.
export function isExcluded(name, { capabilities = [] } = {}) {
  const n = String(name || '').toLowerCase();
  if (EXCLUDE_PATTERNS.some((re) => re.test(n))) return true;
  if (capabilities.map((c) => String(c).toLowerCase()).includes('embedding')) return true;
  return false;
}

// Community (non-`library/`) models must clear a popularity floor to keep the
// NSFW/junk long-tail out of the reviewed allowlist. Official `library/` bypasses.
export const MIN_COMMUNITY_PULLS = 10_000;

// ── EQ-Bench bonus — measured signal, mapped onto Ollama families ─────────────
// EQ-Bench publishes leaderboard JSON keyed by HF names (e.g. "google/gemma-3-27b-it").
// We can't 1:1 map those to Ollama tags, so the generator passes a parsed
// {hfName: normElo0to1} map and we resolve it to a family-level bonus via this
// alias table (HF-name substring → our family key). Unmatched → 0 bonus.
export const EQ_FAMILY_ALIASES = Object.freeze({
  'gemma-3': 'gemma', 'gemma-4': 'gemma', 'gemma-2': 'gemma',
  'qwen3': 'qwen', 'qwen2.5': 'qwen', 'qwen-3': 'qwen',
  'llama-3': 'llama', 'meta-llama': 'llama',
  'mistral-nemo': 'mistral-nemo', 'mistral-small': 'mistral-small', mistral: 'mistral',
  'c4ai-command-r': 'command-r', 'command-r': 'command-r',
  hermes: 'hermes', phi: 'phi', 'yi-': 'yi',
});

// Reduce a parsed EQ leaderboard ({hfName: normElo}) to a per-family max bonus.
export function eqFamilyBonus(eqData) {
  const out = {};
  for (const [hf, elo] of Object.entries(eqData || {})) {
    const h = String(hf).toLowerCase();
    for (const [alias, fam] of Object.entries(EQ_FAMILY_ALIASES)) {
      if (h.includes(alias)) {
        const v = Number(elo) || 0;
        if (!(fam in out) || v > out[fam]) out[fam] = v;
      }
    }
  }
  return out; // { gemma: 0.93, qwen: 0.71, ... } normalized 0..1
}

// ── companion-quality (0..100) ───────────────────────────────────────────────
// quality = 0 if excluded; else a blend dominated by the curated family prior,
// with measured EQ bonus + recency + log-damped popularity as adjustments.
export function companionQuality(m, { eqBonusByFamily = {} } = {}) {
  if (isExcluded(m.name, m)) return 0;
  const fam = familyOf(m.name);
  const base = FAMILY_PRIOR[fam] ?? DEFAULT_PRIOR;
  const eq = eqBonusByFamily[fam] ?? 0;                 // 0..1 (measured)
  const months = monthsSince(m.updated);
  const recency = months == null ? 0.5 : clamp(1 - months / 24, 0, 1);
  const pulls = Number(m.pulls) || 0;
  const popularity = pulls > 0 ? clamp(Math.log10(pulls) / Math.log10(150e6), 0, 1) : 0;
  const score = 0.62 * base + 0.18 * eq + 0.10 * recency + 0.10 * popularity;
  return Math.round(clamp(score, 0, 1) * 100);
}

// ── bestFor tag (UI) from family + size ──────────────────────────────────────
export function bestFor(name, paramsB) {
  const fam = familyOf(name);
  const warm = (FAMILY_PRIOR[fam] ?? DEFAULT_PRIOR) >= 0.78;
  const cool = (FAMILY_PRIOR[fam] ?? DEFAULT_PRIOR) <= 0.5;
  const p = Number(paramsB) || 0;
  if (p < 3) return 'Fast & light';
  if (cool) return 'Technical / STEM';
  if (fam === 'qwen' || fam === 'yi') return p >= 24 ? 'Analytical (large)' : 'Analytical thinking';
  if (warm) return p >= 24 ? 'Warm, deep companion' : 'Warm companion';
  if (p >= 60) return 'Reflective coaching';
  return 'Balanced companion';
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Parse "12.2B" / "8x7B" / "405B" → billions (number) or null.
export function parseParamsB(modelType) {
  const s = String(modelType || '').trim();
  const moe = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)\s*b/i); // e.g. 8x7B
  if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 10) / 10;
  const m = s.match(/(\d+(?:\.\d+)?)\s*b/i);
  return m ? Number(m[1]) : null;
}

// "Updated 3 months ago" / "1 year ago" → months (number) or null.
export function monthsSince(updated) {
  const s = String(updated || '').toLowerCase();
  const m = s.match(/(\d+)\s*(day|week|month|year)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'day') return n / 30;
  if (unit === 'week') return n / 4.3;
  if (unit === 'month') return n;
  return n * 12;
}
