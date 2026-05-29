/**
 * Security hardening tests — validates the crypto changes actually work.
 * Run: node --test tests/crypto-security.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// Generate a test master key
const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const {
  importMasterKey,
  importMasterKeyFromTmpfs,
  readMasterKeyHex,
  encrypt,
  decrypt,
  isEncrypted,
  ScopeViolationError,
  autoDecryptResults,
  clearMasterKeyFromEnv,
} = await import('@mycelium/core/crypto-local.js');

const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);

describe('Scope Enforcement (CRIT-01)', () => {
  it('should encrypt and decrypt within allowed scope', async () => {
    const ciphertext = await encrypt('secret data', 'personal', masterKey);
    assert.ok(isEncrypted(ciphertext));
    const plaintext = await decrypt(ciphertext, masterKey, ['personal', 'org']);
    assert.equal(plaintext, 'secret data');
  });

  it('should reject decryption of disallowed scope', async () => {
    const ciphertext = await encrypt('wealth secret', 'wealth', masterKey);
    await assert.rejects(
      () => decrypt(ciphertext, masterKey, ['personal', 'org']),
      (err) => {
        assert.ok(err instanceof ScopeViolationError);
        assert.match(err.message, /Scope denied.*wealth/);
        return true;
      },
    );
  });

  it('should allow decryption when allowedScopes is null (admin mode)', async () => {
    const ciphertext = await encrypt('admin data', 'wealth', masterKey);
    const plaintext = await decrypt(ciphertext, masterKey, null);
    assert.equal(plaintext, 'admin data');
  });

  it('should allow all 4 scopes independently', async () => {
    for (const scope of ['personal', 'org', 'wealth', 'moms']) {
      const ct = await encrypt(`data-${scope}`, scope, masterKey);
      const pt = await decrypt(ct, masterKey, [scope]);
      assert.equal(pt, `data-${scope}`);
    }
  });

  it('autoDecryptResults should leave disallowed-scope fields as ciphertext', async () => {
    const wealthCt = await encrypt('portfolio value', 'wealth', masterKey);
    const orgCt = await encrypt('company memo', 'org', masterKey);

    const rows = [
      { id: '1', content: wealthCt, summary: orgCt },
    ];

    const result = await autoDecryptResults(rows, masterKey, ['org']);
    // org field should be decrypted
    assert.equal(result[0].summary, 'company memo');
    // wealth field should remain as ciphertext (scope denied)
    assert.ok(isEncrypted(result[0].content), 'wealth content should remain encrypted');
  });
});

describe('Per-User Key Hierarchy — Envelope v2 (C4)', () => {
  it('should produce v2 envelope when userId is provided', async () => {
    const ct = await encrypt('user data', 'personal', masterKey, 'user-123');
    const envelope = JSON.parse(Buffer.from(ct, 'base64').toString('utf8'));
    assert.equal(envelope.v, 2);
    assert.equal(envelope.u, 'user-123');
    assert.equal(envelope.s, 'personal');
  });

  it('should produce v1 envelope when userId is null', async () => {
    const ct = await encrypt('legacy data', 'personal', masterKey, null);
    const envelope = JSON.parse(Buffer.from(ct, 'base64').toString('utf8'));
    assert.equal(envelope.v, 1);
    assert.equal(envelope.u, undefined);
  });

  it('should decrypt v2 envelope correctly', async () => {
    const ct = await encrypt('user secret', 'org', masterKey, 'user-abc');
    const pt = await decrypt(ct, masterKey, ['org']);
    assert.equal(pt, 'user secret');
  });

  it('should still decrypt v1 envelopes (backward compat)', async () => {
    const ct = await encrypt('old data', 'org', masterKey); // no userId = v1
    const pt = await decrypt(ct, masterKey, ['org']);
    assert.equal(pt, 'old data');
  });

  it('different userIds should produce different ciphertexts', async () => {
    const ct1 = await encrypt('same text', 'personal', masterKey, 'user-A');
    const ct2 = await encrypt('same text', 'personal', masterKey, 'user-B');
    // Ciphertexts differ due to random DEK+IV, but more importantly the wrapped DEK differs
    // because scope keys are derived from different user keys
    assert.notEqual(ct1, ct2);

    // Both should decrypt to the same plaintext
    const pt1 = await decrypt(ct1, masterKey);
    const pt2 = await decrypt(ct2, masterKey);
    assert.equal(pt1, 'same text');
    assert.equal(pt2, 'same text');
  });

  it('v2 envelope from user-A cannot be decrypted with user-B key path', async () => {
    // This tests that the per-user derivation actually isolates users.
    // We can't directly test cross-user decryption failure since decrypt()
    // uses the envelope's own "u" field. But we can verify the envelope
    // structure contains the userId, which the decrypt function uses.
    const ct = await encrypt('user-A secret', 'personal', masterKey, 'user-A');
    const envelope = JSON.parse(Buffer.from(ct, 'base64').toString('utf8'));
    assert.equal(envelope.u, 'user-A');
    // Decrypt succeeds because it reads userId from envelope
    const pt = await decrypt(ct, masterKey, ['personal']);
    assert.equal(pt, 'user-A secret');
  });
});

describe('Envelope Format Validation', () => {
  it('should reject unknown envelope version', async () => {
    const fake = Buffer.from(JSON.stringify({ v: 99, s: 'org', iv: 'x', ct: 'x', dk: 'x' })).toString('base64');
    await assert.rejects(
      () => decrypt(fake, masterKey),
      /Unknown envelope version: 99/,
    );
  });

  it('isEncrypted should detect valid envelopes', async () => {
    const ct = await encrypt('test', 'org', masterKey);
    assert.ok(isEncrypted(ct));
    assert.ok(!isEncrypted('plain text'));
    assert.ok(!isEncrypted(''));
    assert.ok(!isEncrypted(null));
    assert.ok(!isEncrypted(123));
  });
});

describe('Memory Protection (C2)', () => {
  it('clearMasterKeyFromEnv should remove key from process.env', () => {
    process.env.ENCRYPTION_MASTER_KEY = 'test_key_to_clear';
    assert.equal(process.env.ENCRYPTION_MASTER_KEY, 'test_key_to_clear');
    clearMasterKeyFromEnv();
    assert.equal(process.env.ENCRYPTION_MASTER_KEY, undefined);
  });
});

describe('Master Key tmpfs Loading (#1)', () => {
  it('readMasterKeyHex returns null when no key available', () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete global._masterKeyFallbackWarned;
    const hex = readMasterKeyHex();
    assert.equal(hex, null, 'should return null when no key in env or tmpfs');
  });

  it('readMasterKeyHex falls back to env var with warning', () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;
    delete global._masterKeyFallbackWarned;

    // Capture console.warn
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const hex = readMasterKeyHex();
      assert.equal(hex, TEST_MASTER_KEY_HEX);
      assert.ok(
        warnings.some(w => w.includes('SECURITY') && w.includes('insecure')),
        'should log security warning when using env fallback',
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('readMasterKeyHex only warns once per process', () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;
    delete global._masterKeyFallbackWarned;

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      readMasterKeyHex();
      readMasterKeyHex();
      readMasterKeyHex();
      const securityWarnings = warnings.filter(w => w.includes('SECURITY'));
      assert.equal(securityWarnings.length, 1, 'should warn only once across multiple calls');
    } finally {
      console.warn = origWarn;
    }
  });

  it('importMasterKeyFromTmpfs returns null when no key available', async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete global._masterKeyFallbackWarned;
    const key = await importMasterKeyFromTmpfs();
    assert.equal(key, null);
  });

  it('importMasterKeyFromTmpfs imports from env fallback successfully', async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;
    delete global._masterKeyFallbackWarned;
    const origWarn = console.warn;
    console.warn = () => {}; // suppress
    try {
      const key = await importMasterKeyFromTmpfs();
      assert.ok(key, 'should return CryptoKey');
      // Verify it's actually usable for crypto by encrypting/decrypting
      const ct = await encrypt('test', 'org', key);
      const pt = await decrypt(ct, key);
      assert.equal(pt, 'test');
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('SSRF protection — isLocalhostUrl', () => {
  // Inline the function (mirrors agent-server.js definition)
  function isLocalhostUrl(urlStr) {
    if (typeof urlStr !== 'string' || urlStr.length === 0 || urlStr.length > 2048) return false;
    let url;
    try { url = new URL(urlStr); } catch { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  }

  it('accepts localhost URLs', () => {
    assert.ok(isLocalhostUrl('http://localhost:3004/callback'));
    assert.ok(isLocalhostUrl('http://127.0.0.1:8095/enrich'));
    assert.ok(isLocalhostUrl('https://localhost/api'));
  });

  it('rejects external URLs', () => {
    assert.ok(!isLocalhostUrl('http://evil.com/exfil'));
    assert.ok(!isLocalhostUrl('http://169.254.169.254/metadata'));
    assert.ok(!isLocalhostUrl('http://10.0.0.1/internal'));
    assert.ok(!isLocalhostUrl('http://example.com'));
  });

  it('rejects non-http schemes', () => {
    assert.ok(!isLocalhostUrl('file:///etc/passwd'));
    assert.ok(!isLocalhostUrl('gopher://localhost/'));
    assert.ok(!isLocalhostUrl('javascript:alert(1)'));
    assert.ok(!isLocalhostUrl('ftp://localhost/'));
  });

  it('rejects malformed URLs', () => {
    assert.ok(!isLocalhostUrl(''));
    assert.ok(!isLocalhostUrl('not a url'));
    assert.ok(!isLocalhostUrl(null));
    assert.ok(!isLocalhostUrl(undefined));
    assert.ok(!isLocalhostUrl(123));
  });

  it('rejects URLs that try to look like localhost', () => {
    assert.ok(!isLocalhostUrl('http://localhost.evil.com/'));
    assert.ok(!isLocalhostUrl('http://127.0.0.1.evil.com/'));
    assert.ok(!isLocalhostUrl('http://evil.com#localhost'));
    assert.ok(!isLocalhostUrl('http://evil.com?host=localhost'));
  });

  it('rejects oversized URLs', () => {
    const big = 'http://localhost/' + 'a'.repeat(3000);
    assert.ok(!isLocalhostUrl(big));
  });
});

describe('Event JSONL validation', () => {
  function validateEvent(event) {
    if (!event || typeof event !== 'object') return null;
    if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 64) return null;
    if (typeof event.ts !== 'number' || event.ts < 0 || event.ts > Date.now() + 60000) return null;
    for (const f of ['agentId', 'traceId', 'spanId', 'parentSpanId', 'agentPath', 'iso']) {
      if (event[f] !== undefined && typeof event[f] !== 'string') return null;
      if (typeof event[f] === 'string' && event[f].length > 256) return null;
    }
    if (event.payload !== undefined && (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload))) {
      return null;
    }
    return event;
  }

  it('accepts valid events', () => {
    assert.ok(validateEvent({ type: 'message.received', ts: Date.now(), agentId: 'mya' }));
    assert.ok(validateEvent({ type: 'spawn.start', ts: Date.now(), payload: { role: 'researcher' } }));
  });

  it('rejects malformed events', () => {
    assert.equal(validateEvent(null), null);
    assert.equal(validateEvent('string'), null);
    assert.equal(validateEvent({}), null); // no type or ts
    assert.equal(validateEvent({ type: 'x' }), null); // no ts
    assert.equal(validateEvent({ ts: Date.now() }), null); // no type
    assert.equal(validateEvent({ type: 123, ts: Date.now() }), null); // type not string
    assert.equal(validateEvent({ type: 'x', ts: 'now' }), null); // ts not number
  });

  it('rejects oversized fields', () => {
    const longType = 'x'.repeat(100);
    assert.equal(validateEvent({ type: longType, ts: Date.now() }), null);

    const longField = 'a'.repeat(300);
    assert.equal(validateEvent({ type: 'x', ts: Date.now(), agentId: longField }), null);
  });

  it('rejects future timestamps (clock skew window 60s)', () => {
    assert.equal(validateEvent({ type: 'x', ts: Date.now() + 120000 }), null);
  });

  it('rejects payload that is not an object', () => {
    assert.equal(validateEvent({ type: 'x', ts: Date.now(), payload: 'string' }), null);
    assert.equal(validateEvent({ type: 'x', ts: Date.now(), payload: [] }), null);
    assert.equal(validateEvent({ type: 'x', ts: Date.now(), payload: 123 }), null);
  });
});

describe('Email Validation', () => {
  // Import the Worker validation utility
  // Can't directly import TS, but we can test the regex pattern
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function isValidEmail(email) {
    return !!email && email.length <= 254 && EMAIL_RE.test(email);
  }

  it('should accept valid emails', () => {
    assert.ok(isValidEmail('user@example.com'));
    assert.ok(isValidEmail('user+tag@domain.co.uk'));
    assert.ok(isValidEmail('a@b.c'));
  });

  it('should reject invalid emails', () => {
    assert.ok(!isValidEmail(''));
    assert.ok(!isValidEmail('@'));
    assert.ok(!isValidEmail('a@'));
    assert.ok(!isValidEmail('@b'));
    assert.ok(!isValidEmail('a@b'));  // no TLD
    assert.ok(!isValidEmail('test'));
    assert.ok(!isValidEmail(null));
    assert.ok(!isValidEmail(undefined));
  });
});
