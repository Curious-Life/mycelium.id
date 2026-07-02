// tests/vault-disk-guard.test.js — fail-closed disk-space guard arithmetic + throw.
// Deterministic without mocking fs: drive ok/not-ok via extreme floorGb/factor so the
// real free space can't flip the result. @see src/db/disk-guard.js,
// docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDiskHeadroom, assertVaultDiskHeadroom } from '../src/db/disk-guard.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskguard-'));
const vault = path.join(tmp, 'vault.db');
fs.writeFileSync(vault, Buffer.alloc(4096, 1)); // a tiny stand-in vault file

describe('disk-guard', () => {
  it('reports headroom shape and passes when the requirement is ~zero', () => {
    const r = vaultDiskHeadroom(vault, { floorGb: 0, factor: 0 });
    assert.equal(r.ok, true);
    assert.equal(typeof r.freeBytes, 'number');
    assert.equal(typeof r.needBytes, 'number');
    assert.equal(r.vaultBytes, 4096);
    assert.ok(r.freeGb >= 0 && r.needGb >= 0);
  });

  it('assert passes (returns headroom) with a trivial requirement', () => {
    const r = assertVaultDiskHeadroom(vault, { floorGb: 0, factor: 0 });
    assert.equal(r.ok, true);
  });

  it('assert throws a tagged DISK_LOW error when free < required', () => {
    let err;
    try { assertVaultDiskHeadroom(vault, { floorGb: 1e9 }); } catch (e) { err = e; } // ~1e9 GiB required
    assert.ok(err, 'expected a throw');
    assert.equal(err.code, 'DISK_LOW');
    assert.match(err.message, /DISK_LOW/);
    assert.equal(err.detail.ok, false);
    // fail-closed: never leak vault contents in the message — sizes only
    assert.doesNotMatch(err.message, /vault\.db|[01]{16}/);
  });

  it('missing vault file → vaultBytes 0, floor still enforced', () => {
    const r = vaultDiskHeadroom(path.join(tmp, 'nope.db'), { floorGb: 3, factor: 2 });
    assert.equal(r.vaultBytes, 0);
    assert.equal(r.needBytes, 3 * 2 ** 30); // floor, since 0 * factor = 0
  });
});
