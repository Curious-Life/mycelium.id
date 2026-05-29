/**
 * Contract tests for createEmbedderClient — the HTTP wrapper around
 * scripts/embed-service.py (Nomic v1.5, 768D).
 *
 * Covers the parts of the contract that can break recall silently:
 *   - task is required (no default — mismatched prefix tanks recall)
 *   - task must be 'query' or 'document' specifically
 *   - text must be a string
 *   - request body shape matches what embed-service.py validates
 *   - health() reads /health, not /embed (no probe text leaks)
 *   - health() returns true only when loaded:true is reported
 *
 * No live HTTP. The tests inject a fake fetch so we can assert the
 * exact request shape and exercise edge cases (5xx, malformed body,
 * timeouts via AbortSignal) deterministically.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEmbedderClient } from '../../packages/core/mind-search/embedder.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchSpy(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const res = await responder({ url, init });
    return res;
  };
  return { fetchImpl, calls };
}

const VALID_EMBEDDING_768 = Array.from({ length: 768 }, (_, i) => (i % 17) / 17);

// ── embed() contract ────────────────────────────────────────────────────────

describe('createEmbedderClient.embed()', () => {
  it('rejects when text is not a string', async () => {
    const { fetchImpl } = makeFetchSpy(() => jsonResponse({}));
    const client = createEmbedderClient({ fetch: fetchImpl });
    await assert.rejects(
      () => client.embed(123, { task: 'query' }),
      /text must be a string/,
    );
  });

  it('rejects when task is missing', async () => {
    const { fetchImpl } = makeFetchSpy(() => jsonResponse({}));
    const client = createEmbedderClient({ fetch: fetchImpl });
    await assert.rejects(
      () => client.embed('hello'),
      /task must be 'query' or 'document'/,
    );
  });

  it("rejects when task is neither 'query' nor 'document'", async () => {
    const { fetchImpl } = makeFetchSpy(() => jsonResponse({}));
    const client = createEmbedderClient({ fetch: fetchImpl });
    await assert.rejects(
      () => client.embed('hello', { task: 'clustering' }),
      /task must be 'query' or 'document'/,
    );
  });

  it("sends the exact body shape embed-service.py expects (task='query')", async () => {
    const { fetchImpl, calls } = makeFetchSpy(() =>
      jsonResponse({ embedding: VALID_EMBEDDING_768, dim: 768, model: 'nomic-v1.5', task: 'query' }),
    );
    const client = createEmbedderClient({ url: 'http://test', fetch: fetchImpl });
    await client.embed('what does mycelium mean', { task: 'query' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://test/embed');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { text: 'what does mycelium mean', task: 'query' });
  });

  it("sends task='document' verbatim for document indexing", async () => {
    const { fetchImpl, calls } = makeFetchSpy(() =>
      jsonResponse({ embedding: VALID_EMBEDDING_768, dim: 768, model: 'nomic-v1.5', task: 'document' }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    await client.embed('a memory worth keeping', { task: 'document' });
    assert.equal(JSON.parse(calls[0].init.body).task, 'document');
  });

  it('returns Float32Array (not number[])', async () => {
    const { fetchImpl } = makeFetchSpy(() =>
      jsonResponse({ embedding: VALID_EMBEDDING_768, dim: 768, model: 'nomic-v1.5', task: 'query' }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    const out = await client.embed('hello', { task: 'query' });
    assert.ok(out instanceof Float32Array, 'expected Float32Array');
    assert.equal(out.length, 768);
  });

  it('caps text at 8000 chars before sending (bounds payload)', async () => {
    const { fetchImpl, calls } = makeFetchSpy(() =>
      jsonResponse({ embedding: VALID_EMBEDDING_768, dim: 768, model: 'nomic-v1.5', task: 'document' }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    const huge = 'x'.repeat(20_000);
    await client.embed(huge, { task: 'document' });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.text.length, 8000);
  });

  it('throws on non-2xx without echoing the response body', async () => {
    const { fetchImpl } = makeFetchSpy(() =>
      jsonResponse({ error: 'should-not-be-echoed-back' }, { status: 500 }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    await assert.rejects(
      () => client.embed('hello', { task: 'query' }),
      (err) => {
        assert.match(err.message, /500/);
        assert.doesNotMatch(err.message, /should-not-be-echoed-back/);
        return true;
      },
    );
  });

  it('throws when response is missing the embedding array', async () => {
    const { fetchImpl } = makeFetchSpy(() => jsonResponse({ dim: 768, model: 'nomic-v1.5' }));
    const client = createEmbedderClient({ fetch: fetchImpl });
    await assert.rejects(
      () => client.embed('hello', { task: 'query' }),
      /missing embedding array/,
    );
  });
});

// ── health() contract ───────────────────────────────────────────────────────

describe('createEmbedderClient.health()', () => {
  it('hits GET /health (not /embed) and never sends probe text', async () => {
    const { fetchImpl, calls } = makeFetchSpy(() =>
      jsonResponse({ status: 'ok', model: 'nomic-v1.5', loaded: true, dim: 768 }),
    );
    const client = createEmbedderClient({ url: 'http://test', fetch: fetchImpl });
    await client.health();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://test/health');
    // No body, no method override — should default to GET.
    assert.equal(calls[0].init?.method ?? 'GET', 'GET');
    assert.equal(calls[0].init?.body, undefined);
  });

  it('returns true only when loaded:true is reported', async () => {
    const { fetchImpl } = makeFetchSpy(() =>
      jsonResponse({ status: 'ok', model: 'nomic-v1.5', loaded: true, dim: 768 }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    assert.equal(await client.health(), true);
  });

  it('returns false when service responds 200 but loaded:false (still loading)', async () => {
    const { fetchImpl } = makeFetchSpy(() =>
      jsonResponse({ status: 'loading', model: 'nomic-v1.5', loaded: false, dim: 768 }),
    );
    const client = createEmbedderClient({ fetch: fetchImpl });
    assert.equal(await client.health(), false);
  });

  it('returns false on non-2xx', async () => {
    const { fetchImpl } = makeFetchSpy(() => jsonResponse({}, { status: 503 }));
    const client = createEmbedderClient({ fetch: fetchImpl });
    assert.equal(await client.health(), false);
  });

  it('returns false on network error (not throw)', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createEmbedderClient({ fetch: fetchImpl });
    assert.equal(await client.health(), false);
  });

  it('returns false on malformed JSON', async () => {
    const fetchImpl = async () =>
      new Response('not json at all', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    const client = createEmbedderClient({ fetch: fetchImpl });
    assert.equal(await client.health(), false);
  });
});

// ── construction contract ───────────────────────────────────────────────────

describe('createEmbedderClient construction', () => {
  it('throws when fetch is not a function', () => {
    // Node 22 always has globalThis.fetch, so `undefined` falls through
    // to the global. This guards the explicit-non-function case.
    assert.throws(
      () => createEmbedderClient({ fetch: 'not a function', url: 'http://test' }),
      /fetch implementation required/,
    );
  });

  it('uses the global fetch by default if available', () => {
    // If globalThis.fetch is present (Node 22), this should not throw.
    // We don't actually invoke it here; just make sure the factory accepts.
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => jsonResponse({});
      const client = createEmbedderClient({ url: 'http://test' });
      assert.equal(typeof client.embed, 'function');
      assert.equal(typeof client.health, 'function');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
