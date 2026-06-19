/**
 * Phase-color interpolation for the Mindscape Pulses visualization
 * (Wave M1 of docs/MINDSCAPE-PULSES-PLAN.md).
 *
 * Each territory has a daily history of {phase, vitality} samples
 * from the `territory_vitality` table. Given a scrub time `t`, we
 * return the color + brightness to render for that territory at that
 * moment — derived from the nearest sample at or before `t` (step
 * function, not continuous interpolation; see Q5 in the plan doc).
 *
 * Phase colors are defined in OKLab space so the hue transitions
 * between neighbouring samples (when the halo fades from one frame's
 * color to the next frame's color) stay perceptually smooth. The
 * amber→cyan sweep is the one RGB interpolation renders especially
 * poorly — muddy greys through the midpoint — so we do the math in
 * OKLab and only convert back to sRGB at the last step.
 *
 * There's no live state in this module. It exports pure functions
 * suitable for frame-loop invocation and for unit tests.
 */

export type PhaseState = 'sparse' | 'active' | 'anchor';

export interface PhaseSample {
  /** ISO 8601 timestamp of when this phase sample was computed. */
  t: string;
  phase: PhaseState;
  /** 0..1, how active this territory was at the sample point. */
  vitality: number;
}

export interface PhaseHistory {
  territory_id: number;
  name: string | null;
  /** Oldest → newest. The server guarantees this ordering. */
  history: PhaseSample[];
}

/**
 * sRGB hex codes for the three phases.
 * - sparse: warm amber / red-orange — contracting, inward
 * - active: aurum gold               — open flow, brand core
 * - anchor: cool violet / cyan       — bridging, outward
 */
export const PHASE_HEX: Record<PhaseState, string> = {
  sparse: '#D97846',
  active: '#E5B84C',
  anchor: '#7DB6D9',
};

/** Fallback color for territories with no samples at (or before) the scrub position. */
export const DORMANT_HEX = '#3A3A42';

// ── sRGB ↔ OKLab conversion ─────────────────────────────────────────
// Reference: https://bottosson.github.io/posts/oklab/

function srgbToLinear(c: number): number {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : Math.pow((cn + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hexToOklab(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16));
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lCbrt = Math.cbrt(l);
  const mCbrt = Math.cbrt(m);
  const sCbrt = Math.cbrt(s);
  return [
    0.2104542553 * lCbrt + 0.793617785 * mCbrt - 0.0040720468 * sCbrt,
    1.9779984951 * lCbrt - 2.428592205 * mCbrt + 0.4505937099 * sCbrt,
    0.0259040371 * lCbrt + 0.7827717662 * mCbrt - 0.808675766 * sCbrt,
  ];
}

function oklabToHex([L, a, b]: [number, number, number]): string {
  const lCbrt = L + 0.3963377774 * a + 0.2158037573 * b;
  const mCbrt = L - 0.1055613458 * a - 0.0638541728 * b;
  const sCbrt = L - 0.0894841775 * a - 1.291485548 * b;
  const lLin = lCbrt ** 3;
  const mLin = mCbrt ** 3;
  const sLin = sCbrt ** 3;
  const r = 4.0767416621 * lLin - 3.3077115913 * mLin + 0.2309699292 * sLin;
  const g = -1.2684380046 * lLin + 2.6097574011 * mLin - 0.3413193965 * sLin;
  const bl = -0.0041960863 * lLin - 0.7034186147 * mLin + 1.707614701 * sLin;
  const rs = linearToSrgb(r).toString(16).padStart(2, '0');
  const gs = linearToSrgb(g).toString(16).padStart(2, '0');
  const bs = linearToSrgb(bl).toString(16).padStart(2, '0');
  return `#${rs}${gs}${bs}`;
}

const PHASE_OKLAB: Record<PhaseState, [number, number, number]> = {
  sparse: hexToOklab(PHASE_HEX.sparse),
  active: hexToOklab(PHASE_HEX.active),
  anchor: hexToOklab(PHASE_HEX.anchor),
};
const DORMANT_OKLAB = hexToOklab(DORMANT_HEX);

// ── lookup ──────────────────────────────────────────────────────────

/**
 * Binary-search the nearest sample at or before `tMs`. Returns null
 * if every sample is strictly after `tMs` (i.e. the territory wasn't
 * yet being tracked at that scrub position).
 */
export function findSampleAt(history: PhaseSample[], tMs: number): PhaseSample | null {
  if (!history || history.length === 0) return null;
  let lo = 0;
  let hi = history.length - 1;
  let best: PhaseSample | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sMs = Date.parse(history[mid].t);
    if (sMs <= tMs) {
      best = history[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export interface PhaseColor {
  /** sRGB hex (#RRGGBB) color for the halo at the scrub position. */
  hex: string;
  /** OKLab triple — handy for downstream gradient math. */
  oklab: [number, number, number];
  /** 0..1 — how bright the halo should render. 0 = dormant, 1 = peak active. */
  brightness: number;
  /** The sample that drove this result, or null for dormant fallback. */
  sample: PhaseSample | null;
}

/**
 * Color + brightness for a territory at scrub time `tMs`.
 *
 * Step function: holds the sample at `t` until the next sample
 * arrives. The render loop's natural frame-to-frame transition gives
 * a smooth visual shift even though the data is daily.
 *
 * Dormant fallback (no sample at or before `tMs`):
 * - hex = DORMANT_HEX (neutral grey)
 * - brightness = 0.15 (very dim, still breathing)
 */
export function phaseColorAt(history: PhaseSample[], tMs: number): PhaseColor {
  const sample = findSampleAt(history, tMs);
  if (!sample) {
    return { hex: DORMANT_HEX, oklab: DORMANT_OKLAB, brightness: 0.15, sample: null };
  }
  const oklab = PHASE_OKLAB[sample.phase] ?? DORMANT_OKLAB;
  const hex = PHASE_HEX[sample.phase] ?? DORMANT_HEX;
  // Brightness maps vitality 0→1 onto 0.25→1.0 — even the dimmest
  // active sample is clearly brighter than dormant (0.15).
  const v = Math.max(0, Math.min(1, sample.vitality || 0));
  const brightness = 0.25 + 0.75 * v;
  return { hex, oklab, brightness, sample };
}

/**
 * Linear OKLab interpolation between two phase colors. Used by the
 * firing-pulse renderer (Wave M3) to produce the tail-to-head
 * gradient along a line.
 */
export function interpolateOklab(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

export function oklabToHexExported(lab: [number, number, number]): string {
  return oklabToHex(lab);
}

/**
 * sRGB hex → normalized [r, g, b] in [0, 1]. Convenience for feeding
 * into Three.js vertex color buffers.
 */
export function hexToRgbNormalized(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
