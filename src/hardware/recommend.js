// src/hardware/recommend.js — rank catalog models by how well they fit the box
// AND how good they are as a warm personal companion / self-development guide.
//
// Pure + deterministic. Given a hardware descriptor (from detect.js) it scores
// every catalog model with the computed fit (fit.js) and returns the FULL list,
// best-first, for the UI to scroll. "Best" blends two axes (design §4.2):
//   • compatibility — does it fit, right-sized? (fit.js)
//   • quality       — companion-suitability: warmth · EQ · reflective depth
//                     (catalog.js `quality`, grounded in EQ-Bench; NOT generic
//                     capability — we rank for personal growth, not coding).
//
// The composite mirrors odysseus/llmfit's weighted-composite shape (a single
// use-case for now; per-use-case weights are a documented deferral) but uses our
// companion-tuned quality, so the warm family (gemma2, mistral-nemo) surfaces
// ahead of cold-but-clever ones (qwen, phi) at every tier.

import { CATALOG } from './catalog.js';
import { estimateMemoryGb, fitScore, fitLevel } from './fit.js';

/**
 * The memory budget a model may use: discrete GPU VRAM when present, otherwise a
 * conservative slice of system RAM (leaving headroom for the OS + the vault).
 */
export function availableMemoryGb(hw) {
  if (hw?.hasGpu && hw.gpuVramGb > 0) return hw.gpuVramGb;
  return Math.round((Number(hw?.totalRamGb) || 0) * 0.6 * 10) / 10;
}

/**
 * Map a fit-score bucket to a 0–1 weight on quality. A right-sized model keeps
 * its full quality; a tight one is discounted so a comfortably-fitting warmer
 * model can outrank a cramped cooler one. (Buckets come from fit.js fitScore:
 * 100 = right-sized, 70 = tight, 50 = very tight.)
 */
export function fitWeight(score) {
  if (score >= 100) return 1.0;
  if (score >= 70) return 0.85;
  if (score > 0) return 0.6;
  return 0; // doesn't fit
}

/** Composite rank for a fitting model: companion-quality discounted by fit. */
function rankScore(quality, score) {
  return Math.round(quality * fitWeight(score) * 10) / 10;
}

/**
 * Recommend local models for the detected hardware.
 *
 * Returns the FULL catalog, scored and sorted into two bands:
 *   Band A (fits, fitScore > 0)  — by rankScore desc, tie-break quality desc.
 *   Band B (won't fit, score 0)  — appended, by paramsB asc (nearest reach first).
 *
 * @param {object} hw  output of detectHardware()
 * @param {object} [opts]
 * @param {number} [opts.ctx=8192]
 * @param {number} [opts.limit]   optional cap (default: all — the UI scrolls)
 * @returns {{available:number, hasGpu:boolean, backend:string, recommendations:object[], note:(string|null)}}
 */
export function recommendModels(hw, { ctx = 8192, limit } = {}) {
  const available = availableMemoryGb(hw);
  const scored = CATALOG.map((m) => {
    // Prefer the REAL download size (weights on disk) from the registry + a
    // KV-cache term + overhead; fall back to the params×bpp estimate when a
    // catalog entry has no measured size.
    const kvGb = 0.000008 * (m.kvParamsB ?? m.paramsB) * ctx;
    const estimatedGb = m.sizeGb > 0
      ? Math.round((m.sizeGb + kvGb + 0.5) * 10) / 10
      : estimateMemoryGb(m.paramsB, m.defaultQuant, ctx, m.kvParamsB ?? m.paramsB);
    const score = fitScore(estimatedGb, available);
    return {
      name: m.name,
      paramsB: m.paramsB,
      quant: m.defaultQuant,
      quality: m.quality,
      bestFor: m.bestFor,
      family: m.family,
      namespace: m.namespace || 'library',
      sizeGb: m.sizeGb || 0,
      estimatedGb,
      fitScore: score,
      fitLevel: fitLevel(estimatedGb, available),
      rankScore: rankScore(m.quality, score),
      blurb: m.blurb,
    };
  });

  const bandA = scored
    .filter((m) => m.fitScore > 0)
    .sort((a, b) => (b.rankScore - a.rankScore) || (b.quality - a.quality));
  const bandB = scored
    .filter((m) => m.fitScore === 0)
    .sort((a, b) => a.paramsB - b.paramsB);

  let recommendations = [...bandA, ...bandB];
  if (Number.isInteger(limit) && limit > 0) recommendations = recommendations.slice(0, limit);

  return {
    available,
    hasGpu: Boolean(hw?.hasGpu),
    backend: hw?.backend || 'cpu',
    recommendations,
    // Only a real warning when NOTHING fits comfortably (Band A empty).
    note: bandA.length ? null : 'No catalogued model fits comfortably; the smaller ones are shown — expect slow CPU-only inference.',
  };
}

export default recommendModels;
