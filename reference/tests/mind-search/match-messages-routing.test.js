/**
 * Contract tests for matchMessages routing — Wave 4b (no Vectorize
 * fallback). Mind-search is the only path; if it's unregistered or
 * fails, the matcher returns []. The /internal/v1/search/mindscape
 * endpoint surfaces warming state via 503 + Retry-After, so callers
 * still see a meaningful "not ready" signal.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMessagesNamespace } from '../../packages/core/db-d1/messages.js';
import {
  setMindSearch,
  clearMindSearch,
} from '../../packages/core/mind-search/registry.js';

function makeDeps({ d1Rows = [] } = {}) {
  const d1QueryCalls = [];
  return {
    d1Query: async (sql, params) => {
      d1QueryCalls.push({ sql, params });
      return { results: d1Rows };
    },
    d1Batch: async () => [],
    firstRow: (r) => (r?.results || [])[0] || null,
    _calls: { d1QueryCalls },
  };
}

function makeMockMindSearch({ hits = [], throwOnQuery = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    async query(opts) {
      calls.push(opts);
      if (throwOnQuery) throw new Error('mind-search exploded');
      return { tier: 1, hits, takenMs: 1, degraded: false };
    },
  };
}

describe('matchMessages routing (Wave 4b — no Vectorize fallback)', () => {
  beforeEach(() => clearMindSearch());
  afterEach(() => clearMindSearch());

  it('uses mind-search hits when registered', async () => {
    setMindSearch(makeMockMindSearch({
      hits: [{ id: 'm1', score: 0.91 }, { id: 'm2', score: 0.84 }],
    }));
    const deps = makeDeps({
      d1Rows: [
        { id: 'm1', content: 'hello', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-01', entity_summary: '' },
        { id: 'm2', content: 'world', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-02', entity_summary: '' },
      ],
    });
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchMessages(Float32Array.from([0.1]), 'user-1', 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'm1');
    assert.equal(out[0].similarity, 0.91);
  });

  it('passes the embedding through to mind-search query', async () => {
    const mind = makeMockMindSearch({ hits: [{ id: 'm1', score: 0.5 }] });
    setMindSearch(mind);
    const deps = makeDeps({
      d1Rows: [{ id: 'm1', content: 'x', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-01', entity_summary: '' }],
    });
    const ns = createMessagesNamespace(deps);
    const emb = Float32Array.from([0.1, 0.2, 0.3]);
    await ns.matchMessages(emb, 'user-1', 3);
    assert.equal(mind._calls[0].embedding, emb);
    assert.equal(mind._calls[0].topK, 3);
  });

  it('returns [] when mind-search returns empty hits (no fallback)', async () => {
    setMindSearch(makeMockMindSearch({ hits: [] }));
    const deps = makeDeps();
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchMessages(Float32Array.from([0.1]), 'user-1', 5);
    assert.deepEqual(out, []);
  });

  it('returns [] when mind-search throws (no fallback, no exception bubbled)', async () => {
    setMindSearch(makeMockMindSearch({ throwOnQuery: true }));
    const deps = makeDeps();
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchMessages(Float32Array.from([0.1]), 'user-1', 5);
    assert.deepEqual(out, []);
  });

  it('returns [] when registry is empty (no Vectorize fallback)', async () => {
    // No setMindSearch — registry stays cleared.
    const deps = makeDeps();
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchMessages(Float32Array.from([0.1]), 'user-1', 5);
    assert.deepEqual(out, []);
  });

  it('result is sorted by similarity descending', async () => {
    setMindSearch(makeMockMindSearch({
      hits: [
        { id: 'low', score: 0.1 },
        { id: 'mid', score: 0.5 },
        { id: 'top', score: 0.9 },
      ],
    }));
    const deps = makeDeps({
      d1Rows: [
        { id: 'low', content: 'low', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-01', entity_summary: '' },
        { id: 'mid', content: 'mid', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-02', entity_summary: '' },
        { id: 'top', content: 'top', role: 'user', source: 'chat', agent_id: 'a', created_at: '2025-01-03', entity_summary: '' },
      ],
    });
    const ns = createMessagesNamespace(deps);
    const out = await ns.matchMessages(Float32Array.from([0.1]), 'user-1', 5);
    assert.equal(out[0].id, 'top');
    assert.equal(out[1].id, 'mid');
    assert.equal(out[2].id, 'low');
  });
});
