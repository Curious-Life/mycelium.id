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
  test('assertResolvesPublic allows when the host does not resolve (fetch will fail harmlessly)', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.doesNotReject(() => assertResolvesPublic('nope.invalid', { lookup }));
  });
  test('assertResolvesPublic rejects if ANY resolved address is private', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await assert.rejects(() => assertResolvesPublic('split.evil.example', { lookup }), /non-public/);
  });
});
