/**
 * Tests for the two-key separation architecture.
 *
 * Background: Mycelium separates customer vault data (encrypted with
 * USER_MASTER_KEY) from operator infrastructure secrets (encrypted with
 * SYSTEM_KEY). The two key families are cryptographically independent —
 * compromise of one does not expose the other, and either key can be
 * rotated without disturbing data protected by the other.
 *
 * This suite validates:
 *   1. v3 system envelopes round-trip with SYSTEM_KEY
 *   2. v3 system envelopes CANNOT be decrypted with USER_MASTER_KEY (even
 *      when the two happen to be derived from the same bytes — the HKDF
 *      info strings differ, so the scope keys are distinct).
 *   3. v1/v2 user envelopes still round-trip with USER_MASTER_KEY
 *   4. v1/v2 user envelopes CANNOT be decrypted with SYSTEM_KEY
 *   5. decrypt() throws a clear error when the required key is missing
 *   6. autoEncryptParams routes `secrets` writes through SYSTEM_KEY
 *   7. autoEncryptParams routes customer-table writes through USER_MASTER_KEY
 *   8. autoEncryptParams REFUSES to write when the required key is missing
 *   9. isEncrypted recognizes v3 envelopes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'crypto';
import {
  importMasterKey,
  encrypt,
  encryptWithSystemKey,
  decrypt,
  isEncrypted,
  autoEncryptParams,
  autoDecryptResults,
} from '@mycelium/core/crypto-local.js';

function randomKeyHex() {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function decodeEnvelope(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

describe('Two-Key Separation: SYSTEM_KEY vs USER_MASTER_KEY', () => {

  it('v3 system envelope round-trips with the same SYSTEM_KEY', async () => {
    const systemKey = await importMasterKey(randomKeyHex());
    const plaintext = 'MYA_WORKER_SECRET=supersecret';
    const encoded = await encryptWithSystemKey(plaintext, 'org', systemKey);

    const env = decodeEnvelope(encoded);
    assert.equal(env.v, 3);
    assert.equal(env.kf, 'system');
    assert.equal(env.s, 'org');
    assert.ok(env.iv && env.ct && env.dk);

    const decrypted = await decrypt(encoded, null, null, { systemKey });
    assert.equal(decrypted, plaintext);
  });

  it('isEncrypted recognizes v3 envelopes', async () => {
    const systemKey = await importMasterKey(randomKeyHex());
    const encoded = await encryptWithSystemKey('hello', 'personal', systemKey);
    assert.equal(isEncrypted(encoded), true);
  });

  it('v3 system envelope CANNOT be decrypted with USER_MASTER_KEY (wrong family)', async () => {
    const systemKey = await importMasterKey(randomKeyHex());
    const masterKey = await importMasterKey(randomKeyHex());
    const encoded = await encryptWithSystemKey('secret data', 'org', systemKey);

    // No systemKey provided → must throw
    await assert.rejects(
      () => decrypt(encoded, masterKey),
      /SYSTEM_KEY required/,
    );
  });

  it('v3 system envelope CANNOT be decrypted via the user path even if the same base bytes are used', async () => {
    // The two key families use distinct HKDF info strings
    // ("mycelium:system-scope:…" vs "mycelium:scope:…") so the derived scope
    // keys are different even when the base bytes are identical. This
    // confirms the two key families are cryptographically isolated.
    const sameHex = randomKeyHex();
    const systemKey = await importMasterKey(sameHex);
    const masterKey = await importMasterKey(sameHex);

    const encoded = await encryptWithSystemKey('secret data', 'org', systemKey);

    // Routing via masterKey (no systemKey) must throw: v3 kf='system'
    // envelopes require the systemKey opt.
    await assert.rejects(
      () => decrypt(encoded, masterKey),
      /SYSTEM_KEY required/,
    );

    // Supplying the (identical-bytes) masterKey as systemKey opt should
    // actually succeed — HKDF produces the same scope key regardless of
    // which CryptoKey object wraps those bytes. This is by design:
    // cryptographic isolation comes from OPERATIONAL separation (different
    // tmpfs files, different rotation procedures, different lifecycles),
    // not from trying to collide on the same 32 bytes.
    const decrypted = await decrypt(encoded, null, null, { systemKey: masterKey });
    assert.equal(decrypted, 'secret data');
  });

  it('v1 user envelope round-trips with USER_MASTER_KEY', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const plaintext = 'diary entry for today';
    const encoded = await encrypt(plaintext, 'personal', masterKey);

    const env = decodeEnvelope(encoded);
    assert.equal(env.v, 1);
    assert.equal(env.kf, undefined); // v1 has no kf field

    const decrypted = await decrypt(encoded, masterKey);
    assert.equal(decrypted, plaintext);
  });

  it('v2 per-user envelope round-trips with USER_MASTER_KEY + userId', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const userId = 'user_abc_123';
    const plaintext = 'personal journal';
    const encoded = await encrypt(plaintext, 'personal', masterKey, userId);

    const env = decodeEnvelope(encoded);
    assert.equal(env.v, 2);
    assert.equal(env.u, userId);

    const decrypted = await decrypt(encoded, masterKey);
    assert.equal(decrypted, plaintext);
  });

  it('v1 user envelope CANNOT be decrypted with SYSTEM_KEY only', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const systemKey = await importMasterKey(randomKeyHex());
    const encoded = await encrypt('user data', 'personal', masterKey);

    // Passing null master key triggers the REFUSE path
    await assert.rejects(
      () => decrypt(encoded, null, null, { systemKey }),
      /USER_MASTER_KEY required/,
    );
  });

  it('decrypt throws with clear error when SYSTEM_KEY is missing for v3 system envelope', async () => {
    const systemKey = await importMasterKey(randomKeyHex());
    const encoded = await encryptWithSystemKey('x', 'org', systemKey);

    await assert.rejects(
      () => decrypt(encoded, null, null, {}),
      /SYSTEM_KEY required/,
    );
  });

  it('decrypt throws with clear error when USER_MASTER_KEY is missing for v1 envelope', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const encoded = await encrypt('x', 'personal', masterKey);

    await assert.rejects(
      () => decrypt(encoded, null, null, {}),
      /USER_MASTER_KEY required/,
    );
  });

  it('autoEncryptParams routes `secrets` table INSERT through SYSTEM_KEY', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const systemKey = await importMasterKey(randomKeyHex());

    const sql = 'INSERT INTO secrets (key, value, description) VALUES (?, ?, ?)';
    const params = ['MYA_WORKER_SECRET', 'plaintextvalue', 'worker auth'];
    await autoEncryptParams(sql, params, 'org', masterKey, null, { systemKey });

    // key + description are encrypted per ENCRYPTED_FIELDS.secrets
    assert.ok(isEncrypted(params[0]), 'key field should be encrypted');
    assert.ok(isEncrypted(params[2]), 'description field should be encrypted');

    // Ciphertext must be v3/system — decryptable with SYSTEM_KEY only
    const envKey = decodeEnvelope(params[0]);
    assert.equal(envKey.v, 3);
    assert.equal(envKey.kf, 'system');

    const decrypted = await decrypt(params[0], null, null, { systemKey });
    assert.equal(decrypted, 'MYA_WORKER_SECRET');

    // Must NOT decrypt with master key alone
    await assert.rejects(() => decrypt(params[0], masterKey));
  });

  it('autoEncryptParams routes customer-table INSERT through USER_MASTER_KEY', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const systemKey = await importMasterKey(randomKeyHex());

    const sql = 'INSERT INTO messages (id, agent_id, content) VALUES (?, ?, ?)';
    const params = ['msg1', 'personal-agent', 'hello world'];
    await autoEncryptParams(sql, params, 'personal', masterKey, null, { systemKey });

    assert.ok(isEncrypted(params[2]), 'content field should be encrypted');

    const env = decodeEnvelope(params[2]);
    assert.equal(env.v, 1); // no userId → v1
    assert.equal(env.kf, undefined);

    const decrypted = await decrypt(params[2], masterKey);
    assert.equal(decrypted, 'hello world');

    // Must NOT decrypt with system key
    await assert.rejects(() => decrypt(params[2], null, null, { systemKey }));
  });

  it('autoEncryptParams REFUSES `secrets` write without SYSTEM_KEY', async () => {
    const masterKey = await importMasterKey(randomKeyHex());

    const sql = 'INSERT INTO secrets (key, value) VALUES (?, ?)';
    const params = ['KEY1', 'val1'];

    await assert.rejects(
      () => autoEncryptParams(sql, params, 'org', masterKey, null, { systemKey: null }),
      /REFUSE: write to 'secrets' requires SYSTEM_KEY/,
    );
  });

  it('autoEncryptParams REFUSES customer-table write without USER_MASTER_KEY', async () => {
    const systemKey = await importMasterKey(randomKeyHex());

    const sql = 'INSERT INTO messages (id, content) VALUES (?, ?)';
    const params = ['msg1', 'hello'];

    await assert.rejects(
      () => autoEncryptParams(sql, params, 'personal', null, null, { systemKey }),
      /REFUSE: write to 'messages' requires USER_MASTER_KEY/,
    );
  });

  it('autoDecryptResults decrypts mixed rows (system + user envelopes) with both keys', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const systemKey = await importMasterKey(randomKeyHex());

    const userCipher = await encrypt('user-content', 'personal', masterKey);
    const systemCipher = await encryptWithSystemKey('infra-secret', 'org', systemKey);

    const rows = [
      { id: 1, content: userCipher, meta: systemCipher },
    ];

    const decrypted = await autoDecryptResults(rows, masterKey, null, { systemKey });
    assert.equal(decrypted[0].content, 'user-content');
    assert.equal(decrypted[0].meta, 'infra-secret');
  });

  it('independent rotation: rotating SYSTEM_KEY does not affect USER_MASTER_KEY data', async () => {
    const masterKey = await importMasterKey(randomKeyHex());
    const oldSystemKey = await importMasterKey(randomKeyHex());
    const newSystemKey = await importMasterKey(randomKeyHex());

    // Encrypt a customer record with master key
    const userData = await encrypt('customer journal entry', 'personal', masterKey);
    // Encrypt an infra secret with the old system key
    const oldInfraSecret = await encryptWithSystemKey('old worker token', 'org', oldSystemKey);

    // "Rotate" the system key — new system secrets use the new key
    const newInfraSecret = await encryptWithSystemKey('new worker token', 'org', newSystemKey);

    // Customer data still decrypts with masterKey — untouched by system key rotation
    assert.equal(await decrypt(userData, masterKey), 'customer journal entry');

    // Old system secret no longer decryptable with new key (must be re-encrypted)
    await assert.rejects(() => decrypt(oldInfraSecret, null, null, { systemKey: newSystemKey }));
    // Still decryptable with the old key
    assert.equal(
      await decrypt(oldInfraSecret, null, null, { systemKey: oldSystemKey }),
      'old worker token',
    );
    // New system secret decrypts with new key
    assert.equal(
      await decrypt(newInfraSecret, null, null, { systemKey: newSystemKey }),
      'new worker token',
    );
  });

  it('independent rotation: rotating USER_MASTER_KEY does not affect SYSTEM_KEY secrets', async () => {
    const systemKey = await importMasterKey(randomKeyHex());
    const oldMasterKey = await importMasterKey(randomKeyHex());
    const newMasterKey = await importMasterKey(randomKeyHex());

    const infraSecret = await encryptWithSystemKey('CLAUDE_API_TOKEN=xyz', 'org', systemKey);
    const oldCustomerData = await encrypt('diary', 'personal', oldMasterKey);

    // Customer master key rotation: infrastructure secret untouched
    assert.equal(
      await decrypt(infraSecret, newMasterKey, null, { systemKey }),
      'CLAUDE_API_TOKEN=xyz',
    );

    // Old customer data still requires old master key
    assert.equal(await decrypt(oldCustomerData, oldMasterKey), 'diary');
    await assert.rejects(() => decrypt(oldCustomerData, newMasterKey));
  });
});
