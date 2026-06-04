// verify:primitives — F1 foundation. Cross-language parity gate for the shared
// measurement primitives (src/metrics/primitives.js) against the Python-reference
// fixture (scripts/fixtures/primitives_fixture.json) at 1e-12, plus property
// tests for the two operators not in the fixture (lzComplexity, countsToProbs).
// PASS/FAIL ledger. This is the "shared primitives in ONE place" guardrail.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  l2Normalize, cosineSim, countsToProbs,
  entropyNats, entropyBits, entropyNormalized, lzComplexity, lz76Complexity, variance, gini,
} from '../src/metrics/primitives.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/primitives_fixture.json');
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const TOL = fx._metadata?.tolerance ?? 1e-12;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOL;
const nearArr = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => near(x, b[i]));

// ── Cross-language fixture parity (1e-12 vs Python references) ──
let eOk = true, eFail = '';
for (const c of fx.entropy) {
  if (!near(entropyNats(c.p), c.entropyNats)) { eOk = false; eFail = `entropyNats[${c.name}] ${entropyNats(c.p)} != ${c.entropyNats}`; break; }
  if (!near(entropyBits(c.p), c.entropyBits)) { eOk = false; eFail = `entropyBits[${c.name}] ${entropyBits(c.p)} != ${c.entropyBits}`; break; }
  if (!near(entropyNormalized(c.p), c.entropyNormalized)) { eOk = false; eFail = `entropyNormalized[${c.name}]`; break; }
}
rec(`P1. entropy {nats,bits,normalized} match Python (${fx.entropy.length} cases @ ${TOL})`, eOk, eFail);

let cOk = true, cFail = '';
for (const c of fx.cosineSim) { if (!near(cosineSim(c.a, c.b), c.expected)) { cOk = false; cFail = `cosineSim[${c.name}] ${cosineSim(c.a, c.b)} != ${c.expected}`; break; } }
rec(`P2. cosineSim matches scipy (${fx.cosineSim.length} cases, incl. zero-norm/mismatch→0)`, cOk, cFail);

let lOk = true, lFail = '';
for (const c of fx.l2Normalize) { if (!nearArr(l2Normalize(c.v), c.expected)) { lOk = false; lFail = `l2Normalize[${c.name}]`; break; } }
rec(`P3. l2Normalize matches numpy (${fx.l2Normalize.length} cases, incl. zero-vector)`, lOk, lFail);

let gOk = true, gFail = '';
for (const c of fx.gini) { if (!near(gini(c.values), c.expected)) { gOk = false; gFail = `gini[${c.name}] ${gini(c.values)} != ${c.expected}`; break; } }
rec(`P4. gini matches numpy (${fx.gini.length} cases, incl. empty/single)`, gOk, gFail);

// ── Property tests for the two operators not in the fixture ──
const probs = countsToProbs([3, 5, 2]);
rec('P5. countsToProbs sums to 1 + uniform on zero-total',
  near(probs.reduce((a, b) => a + b, 0), 1) && countsToProbs([0, 0]).every((x) => near(x, 0.5)),
  `probs=[${probs.map((x) => x.toFixed(3)).join(',')}]`);

const lzRepeat = lzComplexity([1, 1, 1, 1, 1, 1, 1, 1]);
const lzVaried = lzComplexity([1, 2, 3, 4, 5, 6, 7, 8]);
rec('P6. lzComplexity: repetitive < varied; shape intact',
  lzRepeat.complexity < lzVaried.complexity
    && lzComplexity([1]).complexity === 0
    && typeof lzVaried.normalized === 'number' && lzVaried.sequenceLength === 8,
  `repeat=${lzRepeat.complexity} varied=${lzVaried.complexity}`);

// ── F3 new primitives: true LZ76 + variance ──
const lzSame = lz76Complexity([0, 0, 0, 0, 0, 0]).complexity;
const lzDistinct = lz76Complexity([1, 2, 3, 4, 5, 6]).complexity;
rec('P7. true LZ76 (Kaspar-Schuster): all-same c=2 < all-distinct; single symbol c=1',
  lzSame === 2 && lzDistinct > lzSame && lz76Complexity([7]).complexity === 1,
  `all-same=${lzSame} all-distinct=${lzDistinct}`);

rec('P8. variance: known value var([2,4,4,4,5,5,7,9])=4; empty=0',
  near(variance([2, 4, 4, 4, 5, 5, 7, 9]), 4) && variance([]) === 0,
  `var=${variance([2, 4, 4, 4, 5, 5, 7, 9])}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — shared primitives match Python at 1e-12 (one source of truth)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
