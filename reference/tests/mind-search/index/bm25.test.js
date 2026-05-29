/**
 * bm25.js — BM25 scorer property and regression tests.
 *
 * Properties:
 *   • Monotonic in TF (more occurrences → higher score, df fixed)
 *   • Decreasing in DF (rarer term → higher score, tf fixed)
 *   • Zero score for empty query / unknown tokens
 *   • Stable under document-insertion order
 *
 * Regression: hand-computed BM25 values for fixed inputs.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '@mycelium/core/mind-search/index/inverted.js';
import { score, BM25Scorer } from '@mycelium/core/mind-search/index/bm25.js';
import { forAll, gen } from '../../util/property.js';

// ── Helpers ────────────────────────────────────────────────────────────

function buildIndex(docs) {
  // docs: Array<{ id, tokens, ts? }>
  const idx = new InvertedIndex();
  for (const d of docs) {
    idx.add(d.id, d.tokens, d.ts ?? 0);
  }
  return idx;
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Constructor / dep validation ───────────────────────────────────────

describe('BM25Scorer — constructor', () => {
  it('rejects bad index argument', () => {
    assert.throws(() => new BM25Scorer(null), TypeError);
    assert.throws(() => new BM25Scorer({}), TypeError);
  });

  it('rejects out-of-range k1 / b', () => {
    const idx = new InvertedIndex();
    assert.throws(() => new BM25Scorer(idx, { k1: -0.1 }), TypeError);
    assert.throws(() => new BM25Scorer(idx, { b: -0.1 }), TypeError);
    assert.throws(() => new BM25Scorer(idx, { b: 1.1 }), TypeError);
  });

  it('uses standard defaults (k1=1.5, b=0.75)', () => {
    const s = new BM25Scorer(new InvertedIndex());
    assert.equal(s.k1, 1.5);
    assert.equal(s.b, 0.75);
  });
});

// ── Empty / edge cases ─────────────────────────────────────────────────

describe('score() — edge cases', () => {
  it('returns [] for empty index', () => {
    const idx = new InvertedIndex();
    assert.deepEqual(score(['hello'], idx), []);
  });

  it('returns [] for empty query', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['hello', 'world'] }]);
    assert.deepEqual(score([], idx), []);
    assert.deepEqual(score([''], idx), []);
  });

  it('returns [] when no query tokens match the corpus', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['hello', 'world'] }]);
    assert.deepEqual(score(['unknown', 'token'], idx), []);
  });

  it('skips empty / non-string tokens in query', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['hello'] }]);
    const r = score(['', null, undefined, 'hello', 0], idx);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'd1');
  });

  it('deduplicates repeated query tokens', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['cat', 'mat'] }]);
    const r1 = score(['cat'], idx);
    const r2 = score(['cat', 'cat', 'cat'], idx);
    assert.ok(close(r1[0].score, r2[0].score),
      `repeated query tokens should not amplify score: ${r1[0].score} vs ${r2[0].score}`);
  });

  it('topK trims results to requested size', () => {
    const idx = buildIndex([
      { id: 'd1', tokens: ['cat', 'cat', 'cat'] },
      { id: 'd2', tokens: ['cat'] },
      { id: 'd3', tokens: ['cat', 'cat'] },
    ]);
    const r = score(['cat'], idx, { topK: 2 });
    assert.equal(r.length, 2);
  });
});

// ── Sort order / determinism ────────────────────────────────────────────

describe('score() — sort + determinism', () => {
  it('returns descending by score', () => {
    const idx = buildIndex([
      { id: 'd1', tokens: ['cat'] },
      { id: 'd2', tokens: ['cat', 'cat', 'cat'] },
      { id: 'd3', tokens: ['cat', 'cat'] },
    ]);
    const r = score(['cat'], idx);
    for (let i = 1; i < r.length; i++) {
      assert.ok(r[i - 1].score >= r[i].score);
    }
  });

  it('breaks ties by lexicographic id (deterministic)', () => {
    const idx = buildIndex([
      { id: 'b', tokens: ['x'] },
      { id: 'a', tokens: ['x'] },
      { id: 'c', tokens: ['x'] },
    ]);
    const r = score(['x'], idx);
    // All three docs have identical structure → identical score → sorted a, b, c
    assert.deepEqual(r.map((h) => h.id), ['a', 'b', 'c']);
  });

  it('result is independent of insertion order', () => {
    const docs1 = [
      { id: 'd1', tokens: ['apple', 'banana'] },
      { id: 'd2', tokens: ['apple', 'apple'] },
      { id: 'd3', tokens: ['banana'] },
    ];
    const docs2 = [...docs1].reverse();
    const r1 = score(['apple', 'banana'], buildIndex(docs1));
    const r2 = score(['apple', 'banana'], buildIndex(docs2));
    assert.deepEqual(
      r1.map((h) => `${h.id}:${h.score.toFixed(8)}`),
      r2.map((h) => `${h.id}:${h.score.toFixed(8)}`),
    );
  });
});

// ── Properties ──────────────────────────────────────────────────────────

describe('score() — properties', () => {
  it('monotonic in tf: more occurrences → higher score (df fixed)', async () => {
    await forAll(
      [gen.int(1, 10), gen.int(1, 5)],
      (extraTfInDoc1, dfNeeded) => {
        // Two docs with same tokens-other; doc1 has 'target' once, doc2 has it 1+extra times.
        const others = ['filler', 'words'];
        // Add other documents to set DF properly.
        const docs = [
          { id: 'd1', tokens: [...others, 'target'] },
          { id: 'd2', tokens: [...others, ...Array(extraTfInDoc1 + 1).fill('target')] },
        ];
        // Add dfNeeded extra docs without 'target' to fix corpus stats.
        for (let i = 0; i < dfNeeded; i++) docs.push({ id: `nox-${i}`, tokens: ['unrelated'] });
        const idx = buildIndex(docs);
        const r = score(['target'], idx);
        const d1 = r.find((h) => h.id === 'd1');
        const d2 = r.find((h) => h.id === 'd2');
        if (!d1 || !d2) return false;
        // Higher tf → higher score (when adjusted for length)
        // d2 has more occurrences but is also longer; standard BM25 with
        // length normalization may saturate. We check that d2 ≥ d1 (not <).
        return d2.score >= d1.score - 1e-9;
      },
      { name: 'monotonic-in-tf', iterations: 30 },
    );
  });

  it('decreasing in df: rarer term → higher score (tf fixed)', () => {
    // Build a corpus where 'rare' appears in 1 doc and 'common' appears in many.
    // Both occur tf=1 in doc 'd1'. Score for the rarer term should be higher.
    const docs = [
      { id: 'd1', tokens: ['rare', 'common', 'word', 'word', 'word'] },
    ];
    for (let i = 0; i < 20; i++) {
      docs.push({ id: `c${i}`, tokens: ['common', 'word'] });
    }
    const idx = buildIndex(docs);
    const r = new BM25Scorer(idx);
    const rareScore = r.idf('rare');
    const commonScore = r.idf('common');
    assert.ok(rareScore > commonScore,
      `IDF(rare)=${rareScore} should exceed IDF(common)=${commonScore}`);
  });

  it('IDF stays non-negative even when token is in majority of docs', () => {
    // A token appearing in ALL N docs would normally have negative log
    // ((N - df + 0.5) / (df + 0.5)) when df > N/2. The "+1" inside Math.log
    // keeps it non-negative.
    const docs = [];
    for (let i = 0; i < 50; i++) docs.push({ id: `d${i}`, tokens: ['ubiquitous', `unique${i}`] });
    const idx = buildIndex(docs);
    const r = new BM25Scorer(idx);
    assert.ok(r.idf('ubiquitous') >= 0);
  });

  it('property: query-token order does not affect total scores', async () => {
    const docs = [
      { id: 'd1', tokens: ['alpha', 'beta', 'gamma'] },
      { id: 'd2', tokens: ['beta', 'gamma'] },
      { id: 'd3', tokens: ['alpha', 'gamma'] },
    ];
    const idx = buildIndex(docs);
    await forAll(
      [gen.array(3, gen.oneOf('alpha', 'beta', 'gamma'))],
      (q) => {
        const sum1 = score(q, idx).reduce((s, h) => s + h.score, 0);
        const reversed = [...q].reverse();
        const sum2 = score(reversed, idx).reduce((s, h) => s + h.score, 0);
        return Math.abs(sum1 - sum2) < 1e-9;
      },
      { name: 'order-invariant', iterations: 30 },
    );
  });
});

// ── IDF caching ────────────────────────────────────────────────────────

describe('BM25Scorer — IDF caching', () => {
  it('caches IDF values across score() calls', () => {
    const idx = buildIndex([
      { id: 'd1', tokens: ['x', 'y'] },
      { id: 'd2', tokens: ['x'] },
    ]);
    const s = new BM25Scorer(idx);
    const before = s.idf('x');
    const after = s.idf('x');
    assert.equal(before, after);
    // Internal cache populated
    assert.ok(s._idfCache.has('x'));
  });

  it('invalidate() clears IDF cache and refreshes aggregates', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['x'] }]);
    const s = new BM25Scorer(idx);
    s.idf('x'); // populate cache
    assert.ok(s._idfCache.has('x'));
    idx.add('d2', ['x', 'x'], 100);
    s.invalidate();
    assert.equal(s._idfCache.size, 0);
    assert.equal(s._cachedN, 2);
    assert.equal(s._cachedAvgdl, 1.5);
  });

  it('IDF returns 0 for unknown tokens', () => {
    const idx = buildIndex([{ id: 'd1', tokens: ['x'] }]);
    const s = new BM25Scorer(idx);
    assert.equal(s.idf('does-not-exist'), 0);
  });

  it('IDF returns 0 for empty index', () => {
    const s = new BM25Scorer(new InvertedIndex());
    assert.equal(s.idf('anything'), 0);
  });
});

// ── Regression: hand-computed values ───────────────────────────────────

describe('score() — regression with hand-computed values', () => {
  it('single-doc, single-token corpus', () => {
    // N=1, df=1, dl=1, avgdl=1
    // IDF(t) = ln((1 - 1 + 0.5) / (1 + 0.5) + 1) = ln(0.5/1.5 + 1) = ln(1.333) ≈ 0.2877
    // tf=1, k1=1.5, b=0.75
    // norm = 1 - 0.75 + 0.75 * (1/1) = 1
    // tfPart = (1 * 2.5) / (1 + 1.5 * 1) = 2.5 / 2.5 = 1
    // score = 0.2877 * 1 = 0.2877
    const idx = buildIndex([{ id: 'd1', tokens: ['t'] }]);
    const r = score(['t'], idx);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'd1');
    assert.ok(close(r[0].score, Math.log(1.333_333_333), 1e-3),
      `expected ≈ 0.2877, got ${r[0].score}`);
  });

  it('multi-doc corpus produces ranked results', () => {
    // 3 docs, target 'cat' appears in different tf:
    //   d1: tf=3, dl=3
    //   d2: tf=1, dl=2 (other word for length)
    //   d3: tf=1, dl=5 (lots of unrelated)
    // avgdl = (3+2+5)/3 = 3.333
    // df(cat) = 3, N = 3 → IDF = ln((3-3+0.5)/(3+0.5) + 1) = ln(0.143 + 1) ≈ 0.1335
    const idx = buildIndex([
      { id: 'd1', tokens: ['cat', 'cat', 'cat'] },
      { id: 'd2', tokens: ['cat', 'mat'] },
      { id: 'd3', tokens: ['cat', 'a-token', 'b-token', 'c-token', 'd-token'] },
    ]);
    const r = score(['cat'], idx);
    assert.equal(r.length, 3);
    // d1 should top because tf is highest and dl is below avgdl
    assert.equal(r[0].id, 'd1');
    // d2 should beat d3 because dl is shorter (less penalty)
    const d2 = r.find((h) => h.id === 'd2');
    const d3 = r.find((h) => h.id === 'd3');
    assert.ok(d2.score > d3.score, `d2(dl=2)=${d2.score} should exceed d3(dl=5)=${d3.score}`);
  });
});
