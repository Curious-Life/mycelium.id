/**
 * Tests for master key rotation via rewrapEnvelope().
 *
 * Validates the core operation: take an envelope encrypted with oldKey,
 * re-wrap the DEK with newKey, verify the result decrypts with newKey
 * and fails with oldKey.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'crypto';
import { encrypt, decrypt, rewrapEnvelope, importMasterKey, clearAllCaches } from '../lib/crypto-local.js';

const { subtle } = webcrypto;

// Generate a random 64-char hex master key
function randomKeyHex() {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('Master Key Rotation', () => {
  beforeEach(async () => {
    // Each test uses fresh random master keys — clear caches to avoid stale scope keys
    await clearAllCaches();
  });

  it('rewrapEnvelope produces an envelope decryptable with new key (v1, no userId)', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const plaintext = 'sensitive message content';
    const oldEnvelope = await encrypt(plaintext, 'personal', oldKey);

    // Verify it decrypts with old key
    const decrypted1 = await decrypt(oldEnvelope, oldKey);
    assert.equal(decrypted1, plaintext);

    // Re-wrap with new key
    const newEnvelope = await rewrapEnvelope(oldEnvelope, oldKey, newKey);

    // Clear cache before decrypt with new key (real rotation flow does this too)
    await clearAllCaches();

    // Verify new envelope decrypts with new key
    const decrypted2 = await decrypt(newEnvelope, newKey);
    assert.equal(decrypted2, plaintext);
  });

  it('rewrapped envelope CANNOT decrypt with old key', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const plaintext = 'should be unreadable with old key after rotation';
    const oldEnvelope = await encrypt(plaintext, 'personal', oldKey);
    const newEnvelope = await rewrapEnvelope(oldEnvelope, oldKey, newKey);

    // Old key should NOT decrypt the new envelope
    await assert.rejects(
      async () => await decrypt(newEnvelope, oldKey),
      /./
    );
  });

  it('rewrapEnvelope handles v2 envelopes with userId', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());
    const userId = 'user-123-abc';

    const plaintext = 'per-user encrypted data';
    const oldEnvelope = await encrypt(plaintext, 'personal', oldKey, userId);

    // Verify v2 envelope structure
    const parsed = JSON.parse(Buffer.from(oldEnvelope, 'base64').toString('utf8'));
    assert.equal(parsed.v, 2);
    assert.equal(parsed.u, userId);

    // Re-wrap and verify
    const newEnvelope = await rewrapEnvelope(oldEnvelope, oldKey, newKey);
    const newParsed = JSON.parse(Buffer.from(newEnvelope, 'base64').toString('utf8'));
    assert.equal(newParsed.v, 2);
    assert.equal(newParsed.u, userId);

    const decrypted = await decrypt(newEnvelope, newKey);
    assert.equal(decrypted, plaintext);
  });

  it('rewrapEnvelope preserves ciphertext and IV unchanged', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const plaintext = 'ct and iv should be identical after rewrap';
    const oldEnvelope = await encrypt(plaintext, 'personal', oldKey);
    const newEnvelope = await rewrapEnvelope(oldEnvelope, oldKey, newKey);

    const oldParsed = JSON.parse(Buffer.from(oldEnvelope, 'base64').toString('utf8'));
    const newParsed = JSON.parse(Buffer.from(newEnvelope, 'base64').toString('utf8'));

    // ct and iv must be identical (only the dk changes)
    assert.equal(newParsed.ct, oldParsed.ct);
    assert.equal(newParsed.iv, oldParsed.iv);
    // dk must be different (re-wrapped with different scope key)
    assert.notEqual(newParsed.dk, oldParsed.dk);
    // version, scope, userId unchanged
    assert.equal(newParsed.v, oldParsed.v);
    assert.equal(newParsed.s, oldParsed.s);
  });

  it('rewrapEnvelope works for all four scopes', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    for (const scope of ['personal', 'org', 'wealth', 'moms']) {
      const plaintext = `data for scope: ${scope}`;
      const oldEnvelope = await encrypt(plaintext, scope, oldKey);
      const newEnvelope = await rewrapEnvelope(oldEnvelope, oldKey, newKey);
      const decrypted = await decrypt(newEnvelope, newKey);
      assert.equal(decrypted, plaintext, `scope ${scope} should decrypt`);
    }
  });

  it('rewrapEnvelope rejects unknown envelope versions', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const fake = Buffer.from(JSON.stringify({ v: 99, s: 'personal', iv: '', ct: '', dk: '' })).toString('base64');
    await assert.rejects(
      async () => await rewrapEnvelope(fake, oldKey, newKey),
      /Unknown envelope version/
    );
  });

  it('round-trip 100 envelopes (simulating batch rotation)', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const plaintexts = Array.from({ length: 100 }, (_, i) => `message ${i} with content ${Math.random()}`);

    // Encrypt all with old key
    const oldEnvelopes = await Promise.all(plaintexts.map(p => encrypt(p, 'personal', oldKey)));

    // Re-wrap all with new key
    const newEnvelopes = await Promise.all(oldEnvelopes.map(e => rewrapEnvelope(e, oldKey, newKey)));

    // Decrypt all with new key, verify match
    for (let i = 0; i < 100; i++) {
      const decrypted = await decrypt(newEnvelopes[i], newKey);
      assert.equal(decrypted, plaintexts[i]);
    }
  });

  it('rewrap is reversible if both keys are kept', async () => {
    const oldKey = await importMasterKey(randomKeyHex());
    const newKey = await importMasterKey(randomKeyHex());

    const plaintext = 'reversible round-trip';
    const original = await encrypt(plaintext, 'personal', oldKey);
    const rewrapped = await rewrapEnvelope(original, oldKey, newKey);
    const reverted = await rewrapEnvelope(rewrapped, newKey, oldKey);

    // Both should decrypt
    assert.equal(await decrypt(rewrapped, newKey), plaintext);
    assert.equal(await decrypt(reverted, oldKey), plaintext);
  });
});
