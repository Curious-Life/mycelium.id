/**
 * inverted.js — InvertedIndex round-trip, eviction, serialization.
 *
 * Core properties:
 *   • add(id, ...) ; remove(id) returns the index to its pre-add state
 *   • serialize → deserialize is identity (lookups return the same)
 *   • eviction at maxTokens drops highest-DF tokens first
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '@mycelium/core/mind-search/index/inverted.js';
import { forAll, gen } from '../../util/property.js';

// ── Helpers ────────────────────────────────────────────────────────────

function snapshot(idx) {
  // Reduce the index to a comparable shape: tokens with sorted postings
  // (by id), plus document map. Used to compare states across mutations.
  const tokens = {};
  for (const [t, list] of idx.postings) {
    tokens[t] = [...list]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => `${p.id}:${p.tf}`);
  }
  const docs = {};
  for (const [id, meta] of idx.documents) {
    docs[id] = `${meta.ts}:${meta.length}`;
  }
  return { tokens, docs, totalLength: idx._totalLength };
}

// ── Constructor ────────────────────────────────────────────────────────

describe('new InvertedIndex()', () => {
  it('starts empty', () => {
    const idx = new InvertedIndex();
    assert.deepEqual(idx.size(), { tokens: 0, documents: 0, totalPostings: 0 });
    assert.equal(idx.totalDocs(), 0);
    assert.equal(idx.avgDocumentLength(), 0);
  });

  it('respects maxTokens option', () => {
    const idx = new InvertedIndex({ maxTokens: 5 });
    assert.equal(idx.maxTokens, 5);
  });

  it('rejects invalid maxTokens', () => {
    assert.throws(() => new InvertedIndex({ maxTokens: 0 }), TypeError);
    assert.throws(() => new InvertedIndex({ maxTokens: -1 }), TypeError);
    assert.throws(() => new InvertedIndex({ maxTokens: 1.5 }), TypeError);
    assert.throws(() => new InvertedIndex({ maxTokens: 'huge' }), TypeError);
  });
});

// ── add / lookup / remove ──────────────────────────────────────────────

describe('add / lookup / remove', () => {
  it('add stores postings by token', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['hello', 'world', 'hello'], 1000);
    assert.deepEqual(idx.lookup('hello'), [{ id: 'doc1', tf: 2 }]);
    assert.deepEqual(idx.lookup('world'), [{ id: 'doc1', tf: 1 }]);
    assert.deepEqual(idx.lookup('missing'), []);
  });

  it('add tracks document length and timestamp', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['hello', 'world', 'hello'], 1234);
    assert.equal(idx.documentLength('doc1'), 3);
    assert.equal(idx.documentTs('doc1'), 1234);
  });

  it('multiple documents share tokens', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['cat', 'mat'], 100);
    idx.add('doc2', ['cat', 'hat'], 200);
    const catList = idx.lookup('cat');
    assert.equal(catList.length, 2);
    assert.ok(catList.some((p) => p.id === 'doc1'));
    assert.ok(catList.some((p) => p.id === 'doc2'));
  });

  it('add is idempotent: re-adding the same id replaces postings', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['cat', 'cat', 'cat'], 100);
    assert.deepEqual(idx.lookup('cat'), [{ id: 'doc1', tf: 3 }]);
    idx.add('doc1', ['cat'], 200); // re-add with new content
    assert.deepEqual(idx.lookup('cat'), [{ id: 'doc1', tf: 1 }]);
    assert.equal(idx.documentTs('doc1'), 200);
  });

  it('remove drops postings and document metadata', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['cat', 'mat'], 100);
    idx.add('doc2', ['cat', 'hat'], 200);
    idx.remove('doc1');
    assert.deepEqual(idx.lookup('cat'), [{ id: 'doc2', tf: 1 }]);
    assert.deepEqual(idx.lookup('mat'), []); // last reference gone, list deleted
    assert.equal(idx.has('doc1'), false);
    assert.equal(idx.has('doc2'), true);
  });

  it('remove on unknown id is a no-op', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['cat'], 100);
    const before = snapshot(idx);
    idx.remove('does-not-exist');
    assert.deepEqual(snapshot(idx), before);
  });

  it('rejects bad inputs to add', () => {
    const idx = new InvertedIndex();
    assert.throws(() => idx.add('', ['t'], 0), TypeError);
    assert.throws(() => idx.add(null, ['t'], 0), TypeError);
    assert.throws(() => idx.add('doc1', ['t'], NaN), TypeError);
    assert.throws(() => idx.add('doc1', ['t'], Infinity), TypeError);
  });

  it('skips empty tokens silently', () => {
    const idx = new InvertedIndex();
    idx.add('doc1', ['hello', '', 'world'], 100);
    assert.equal(idx.documentLength('doc1'), 2); // empty token didn't count
    assert.deepEqual(idx.lookup('hello'), [{ id: 'doc1', tf: 1 }]);
  });
});

// ── Aggregate state ─────────────────────────────────────────────────────

describe('aggregate state', () => {
  it('size() reports correct counts', () => {
    const idx = new InvertedIndex();
    idx.add('a', ['x', 'y'], 1);
    idx.add('b', ['y', 'z'], 2);
    const s = idx.size();
    assert.equal(s.tokens, 3);          // x, y, z
    assert.equal(s.documents, 2);
    assert.equal(s.totalPostings, 4);   // x:1, y:2, z:1
  });

  it('avgDocumentLength reflects all documents', () => {
    const idx = new InvertedIndex();
    idx.add('a', ['x', 'y'], 1);
    idx.add('b', ['x', 'y', 'z'], 2);
    assert.equal(idx.avgDocumentLength(), 2.5);
  });

  it('avgDocumentLength is 0 when empty', () => {
    const idx = new InvertedIndex();
    assert.equal(idx.avgDocumentLength(), 0);
  });

  it('documentFrequency counts unique docs containing token', () => {
    const idx = new InvertedIndex();
    idx.add('a', ['x', 'x', 'x'], 1);  // tf=3 but df=1
    idx.add('b', ['x', 'y'], 2);
    idx.add('c', ['y', 'z'], 3);
    assert.equal(idx.documentFrequency('x'), 2);
    assert.equal(idx.documentFrequency('y'), 2);
    assert.equal(idx.documentFrequency('z'), 1);
    assert.equal(idx.documentFrequency('absent'), 0);
  });
});

// ── Critical property: add+remove returns to pre-add state ─────────────

describe('add ; remove returns to pre-add state', () => {
  it('single add+remove on fresh index yields empty index', () => {
    const idx = new InvertedIndex();
    const before = snapshot(idx);
    idx.add('doc1', ['cat', 'mat', 'cat'], 100);
    idx.remove('doc1');
    assert.deepEqual(snapshot(idx), before);
  });

  it('add+remove on top of existing data is invariant', () => {
    const idx = new InvertedIndex();
    idx.add('seed1', ['a-token', 'b-token'], 50);
    idx.add('seed2', ['b-token', 'c-token'], 60);
    const before = snapshot(idx);

    idx.add('xyz', ['a-token', 'b-token', 'c-token', 'a-token'], 999);
    idx.remove('xyz');

    assert.deepEqual(snapshot(idx), before);
  });

  it('property: random add+remove cycles preserve state', async () => {
    await forAll(
      [
        gen.array(8, gen.oneOf('alpha', 'beta', 'gamma', 'delta', 'eps')),
        gen.int(100, 99999),
      ],
      (tokens, ts) => {
        const idx = new InvertedIndex();
        idx.add('seed', ['anchor1', 'anchor2'], 1);
        const before = snapshot(idx);
        idx.add('volatile', tokens, ts);
        idx.remove('volatile');
        const after = snapshot(idx);
        return JSON.stringify(after) === JSON.stringify(before);
      },
      { name: 'add-remove-invariant', iterations: 50 },
    );
  });
});

// ── Eviction ────────────────────────────────────────────────────────────

describe('eviction at maxTokens', () => {
  it('keeps unique-token count at or below maxTokens', () => {
    const idx = new InvertedIndex({ maxTokens: 3 });
    idx.add('d1', ['a', 'b', 'c', 'd', 'e'], 1);
    assert.ok(idx.size().tokens <= 3, `expected ≤ 3 tokens, got ${idx.size().tokens}`);
  });

  it('evicts highest-DF tokens first (noise-first)', () => {
    const idx = new InvertedIndex({ maxTokens: 2 });
    // Build so 'common' has the unambiguously-highest DF at eviction time.
    idx.add('d1', ['common', 'rare1'], 1);
    idx.add('d2', ['common', 'rare2'], 2);
    // State pre-eviction: {common: df=2, rare1: df=1, rare2: df=1} → size=3.
    // Eviction drops the highest-DF token: 'common'. Survivors: rare1, rare2.
    assert.equal(idx.documentFrequency('common'), 0,
      'highest-DF token "common" should have been evicted');
    assert.equal(idx.documentFrequency('rare1'), 1);
    assert.equal(idx.documentFrequency('rare2'), 1);
    assert.equal(idx.size().tokens, 2);
  });

  it('eviction is bounded but reversible: re-adding evicted tokens works', () => {
    const idx = new InvertedIndex({ maxTokens: 2 });
    idx.add('d1', ['common', 'rare1'], 1);
    idx.add('d2', ['common', 'rare2'], 2);
    // 'common' was evicted. Re-add via a new doc.
    idx.add('d3', ['common', 'rare3'], 3);
    // Now common has df=1 (only d3 sees it post-eviction), tied with others.
    // Eviction picks first-in-Map-order — but the surviving total is ≤ 2.
    assert.ok(idx.size().tokens <= 2);
  });

  it('eviction does not affect document records', () => {
    const idx = new InvertedIndex({ maxTokens: 1 });
    idx.add('d1', ['x', 'y', 'z'], 100);
    idx.add('d2', ['a', 'b', 'c'], 200);
    // Tokens evicted aggressively, but documents remain
    assert.equal(idx.totalDocs(), 2);
    assert.equal(idx.documentLength('d1'), 3);
    assert.equal(idx.documentLength('d2'), 3);
  });
});

// ── Serialize / Deserialize ─────────────────────────────────────────────

describe('serialize / deserialize', () => {
  it('round-trips an empty index', () => {
    const idx = new InvertedIndex();
    const buf = idx.serialize();
    const idx2 = InvertedIndex.deserialize(buf);
    assert.deepEqual(idx2.size(), idx.size());
  });

  it('round-trips a populated index identically', () => {
    const idx = new InvertedIndex({ maxTokens: 999 });
    idx.add('doc1', ['hello', 'world'], 100);
    idx.add('doc2', ['hello', 'mycelium', 'world'], 200);
    idx.add('doc3', ['mycelium', 'mycelium', 'mycelium'], 300);

    const idx2 = InvertedIndex.deserialize(idx.serialize());

    // All postings recovered
    assert.deepEqual(idx2.lookup('hello'), idx.lookup('hello'));
    assert.deepEqual(idx2.lookup('world'), idx.lookup('world'));
    assert.deepEqual(idx2.lookup('mycelium'), idx.lookup('mycelium'));

    // All document metadata recovered
    assert.equal(idx2.documentLength('doc1'), 2);
    assert.equal(idx2.documentLength('doc2'), 3);
    assert.equal(idx2.documentLength('doc3'), 3);
    assert.equal(idx2.documentTs('doc1'), 100);
    assert.equal(idx2.documentTs('doc3'), 300);

    // Aggregates match
    assert.deepEqual(idx2.size(), idx.size());
    assert.equal(idx2.avgDocumentLength(), idx.avgDocumentLength());
    assert.equal(idx2.maxTokens, idx.maxTokens);
  });

  it('property: serialize → deserialize → serialize is fixed point', async () => {
    await forAll(
      [gen.int(1, 30)],
      (n) => {
        const idx = new InvertedIndex();
        for (let i = 0; i < n; i++) {
          idx.add(`doc-${i}`, [`tok-${i % 3}`, `tok-${i % 5}`, `tok-${i}`], i * 10);
        }
        const round1 = idx.serialize().toString('utf8');
        const idx2 = InvertedIndex.deserialize(round1);
        const round2 = idx2.serialize().toString('utf8');
        return round1 === round2;
      },
      { name: 'serialize-fixed-point', iterations: 30 },
    );
  });

  it('rejects invalid input', () => {
    assert.throws(() => InvertedIndex.deserialize(123), TypeError);
    assert.throws(() => InvertedIndex.deserialize(null), TypeError);
    assert.throws(() => InvertedIndex.deserialize('not json'), /malformed JSON/);
    assert.throws(
      () => InvertedIndex.deserialize(JSON.stringify({ v: 99, tokens: [], docs: [] })),
      /unsupported schema version/,
    );
    assert.throws(
      () => InvertedIndex.deserialize(JSON.stringify({ v: 1, tokens: 'not-array', docs: [] })),
      /malformed payload/,
    );
  });

  it('accepts Buffer, Uint8Array, and string', () => {
    const idx = new InvertedIndex();
    idx.add('d1', ['x'], 1);
    const buf = idx.serialize();
    const str = buf.toString('utf8');
    const u8 = new Uint8Array(buf);

    assert.equal(InvertedIndex.deserialize(buf).totalDocs(), 1);
    assert.equal(InvertedIndex.deserialize(str).totalDocs(), 1);
    assert.equal(InvertedIndex.deserialize(u8).totalDocs(), 1);
  });
});
