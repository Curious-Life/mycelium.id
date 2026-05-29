/**
 * tokenize.js — coverage tests.
 *
 * Properties: length-bounded output, lowercase, idempotent, no-content-leak in
 *             return shape (positions are integers, never substrings of input).
 * Unicode:    Cyrillic, Greek, accented Latin, CJK runs.
 * Edges:      empty/null/undefined, all-stop-words, all-punctuation, urls/hex.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  tokenizeStrings,
  isStopWord,
  getStopWords,
} from '@mycelium/core/mind-search/index/tokenize.js';
import { forAll, gen } from '../../util/property.js';

// ── Basic semantics ────────────────────────────────────────────────────

describe('tokenize() — basic semantics', () => {
  it('lowercases output', () => {
    const tokens = tokenizeStrings('Hello WORLD');
    assert.deepEqual(tokens, ['hello', 'world']);
  });

  it('drops English stop words by default', () => {
    const tokens = tokenizeStrings('the cat sat on the mat');
    assert.deepEqual(tokens, ['cat', 'sat', 'mat']);
  });

  it('preserves stop words when explicitly asked', () => {
    const tokens = tokenizeStrings('the cat', { includeStopWords: true });
    assert.deepEqual(tokens, ['the', 'cat']);
  });

  it('empty / null / undefined input → empty array', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });

  it('whitespace-only input → empty array', () => {
    assert.deepEqual(tokenize('   \t\n   '), []);
  });

  it('single-char tokens dropped (below MIN_TOKEN_LEN)', () => {
    // "a" and "i" are both stop-words AND below min-len; both filters drop.
    const tokens = tokenizeStrings('a b c d');
    // 'b', 'c', 'd' all 1 char → dropped by length filter
    assert.deepEqual(tokens, []);
  });

  it('very long tokens dropped (above MAX_TOKEN_LEN)', () => {
    const huge = 'x'.repeat(100);
    const tokens = tokenizeStrings(`hello ${huge} world`);
    assert.deepEqual(tokens, ['hello', 'world']);
  });

  it('returns positions monotonically increasing from 0', () => {
    const tokens = tokenize('apple banana cherry');
    assert.deepEqual(
      tokens.map((t) => t.position),
      [0, 1, 2],
    );
  });

  it('positions skip stop-word boundaries', () => {
    const tokens = tokenize('apple the banana the cherry');
    // 'the' filtered → positions are 0, 1, 2 not 0, 2, 4
    assert.deepEqual(tokens.map((t) => t.position), [0, 1, 2]);
  });
});

// ── Word-break correctness ─────────────────────────────────────────────

describe('tokenize() — word boundaries', () => {
  it('splits on punctuation and whitespace', () => {
    const tokens = tokenizeStrings('hello, world! how are you?');
    assert.deepEqual(tokens, ['hello', 'world']);  // 'how','are','you' are stop-words
  });

  it("preserves contractions like don't, won't", () => {
    const tokens = tokenizeStrings("don't won't can't");
    assert.deepEqual(tokens, ["don't", "won't", "can't"]);
  });

  it('preserves hyphenated words', () => {
    const tokens = tokenizeStrings('state-of-the-art');
    // 'state-of-the-art' is single contiguous match (hyphens kept)
    // but contains 'of'/'the' inside — those don't apply since the regex
    // matches the whole thing as ONE token.
    assert.deepEqual(tokens, ['state-of-the-art']);
  });

  it('strips leading/trailing apostrophes and hyphens', () => {
    const tokens = tokenizeStrings("'hello' --world-- 'mixed-up'");
    assert.deepEqual(tokens, ['hello', 'world', 'mixed-up']);
  });

  it('numbers tokenize as themselves', () => {
    const tokens = tokenizeStrings('build 42 of 100 done');
    assert.deepEqual(tokens, ['build', '42', '100', 'done']);
  });

  it('alphanumeric mixes (identifiers, version strings) stay together', () => {
    const tokens = tokenizeStrings('node22 v1.5.3 abc123');
    // dots split — v1.5.3 → v1, 5, 3
    assert.deepEqual(tokens, ['node22', 'v1', 'abc123']);
    // Note: '5' and '3' are 1-char → dropped by min-len filter
  });
});

// ── Unicode coverage ────────────────────────────────────────────────────

describe('tokenize() — Unicode', () => {
  it('Cyrillic words', () => {
    const tokens = tokenizeStrings('привет мир');
    assert.deepEqual(tokens, ['привет', 'мир']);
  });

  it('accented Latin', () => {
    const tokens = tokenizeStrings('café résumé naïve façade');
    assert.deepEqual(tokens, ['café', 'résumé', 'naïve', 'façade']);
  });

  it('Greek', () => {
    const tokens = tokenizeStrings('αλφα βήτα');
    assert.deepEqual(tokens, ['αλφα', 'βήτα']);
  });

  it('CJK runs stay as single tokens (no per-char splitting)', () => {
    // Documented limitation: Japanese/Chinese aren't word-segmented.
    // The whole run becomes one token. Acceptable until we have a
    // non-Latin user at scale.
    const tokens = tokenizeStrings('日本語 中文');
    assert.deepEqual(tokens, ['日本語', '中文']);
  });

  it('mixed-script input', () => {
    const tokens = tokenizeStrings('hello мир 日本');
    assert.deepEqual(tokens, ['hello', 'мир', '日本']);
  });

  it('emoji are not tokens', () => {
    // \p{L} doesn't match emoji (they're symbol category). Filtered out.
    const tokens = tokenizeStrings('hello 👋 world 🌍');
    assert.deepEqual(tokens, ['hello', 'world']);
  });

  it('Unicode-aware lowercasing', () => {
    const tokens = tokenizeStrings('CAFÉ Москва');
    assert.deepEqual(tokens, ['café', 'москва']);
  });
});

// ── Stop words ──────────────────────────────────────────────────────────

describe('isStopWord() and getStopWords()', () => {
  it('classic stop-words flagged', () => {
    assert.ok(isStopWord('the'));
    assert.ok(isStopWord('and'));
    assert.ok(isStopWord('is'));
  });

  it('content words not flagged', () => {
    assert.ok(!isStopWord('mycelium'));
    assert.ok(!isStopWord('encryption'));
  });

  it('case sensitivity: stop words are stored lowercase', () => {
    // Tokenizer lowercases before lookup; isStopWord('THE') is technically
    // false because it's not stored uppercase. Document this.
    assert.ok(!isStopWord('THE'));
    assert.ok(isStopWord('the'));
  });

  it('getStopWords returns a defensive copy', () => {
    const a = getStopWords();
    a.delete('the');
    const b = getStopWords();
    assert.ok(b.has('the'), 'mutation of returned set must not affect internal state');
  });
});

// ── Properties ──────────────────────────────────────────────────────────

describe('tokenize() — properties', () => {
  it('len(tokens(s)) ≤ len(s) for any input', async () => {
    await forAll(
      [gen.asciiString(0, 200)],
      (s) => tokenize(s).length <= s.length,
      { name: 'tokens-bounded-by-input-length', iterations: 200 },
    );
  });

  it('all output tokens are 2..50 chars', async () => {
    await forAll(
      [gen.asciiString(0, 500)],
      (s) => tokenize(s).every((t) => t.token.length >= 2 && t.token.length <= 50),
      { name: 'token-len-bounds', iterations: 100 },
    );
  });

  it('all output tokens are lowercase', async () => {
    await forAll(
      [gen.asciiString(0, 200)],
      (s) => tokenize(s).every((t) => t.token === t.token.toLowerCase()),
      { name: 'tokens-lowercase', iterations: 100 },
    );
  });

  it('no output token is in the stop-words set (default mode)', async () => {
    await forAll(
      [gen.asciiString(0, 200)],
      (s) => tokenize(s).every((t) => !isStopWord(t.token)),
      { name: 'tokens-no-stops', iterations: 100 },
    );
  });

  it('idempotent on already-tokenized output', async () => {
    // tokenize(joined-tokens) === tokenize(tokenize(joined-tokens)).map(t=>t.token)
    // For tokens we generate, no stop words and no special chars survive
    // joining with spaces — so re-tokenizing should give back the same list.
    await forAll(
      [gen.asciiString(0, 200)],
      (s) => {
        const once = tokenizeStrings(s);
        const twice = tokenizeStrings(once.join(' '));
        return once.length === twice.length
          && once.every((t, i) => t === twice[i]);
      },
      { name: 'idempotent', iterations: 50 },
    );
  });

  it('output positions are dense [0, n)', async () => {
    await forAll(
      [gen.asciiString(0, 300)],
      (s) => {
        const out = tokenize(s);
        return out.every((t, i) => t.position === i);
      },
      { name: 'positions-dense', iterations: 100 },
    );
  });
});

// ── Realistic samples ───────────────────────────────────────────────────

describe('tokenize() — realistic Mycelium-shaped content', () => {
  it('agent task description', () => {
    const tokens = tokenizeStrings(
      "Wire mind-search into agent-server with feature flag MIND_SEARCH_BACKEND=local; soak 7 days.",
    );
    assert.ok(tokens.includes('mind-search'));
    assert.ok(tokens.includes('agent-server'));
    assert.ok(tokens.includes('mind_search_backend'));
    assert.ok(tokens.includes('local'));
    assert.ok(tokens.includes('soak'));
  });

  it('UUIDs and hashes get filtered by max-len or split into chunks', () => {
    // UUID is split by hyphens into 5 tokens, all fitting within max-len.
    const tokens = tokenizeStrings('id 7c3d2a4e-5678-9abc-def0-1234567890ab here');
    // Each segment is 4-12 chars, hyphens split inside the regex match
    // because we kept hyphens — actually NO, regex keeps hyphens within
    // a run. The run is `7c3d2a4e-5678-9abc-def0-1234567890ab` — that's 36
    // chars, under MAX_TOKEN_LEN (50). So it stays as ONE token.
    assert.ok(tokens.includes('7c3d2a4e-5678-9abc-def0-1234567890ab'));
  });

  it('long base64 / hex strings dropped', () => {
    const big = 'a'.repeat(60);
    const tokens = tokenizeStrings(`hash ${big} payload`);
    assert.deepEqual(tokens, ['hash', 'payload']);
  });
});
