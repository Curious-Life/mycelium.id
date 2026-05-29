/**
 * persist.js — encrypted index round-trip tests.
 *
 * What this covers:
 *   • saveIndex → loadIndex round-trip preserves all queries
 *   • file format: 4-byte magic header is present
 *   • scope mismatch rejected with ScopeMismatchError (not generic decrypt error)
 *   • tampered ciphertext rejected with DecryptError
 *   • truncated file rejected with IndexUnavailableError
 *   • bad magic rejected with IndexUnavailableError
 *   • file permissions are 0600 (owner-only)
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Set master key BEFORE importing crypto-local (it reads env at import).
const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
const { InvertedIndex } = await import('@mycelium/core/mind-search/index/inverted.js');
const { saveIndex, loadIndex } = await import('@mycelium/core/mind-search/index/persist.js');
const {
  DecryptError,
  IndexUnavailableError,
  ScopeMismatchError,
} = await import('@mycelium/core/mind-search/errors.js');

let masterKey;
let tmpDir;

before(async () => {
  masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-search-persist-'));
});

after(async () => {
  if (tmpDir) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* test cleanup best-effort */ }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

function buildSampleIndex() {
  const idx = new InvertedIndex({ maxTokens: 1000 });
  idx.add('doc-001', ['mycelium', 'sovereignty', 'persistence'], 1700000000);
  idx.add('doc-002', ['mycelium', 'mycelium', 'agents', 'persistence'], 1700000100);
  idx.add('doc-003', ['inner', 'work', 'reflection'], 1700000200);
  idx.add('doc-004', ['agents', 'collaboration', 'sovereignty'], 1700000300);
  return idx;
}

function newPath(prefix = 'snap') {
  return path.join(tmpDir, `${prefix}-${crypto.randomBytes(4).toString('hex')}.bin`);
}

// ── Round-trip ─────────────────────────────────────────────────────────

describe('saveIndex / loadIndex — round-trip', () => {
  it('preserves all postings and document metadata', async () => {
    const filepath = newPath('roundtrip');
    const original = buildSampleIndex();

    const result = await saveIndex(original, filepath, 'personal', masterKey);
    assert.ok(result.bytes > 0, 'saveIndex should report bytes written');

    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.ok(loaded instanceof InvertedIndex);
    assert.deepEqual(loaded.size(), original.size());
    assert.equal(loaded.avgDocumentLength(), original.avgDocumentLength());

    // Every token's posting list matches
    for (const token of original.postings.keys()) {
      const o = original.lookup(token);
      const l = loaded.lookup(token);
      // Sort by id for stable comparison
      const norm = (list) => [...list].sort((a, b) => a.id < b.id ? -1 : 1);
      assert.deepEqual(norm(l), norm(o), `posting list mismatch for token "${token}"`);
    }

    // Document metadata
    for (const id of original.documents.keys()) {
      assert.equal(loaded.documentLength(id), original.documentLength(id));
      assert.equal(loaded.documentTs(id), original.documentTs(id));
    }
  });

  it('round-trips an empty index', async () => {
    const filepath = newPath('empty');
    const original = new InvertedIndex();
    await saveIndex(original, filepath, 'personal', masterKey);
    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.deepEqual(loaded.size(), { tokens: 0, documents: 0, totalPostings: 0 });
  });

  it('round-trips a per-user (envelope v2) snapshot', async () => {
    const filepath = newPath('v2');
    const idx = buildSampleIndex();
    await saveIndex(idx, filepath, 'personal', masterKey, 'user-uuid-123');
    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.equal(loaded.totalDocs(), idx.totalDocs());
  });

  it('overwrites an existing snapshot atomically', async () => {
    const filepath = newPath('overwrite');
    const a = new InvertedIndex();
    a.add('a', ['foo'], 1);
    await saveIndex(a, filepath, 'personal', masterKey);

    const b = new InvertedIndex();
    b.add('b', ['bar'], 2);
    await saveIndex(b, filepath, 'personal', masterKey);

    const loaded = await loadIndex(filepath, masterKey, ['personal']);
    assert.equal(loaded.has('a'), false);
    assert.equal(loaded.has('b'), true);
  });

  it('does not leave a .tmp file after successful save', async () => {
    const filepath = newPath('clean');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);
    const dir = path.dirname(filepath);
    const baseName = path.basename(filepath);
    const entries = await fs.readdir(dir);
    const orphans = entries.filter((e) => e.startsWith(`${baseName}.tmp.`));
    assert.deepEqual(orphans, [], 'no .tmp files should remain after rename');
  });

  it('admin mode (allowedScopes=null) loads any scope', async () => {
    const filepath = newPath('admin');
    await saveIndex(buildSampleIndex(), filepath, 'wealth', masterKey);
    const loaded = await loadIndex(filepath, masterKey, null);
    assert.ok(loaded);
    assert.equal(loaded.totalDocs(), 4);
  });
});

// ── File format ────────────────────────────────────────────────────────

describe('persist.js — file format', () => {
  it('starts with 4-byte magic "MIS1"', async () => {
    const filepath = newPath('magic');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);
    const raw = await fs.readFile(filepath);
    assert.equal(raw.subarray(0, 4).toString('latin1'), 'MIS1');
  });

  it('writes file with mode 0600 (owner-only)', async () => {
    const filepath = newPath('mode');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);
    const stat = await fs.stat(filepath);
    // Mode is 0o600 — owner read/write only. On macOS / Linux umask
    // doesn't override file creation mode set explicitly.
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600,
      `expected 0600, got 0${perms.toString(8)}`);
  });
});

// ── Scope mismatch ─────────────────────────────────────────────────────

describe('loadIndex — scope mismatch', () => {
  it('throws ScopeMismatchError when caller scope is wrong', async () => {
    const filepath = newPath('scope');
    await saveIndex(buildSampleIndex(), filepath, 'wealth', masterKey);
    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal', 'org']),
      (err) => {
        assert.ok(err instanceof ScopeMismatchError, `expected ScopeMismatchError, got ${err.constructor.name}`);
        assert.equal(err.class, 'scope_mismatch');
        assert.equal(err.tier, null, 'scope errors must refuse to degrade');
        return true;
      },
    );
  });

  it('throws ScopeMismatchError on empty allowedScopes (no scopes allowed)', async () => {
    const filepath = newPath('scope-empty');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);
    await assert.rejects(
      () => loadIndex(filepath, masterKey, []),
      (err) => err instanceof ScopeMismatchError,
    );
  });
});

// ── Tampering / corruption ─────────────────────────────────────────────

describe('loadIndex — corrupt files', () => {
  it('throws IndexUnavailableError on missing magic header', async () => {
    const filepath = newPath('badmagic');
    await fs.writeFile(filepath, Buffer.from('XXXX' + 'rest of file', 'latin1'));
    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal']),
      (err) => {
        assert.ok(err instanceof IndexUnavailableError);
        assert.match(err.message, /magic mismatch/);
        return true;
      },
    );
  });

  it('throws IndexUnavailableError on truncated file (< header length)', async () => {
    const filepath = newPath('trunc');
    await fs.writeFile(filepath, Buffer.from('MI', 'latin1'));
    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal']),
      (err) => {
        assert.ok(err instanceof IndexUnavailableError);
        assert.match(err.message, /truncated/);
        return true;
      },
    );
  });

  it('throws IndexUnavailableError on completely empty file', async () => {
    const filepath = newPath('empty-bytes');
    await fs.writeFile(filepath, Buffer.alloc(0));
    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal']),
      (err) => err instanceof IndexUnavailableError,
    );
  });

  it('throws DecryptError when ciphertext is tampered', async () => {
    const filepath = newPath('tamper');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);

    // Read, flip a byte AFTER the magic+envelope-prefix area, write back.
    // The envelope is base64-encoded JSON; flipping a byte mid-stream
    // either corrupts the JSON parse, or corrupts the ct field's base64,
    // or corrupts the ciphertext's auth tag. All paths should land in
    // DecryptError, not IndexUnavailableError or a generic crash.
    const raw = await fs.readFile(filepath);
    // Flip a byte deep enough to be inside the ct payload, which is
    // typically the largest field of the envelope JSON.
    const tampered = Buffer.from(raw);
    const tamperOffset = Math.floor(raw.length / 2);
    tampered[tamperOffset] = tampered[tamperOffset] ^ 0xFF;
    await fs.writeFile(filepath, tampered);

    await assert.rejects(
      () => loadIndex(filepath, masterKey, ['personal']),
      (err) => {
        assert.ok(err instanceof DecryptError, `expected DecryptError, got ${err.constructor.name}: ${err.message}`);
        return true;
      },
    );
  });

  it('error messages do not include vector or content data', async () => {
    const filepath = newPath('error-content-leak');
    await saveIndex(buildSampleIndex(), filepath, 'personal', masterKey);
    const raw = await fs.readFile(filepath);
    raw[10] ^= 0xFF; // small surgical tamper
    await fs.writeFile(filepath, raw);

    try {
      await loadIndex(filepath, masterKey, ['personal']);
      assert.fail('should have thrown');
    } catch (err) {
      // Error message is bounded and contains no document-shaped content
      assert.ok(err.message.length < 200, `error message too long: ${err.message}`);
      assert.ok(!err.message.includes('mycelium'),
        'error message must not include corpus tokens');
      assert.ok(!err.message.includes('doc-001'),
        'error message must not include document ids');
    }
  });
});

// ── saveIndex input validation ─────────────────────────────────────────

describe('saveIndex — input validation', () => {
  it('throws TypeError on non-InvertedIndex input', async () => {
    await assert.rejects(
      () => saveIndex({}, newPath(), 'personal', masterKey),
      TypeError,
    );
    await assert.rejects(
      () => saveIndex(null, newPath(), 'personal', masterKey),
      TypeError,
    );
  });

  it('throws TypeError on empty filepath', async () => {
    await assert.rejects(
      () => saveIndex(new InvertedIndex(), '', 'personal', masterKey),
      TypeError,
    );
  });

  it('throws TypeError on empty scope', async () => {
    await assert.rejects(
      () => saveIndex(new InvertedIndex(), newPath(), '', masterKey),
      TypeError,
    );
  });

  it('throws TypeError on missing masterKey', async () => {
    await assert.rejects(
      () => saveIndex(new InvertedIndex(), newPath(), 'personal', null),
      TypeError,
    );
  });
});
