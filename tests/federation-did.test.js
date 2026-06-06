// tests/federation-did.test.js — did:web + WebFinger documents and resolution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDidDocument, buildWebfinger, resolveDidKey, toMultibase, fromMultibase } from '../src/federation/did.js';
import { createIdentity } from '../src/identity/identity.js';

const id = createIdentity({ masterHex: 'c'.repeat(64), handle: 'alice' });
const HOST = 'alice.mycelium.id';

describe('multibase', () => {
  it('round-trips an ed25519 public key through publicKeyMultibase (0xed01 z-base58btc)', () => {
    const mb = toMultibase(id.publicKeyB64);
    assert.equal(mb[0], 'z');
    assert.equal(fromMultibase(mb), id.publicKeyB64);
  });
  it('rejects a non-ed25519 / non-z multibase', () => {
    assert.throws(() => fromMultibase('Qabc'));
  });
});

describe('buildDidDocument', () => {
  it('builds a did:web doc whose key decodes back to the identity key', () => {
    const doc = buildDidDocument(HOST, id.publicKeyB64);
    assert.equal(doc.id, `did:web:${HOST}`);
    assert.equal(fromMultibase(doc.verificationMethod[0].publicKeyMultibase), id.publicKeyB64);
    assert.equal(doc.service[0].serviceEndpoint, `https://${HOST}/federation`);
  });
  it('fails closed for a missing/invalid host or key', () => {
    assert.equal(buildDidDocument('', id.publicKeyB64), null);
    assert.equal(buildDidDocument('has_underscore', id.publicKeyB64), null);
    assert.equal(buildDidDocument(HOST, ''), null);
  });
});

describe('buildWebfinger', () => {
  it('describes our own acct with a rel-includes-"federation" link', () => {
    const wf = buildWebfinger(HOST, 'alice', `acct:alice@${HOST}`);
    const fed = wf.links.find((l) => l.rel.includes('federation'));
    assert.ok(fed && fed.href === `https://${HOST}/federation`);
  });
  it('fails closed for a foreign or malformed resource', () => {
    assert.equal(buildWebfinger(HOST, 'alice', `acct:eve@${HOST}`), null);
    assert.equal(buildWebfinger(HOST, 'alice', 'acct:alice@evil.example'), null);
    assert.equal(buildWebfinger(HOST, 'alice', undefined), null);
  });
});

describe('resolveDidKey', () => {
  // fake fetch serving the did doc for HOST over a stubbed https
  function fakeFetch(servedDoc) {
    return async (url, init) => {
      assert.ok(url.startsWith('https://'), 'must be https');
      assert.equal(init.redirect, 'manual', 'must refuse redirects');
      if (url === `https://${HOST}/.well-known/did.json` && servedDoc) {
        return { ok: true, status: 200, async json() { return servedDoc; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
  }

  it('resolves a peer did:web key for inbound verification', async () => {
    const doc = buildDidDocument(HOST, id.publicKeyB64);
    const key = await resolveDidKey(`did:web:${HOST}`, { fetch: fakeFetch(doc) });
    assert.equal(key, id.publicKeyB64);
  });
  it('rejects a malformed did, an IP/port host, and a doc id mismatch', async () => {
    await assert.rejects(() => resolveDidKey('did:key:zabc', { fetch: fakeFetch(null) }));
    await assert.rejects(() => resolveDidKey('did:web:127.0.0.1:8080', { fetch: fakeFetch(null) }));
    const wrong = buildDidDocument(HOST, id.publicKeyB64); wrong.id = 'did:web:evil.example';
    await assert.rejects(() => resolveDidKey(`did:web:${HOST}`, { fetch: fakeFetch(wrong) }));
  });
});
