/**
 * decode.js — vector envelope codec tests.
 *
 * Round-trip: Float32Array → encrypted envelope → Float32Array, byte-identical.
 * Faults: corrupt envelope, length mismatch, scope mismatch, missing key.
 * Pure helpers: encodeVector / decodeVectorBytes (no crypto involved).
 *
 * Run: npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Set a test master key BEFORE importing crypto-local (it reads env at import).
const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
const {
  encodeVector,
  decodeVectorBytes,
  encryptVector,
  decryptVector,
} = await import('@mycelium/core/mind-search/ann/decode.js');
const {
  DecryptError,
  ScopeMismatchError,
} = await import('@mycelium/core/mind-search/errors.js');

let masterKey;
before(async () => {
  masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
});

// ── Pure encoding helpers ──────────────────────────────────────────────

describe('encodeVector / decodeVectorBytes — pure helpers', () => {
  it('round-trip: Float32Array → b64 → Float32Array byte-identical', () => {
    const v = new Float32Array([1.5, -0.25, 1e-6, 0, 1e10, -3.14159]);
    const b64 = encodeVector(v);
    assert.equal(typeof b64, 'string');
    const out = decodeVectorBytes(b64, v.length);
    assert.equal(out.length, v.length);
    for (let i = 0; i < v.length; i++) {
      assert.equal(out[i], v[i], `mismatch at index ${i}: ${out[i]} vs ${v[i]}`);
    }
  });

  it('round-trip preserves a 768D random vector exactly', () => {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.random() * 2 - 1;
    const out = decodeVectorBytes(encodeVector(v), 768);
    for (let i = 0; i < 768; i++) {
      assert.equal(out[i], v[i]);
    }
  });

  it('encodeVector throws TypeError on non-Float32Array', () => {
    assert.throws(() => encodeVector([1, 2, 3]), TypeError);
    assert.throws(() => encodeVector(new Uint8Array(4)), TypeError);
    assert.throws(() => encodeVector(null), TypeError);
  });

  it('decodeVectorBytes throws DecryptError on length mismatch', () => {
    const v = new Float32Array([1, 2, 3]);
    const b64 = encodeVector(v);
    assert.throws(
      () => decodeVectorBytes(b64, 4),  // wrong dim
      (err) => {
        assert.ok(err instanceof DecryptError);
        assert.equal(err.class, 'decrypt_failure');
        assert.match(err.message, /length mismatch/);
        return true;
      },
    );
  });

  it('decodeVectorBytes throws DecryptError on non-string input', () => {
    assert.throws(
      () => decodeVectorBytes(null, 768),
      (err) => err instanceof DecryptError,
    );
    assert.throws(
      () => decodeVectorBytes(123, 768),
      (err) => err instanceof DecryptError,
    );
  });

  it('encodeVector handles vectors backed by sliced ArrayBuffers', () => {
    // Float32Array view into a larger buffer at non-zero offset.
    const big = new Float32Array(100);
    for (let i = 0; i < 100; i++) big[i] = i * 0.1;
    const slice = new Float32Array(big.buffer, 40, 8); // bytes 40..72, dim 8
    const out = decodeVectorBytes(encodeVector(slice), 8);
    for (let i = 0; i < 8; i++) {
      assert.ok(Math.abs(out[i] - slice[i]) < 1e-6,
        `slice[${i}]: ${slice[i]} != ${out[i]}`);
    }
  });
});

// ── Full encrypt/decrypt round-trip ────────────────────────────────────

describe('encryptVector / decryptVector — encrypted round-trip', () => {
  it('round-trip preserves Float32Array byte-identical', async () => {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.sin(i / 100);

    const envelope = await encryptVector(v, 'personal', masterKey);
    assert.equal(typeof envelope, 'string');
    assert.ok(envelope.length > 100, 'envelope should be non-trivial size');

    const out = await decryptVector(envelope, masterKey, ['personal'], 768);
    assert.ok(out instanceof Float32Array);
    assert.equal(out.length, 768);
    for (let i = 0; i < 768; i++) {
      assert.equal(out[i], v[i], `dim ${i}: ${out[i]} vs ${v[i]}`);
    }
  });

  it('admin mode (allowedScopes=null) decrypts any scope', async () => {
    const v = new Float32Array([0.1, 0.2, 0.3]);
    const envelope = await encryptVector(v, 'wealth', masterKey);
    const out = await decryptVector(envelope, masterKey, null, 3);
    assert.equal(out[0], v[0]);
    assert.equal(out[1], v[1]);
    assert.equal(out[2], v[2]);
  });

  it('per-user key derivation: v2 envelope round-trips', async () => {
    const v = new Float32Array([1, 2, 3, 4]);
    const userId = 'user-test-uuid';
    const envelope = await encryptVector(v, 'personal', masterKey, userId);
    const out = await decryptVector(envelope, masterKey, ['personal'], 4);
    assert.equal(out[0], 1);
    assert.equal(out[3], 4);
  });
});

// ── Fault handling ─────────────────────────────────────────────────────

describe('decryptVector — fault handling', () => {
  it('throws ScopeMismatchError when caller scope is wrong', async () => {
    const v = new Float32Array([1, 2, 3]);
    const envelope = await encryptVector(v, 'wealth', masterKey);

    await assert.rejects(
      () => decryptVector(envelope, masterKey, ['personal'], 3),
      (err) => {
        assert.ok(err instanceof ScopeMismatchError, `expected ScopeMismatchError, got ${err.constructor.name}`);
        assert.equal(err.class, 'scope_mismatch');
        assert.equal(err.tier, null); // refuses to degrade
        return true;
      },
    );
  });

  it('throws DecryptError on tampered ciphertext', async () => {
    const v = new Float32Array([1, 2, 3]);
    const envelope = await encryptVector(v, 'personal', masterKey);
    // Decode envelope, flip a byte in ct, re-encode.
    const decoded = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
    const ctBytes = Buffer.from(decoded.ct, 'base64');
    ctBytes[0] ^= 0x01;
    decoded.ct = ctBytes.toString('base64');
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');

    await assert.rejects(
      () => decryptVector(tampered, masterKey, ['personal'], 3),
      (err) => {
        assert.ok(err instanceof DecryptError);
        assert.equal(err.class, 'decrypt_failure');
        return true;
      },
    );
  });

  it('throws DecryptError on length mismatch (vector encrypted with wrong dim)', async () => {
    const v = new Float32Array([1, 2, 3]); // 3 floats = 12 bytes
    const envelope = await encryptVector(v, 'personal', masterKey);
    await assert.rejects(
      () => decryptVector(envelope, masterKey, ['personal'], 768), // claim 768 dim
      (err) => {
        assert.ok(err instanceof DecryptError);
        assert.match(err.message, /length mismatch/);
        return true;
      },
    );
  });

  it('throws DecryptError on empty envelope', async () => {
    await assert.rejects(
      () => decryptVector('', masterKey, ['personal'], 3),
      (err) => err instanceof DecryptError,
    );
  });

  it('throws DecryptError on missing master key', async () => {
    const v = new Float32Array([1, 2, 3]);
    const envelope = await encryptVector(v, 'personal', masterKey);
    await assert.rejects(
      () => decryptVector(envelope, null, ['personal'], 3),
      (err) => {
        assert.ok(err instanceof DecryptError);
        assert.match(err.message, /masterKey/);
        return true;
      },
    );
  });

  it('throws TypeError on non-positive dim', async () => {
    const v = new Float32Array([1, 2, 3]);
    const envelope = await encryptVector(v, 'personal', masterKey);
    await assert.rejects(
      () => decryptVector(envelope, masterKey, ['personal'], 0),
      TypeError,
    );
    await assert.rejects(
      () => decryptVector(envelope, masterKey, ['personal'], -1),
      TypeError,
    );
    await assert.rejects(
      () => decryptVector(envelope, masterKey, ['personal'], 1.5),
      TypeError,
    );
  });

  it('error messages do not include vector contents', async () => {
    const v = new Float32Array([1, 2, 3]);
    const envelope = await encryptVector(v, 'wealth', masterKey);
    try {
      await decryptVector(envelope, masterKey, ['personal'], 3);
      assert.fail('should have thrown');
    } catch (err) {
      // Error message should not include any vector values
      assert.ok(!err.message.includes('1.0'));
      assert.ok(!err.message.includes('2.0'));
      assert.ok(!err.message.includes('3.0'));
      // Should be bounded
      assert.ok(err.message.length < 200);
    }
  });
});

// ── Negative: encryptVector input validation ───────────────────────────

describe('encryptVector — input validation', () => {
  it('throws TypeError on non-Float32Array', async () => {
    await assert.rejects(
      () => encryptVector([1, 2, 3], 'personal', masterKey),
      TypeError,
    );
  });

  it('throws on missing master key', async () => {
    const v = new Float32Array([1, 2, 3]);
    await assert.rejects(
      () => encryptVector(v, 'personal', null),
      /masterKey required/,
    );
  });
});
