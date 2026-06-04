// src/hardware/recommend.js — rank catalog models by how well they fit the box.
//
// Pure + deterministic: given a hardware descriptor (from detect.js) it scores
// every catalog model with the computed fit (fit.js) and returns the best-fitting
// few. "Best" rewards right-sizing (use ~50–80% of memory) and, among equally
// well-fitting models, prefers the MORE capable (larger) one.

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
 * Recommend local models for the detected hardware.
 * @param {object} hw  output of detectHardware()
 * @param {object} [opts]
 * @param {number} [opts.limit=4]
 * @param {number} [opts.ctx=8192]
 * @returns {{available:number, hasGpu:boolean, backend:string, recommendations:object[], note:(string|null)}}
 */
export function recommendModels(hw, { limit = 4, ctx = 8192 } = {}) {
  const available = availableMemoryGb(hw);
  const scored = CATALOG.map((m) => {
    const estimatedGb = estimateMemoryGb(m.paramsB, m.defaultQuant, ctx, m.kvParamsB ?? m.paramsB);
    return {
      name: m.name,
      paramsB: m.paramsB,
      quant: m.defaultQuant,
      estimatedGb,
      fitScore: fitScore(estimatedGb, available),
      fitLevel: fitLevel(estimatedGb, available),
      blurb: m.blurb,
    };
  }).sort((a, b) => (b.fitScore - a.fitScore) || (b.paramsB - a.paramsB));

  const fits = scored.filter((m) => m.fitScore > 0);
  // Nothing fits comfortably → show the single smallest model, flagged.
  const smallest = [...scored].sort((a, b) => a.paramsB - b.paramsB)[0];
  const recommendations = (fits.length ? fits : (smallest ? [smallest] : [])).slice(0, limit);

  return {
    available,
    hasGpu: Boolean(hw?.hasGpu),
    backend: hw?.backend || 'cpu',
    recommendations,
    note: fits.length ? null : 'No catalogued model fits comfortably; the smallest is shown — expect slow CPU-only inference.',
  };
}

export default recommendModels;
