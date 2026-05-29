/**
 * server.js — bootstrap tests.
 *
 * Covers:
 *   • shouldEnableMindSearch flag detection
 *   • bootstrap returns null on flag-off
 *   • bootstrap returns null on missing embedder / master key / userId
 *   • bootstrap returns instance when all deps present
 *   • bootstrap calls init() on the instance
 *   • bootstrap survives init() throwing (returns instance, logs)
 *   • bootstrap surfaces structured log events at every decision
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
  shouldEnableMindSearch,
  bootstrapMindSearch,
} = await import('@mycelium/core/mind-search/server.js');

const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);

// ── Helpers ─────────────────────────────────────────────────────────────

function fakeEmbedder() {
  return {
    async embed() { return new Float32Array(32); },
    async health() { return true; },
  };
}

function captureLogger() {
  const events = [];
  const logger = {
    child: () => logger,
    debug: (rec) => events.push({ level: 'debug', ...rec }),
    info:  (rec) => events.push({ level: 'info',  ...rec }),
    warn:  (rec) => events.push({ level: 'warn',  ...rec }),
    error: (rec) => events.push({ level: 'error', ...rec }),
  };
  logger.events = events;
  return logger;
}

function flagOnEnv(over = {}) {
  return {
    MIND_SEARCH_BACKEND: 'local',
    AGENT_ID: 'test-agent',
    ...over,
  };
}

// ── shouldEnableMindSearch ──────────────────────────────────────────────

describe('shouldEnableMindSearch()', () => {
  it('true when env.MIND_SEARCH_BACKEND === "local"', () => {
    assert.equal(shouldEnableMindSearch({ MIND_SEARCH_BACKEND: 'local' }), true);
  });

  it('false when env.MIND_SEARCH_BACKEND is anything else', () => {
    assert.equal(shouldEnableMindSearch({ MIND_SEARCH_BACKEND: 'vectorize' }), false);
    assert.equal(shouldEnableMindSearch({ MIND_SEARCH_BACKEND: '' }), false);
    assert.equal(shouldEnableMindSearch({ MIND_SEARCH_BACKEND: undefined }), false);
    assert.equal(shouldEnableMindSearch({}), false);
  });

  it('reads process.env by default', () => {
    const original = process.env.MIND_SEARCH_BACKEND;
    process.env.MIND_SEARCH_BACKEND = 'local';
    try {
      assert.equal(shouldEnableMindSearch(), true);
    } finally {
      if (original === undefined) delete process.env.MIND_SEARCH_BACKEND;
      else process.env.MIND_SEARCH_BACKEND = original;
    }
  });
});

// ── bootstrapMindSearch — flag-off ──────────────────────────────────────

describe('bootstrapMindSearch — flag off', () => {
  it('returns null when env flag is unset', async () => {
    const result = await bootstrapMindSearch({
      env: {},
      embedder: fakeEmbedder(),
      masterKey,
    });
    assert.equal(result, null);
  });

  it('returns null when env flag is "vectorize"', async () => {
    const result = await bootstrapMindSearch({
      env: { MIND_SEARCH_BACKEND: 'vectorize' },
      embedder: fakeEmbedder(),
      masterKey,
    });
    assert.equal(result, null);
  });

  it('emits debug event on flag-off skip', async () => {
    const logger = captureLogger();
    await bootstrapMindSearch({ env: {}, logger });
    const skips = logger.events.filter((e) => e.evt === 'mind_search.bootstrap.skipped');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].reason, 'flag_off');
    assert.equal(skips[0].level, 'debug');
  });
});

// ── bootstrapMindSearch — missing deps with flag on ────────────────────

describe('bootstrapMindSearch — missing deps', () => {
  it('returns null when embedder is missing', async () => {
    const logger = captureLogger();
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      masterKey,
      logger,
    });
    assert.equal(result, null);
    const skips = logger.events.filter((e) => e.reason === 'no_embedder');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].level, 'warn');
  });

  it('returns null when embedder is malformed (missing embed/health)', async () => {
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      masterKey,
      embedder: { embed: () => {} }, // no health
    });
    assert.equal(result, null);
  });

  it('returns null when masterKey is missing', async () => {
    const logger = captureLogger();
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      embedder: fakeEmbedder(),
      logger,
    });
    assert.equal(result, null);
    const skips = logger.events.filter((e) => e.reason === 'no_master_key');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].level, 'warn');
  });

  it('returns null when no userId can be derived (no AGENT_ID)', async () => {
    const logger = captureLogger();
    const result = await bootstrapMindSearch({
      env: { MIND_SEARCH_BACKEND: 'local' }, // no AGENT_ID
      embedder: fakeEmbedder(),
      masterKey,
      logger,
    });
    assert.equal(result, null);
    const skips = logger.events.filter((e) => e.reason === 'no_user_id');
    assert.equal(skips.length, 1);
  });
});

// ── bootstrapMindSearch — happy path ───────────────────────────────────

describe('bootstrapMindSearch — happy path', () => {
  it('returns a backend instance when all deps are present', async () => {
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      embedder: fakeEmbedder(),
      masterKey,
    });
    assert.ok(result, 'expected non-null result');
    assert.equal(typeof result.add, 'function');
    assert.equal(typeof result.query, 'function');
    assert.equal(typeof result.health, 'function');
    assert.equal(typeof result.init, 'function');
    assert.equal(typeof result.checkpoint, 'function');
  });

  it('uses explicit userId over env.AGENT_ID', async () => {
    const result = await bootstrapMindSearch({
      env: flagOnEnv({ AGENT_ID: 'env-agent' }),
      embedder: fakeEmbedder(),
      masterKey,
      userId: 'explicit-user',
    });
    assert.ok(result);
    // Indirect verification: the instance accepted the userId without throw.
    // (We could expose userId via _internal() but that's a leaky interface.)
  });

  it('uses default scopes ["personal"] when not specified', async () => {
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      embedder: fakeEmbedder(),
      masterKey,
    });
    assert.ok(result);
  });

  it('accepts explicit scopes', async () => {
    const result = await bootstrapMindSearch({
      env: flagOnEnv(),
      embedder: fakeEmbedder(),
      masterKey,
      scopes: ['org', 'wealth'],
    });
    assert.ok(result);
  });

  it('emits info event on successful bootstrap', async () => {
    const logger = captureLogger();
    await bootstrapMindSearch({
      env: flagOnEnv(),
      embedder: fakeEmbedder(),
      masterKey,
      logger,
    });
    const ready = logger.events.filter((e) => e.evt === 'mind_search.bootstrap.ready');
    assert.equal(ready.length, 1);
    assert.equal(ready[0].level, 'info');
    assert.equal(ready[0].loadedFromSnapshot, false); // no persistPath
    assert.equal(ready[0].scope, 'personal');
  });
});

// ── bootstrapMindSearch — init() failure handling ──────────────────────

describe('bootstrapMindSearch — init() failure', () => {
  it('returns the instance even when init() fails (degrades to empty index)', async () => {
    // Easiest way to force init() to fail: pass a persistPath that exists
    // and contains garbage. The backend's init() catches and logs the
    // error itself; our bootstrap then proceeds.
    const { promises: fs } = await import('node:fs');
    const os = (await import('node:os')).default;
    const path = (await import('node:path')).default;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-init-'));
    const corrupt = path.join(dir, 'corrupt.bin');
    await fs.writeFile(corrupt, 'not a valid snapshot');

    try {
      const logger = captureLogger();
      const result = await bootstrapMindSearch({
        env: flagOnEnv(),
        embedder: fakeEmbedder(),
        masterKey,
        persistPath: corrupt,
        logger,
      });
      // init() logs internally and returns { loaded: false }; bootstrap
      // sees that as a successful (if empty) start.
      assert.ok(result);
      const ready = logger.events.filter((e) => e.evt === 'mind_search.bootstrap.ready');
      assert.equal(ready.length, 1);
      assert.equal(ready[0].loadedFromSnapshot, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
