/**
 * mind-search — interface contract tests.
 *
 * Pins the public surface so the LocalBackend in PR 8 (and any future
 * backend) conforms to the MindBackend contract. If a future PR removes
 * a method, renames an error class, or alters the dep shape, this test
 * fails — that's the point.
 *
 * Behavior tests live in tests/mind-search/integration/.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');

const {
  createMindSearch,
  MindSearchError,
  NotImplementedError,
  EmbedDownError,
  IndexUnavailableError,
  DecryptError,
  ScopeMismatchError,
  MasterKeyMissingError,
  BudgetExceededError,
} = await import('@mycelium/core/mind-search/index.js');

const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);

// ── Minimal valid deps ───────────────────────────────────────────────────

function fakeDeps(overrides = {}) {
  return {
    embedder: {
      async embed(_text) { return new Float32Array(64); },
      async health() { return true; },
    },
    masterKey,
    scopes: ['personal'],
    userId: 'test-user-00000000-0000-0000-0000-000000000000',
    ...overrides,
  };
}

// ── Factory: dep validation ──────────────────────────────────────────────

describe('createMindSearch — dep validation', () => {
  it('throws TypeError when called with no args', () => {
    assert.throws(() => createMindSearch(), TypeError);
  });

  it('throws TypeError when deps is null', () => {
    assert.throws(() => createMindSearch(null), TypeError);
  });

  it('throws TypeError when embedder missing or malformed', () => {
    assert.throws(
      () => createMindSearch(fakeDeps({ embedder: undefined })),
      /embedder/,
    );
    assert.throws(
      () => createMindSearch(fakeDeps({ embedder: {} })),
      /embed.*health/,
    );
    assert.throws(
      () => createMindSearch(fakeDeps({ embedder: { embed: () => {} } })), // missing health
      /embed.*health/,
    );
  });

  it('throws TypeError when masterKey missing', () => {
    assert.throws(
      () => createMindSearch(fakeDeps({ masterKey: null })),
      /masterKey/,
    );
  });

  it('throws TypeError when scopes missing or empty', () => {
    assert.throws(
      () => createMindSearch(fakeDeps({ scopes: undefined })),
      /scopes/,
    );
    assert.throws(
      () => createMindSearch(fakeDeps({ scopes: [] })),
      /scopes/,
    );
  });

  it('throws TypeError when userId missing or empty', () => {
    assert.throws(
      () => createMindSearch(fakeDeps({ userId: undefined })),
      /userId/,
    );
    assert.throws(
      () => createMindSearch(fakeDeps({ userId: '' })),
      /userId/,
    );
  });

  it('accepts deps without db (db is optional)', () => {
    const mind = createMindSearch(fakeDeps());
    assert.equal(typeof mind, 'object');
  });

  it('returns an object when given valid deps', () => {
    const mind = createMindSearch(fakeDeps());
    assert.equal(typeof mind, 'object');
    assert.ok(mind !== null);
  });
});

// ── MindBackend surface ──────────────────────────────────────────────────

describe('createMindSearch — MindBackend surface', () => {
  const mind = createMindSearch(fakeDeps());

  for (const method of ['add', 'upsert', 'query', 'get', 'delete', 'count', 'health']) {
    it(`exposes ${method} as an async function`, () => {
      assert.equal(typeof mind[method], 'function', `${method} should be a function`);
    });
  }

  it('exposes init() and checkpoint() lifecycle methods', () => {
    assert.equal(typeof mind.init, 'function');
    assert.equal(typeof mind.checkpoint, 'function');
  });

  it('exposes _internal() for tests (not for production)', () => {
    assert.equal(typeof mind._internal, 'function');
    const inner = mind._internal();
    assert.ok(inner.index);
    assert.ok(inner.vectors instanceof Map);
  });
});

// ── Method shape — basic invocations succeed ────────────────────────────

describe('createMindSearch — basic method invocation', () => {
  it('count() on empty backend returns 0', async () => {
    const mind = createMindSearch(fakeDeps());
    assert.equal(await mind.count(), 0);
  });

  it('init() with no persistPath returns { loaded: false }', async () => {
    const mind = createMindSearch(fakeDeps());
    const result = await mind.init();
    assert.equal(result.loaded, false);
  });

  it('checkpoint() with no persistPath returns { saved: false }', async () => {
    const mind = createMindSearch(fakeDeps());
    const result = await mind.checkpoint();
    assert.equal(result.saved, false);
  });

  it('health() returns the documented shape', async () => {
    const mind = createMindSearch(fakeDeps());
    const h = await mind.health();
    assert.ok(['ok', 'degraded', 'down'].includes(h.status));
    assert.equal(typeof h.embedServiceUp, 'boolean');
    assert.equal(typeof h.indexLoaded, 'boolean');
    assert.equal(typeof h.indexSize, 'number');
    assert.ok(h.lastQueryAt === null || typeof h.lastQueryAt === 'number');
  });

  it('add() rejects malformed input with TypeError', async () => {
    const mind = createMindSearch(fakeDeps());
    await assert.rejects(() => mind.add(), TypeError);
    await assert.rejects(() => mind.add({}), TypeError);
    await assert.rejects(() => mind.add({ id: 'x' }), TypeError);
    await assert.rejects(() => mind.add({ id: 'x', ts: NaN }), TypeError);
  });

  it('get() with empty filter returns []', async () => {
    const mind = createMindSearch(fakeDeps());
    assert.deepEqual(await mind.get({}), []);
    assert.deepEqual(await mind.get({ ids: [] }), []);
  });

  it('delete() with empty filter is a no-op', async () => {
    const mind = createMindSearch(fakeDeps());
    const result = await mind.delete({ ids: [] });
    assert.equal(result.deleted, 0);
  });
});

// ── Error class hierarchy ────────────────────────────────────────────────

describe('mind-search — error class hierarchy', () => {
  it('all named errors extend MindSearchError', () => {
    const cases = [
      new NotImplementedError('foo'),
      new EmbedDownError('embedder unreachable'),
      new IndexUnavailableError('cold'),
      new DecryptError('tag mismatch'),
      new ScopeMismatchError('cross scope'),
      new MasterKeyMissingError(),
      new BudgetExceededError('latency'),
    ];
    for (const err of cases) {
      assert.ok(err instanceof MindSearchError);
      assert.ok(err instanceof Error);
    }
  });

  it('every error carries a stable class string for log/Sentry tagging', () => {
    assert.equal(new NotImplementedError('foo').class, 'not_implemented');
    assert.equal(new EmbedDownError('').class, 'embed_down');
    assert.equal(new IndexUnavailableError('').class, 'index_unavailable');
    assert.equal(new DecryptError('').class, 'decrypt_failure');
    assert.equal(new ScopeMismatchError('').class, 'scope_mismatch');
    assert.equal(new MasterKeyMissingError().class, 'master_key_missing');
    assert.equal(new BudgetExceededError('').class, 'budget_exceeded');
  });

  it('correctness errors (scope, master key) refuse to degrade (tier=null)', () => {
    assert.equal(new ScopeMismatchError('').tier, null);
    assert.equal(new MasterKeyMissingError().tier, null);
    assert.equal(new NotImplementedError('foo').tier, null);
    assert.equal(new BudgetExceededError('').tier, null);
  });

  it('infrastructure errors carry a degradation tier hint', () => {
    assert.equal(new EmbedDownError('').tier, 2);
    assert.equal(new IndexUnavailableError('').tier, 3);
    assert.equal(new DecryptError('').tier, null);
  });

  it('error name property matches class name (for stack trace clarity)', () => {
    assert.equal(new NotImplementedError('foo').name, 'NotImplementedError');
    assert.equal(new EmbedDownError('').name, 'EmbedDownError');
    assert.equal(new IndexUnavailableError('').name, 'IndexUnavailableError');
    assert.equal(new DecryptError('').name, 'DecryptError');
    assert.equal(new ScopeMismatchError('').name, 'ScopeMismatchError');
    assert.equal(new MasterKeyMissingError().name, 'MasterKeyMissingError');
    assert.equal(new BudgetExceededError('').name, 'BudgetExceededError');
  });

  it('errors do NOT include content fields in their message by construction', () => {
    const errs = [
      new EmbedDownError('embed service did not respond'),
      new IndexUnavailableError('rebuilding'),
      new DecryptError('auth tag invalid'),
      new ScopeMismatchError('caller has [org] but envelope is personal'),
    ];
    for (const e of errs) {
      assert.ok(e.message.length < 200, `error message too long: ${e.message.length} chars`);
    }
  });
});
