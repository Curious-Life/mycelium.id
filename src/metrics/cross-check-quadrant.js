// The movement cross-check quadrant — the 2x2 honesty signal that tells a Fisher movement
// spike caused by the clustering being redrawn apart from real semantic movement.
//
// Two axes, both baseline-z's (self-normalized "unusual for ME", via baseline-z.js):
//   F = Fisher velocity_baseline_z  (how the territory/realm DISTRIBUTION moved)
//   E = global centroid_drift_z     (how the semantic CENTER moved — basis-free)
//
//                | E flat              | E moved
//   -------------+---------------------+---------------------------
//   F moved      | BASIS-SUSPECT       | CORROBORATED ("real movement")
//   F flat       | SETTLED             | HIDDEN-DRIFT ("topic-map didn't catch it")
//
// The two off-diagonals are OPPOSITE events — a symmetric agreement score would destroy
// the directionality, which is the whole point. basis-suspect = a Fisher false-positive
// (the map moved, your content didn't); hidden-drift = a Fisher false-negative (your
// content moved within your territories, the distribution can't see it).
//
// HONESTY CONTRACT (made executable in verify:cross-check-quadrant): EITHER side
// low-confidence (or no common confident week) → 'insufficient', never a quadrant — a
// basis-suspect chip on a directionless week would be exactly the false alarm this
// metric exists to prevent. A z in the [FLAT_Z, MOVED_Z) deadzone → 'consistent' (no
// alarm) so the chip doesn't flap week to week.
//
// v1 ships SOFT basis-suspect copy. The cross-run velocity-change disambiguator (which
// sharpens it into "the map redrew" vs "a minor reshuffle") is a fast-follow — see the
// design doc Part 13.8.

export const QUADRANT_DEFAULTS = Object.freeze({
  movedZ: Number(process.env.CROSSCHECK_MOVED_Z) || 2, // |z| ≥ this ⇒ "moved" (conventional 2σ)
  flatZ: Number(process.env.CROSSCHECK_FLAT_Z) || 1,   // |z| < this ⇒ "flat"; [flatZ, movedZ) ⇒ deadzone
});

export const QUADRANT_COPY = Object.freeze({
  corroborated: { label: 'real movement', detail: 'Your topic map and your semantic center both shifted — a real move.' },
  settled: { label: 'a settled week', detail: 'Both your topic map and your semantic center held steady.' },
  basis_suspect: { label: 'movement your semantic center didn’t register', detail: 'Your topic map moved but the meaning of your writing didn’t — possibly a map effect, or a small, local move.' },
  hidden_drift: { label: 'movement your topic map didn’t catch', detail: 'Your semantic center moved while your topic distribution held — drift within your existing territories.' },
  consistent: { label: 'consistent', detail: 'Movement this week is in your normal range on both signals.' },
  insufficient: { label: 'not enough signal yet', detail: 'Not enough confident history on one of the two signals to compare them.' },
});

const band = (z, movedZ, flatZ) => {
  const m = Math.abs(z);
  return m >= movedZ ? 'moved' : (m < flatZ ? 'flat' : 'mid');
};

/**
 * @param {{z:number|null, lowConfidence:boolean}|null} F Fisher velocity baseline-z result
 * @param {{z:number|null, lowConfidence:boolean}|null} E global centroid-drift baseline-z result
 * @param {{movedZ?:number, flatZ?:number}} [opts]
 * @returns {{state:string, f:string|null, e:string|null}}
 *   state ∈ {corroborated, settled, basis_suspect, hidden_drift, consistent, insufficient}
 */
export function crossCheckQuadrant(F, E, opts = {}) {
  const { movedZ, flatZ } = { ...QUADRANT_DEFAULTS, ...opts };
  // Fail closed: either axis missing or low-confidence → no quadrant.
  if (!F || !E || F.lowConfidence || E.lowConfidence || !Number.isFinite(F.z) || !Number.isFinite(E.z)) {
    return { state: 'insufficient', f: null, e: null };
  }
  const f = band(F.z, movedZ, flatZ);
  const e = band(E.z, movedZ, flatZ);
  if (f === 'mid' || e === 'mid') return { state: 'consistent', f, e };
  if (f === 'moved' && e === 'moved') return { state: 'corroborated', f, e };
  if (f === 'flat' && e === 'flat') return { state: 'settled', f, e };
  if (f === 'moved' && e === 'flat') return { state: 'basis_suspect', f, e };
  return { state: 'hidden_drift', f, e }; // f flat, e moved
}
