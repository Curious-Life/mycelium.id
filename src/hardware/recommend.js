// src/hardware/recommend.js — rank catalog models by how well they fit the box, and
// star ONLY the ones we actually use.
//
// Pure + deterministic. Given a hardware descriptor (from detect.js) it scores every
// catalog model with the computed fit (fit.js) and returns the FULL list to browse.
//
// ⚠️ THE ★ IS CURATED, NOT ALGORITHMIC (operator decision 2026-07-19). It used to blend
// a "companion warmth" family-prior (gemma2, mistral-nemo…) with fit and star the top 3 —
// which headlined gemma, a family we don't use and judged not good. A model we haven't
// validated must never carry a "we recommend this" claim (the §3.11d silent-lie class).
// So the ★ now comes ONLY from endorsedLocalModels() (single-sourced in role-models.js);
// everything else is LISTED, ordered by hardware fit, with no star. The `quality` field
// survives only as a last-resort tiebreak within the browse list — it no longer decides
// what we recommend, nor the headline order.

import { CATALOG } from './catalog.js';
import { estimateMemoryGb, fitScore, fitLevel } from './fit.js';
import { monthsSince } from './catalog-meta.js';
import { labelingRecommendedModel, endorsedLocalModels } from '../inference/role-models.js';

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
      updated: m.updated || '',
      ageMonths: monthsSince(m.updated),
      blurb: m.blurb,
    };
  });

  // ★ ENDORSED = the curated models we actually use (single-sourced). Only these earn the
  // badge, and only where they FIT (we don't recommend a model this box can't run).
  const endorsed = new Set(endorsedLocalModels());
  for (const m of scored) m.recommended = endorsed.has(m.name) && m.fitScore > 0;

  // Band A (fits): endorsed-and-fitting FIRST (the ones we use lead), then the rest by
  // hardware fit — right-sized first (fitScore desc), newer first (ageMonths asc), and
  // `quality` only as a final tiebreak. This drops the warmth ranking that used to float
  // gemma to the top of every box.
  const rank = (m) => (m.recommended ? 1 : 0);
  const bandA = scored
    .filter((m) => m.fitScore > 0)
    .sort((a, b) =>
      (rank(b) - rank(a))
      || (b.fitScore - a.fitScore)
      || ((a.ageMonths ?? 999) - (b.ageMonths ?? 999))
      || (b.quality - a.quality));
  const bandB = scored
    .filter((m) => m.fitScore === 0)
    .sort((a, b) => a.paramsB - b.paramsB);

  // Role-aware tag (curated). The on-box labeling model is single-sourced from
  // role-models.js; the UI shows it as "for labeling" context on the recommended chip.
  // (Descriptions→cloud-Regolo is a cloud preset, not a local catalog model, so it's
  // badged on the cloud-preset lane, not here.)
  const labelPick = labelingRecommendedModel();
  for (const m of scored) m.recommendedFor = m.name === labelPick ? ['labeling'] : [];

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
