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
rec('P6. lzComplexity: repetitive < varied; textbook c≤n; surrogate shape',
  lzRepeat.complexity < lzVaried.complexity
    && lzComplexity([1]).complexity === 1            // single symbol → c=1 (textbook; was 0)
    && lzVaried.complexity <= lzVaried.sequenceLength // char-fix invariant: raw ≤ seqlen
    && typeof lzVaried.normalized === 'number' && lzVaried.sequenceLength === 8
    && 'lowConfidence' in lzVaried,                   // new surrogate-shape field
  `repeat=${lzRepeat.complexity} varied=${lzVaried.complexity} lowConf=${lzVaried.lowConfidence}`);

// P6b. surrogate normalization kills small-n saturation discrimination: a STRUCTURED
// long sequence scores well below 1; a RANDOM one near 1; short seqs flagged.
const seedRng = (s => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff))(7);
const structured = Array.from({ length: 40 }, (_, i) => i % 3);
const random40 = Array.from({ length: 40 }, () => Math.floor(seedRng() * 4));
const lzStruct = lzComplexity(structured, { seed: 1 });
const lzRand = lzComplexity(random40, { seed: 1 });
const lzShort = lzComplexity([3, 5], { seed: 1 });
rec('P6b. surrogate norm: structured≪random (no saturation); short→low_confidence; deterministic',
  lzStruct.normalized < 0.7 && lzRand.normalized > lzStruct.normalized
    && lzStruct.lowConfidence === 0 && lzShort.lowConfidence === 1
    && lzComplexity(random40, { seed: 1 }).normalized === lzRand.normalized,
  `struct=${lzStruct.normalized} rand=${lzRand.normalized} short.lowConf=${lzShort.lowConfidence}`);

// P6c. LONG-branch (n ≥ LZ_SURROGATE_MAX_N) bound must NOT saturate large-alphabet
// streams. A length-1200 sequence cycling a 250-symbol alphabet (period 250 → highly
// compressible) read 1.00 under the wrong `n/log2(a)` bound; the correct LZ bound
// b(n)=n·log2(a)/log2(n) returns its true (well-below-1) value. Mirrors the real global
// stream (n≈10.5k, a=250) that the user saw pinned at 1.00.
const lzBig = lzComplexity(Array.from({ length: 1200 }, (_, i) => i % 250), { seed: 1 });
rec('P6c. long-branch large-alphabet does NOT saturate (n/log_a(n) bound, not n/log2(a))',
  lzBig.sequenceLength === 1200 && lzBig.lowConfidence === 0
    && lzBig.normalized > 0 && lzBig.normalized < 0.95,
  `n=${lzBig.sequenceLength} a=${lzBig.alphabetSize} normalized=${lzBig.normalized} (was 1.00 pre-fix)`);

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
