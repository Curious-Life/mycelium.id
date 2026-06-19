// verify:measure-only — the measurement-only refresh path (src/jobs.js +
// run-clustering.sh MEASURE_ONLY). Non-destructive metric refresh on the existing
// mindscape: no cluster.py (no re-cluster), no describe (no narration), and EXEMPT
// from the Generate kill-switch.
//   M1 run-clustering.sh wraps Steps 1-3 (sync/cluster/describe) in the MEASURE_ONLY
//      guard, so Steps 4-16 (metrics) run on the existing structure
//   M2 startMeasurementJob is exported and delegates to startClusteringJob(measureOnly)
//   M3 with Generate LOCKED: startClusteringJob → 'disabled'; startMeasurementJob is
//      EXEMPT (gets past the lock) — proven by it failing later (on keys), not at the lock
import { readFileSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── M1: script structure ──
const sh = readFileSync('pipeline/run-clustering.sh', 'utf8');
const iGuard = sh.indexOf('MYCELIUM_MEASURE_ONLY:-}" = "1"');
const iStep1 = sh.indexOf('Step 1/16');
const iFi = sh.indexOf('# end non-MEASURE_ONLY');
const iStep4 = sh.indexOf('Step 4/16');
rec('M1. MEASURE_ONLY guard wraps Steps 1-3 (cluster/describe skipped); Steps 4-16 still run',
  iGuard > 0 && iGuard < iStep1 && iFi > iStep1 && iFi < iStep4,
  `guard@${iGuard} step1@${iStep1} fi@${iFi} step4@${iStep4}`);

// ── M2/M3: job behaviour with Generate locked ──
process.env.MYCELIUM_DISABLE_GENERATE = '1';
const { startClusteringJob, startMeasurementJob, generateLocked } = await import('../src/jobs.js');
rec('M2. startMeasurementJob is exported', typeof startMeasurementJob === 'function' && generateLocked() === true);

const gen = startClusteringJob({});
let measurePastLock = false;
try { const m = startMeasurementJob({}); measurePastLock = m.status !== 'disabled'; }
catch { measurePastLock = true; } // threw later (on keys) → it got PAST the lock
rec('M3. kill-switch blocks generate (disabled) but EXEMPTS measure-only',
  gen.status === 'disabled' && measurePastLock,
  `generate=${gen.status} measurePastLock=${measurePastLock}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — measure-only: skips cluster/describe, refreshes metrics, exempt from the Generate kill-switch' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
