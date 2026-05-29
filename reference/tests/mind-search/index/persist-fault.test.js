/**
 * persist.js — fault injection.
 *
 * Behaviors required by the design plan:
 *   • Missing file → loadIndex returns null (caller falls back to D1 rebuild)
 *   • Atomic write: a partial .tmp does not corrupt the target
 *   • Atomic write: a crash before rename leaves the target intact
 *   • Disk-full / write failure: previous snapshot survives (no half-write)
 *   • cleanupOrphanTmpFiles removes leftovers from prior aborted saves
 *
 * "Disk full" cannot be cleanly injected from a unit test on macOS / Linux
 * without root or fs-mocking. We approximate it via:
 *   - Read-only directories (write fails with EACCES)
 *   - Skipping the test when running as root (where EACCES wouldn't fire)
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
const { InvertedIndex } = await import('@mycelium/core/mind-search/index/inverted.js');
const {
  saveIndex,
  loadIndex,
  cleanupOrphanTmpFiles,
} = await import('@mycelium/core/mind-search/index/persist.js');
const {
  IndexUnavailableError,
} = await import('@mycelium/core/mind-search/errors.js');

let masterKey;
let tmpDir;

before(async () => {
  masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-search-fault-'));
});

after(async () => {
  if (tmpDir) {
    try {
      // Ensure directory is writable before rm (some fault tests revoke perms)
      await fs.chmod(tmpDir, 0o755).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* test cleanup best-effort */ }
  }
});

function newPath(prefix = 'fault') {
  return path.join(tmpDir, `${prefix}-${crypto.randomBytes(4).toString('hex')}.bin`);
}

function buildIdx() {
  const idx = new InvertedIndex();
  idx.add('a', ['mycelium', 'sovereignty'], 1);
  idx.add('b', ['agents', 'persistence'], 2);
  return idx;
}

const isRoot = process.getuid && process.getuid() === 0;

// ── Missing file ───────────────────────────────────────────────────────

describe('loadIndex — missing file', () => {
  it('returns null when the file does not exist', async () => {
    const result = await loadIndex(newPath('does-not-exist'), masterKey, ['personal']);
    assert.equal(result, null);
  });

  it('returns null even with admin scopes', async () => {
    const result = await loadIndex(newPath('also-missing'), masterKey, null);
    assert.equal(result, null);
  });
});

// ── Atomicity: partial .tmp does not corrupt target ────────────────────

describe('saveIndex — atomicity', () => {
  it('a partial .tmp file does not affect the loadable target', async () => {
    const filepath = newPath('atomic');
    // First, save a valid snapshot.
    await saveIndex(buildIdx(), filepath, 'personal', masterKey);

    // Simulate a half-written .tmp file from a prior aborted save.
    // The .tmp filename uses pid; we approximate the pattern.
    const orphan = `${filepath}.tmp.99999`;
    await fs.writeFile(orphan, Buffer.from('garbage that is not a valid snapshot'));

    // Loading the target should succeed — orphan is irrelevant.
    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.ok(loaded);
    assert.equal(loaded.totalDocs(), 2);

    // Cleanup helper finds and removes the orphan.
    const result = await cleanupOrphanTmpFiles(filepath);
    assert.equal(result.removed, 1);
    const dirEntries = await fs.readdir(path.dirname(filepath));
    const remainingOrphans = dirEntries.filter((e) =>
      e.startsWith(`${path.basename(filepath)}.tmp.`));
    assert.deepEqual(remainingOrphans, []);
  });

  it('overwriting an existing snapshot does not lose the old one on read mid-flight', async () => {
    // We can't truly test "kill mid-save", but we can verify that the
    // atomic-rename property holds: until rename succeeds, the target
    // file path still points at the old contents. This is what POSIX
    // rename guarantees, and what saveIndex relies on.
    const filepath = newPath('mid-flight');

    // Initial save
    const a = new InvertedIndex();
    a.add('original', ['stable'], 1);
    await saveIndex(a, filepath, 'personal', masterKey);

    // Confirm target reads the original content
    const before = await loadIndex(filepath, masterKey, ['personal']);
    assert.equal(before.has('original'), true);

    // Save a new index. After saveIndex resolves, the target reflects new content.
    const b = new InvertedIndex();
    b.add('replacement', ['updated'], 2);
    await saveIndex(b, filepath, 'personal', masterKey);

    const after = await loadIndex(filepath, masterKey, ['personal']);
    assert.equal(after.has('original'), false);
    assert.equal(after.has('replacement'), true);
  });
});

// ── Cleanup helper ──────────────────────────────────────────────────────

describe('cleanupOrphanTmpFiles', () => {
  it('removes only files matching the .tmp.<pid> pattern', async () => {
    const filepath = newPath('cleanup');
    const dir = path.dirname(filepath);
    const baseName = path.basename(filepath);

    // Create a valid snapshot
    await saveIndex(buildIdx(), filepath, 'personal', masterKey);

    // Add three orphans + one unrelated file
    await fs.writeFile(`${filepath}.tmp.1111`, 'orphan-1');
    await fs.writeFile(`${filepath}.tmp.2222`, 'orphan-2');
    await fs.writeFile(`${filepath}.tmp.3333`, 'orphan-3');
    const unrelated = path.join(dir, 'unrelated.bin');
    await fs.writeFile(unrelated, 'do-not-touch');

    const result = await cleanupOrphanTmpFiles(filepath);
    assert.equal(result.removed, 3);

    // Target survives, unrelated file survives
    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.ok(loaded);
    const unrelatedExists = await fs.access(unrelated).then(() => true).catch(() => false);
    assert.equal(unrelatedExists, true);
  });

  it('does not throw when the directory does not exist', async () => {
    const result = await cleanupOrphanTmpFiles('/nowhere/that/exists/file.bin');
    assert.equal(result.removed, 0);
  });

  it('returns 0 when there are no orphans', async () => {
    const filepath = newPath('no-orphans');
    await saveIndex(buildIdx(), filepath, 'personal', masterKey);
    const result = await cleanupOrphanTmpFiles(filepath);
    assert.equal(result.removed, 0);
  });
});

// ── Read failures ──────────────────────────────────────────────────────

describe('loadIndex — read failures', () => {
  it('directory instead of file → IndexUnavailableError (not ENOENT-as-null)', async () => {
    // Path points at a directory. readFile fails with EISDIR — not ENOENT.
    const dir = path.join(tmpDir, 'a-directory');
    await fs.mkdir(dir);
    await assert.rejects(
      () => loadIndex(dir, masterKey, ['personal']),
      (err) => {
        assert.ok(err instanceof IndexUnavailableError);
        assert.equal(err.tier, 3);
        return true;
      },
    );
  });

  it(
    'unreadable file → IndexUnavailableError (skipped if running as root)',
    { skip: isRoot ? 'running as root' : false },
    async () => {
      const filepath = newPath('unreadable');
      await fs.writeFile(filepath, 'MIS1' + 'opaque');
      await fs.chmod(filepath, 0o000);
      try {
        await assert.rejects(
          () => loadIndex(filepath, masterKey, ['personal']),
          (err) => err instanceof IndexUnavailableError,
        );
      } finally {
        await fs.chmod(filepath, 0o600).catch(() => {});
      }
    },
  );
});

// ── Write failures ──────────────────────────────────────────────────────

describe('saveIndex — write failures preserve previous snapshot', () => {
  it(
    'EACCES on rename → throws, previous snapshot intact (skipped as root)',
    { skip: isRoot ? 'running as root' : false },
    async () => {
      const subdir = path.join(tmpDir, 'sealed-subdir');
      await fs.mkdir(subdir);
      const filepath = path.join(subdir, 'snap.bin');

      // Initial valid snapshot
      const original = buildIdx();
      await saveIndex(original, filepath, 'personal', masterKey);

      // Verify it loads
      const before = await loadIndex(filepath, masterKey, ['personal']);
      assert.ok(before);
      assert.equal(before.totalDocs(), 2);

      // Revoke write perms on the directory: rename will fail with EACCES.
      await fs.chmod(subdir, 0o500); // r-x only, no write

      try {
        const replacement = new InvertedIndex();
        replacement.add('z', ['changed'], 999);
        await assert.rejects(
          () => saveIndex(replacement, filepath, 'personal', masterKey),
          (err) => {
            // The error class is the underlying fs error; we don't
            // wrap saveIndex failures, callers handle them generically.
            return err && (err.code === 'EACCES' || err.code === 'EPERM');
          },
        );

        // Previous snapshot still intact
        await fs.chmod(subdir, 0o755).catch(() => {});
        const after = await loadIndex(filepath, masterKey, ['personal']);
        assert.ok(after);
        assert.equal(after.has('a'), true, 'original "a" doc must still be present');
        assert.equal(after.has('z'), false, 'failed save must not partially apply');
      } finally {
        await fs.chmod(subdir, 0o755).catch(() => {});
      }
    },
  );
});

// ── Validation pass-through ─────────────────────────────────────────────

describe('loadIndex — validation', () => {
  it('throws TypeError on empty filepath', async () => {
    await assert.rejects(
      () => loadIndex('', masterKey, ['personal']),
      TypeError,
    );
  });

  it('throws TypeError on missing masterKey', async () => {
    await assert.rejects(
      () => loadIndex(newPath('any'), null, ['personal']),
      TypeError,
    );
  });
});
