// src/hardware/fit.js — does a model fit this machine? (S6 "Cookbook" core.)
//
// A model's memory footprint is COMPUTED (weights + KV-cache + overhead), not
// looked up from a brittle static "≥24GB→70B" tier table — so it stays correct
// across quantisation levels and context lengths.
//
// The formula, the bytes-per-param table, and the ratio fit-score are borrowed
// from the odysseus project's `hwfit` library (services/hwfit/{models,fit}.py),
// MIT-licensed (Copyright (c) 2025 Odysseus Contributors), reimplemented here in
// JS. MIT permits this with attribution; this header is that attribution.

// Bytes-per-parameter by quantisation (odysseus QUANT_BPP). Q4_K_M is the Ollama
// default and our catalog default.
export const QUANT_BPP = Object.freeze({
  F16: 2.0, FP16: 2.0, BF16: 2.0,
  FP8: 1.0, Q8_0: 1.05, Q6_K: 0.8, Q5_K_M: 0.68,
  Q4_K_M: 0.58, Q4_0: 0.56, Q3_K_M: 0.48, Q2_K: 0.37,
  'AWQ-4bit': 0.5, 'GPTQ-Int4': 0.5, 'mlx-4bit': 0.55,
});

const DEFAULT_BPP = 0.58; // Q4_K_M — the safe default when a quant is unknown.

/**
 * Estimate a model's RAM/VRAM footprint in GB.
 *   weights = paramsB × bytes-per-param
 *   kv-cache ≈ 0.000008 × activeParamsB × ctx   (MoE uses active, not total)
 *   + 0.5 GB runtime overhead
 * (odysseus `estimate_memory_gb`).
 * @param {number} paramsB     total parameters, in billions
 * @param {string} quant       a QUANT_BPP key (default Q4_K_M)
 * @param {number} ctx         context length in tokens
 * @param {number} [kvParamsB] active params for the KV term (default = paramsB)
 */
export function estimateMemoryGb(paramsB, quant = 'Q4_K_M', ctx = 8192, kvParamsB = paramsB) {
  const bpp = QUANT_BPP[quant] ?? DEFAULT_BPP;
  const weights = Number(paramsB) * bpp;
  const kv = 0.000008 * Number(kvParamsB) * Number(ctx);
  return Math.round((weights + kv + 0.5) * 10) / 10;
}

/**
 * Ratio fit-score 0–100 (odysseus `_fit_score`). Rewards "right-sizing":
 * using ~50–80% of available memory scores 100; tiny models waste capacity
 * (lower); >100% does not fit (0).
 */
export function fitScore(requiredGb, availableGb) {
  if (!(availableGb > 0)) return 0;
  if (requiredGb > availableGb) return 0;
  const ratio = requiredGb / availableGb;
  if (ratio <= 0.5) return Math.round(60 + (ratio / 0.5) * 40);
  if (ratio <= 0.8) return 100;
  if (ratio <= 0.9) return 70;
  return 50;
}

/** Discrete fit level derived from the score (for UI badges). */
export function fitLevel(requiredGb, availableGb) {
  const s = fitScore(requiredGb, availableGb);
  if (s === 0) return 'too_tight';
  if (s >= 90) return 'perfect';
  if (s >= 60) return 'good';
  return 'marginal';
}

export default { QUANT_BPP, estimateMemoryGb, fitScore, fitLevel };
