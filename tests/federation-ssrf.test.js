import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, assertResolvesPublic } from '../src/federation/ssrf.js';

describe('federation SSRF guard', () => {
  test('isPrivateAddress flags private / loopback / link-local / ULA / CGNAT', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '172.31.255.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
    }
  });
  test('isPrivateAddress allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
    }
  });

  test('assertResolvesPublic rejects a host that resolves to a private IP (DNS-rebinding)', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await assert.rejects(() => assertResolvesPublic('metadata.evil.example', { lookup }), /non-public address/);
  });
  test('assertResolvesPublic allows a host that resolves to a public IP', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    await assert.doesNotReject(() => assertResolvesPublic('example.com', { lookup }));
  });
  // ⚠️ THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-07-27, AND NOTHING RAN IT TO NOTICE.
  //
  // It used to read "allows when the host does not resolve (fetch will fail harmlessly)" and call
  // assert.doesNotReject. That was true of an EARLIER assertResolvesPublic. The guard was later
  // hardened to fail CLOSED, for the reason stated at src/federation/ssrf.js:109-118: an attacker
  // who can make the GUARD's resolver fail must not thereby get a free pass, because the FETCH's
  // own resolver may still succeed — and succeed to a private address. "The fetch will fail
  // harmlessly" is an assumption about a second resolver we do not control.
  //
  // The test was never updated, because `tests/federation-ssrf.test.js` was in NO npm script — one
  // of ELEVEN such files. So this file has been asserting a WEAKER security property than the code
  // actually enforces, invisibly, for as long as the hardening has been shipped.
  //
  // ⚠️ THE REAL DANGER IS THE OBVIOUS REPAIR. Someone who finally ran this, saw one red, and
  // "fixed" it the quick way — by making the guard permissive again — would have re-opened the SSRF
  // hole while turning the suite green. That is why the fix is to correct the TEST to the code's
  // current, stronger contract, and why the rationale is written down here rather than left to the
  // next reader's judgement.
  test('assertResolvesPublic REJECTS when the host does not resolve (fail-closed, not fail-open)', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(() => assertResolvesPublic('nope.invalid', { lookup }), /unresolvable host/);
  });
  // The same rule for an EMPTY answer: a resolver that returns no addresses has told us nothing,
  // and "no addresses" is not "no private addresses".
  test('assertResolvesPublic REJECTS an empty resolver answer (absence is not evidence)', async () => {
    const lookup = async () => [];
    await assert.rejects(() => assertResolvesPublic('empty.invalid', { lookup }), /unresolvable host/);
  });
  test('assertResolvesPublic rejects if ANY resolved address is private', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await assert.rejects(() => assertResolvesPublic('split.evil.example', { lookup }), /non-public/);
  });
});
