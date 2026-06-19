// verify:fisher-display — the construct-validity gate for the movement display contract.
//
// Two assertions in miniature, the same discipline the CVP gate enforces globally:
//   (1) HONEST HEADLINE — a real change for a varying writer yields a finite baseline-z,
//       computed over a TRAILING + EXCLUSIVE window (the current value is not in its own
//       mean/std), so a big week does not partially hide itself.
//   (2) DEGENERATE FAIL-CLOSED — a near-constant baseline returns low_confidence, NEVER a
//       fabricated giant σ. A gate that checked only (1) would let a fake "100σ off your
//       normal" ship — exactly the dishonesty this metric exists to kill.
// Plus the wiring contract: the endpoint surfaces the baseline-z headline AND keeps the
// pooled-null z as the confidence gate; the chart toggle no longer exposes cumulative columns.

import { readFileSync } from 'node:fs';
import { baselineZ } from '../src/metrics/baseline-z.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(Boolean(pass));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ── (1) HONEST: varying writer, real big week → finite z, not low-confidence ──
const prior = [0.08, 0.12, 0.09, 0.11, 0.1, 0.13, 0.09, 0.1];
const bigWeek = baselineZ([...prior, 0.2]);
rec('D1. honest: varying writer + real big week → finite z, confident',
  bigWeek.z != null && !bigWeek.lowConfidence && bigWeek.z > 3,
  `z=${bigWeek.z?.toFixed(2)} lowConf=${bigWeek.lowConfidence}`);

// A within-normal week for the SAME writer → a small "for-me" σ exists (the number the
// headline shows instead of a high pooled-z for a stable low-volume writer).
const typicalWeek = baselineZ([...prior, 0.11]);
rec('D2. honest: within-normal week → small baseline-z exists (|z|<1.5), confident',
  typicalWeek.z != null && !typicalWeek.lowConfidence && Math.abs(typicalWeek.z) < 1.5,
  `z=${typicalWeek.z?.toFixed(2)}`);

// ── (2) DEGENERATE FAIL-CLOSED: near-constant baseline + a spike → low_confidence, z null ──
const constThenSpike = baselineZ([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.5]);
rec('D3. degenerate fail-closed: near-constant baseline + spike → low_confidence, z=null (NOT a fabricated σ)',
  constThenSpike.z === null && constThenSpike.lowConfidence && constThenSpike.reason === 'degenerate_baseline',
  `z=${constThenSpike.z} reason=${constThenSpike.reason}`);

const exactConstant = baselineZ([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
rec('D4. degenerate fail-closed: exactly-constant history → low_confidence, never ±Infinity',
  exactConstant.z === null && exactConstant.lowConfidence && Number.isFinite(exactConstant.std ?? 0),
  `z=${exactConstant.z} std=${exactConstant.std}`);

// ── TRAILING + EXCLUSIVE: the current value must be excluded from its own mean/std ──
// prior=[1..7] (mean 4, std ~2.16); current=100. Exclusive → z≈44. If current were INCLUDED
// the mean/std would absorb it and z≈2.5 — so a z>30 proves exclusion.
const excl = baselineZ([1, 2, 3, 4, 5, 6, 7, 100]);
rec('D5. trailing+exclusive: current excluded from its own baseline (outlier z>30, not ~2.5)',
  excl.z != null && excl.z > 30,
  `z=${excl.z?.toFixed(1)} mean=${excl.mean?.toFixed(2)} std=${excl.std?.toFixed(2)}`);

// ── insufficient history → low_confidence (not a guess) ──
const short = baselineZ([0.1, 0.2, 0.1]);
rec('D6. insufficient history → low_confidence (reason insufficient_history)',
  short.z === null && short.lowConfidence && short.reason === 'insufficient_history',
  `n=${short.n} reason=${short.reason}`);

// ── WIRING CONTRACT (read source) ──
const restSrc = readFileSync(new URL('../src/portal-measurement.js', import.meta.url), 'utf8');
rec('D7. endpoint surfaces baseline-z headline AND keeps pooled-null z as the gate',
  restSrc.includes('velocity_baseline_z') && restSrc.includes('entropy_baseline_z')
    && restSrc.includes('avg_velocity_z') && restSrc.includes("from './metrics/baseline-z.js'"),
  'velocity_baseline_z + entropy_baseline_z + avg_velocity_z present; baseline-z imported');

const viewSrc = readFileSync(new URL('../portal-app/src/lib/views/CuriousLifeView.svelte', import.meta.url), 'utf8');
const toggleBlock = viewSrc.slice(viewSrc.indexOf('moveMetricOpts = ['), viewSrc.indexOf('moveMetricOpts = [') + 200);
rec('D8. chart toggle retired cumulative columns (no path-length / displacement)',
  !toggleBlock.includes('fisher_trajectory_length') && !toggleBlock.includes('fisher_displacement')
    && viewSrc.includes('velocity_baseline_z'),
  'moveMetricOpts has neither cumulative key; view reads velocity_baseline_z');

// ── P2: movement reads carry a family-level freshness hedge (a stale card must not
// read as authoritative). The agent surface already hedges (fisher-tools.js); this
// asserts the PORTAL endpoints do too.
rec('D9. P2: /trajectory endpoints attach the fisher_trajectory freshness hedge',
  restSrc.includes('familyFreshness') && restSrc.includes('freshnessHedge')
    && restSrc.includes("familyFreshness(db, u.id, 'fisher_trajectory')"),
  'familyFreshness + freshnessHedge wired into the movement endpoints');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — movement headline is baseline-relative + honest; degenerate baselines fail closed; cumulative columns retired' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
