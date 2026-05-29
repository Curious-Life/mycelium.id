/**
 * Contract tests for rehydrateFromD1 — the loader that populates the
 * mind-search RAM cache from messages.embedding_768 at agent boot.
 *
 * Pinning the contract:
 *   - Cursor-paginates until streamForRehydrate returns []
 *   - Decrypts vector envelope first; on failure, increments counter
 *     AND skips the row (does NOT call backend.add for that row)
 *   - Decrypts content lazily via isEncrypted gate
 *   - Calls backend.add with { id, text, embedding (Float32Array), ts }
 *   - Wrong-dim returns counted as decryptVectorFailed (not silent)
 *   - Empty embedding_768 string skipped without trying to decrypt
 *   - Bad created_at counted as skipped (not a vector failure)
 *   - Returns counters with elapsedMs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rehydrateFromD1 } from '../../packages/core/mind-search/d1-loader.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeBackend() {
  const calls = [];
  return {
    _calls: calls,
    async add(req) {
      calls.push(req);
    },
  };
}

function makeDb(pages) {
  // pages: array of [{id, content, scope, created_at, embedding_768}, ...]
  let pageIdx = 0;
  return {
    messages: {
      async streamForRehydrate(/* userId, opts */) {
        if (pageIdx >= pages.length) return [];
        return pages[pageIdx++];
      },
    },
  };
}

const FRESH_TS = '2026-05-01T12:00:00Z';

function row(overrides) {
  return {
    id: 'm1',
    content: 'plaintext-content',
    scope: 'personal',
    created_at: FRESH_TS,
    embedding_768: 'fake-envelope-1',
    ...overrides,
  };
}

function vec768(seedFloat) {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = (seedFloat + i) / 1000;
  return v;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('rehydrateFromD1', () => {
  it('iterates batches until streamForRehydrate returns []', async () => {
    const backend = makeBackend();
    const db = makeDb([
      [row({ id: 'a', embedding_768: 'env-a' }), row({ id: 'b', embedding_768: 'env-b' })],
      [row({ id: 'c', embedding_768: 'env-c' })],
      [], // terminator
    ]);
    const stats = await rehydrateFromD1({
      backend,
      db,
      decryptVector: async () => vec768(0.5),
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(stats.added, 3);
    assert.equal(stats.batches, 2);
    assert.equal(backend._calls.length, 3);
    assert.deepEqual(backend._calls.map((c) => c.id), ['a', 'b', 'c']);
  });

  it('passes Float32Array vector and integer ts to backend.add', async () => {
    const backend = makeBackend();
    const db = makeDb([[row()], []]);
    await rehydrateFromD1({
      backend, db,
      decryptVector: async () => vec768(0.1),
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    const call = backend._calls[0];
    assert.ok(call.embedding instanceof Float32Array, 'embedding must be Float32Array');
    assert.equal(call.embedding.length, 768);
    assert.equal(typeof call.ts, 'number');
    assert.ok(Number.isInteger(call.ts), 'ts must be integer (epoch seconds)');
    // 2026-05-01T12:00:00Z = 1777636800 epoch seconds
    assert.equal(call.ts, 1777636800);
  });

  it('decryptVector failure → row skipped, counter incremented, content NOT decrypted', async () => {
    const backend = makeBackend();
    const db = makeDb([[row()], []]);
    let contentDecryptCalled = false;
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => { throw new Error('scope mismatch'); },
      decryptContent: async (s) => { contentDecryptCalled = true; return s; },
      isEncrypted: () => true,
      userId: 'u1',
    });
    assert.equal(stats.added, 0);
    assert.equal(stats.decryptVectorFailed, 1);
    assert.equal(backend._calls.length, 0, 'add() should not be called for failed-decrypt row');
    assert.equal(contentDecryptCalled, false, 'content decrypt should be skipped on vector failure');
  });

  it('wrong-dim vector counted as decryptVectorFailed (not silent)', async () => {
    const backend = makeBackend();
    const db = makeDb([[row()], []]);
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => new Float32Array(512), // wrong dim
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(stats.added, 0);
    assert.equal(stats.decryptVectorFailed, 1);
  });

  it('empty embedding_768 string → skipped without calling decryptVector', async () => {
    const backend = makeBackend();
    const db = makeDb([[row({ embedding_768: '' })], []]);
    let decryptVectorCalled = false;
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => { decryptVectorCalled = true; return vec768(0); },
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(decryptVectorCalled, false);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.added, 0);
  });

  it('content decrypt failure → vector still added with empty text', async () => {
    const backend = makeBackend();
    const db = makeDb([[row({ content: 'enc:envelope' })], []]);
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => vec768(0.2),
      decryptContent: async () => { throw new Error('content envelope corrupt'); },
      isEncrypted: () => true,
      userId: 'u1',
    });
    assert.equal(stats.added, 1, 'vector still added even when content fails');
    assert.equal(stats.decryptContentFailed, 1);
    assert.equal(backend._calls[0].text, '', 'text falls back to empty string');
  });

  it('skips rows with bad created_at without counting as vector failure', async () => {
    const backend = makeBackend();
    const db = makeDb([[row({ created_at: 'not-a-date' })], []]);
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => vec768(0.1),
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(stats.added, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.decryptVectorFailed, 0);
  });

  it('plaintext content (isEncrypted=false) passes through without decrypt call', async () => {
    const backend = makeBackend();
    const db = makeDb([[row({ content: 'already-plaintext' })], []]);
    let decryptCalled = false;
    await rehydrateFromD1({
      backend, db,
      decryptVector: async () => vec768(0.1),
      decryptContent: async () => { decryptCalled = true; return ''; },
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(decryptCalled, false);
    assert.equal(backend._calls[0].text, 'already-plaintext');
  });

  it('returns counters with elapsedMs', async () => {
    const backend = makeBackend();
    const db = makeDb([[]]);
    const stats = await rehydrateFromD1({
      backend, db,
      decryptVector: async () => vec768(0),
      decryptContent: async (s) => s,
      isEncrypted: () => false,
      userId: 'u1',
    });
    assert.equal(stats.added, 0);
    assert.equal(stats.batches, 0);
    assert.ok(typeof stats.elapsedMs === 'number');
    assert.ok(stats.elapsedMs >= 0);
  });

  it('rejects on missing required deps', async () => {
    await assert.rejects(
      () => rehydrateFromD1({}),
      /backend with add\(\) required/,
    );
    await assert.rejects(
      () => rehydrateFromD1({ backend: { add: async () => {} } }),
      /db\.messages\.streamForRehydrate required/,
    );
    const db = { messages: { streamForRehydrate: async () => [] } };
    await assert.rejects(
      () => rehydrateFromD1({ backend: { add: async () => {} }, db }),
      /decryptVector \+ decryptContent required/,
    );
    await assert.rejects(
      () => rehydrateFromD1({
        backend: { add: async () => {} },
        db,
        decryptVector: async () => {},
        decryptContent: async () => {},
      }),
      /userId required/,
    );
  });
});
