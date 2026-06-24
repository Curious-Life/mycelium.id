// verify:cross-check-quadrant — the construct-validity test for the movement cross-check, in
// miniature (same shape as verify:fisher-display's honest-headline + degenerate-fail-closed):
// the four quadrants fire on the right (F, E) baseline-z pairs, the deadzone stays quiet, and
// EITHER side low-confidence fails closed to 'insufficient' — NEVER a false basis-suspect chip.
// Pure unit test of the single-sourced helper; no DB, no corpus.
import { crossCheckQuadrant, QUADRANT_COPY } from '../src/metrics/cross-check-quadrant.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const z = (val, low = false) => ({ z: val, lowConfidence: low });

// Defaults: moved |z|≥2, flat |z|<1, [1,2) = deadzone.
rec('Q1. F moved + E moved → corroborated', crossCheckQuadrant(z(3), z(2.5)).state === 'corroborated');
rec('Q2. F flat + E flat → settled', crossCheckQuadrant(z(0.3), z(-0.4)).state === 'settled');
rec('Q3. F moved + E flat → basis_suspect (Fisher false-positive)', crossCheckQuadrant(z(3.2), z(0.2)).state === 'basis_suspect');
rec('Q4. F flat + E moved → hidden_drift (Fisher false-negative)', crossCheckQuadrant(z(0.1), z(2.6)).state === 'hidden_drift');

// Deadzone: a z in [1,2) on EITHER axis → consistent (no alarm, so the chip doesn't flap).
rec('Q5. F in deadzone (1.5) + E moved → consistent (not hidden_drift)', crossCheckQuadrant(z(1.5), z(3)).state === 'consistent');
rec('Q6. F moved + E in deadzone (1.5) → consistent (NOT a false basis_suspect)', crossCheckQuadrant(z(3), z(1.5)).state === 'consistent');

// Fail-safe: EITHER side low-confidence or missing → insufficient, never a quadrant.
rec('Q7. F low-confidence → insufficient (no false basis_suspect on a directionless week)',
  crossCheckQuadrant(z(3, true), z(0.1)).state === 'insufficient');
rec('Q8. E low-confidence → insufficient', crossCheckQuadrant(z(3), z(0.1, true)).state === 'insufficient');
rec('Q9. either side null / non-finite → insufficient',
  crossCheckQuadrant(null, z(2)).state === 'insufficient'
    && crossCheckQuadrant(z(2), { z: null, lowConfidence: false }).state === 'insufficient'
    && crossCheckQuadrant(z(2), { z: NaN, lowConfidence: false }).state === 'insufficient');

// Copy exists for every state (the chip never renders an empty label).
const states = ['corroborated', 'settled', 'basis_suspect', 'hidden_drift', 'consistent', 'insufficient'];
rec('Q10. every quadrant state has non-empty label + detail copy',
  states.every((s) => QUADRANT_COPY[s]?.label && QUADRANT_COPY[s]?.detail),
  `states=${states.length}`);

// basis_suspect copy is SOFT in v1 (no hard "the map redrew" claim — that needs the
// cross-run disambiguator fast-follow).
rec('Q11. v1 basis_suspect copy is soft (no unqualified "redrew" claim)',
  /possibly|might|may|local move/i.test(QUADRANT_COPY.basis_suspect.detail)
    && !/\bredrew\b/i.test(QUADRANT_COPY.basis_suspect.detail),
  QUADRANT_COPY.basis_suspect.detail);

const ok = ledger.every(Boolean);
console.log(`\n${'='.repeat(64)}\nVERDICT: ${ok ? 'GO — 2x2 quadrant honest on all inputs; deadzone quiet; either-low-conf fails closed; soft basis-suspect copy' : 'NO-GO — see FAIL rows'}  EXIT=${ok ? 0 : 1}\n${'='.repeat(64)}`);
process.exit(ok ? 0 : 1);
