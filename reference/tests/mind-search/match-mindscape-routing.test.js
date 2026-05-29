/**
 * Contract tests for matchTerritories / matchRealms / matchThemes
 * (db.search) and matchDocuments (db.messages) — Wave 4b (no
 * Vectorize fallback). Scan-matchers are the only path; empty or
 * unregistered → return [].
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSearchNamespace } from '../../packages/core/db-d1/search.js';
import { createMessagesNamespace } from '../../packages/core/db-d1/messages.js';
import {
  setScanMatcher,
  clearScanMatchers,
} from '../../packages/core/mind-search/scan-matcher-registry.js';
import {
  clearMindSearch,
} from '../../packages/core/mind-search/registry.js';

function makeSearchDeps({ d1Rows = [] } = {}) {
  const d1Calls = [];
  return {
    d1Query: async (sql, params) => {
      d1Calls.push({ sql, params });
      return { results: d1Rows };
    },
    parseJson: (v) => {
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
    },
    _calls: { d1Calls },
  };
}

function makeMessagesDeps(opts) {
  const base = makeSearchDeps(opts);
  return {
    ...base,
    d1Batch: async () => [],
    firstRow: (r) => (r?.results || [])[0] || null,
  };
}

function makeScanMatcher({ hits = [], throwOnSearch = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    async search(vec, topK) {
      calls.push({ vec, topK });
      if (throwOnSearch) throw new Error('scan-matcher exploded');
      return hits;
    },
    async preload() { return { loaded: hits.length, decryptFailed: 0, elapsedMs: 0 }; },
  };
}

const QUERY_VEC = Float32Array.from([0.1, 0.2, 0.3]);

describe('matchTerritories routing (Wave 4b — no Vectorize fallback)', () => {
  beforeEach(() => clearScanMatchers());
  afterEach(() => clearScanMatchers());

  it('returns scan-matcher hits hydrated from D1', async () => {
    setScanMatcher('territory_profiles', makeScanMatcher({
      hits: [{ id: 't1', score: 0.9 }, { id: 't2', score: 0.7 }],
    }));
    const deps = makeSearchDeps({
      d1Rows: [
        { id: 't1', territory_id: 1, name: 'A', essence: '...', message_count: 5, top_entities: '[]' },
        { id: 't2', territory_id: 2, name: 'B', essence: '...', message_count: 3, top_entities: '[]' },
      ],
    });
    const ns = createSearchNamespace(deps);
    const out = await ns.matchTerritories(QUERY_VEC, 'u1', 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].similarity, 0.9);
  });

  it('returns [] when scan-matcher returns empty', async () => {
    setScanMatcher('territory_profiles', makeScanMatcher({ hits: [] }));
    const ns = createSearchNamespace(makeSearchDeps());
    assert.deepEqual(await ns.matchTerritories(QUERY_VEC, 'u1', 5), []);
  });

  it('returns [] when scan-matcher throws', async () => {
    setScanMatcher('territory_profiles', makeScanMatcher({ throwOnSearch: true }));
    const ns = createSearchNamespace(makeSearchDeps());
    assert.deepEqual(await ns.matchTerritories(QUERY_VEC, 'u1', 5), []);
  });

  it('returns [] when registry empty', async () => {
    const ns = createSearchNamespace(makeSearchDeps());
    assert.deepEqual(await ns.matchTerritories(QUERY_VEC, 'u1', 5), []);
  });

  it('hydrate query filters by user_id', async () => {
    setScanMatcher('territory_profiles', makeScanMatcher({
      hits: [{ id: 't1', score: 0.9 }],
    }));
    const deps = makeSearchDeps({
      d1Rows: [{ id: 't1', territory_id: 1, name: 'A', essence: '', message_count: 5, top_entities: '[]' }],
    });
    const ns = createSearchNamespace(deps);
    await ns.matchTerritories(QUERY_VEC, 'u1', 5);
    const sql = deps._calls.d1Calls[deps._calls.d1Calls.length - 1].sql;
    const params = deps._calls.d1Calls[deps._calls.d1Calls.length - 1].params;
    assert.match(sql, /user_id = \?/);
    assert.equal(params[0], 'u1');
  });
});

describe('matchRealms routing (Wave 4b)', () => {
  beforeEach(() => clearScanMatchers());
  afterEach(() => clearScanMatchers());

  it('returns scan-matcher hits hydrated', async () => {
    setScanMatcher('realms', makeScanMatcher({ hits: [{ id: 'r1', score: 0.85 }] }));
    const deps = makeSearchDeps({
      d1Rows: [{ id: 'r1', realm_id: 1, name: 'R', essence: '', territory_count: 5, message_count: 10 }],
    });
    const ns = createSearchNamespace(deps);
    const out = await ns.matchRealms(QUERY_VEC, 'u1', 5);
    assert.equal(out[0].similarity, 0.85);
  });

  it('hydrate query filters by user_id', async () => {
    setScanMatcher('realms', makeScanMatcher({ hits: [{ id: 'r1', score: 0.5 }] }));
    const deps = makeSearchDeps({
      d1Rows: [{ id: 'r1', realm_id: 1, name: 'R', essence: '', territory_count: 0, message_count: 0 }],
    });
    const ns = createSearchNamespace(deps);
    await ns.matchRealms(QUERY_VEC, 'u1', 5);
    const last = deps._calls.d1Calls[deps._calls.d1Calls.length - 1];
    assert.match(last.sql, /user_id = \?/);
    assert.equal(last.params[0], 'u1');
  });

  it('returns [] when matcher empty/unregistered', async () => {
    const ns = createSearchNamespace(makeSearchDeps());
    assert.deepEqual(await ns.matchRealms(QUERY_VEC, 'u1', 5), []);
    setScanMatcher('realms', makeScanMatcher({ hits: [] }));
    assert.deepEqual(await ns.matchRealms(QUERY_VEC, 'u1', 5), []);
  });
});

describe('matchThemes routing (Wave 4b)', () => {
  beforeEach(() => clearScanMatchers());
  afterEach(() => clearScanMatchers());

  it('returns scan-matcher hits hydrated', async () => {
    setScanMatcher('semantic_themes', makeScanMatcher({ hits: [{ id: 'th1', score: 0.77 }] }));
    const deps = makeSearchDeps({
      d1Rows: [{ id: 'th1', semantic_theme_id: 1, name: 'T', essence: '', territory_count: 2, message_count: 5 }],
    });
    const ns = createSearchNamespace(deps);
    const out = await ns.matchThemes(QUERY_VEC, 'u1', 5);
    assert.equal(out[0].similarity, 0.77);
  });

  it('hydrate query filters by user_id', async () => {
    setScanMatcher('semantic_themes', makeScanMatcher({ hits: [{ id: 'th1', score: 0.5 }] }));
    const deps = makeSearchDeps({
      d1Rows: [{ id: 'th1', semantic_theme_id: 1, name: 'T', essence: '', territory_count: 0, message_count: 0 }],
    });
    const ns = createSearchNamespace(deps);
    await ns.matchThemes(QUERY_VEC, 'u1', 5);
    const last = deps._calls.d1Calls[deps._calls.d1Calls.length - 1];
    assert.match(last.sql, /user_id = \?/);
    assert.equal(last.params[0], 'u1');
  });

  it('returns [] when registry empty', async () => {
    const ns = createSearchNamespace(makeSearchDeps());
    assert.deepEqual(await ns.matchThemes(QUERY_VEC, 'u1', 5), []);
  });
});

describe('matchDocuments routing (Wave 4b)', () => {
  beforeEach(() => {
    clearScanMatchers();
    clearMindSearch();
  });
  afterEach(() => {
    clearScanMatchers();
    clearMindSearch();
  });

  it('returns scan-matcher hits hydrated', async () => {
    setScanMatcher('documents', makeScanMatcher({
      hits: [{ id: 'd1', score: 0.93 }, { id: 'd2', score: 0.81 }],
    }));
    const deps = makeMessagesDeps({
      d1Rows: [
        { id: 'd1', path: '/a', title: 'A', summary: '', content: '...' },
        { id: 'd2', path: '/b', title: 'B', summary: '', content: '...' },
      ],
    });
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchDocuments(QUERY_VEC, 'u1', 5, true);
    assert.equal(out[0].id, 'd1');
    assert.equal(out[0].similarity, 0.93);
  });

  it('returns [] when matcher empty / unregistered / throws', async () => {
    const deps = makeMessagesDeps();
    const ns = createMessagesNamespace(deps);
    assert.deepEqual(await ns.matchDocuments(QUERY_VEC, 'u1', 5, true), []);
    setScanMatcher('documents', makeScanMatcher({ hits: [] }));
    assert.deepEqual(await ns.matchDocuments(QUERY_VEC, 'u1', 5, true), []);
    setScanMatcher('documents', makeScanMatcher({ throwOnSearch: true }));
    assert.deepEqual(await ns.matchDocuments(QUERY_VEC, 'u1', 5, true), []);
  });

  it('preserves includeInternal=false SQL filter', async () => {
    setScanMatcher('documents', makeScanMatcher({ hits: [{ id: 'd1', score: 0.5 }] }));
    const deps = makeMessagesDeps({
      d1Rows: [{ id: 'd1', path: '/a', title: 'A', summary: '', content: '...' }],
    });
    const ns = createMessagesNamespace(deps);
    await ns.matchDocuments(QUERY_VEC, 'u1', 5 /* includeInternal default false */);
    const lastSql = deps._calls.d1Calls[deps._calls.d1Calls.length - 1].sql;
    assert.match(lastSql, /AND is_internal = 0/);
  });
});
