/**
 * LocalBackend — scope-isolation integration test.
 *
 * Per CLAUDE.md §5 (tenant isolation is total) the backend must enforce
 * scope at the encryption boundary: a backend instantiated with one
 * scope cannot read snapshots written under another. This test exercises
 * that invariant end-to-end via the persistence path, which is the
 * only place mind-search actively gates by scope (in-memory data is
 * scope-tagged at write time).
 *
 * Tests:
 *   • Snapshot encrypted under 'personal' rejected by ['org']-only backend
 *   • Snapshot encrypted under 'wealth' rejected by ['personal']-only backend
 *   • Caller with the right scope succeeds (positive control)
 *   • Caller with multiple allowed scopes succeeds when one matches
 *   • Refusing to degrade — ScopeMismatchError carries tier=null
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
const { createMindSearch } = await import('@mycelium/core/mind-search/index.js');
const { ScopeMismatchError } = await import('@mycelium/core/mind-search/errors.js');

let masterKey;
let tmpDir;

before(async () => {
  masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-search-scope-'));
});

after(async () => {
  if (tmpDir) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function newPath(prefix = 'snap') {
  return path.join(tmpDir, `${prefix}-${crypto.randomBytes(4).toString('hex')}.bin`);
}

function fakeEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(32);
      const h = crypto.createHash('sha256').update(text).digest();
      let sum = 0;
      for (let i = 0; i < 32; i++) {
        v[i] = (h[i] / 255) * 2 - 1;
        sum += v[i] * v[i];
      }
      const n = Math.sqrt(sum) || 1;
      for (let i = 0; i < 32; i++) v[i] /= n;
      return v;
    },
    async health() { return true; },
  };
}

async function buildBackend({ scope, persistPath }) {
  const backend = createMindSearch({
    embedder: fakeEmbedder(),
    masterKey,
    scopes: Array.isArray(scope) ? scope : [scope],
    userId: `user-${scope}`,
    persistPath,
    ttlMs: 0,
  });
  return backend;
}

// ── Snapshot scope rejection ────────────────────────────────────────────

describe('LocalBackend — scope isolation via snapshot', () => {
  it('snapshot written under "personal" is rejected by ["org"]-only backend', async () => {
    const filepath = newPath('personal');

    // Writer: backend with scope 'personal'
    const writer = await buildBackend({ scope: 'personal', persistPath: filepath });
    await writer.add({ id: 'doc1', text: 'private journal entry', ts: 1700000000 });
    await writer.add({ id: 'doc2', text: 'reflection on inner work', ts: 1700001000 });
    await writer.checkpoint();

    // Reader: backend with scope 'org' only
    const reader = await buildBackend({ scope: 'org', persistPath: filepath });
    const initResult = await reader.init();
    assert.equal(initResult.loaded, false, 'init must not load a wrong-scope snapshot');

    // Reader's index must be empty — nothing leaked
    assert.equal(await reader.count(), 0);
  });

  it('snapshot written under "wealth" is rejected by ["personal"]-only backend', async () => {
    const filepath = newPath('wealth');
    const writer = await buildBackend({ scope: 'wealth', persistPath: filepath });
    await writer.add({ id: 'finance-1', text: 'portfolio allocation', ts: 1700000000 });
    await writer.checkpoint();

    const reader = await buildBackend({ scope: 'personal', persistPath: filepath });
    const initResult = await reader.init();
    assert.equal(initResult.loaded, false);
    assert.equal(await reader.count(), 0);
  });

  it('positive control: same scope reads snapshot successfully', async () => {
    const filepath = newPath('personal-control');
    const writer = await buildBackend({ scope: 'personal', persistPath: filepath });
    await writer.add({ id: 'doc1', text: 'note', ts: 1700000000 });
    await writer.checkpoint();

    const reader = await buildBackend({ scope: 'personal', persistPath: filepath });
    const initResult = await reader.init();
    assert.equal(initResult.loaded, true);
    assert.equal(await reader.count(), 1);
  });

  it('caller with multi-scope allow list reads when one matches', async () => {
    const filepath = newPath('multi');
    const writer = await buildBackend({ scope: 'personal', persistPath: filepath });
    await writer.add({ id: 'doc1', text: 'note', ts: 1700000000 });
    await writer.checkpoint();

    // Reader allows ['personal', 'org'] — should read the personal-scoped snapshot
    const reader = await buildBackend({ scope: ['personal', 'org'], persistPath: filepath });
    const initResult = await reader.init();
    assert.equal(initResult.loaded, true);
    assert.equal(await reader.count(), 1);
  });

  it('init() error logged with class name, no content leaked', async () => {
    const filepath = newPath('logged');

    // Write under wealth
    const writer = await buildBackend({ scope: 'wealth', persistPath: filepath });
    await writer.add({ id: 'secret-portfolio', text: 'gold:5000oz, silver:200kg', ts: 1700000000 });
    await writer.checkpoint();

    // Reader: capture log events through a custom logger
    const events = [];
    const logger = {
      child: () => logger,
      debug: (rec) => events.push({ level: 'debug', ...rec }),
      info:  (rec) => events.push({ level: 'info',  ...rec }),
      warn:  (rec) => events.push({ level: 'warn',  ...rec }),
      error: (rec) => events.push({ level: 'error', ...rec }),
    };
    const reader = createMindSearch({
      embedder: fakeEmbedder(),
      masterKey,
      scopes: ['personal'],
      userId: 'reader',
      persistPath: filepath,
      logger,
    });
    await reader.init();

    // Some kind of failure event was emitted
    const failures = events.filter((e) => e.evt === 'mind_search.init.snapshot_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorClass, 'scope_mismatch');

    // No content fields leaked through any log
    for (const e of events) {
      const dump = JSON.stringify(e);
      assert.ok(!dump.includes('gold:5000oz'), 'log must not include vault content');
      assert.ok(!dump.includes('secret-portfolio'), 'log must not include doc id literal');
    }
  });
});

// ── ScopeMismatchError shape ────────────────────────────────────────────

describe('LocalBackend — ScopeMismatchError refuses to degrade', () => {
  it('the underlying error from loadIndex carries tier=null', async () => {
    // Use the persist module directly so we can catch the typed error
    // (the backend swallows it and falls back to empty index). The
    // backend's swallow is correct behavior — but the typed error MUST
    // exist at the source for telemetry.
    const filepath = newPath('typed');
    const writer = await buildBackend({ scope: 'wealth', persistPath: filepath });
    await writer.add({ id: 'd1', text: 'x', ts: 1 });
    await writer.checkpoint();

    const { loadIndex } = await import('@mycelium/core/mind-search/index/persist.js');
    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal']),
      (err) => {
        assert.ok(err instanceof ScopeMismatchError);
        assert.equal(err.class, 'scope_mismatch');
        assert.equal(err.tier, null,
          'scope mismatch must refuse to degrade — security invariant');
        return true;
      },
    );
  });
});
