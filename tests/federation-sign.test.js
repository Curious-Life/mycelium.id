// tests/federation-sign.test.js — canonicalization + detached-signature verify.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, verifyDetached } from '../src/federation/sign.js';
import { createIdentity } from '../src/identity/identity.js';

const MASTER = 'a'.repeat(64);

describe('canonicalize', () => {
  it('is stable regardless of key insertion order', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });
  it('sorts keys at every nesting level and preserves array order', () => {
    const s = canonicalize({ z: [3, 1, 2], a: { y: 1, x: 2 } });
    assert.equal(s, '{"a":{"x":2,"y":1},"z":[3,1,2]}');
  });
  it('handles primitives and null', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize('hi'), '"hi"');
    assert.equal(canonicalize(42), '42');
  });
});

describe('verifyDetached', () => {
  const id = createIdentity({ masterHex: MASTER, handle: 'alice' });
  const body = canonicalize({ $type: 'x', nonce: 'n1', ts: 123 });
  const sig = id.sign(body);

  it('accepts a valid signature over the raw body', () => {
    assert.equal(verifyDetached(id.publicKeyB64, body, sig), true);
  });
  it('rejects a tampered body (fail closed)', () => {
    assert.equal(verifyDetached(id.publicKeyB64, body + ' ', sig), false);
  });
  it('rejects a signature from a different key', () => {
    const other = createIdentity({ masterHex: 'b'.repeat(64), handle: 'alice' });
    assert.equal(verifyDetached(id.publicKeyB64, body, other.sign(body)), false);
  });
  it('rejects missing inputs without throwing', () => {
    assert.equal(verifyDetached(id.publicKeyB64, body, ''), false);
    assert.equal(verifyDetached('', body, sig), false);
    assert.equal(verifyDetached(id.publicKeyB64, body, 'not-base64!!'), false);
  });
});
