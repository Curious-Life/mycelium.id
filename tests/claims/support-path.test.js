// tests/claims/support-path.test.js — support-path rendering, budgeted
// selection (PersonaTree Eq. 5), and query-level routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxTokens, renderPath, selectUnderBudget, renderClaimsBlock } from '../../src/claims/support-path.js';
import { routeLevel } from '../../src/claims/route.js';

const CLAIM = {
  id: 'c1', claimType: 'value', content: 'The user values hands-on, social learning.', confidence: 0.82,
  supportMids: [{ name: 'Collaborative learning', essence: 'prefers peer/workshop settings' }],
  supportLeaves: [
    { snippet: 'A live Q&A with a retired athlete felt especially insightful.', ts: '2026-05-03T16:57:00Z' },
    { snippet: 'An organized tour felt too rigid; spontaneous visits felt better.', ts: '2026-05-28T18:42:00Z' },
  ],
};

test('renderPath depth 0 = claim only', () => {
  const r = renderPath(CLAIM, 0);
  assert.match(r, /\[Claim\] value: The user values hands-on/);
  assert.match(r, /confidence 0\.82/);
  assert.ok(!/\[Pattern\]/.test(r) && !/\[Evidence\]/.test(r));
});

test('renderPath depth 1 adds the mid; depth 2 adds leaves (claim-before-evidence order)', () => {
  const d1 = renderPath(CLAIM, 1);
  assert.match(d1, /\[Pattern\] Collaborative learning/);
  assert.ok(!/\[Evidence\]/.test(d1));

  const d2 = renderPath(CLAIM, 2);
  assert.match(d2, /\[Evidence\] A live Q&A/);
  assert.match(d2, /\(2026-05-03\)/);
  // Claim line comes before pattern, pattern before evidence.
  assert.ok(d2.indexOf('[Claim]') < d2.indexOf('[Pattern]'));
  assert.ok(d2.indexOf('[Pattern]') < d2.indexOf('[Evidence]'));
});

test('depth clamps to [0,2] and a contentless claim renders empty', () => {
  assert.equal(renderPath({}, 1), '');
  assert.equal(renderPath(CLAIM, 9), renderPath(CLAIM, 2));
});

test('approxTokens ~ len/4', () => {
  assert.equal(approxTokens('12345678'), 2);
  assert.equal(approxTokens(''), 0);
});

test('selectUnderBudget never exceeds the budget, prefers value density', () => {
  const items = [
    { text: 'x'.repeat(400), score: 0.9, key: 'big' },   // 100 tokens
    { text: 'y'.repeat(40), score: 0.8, key: 'small' },  // 10 tokens
    { text: 'z'.repeat(40), score: 0.7, key: 'small2' }, // 10 tokens
  ];
  const chosen = selectUnderBudget(items, 25);
  const total = chosen.reduce((n, c) => n + c.tokens, 0);
  assert.ok(total <= 25, `total ${total} > 25`);
  // The two small high-density items fit; the big one does not.
  assert.deepEqual(chosen.map((c) => c.key).sort(), ['small', 'small2']);
});

test('renderClaimsBlock drops claims that do not fit (not truncated)', () => {
  const claims = [
    { id: 'a', content: 'A'.repeat(40), confidence: 0.9 },
    { id: 'b', content: 'B'.repeat(2000), confidence: 0.4 }, // too big for the budget
  ];
  const block = renderClaimsBlock(claims, { depth: 0, budgetTokens: 30 });
  assert.match(block, /AAAA/);
  assert.ok(!/BBBB/.test(block), 'oversized low-confidence claim dropped whole');
});

test('routeLevel: claim cues → claim/depth0', () => {
  for (const q of ['Why do I value a short commute?', 'What are my core values?', 'What boundaries do I have?']) {
    assert.deepEqual(routeLevel(q), { level: 'claim', depth: 0 });
  }
});

test('routeLevel: event cues → event/depth2', () => {
  for (const q of ['When did I last go hiking?', 'What did I do yesterday?']) {
    assert.deepEqual(routeLevel(q), { level: 'event', depth: 2 });
  }
});

test('routeLevel: pattern cues + default → pattern/depth1', () => {
  assert.deepEqual(routeLevel('What do I usually eat for breakfast?'), { level: 'pattern', depth: 1 });
  assert.deepEqual(routeLevel('tell me about my mornings'), { level: 'pattern', depth: 1 });
});
