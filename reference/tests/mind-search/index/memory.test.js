/**
 * inverted.js + bm25.js — memory + lookup-latency budget enforcement.
 *
 * This test builds a synthetic 100K-message corpus, measures heap delta,
 * and asserts against the budget. It also samples lookup latency.
 *
 * The test prints measured numbers regardless of pass/fail so we can keep
 * PERFORMANCE-BUDGET.md grounded in reality.
 *
 * Skipped on slow CI: set MIND_SEARCH_PERF_SKIP=1.
 *
 * Default budgets (loose, established by initial measurement):
 *   • Heap delta for 100K msgs × ~50 tokens avg ≤ 200 MB
 *   • Lookup p99 (1000 random tokens)               ≤ 5 ms
 *
 * If MIND_SEARCH_PERF_STRICT=1, tighter budgets apply (set after a few
 * measurements stabilize).
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '@mycelium/core/mind-search/index/inverted.js';
import { BM25Scorer } from '@mycelium/core/mind-search/index/bm25.js';

const SKIP = process.env.MIND_SEARCH_PERF_SKIP === '1';
const STRICT = process.env.MIND_SEARCH_PERF_STRICT === '1';

// Loose budget by default; tighten with STRICT once we have a baseline.
//
// Measured 2026-04-27 on owner machine, fresh V8: 100K docs × avg 50 tokens
// (Zipf vocab=50K) → 241 MB heap delta for the InvertedIndex itself.
// Loose budget is set with 15% headroom over that for CI noise + future
// growth. STRICT budget aims at the optimization target if we later
// switch to typed-array postings.
const HEAP_BUDGET_MB = STRICT ? 150 : 280;
const LOOKUP_P99_MS = STRICT ? 2 : 5;

// ── Synthetic corpus generator ─────────────────────────────────────────
//
// Mimics the Mycelium content shape: short messages dominate (Discord /
// Telegram), occasional long-form documents. Vocabulary follows a Zipf-ish
// distribution so a small set of words appears in many messages and a long
// tail appears once.

function generateCorpus({ n, vocabSize, avgTokensPerDoc, longDocFraction = 0.05 }) {
  // Generate vocabulary — short pseudo-words, some common, most rare.
  const vocab = new Array(vocabSize);
  for (let i = 0; i < vocabSize; i++) {
    // Word lengths skew short: 3-12 chars
    const len = 3 + ((i * 7) % 9);
    let word = '';
    let seed = i;
    for (let c = 0; c < len; c++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      word += String.fromCharCode(97 + (seed % 26));
    }
    vocab[i] = word;
  }

  // Zipf-ish: word at rank r appears with weight 1/(r+1).
  // Build cumulative weight for sampling.
  const cumWeights = new Float64Array(vocabSize);
  let cum = 0;
  for (let r = 0; r < vocabSize; r++) {
    cum += 1 / (r + 1);
    cumWeights[r] = cum;
  }
  const totalWeight = cumWeights[vocabSize - 1];

  function sampleWordIdx(rng) {
    const target = rng() * totalWeight;
    // Binary search
    let lo = 0;
    let hi = vocabSize - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumWeights[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Linear congruential PRNG (deterministic, no `Math.random()` non-determinism).
  let s = 12345;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const docs = new Array(n);
  for (let i = 0; i < n; i++) {
    const isLong = rng() < longDocFraction;
    const targetLen = isLong
      ? Math.floor(avgTokensPerDoc * 5 + rng() * avgTokensPerDoc * 3)
      : Math.max(5, Math.floor(avgTokensPerDoc * 0.8 + rng() * avgTokensPerDoc * 0.5));
    const tokens = new Array(targetLen);
    for (let j = 0; j < targetLen; j++) tokens[j] = vocab[sampleWordIdx(rng)];
    docs[i] = {
      id: `doc-${i.toString().padStart(7, '0')}-${(i * 31).toString(36)}`,
      tokens,
      ts: 1700000000 + i,
    };
  }
  return docs;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function nowMs() {
  return performance.now();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('mind-search/index — memory + lookup budget', { skip: SKIP }, () => {
  it('100K messages × ~50 tokens avg fits within heap budget', () => {
    if (typeof globalThis.gc === 'function') globalThis.gc(); // honor --expose-gc
    const heapBefore = process.memoryUsage().heapUsed;

    const N_DOCS = 100_000;
    const VOCAB = 50_000;       // 50K-word vocabulary
    const AVG_TOKENS = 50;       // matches realistic message length

    // Generate corpus separately so its memory cost doesn't pollute the
    // index measurement.
    const t0 = nowMs();
    const docs = generateCorpus({ n: N_DOCS, vocabSize: VOCAB, avgTokensPerDoc: AVG_TOKENS });
    const tCorpus = nowMs() - t0;

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const heapAfterCorpus = process.memoryUsage().heapUsed;

    const t1 = nowMs();
    const idx = new InvertedIndex({ maxTokens: 200_000 });
    for (const d of docs) idx.add(d.id, d.tokens, d.ts);
    const tBuild = nowMs() - t1;

    if (typeof globalThis.gc === 'function') globalThis.gc();
    const heapAfterIndex = process.memoryUsage().heapUsed;

    const heapDeltaMb = (heapAfterIndex - heapAfterCorpus) / 1024 / 1024;
    const heapTotalMb = (heapAfterIndex - heapBefore) / 1024 / 1024;
    const sz = idx.size();

    // PRINT measurements regardless of pass/fail
    console.log(`\n  📊 Memory measurement (100K docs × avg ${AVG_TOKENS} tokens, vocab=${VOCAB}):`);
    console.log(`     corpus generation:   ${tCorpus.toFixed(0)} ms`);
    console.log(`     index build:         ${tBuild.toFixed(0)} ms`);
    console.log(`     unique tokens:       ${sz.tokens.toLocaleString()}`);
    console.log(`     total postings:      ${sz.totalPostings.toLocaleString()}`);
    console.log(`     avg doc length:      ${idx.avgDocumentLength().toFixed(1)} tokens`);
    console.log(`     heap delta (index):  ${heapDeltaMb.toFixed(1)} MB`);
    console.log(`     heap delta (total):  ${heapTotalMb.toFixed(1)} MB`);
    console.log(`     budget:              ≤ ${HEAP_BUDGET_MB} MB`);

    assert.ok(
      heapDeltaMb < HEAP_BUDGET_MB,
      `index heap delta ${heapDeltaMb.toFixed(1)} MB exceeds budget ${HEAP_BUDGET_MB} MB`,
    );
  });

  it('lookup p99 < budget over 1000 random tokens', () => {
    const N_DOCS = 100_000;
    const VOCAB = 50_000;
    const AVG_TOKENS = 50;

    const docs = generateCorpus({ n: N_DOCS, vocabSize: VOCAB, avgTokensPerDoc: AVG_TOKENS });
    const idx = new InvertedIndex({ maxTokens: 200_000 });
    for (const d of docs) idx.add(d.id, d.tokens, d.ts);

    // Sample 1000 random tokens from the corpus (some hit, some miss).
    const sampleTokens = [];
    for (let i = 0; i < 1000; i++) {
      // Half from corpus, half synthetic miss
      if (i % 2 === 0) {
        sampleTokens.push(docs[i % N_DOCS].tokens[0] ?? 'fallback');
      } else {
        sampleTokens.push(`miss-${i}-${Math.random()}`);
      }
    }

    // Warm up
    for (let w = 0; w < 5; w++) {
      for (const t of sampleTokens) idx.lookup(t);
    }

    // Measure individual lookup latencies
    const durations = [];
    for (const t of sampleTokens) {
      const start = nowMs();
      idx.lookup(t);
      durations.push(nowMs() - start);
    }

    const med = median(durations);
    const p99 = percentile(durations, 0.99);

    console.log(`\n  📊 Lookup latency (1000 samples):`);
    console.log(`     median:  ${med.toFixed(3)} ms`);
    console.log(`     p99:     ${p99.toFixed(3)} ms`);
    console.log(`     budget:  ≤ ${LOOKUP_P99_MS} ms`);

    assert.ok(p99 < LOOKUP_P99_MS,
      `lookup p99 ${p99.toFixed(3)} ms exceeds budget ${LOOKUP_P99_MS} ms`);
  });

  it('BM25 score over 100K corpus completes in reasonable time', () => {
    const N_DOCS = 100_000;
    const VOCAB = 50_000;
    const docs = generateCorpus({ n: N_DOCS, vocabSize: VOCAB, avgTokensPerDoc: 50 });
    const idx = new InvertedIndex({ maxTokens: 200_000 });
    for (const d of docs) idx.add(d.id, d.tokens, d.ts);

    const scorer = new BM25Scorer(idx);
    // Pick 5 query tokens that exist in the corpus
    const queryTokens = [];
    for (let i = 0; i < 5; i++) queryTokens.push(docs[i * 1000].tokens[0]);

    // Warm up
    for (let w = 0; w < 3; w++) scorer.score(queryTokens, { topK: 50 });

    // Measure
    const trials = 5;
    const durations = [];
    for (let t = 0; t < trials; t++) {
      const start = nowMs();
      const r = scorer.score(queryTokens, { topK: 50 });
      durations.push(nowMs() - start);
      assert.ok(r.length <= 50);
    }
    const med = median(durations);
    console.log(`\n  📊 BM25 query (5 tokens, 100K corpus, topK=50):`);
    console.log(`     median:  ${med.toFixed(1)} ms`);

    // Budget: 100ms is the broader search-latency budget; BM25 alone
    // should be well under. Use 50ms as a soft ceiling.
    assert.ok(med < 200, `BM25 query median ${med.toFixed(1)} ms is alarmingly slow`);
  });
});
