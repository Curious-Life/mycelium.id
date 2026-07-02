// tests/mindscape-coverage-summary.test.js — coverageSummary() rollup mapping.
// Stubs d1Query (the harness pattern) to return canned rows for the 3 coverage
// queries and asserts the namespace maps them to the documented shape:
//   territories.{total,described←started,fullyDescribed←fully,avgPercent←avg_pct}
//   themes/realms.{total,avgPercent}, overall.avgPercent = territory weighted avg.
// Design: docs/COVERAGE-VISIBILITY-AND-DESCRIBE-MORE-DESIGN-2026-06-30.md
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMindscapeNamespace } from '../src/db/mindscape.js';

// Route the 3 coverageSummary queries by their distinguishing SQL fragments.
function d1QueryStub() {
  return async (sql) => {
    if (/AS fully/.test(sql) && /FROM territory_profiles\s+WHERE/i.test(sql) && !/GROUP BY/i.test(sql)) {
      return { results: [{ total: 10, fully: 2, started: 7, avg_pct: 40 }] }; // territory level
    }
    if (/semantic_theme_id IS NOT NULL/.test(sql)) {
      return { results: [{ total: 5, avg_pct: 55 }] }; // theme rollup
    }
    if (/realm_id IS NOT NULL/.test(sql) && !/semantic_theme_id/.test(sql)) {
      return { results: [{ total: 3, avg_pct: 60 }] }; // realm rollup
    }
    return { results: [] };
  };
}

describe('mindscape.coverageSummary', () => {
  const ns = createMindscapeNamespace({ d1Query: d1QueryStub(), parseJson: JSON.parse });

  it('maps territory/theme/realm rows to the documented coverage shape', async () => {
    const c = await ns.coverageSummary('local-user');
    assert.deepEqual(c.territories, { total: 10, described: 7, fullyDescribed: 2, avgPercent: 40 });
    assert.deepEqual(c.themes, { total: 5, avgPercent: 55 });
    assert.deepEqual(c.realms, { total: 3, avgPercent: 60 });
    assert.equal(c.overall.avgPercent, 40); // overall = territory message-weighted avg
  });

  it('returns zeros (never throws/NaN) on an empty vault', async () => {
    const empty = createMindscapeNamespace({ d1Query: async () => ({ results: [] }), parseJson: JSON.parse });
    const c = await empty.coverageSummary('local-user');
    assert.deepEqual(c.territories, { total: 0, described: 0, fullyDescribed: 0, avgPercent: 0 });
    assert.equal(c.themes.total, 0);
    assert.equal(c.realms.avgPercent, 0);
    assert.equal(c.overall.avgPercent, 0);
  });
});
