/**
 * Contract tests for the scan-matcher registry — late binding for the
 * 4 small-corpus matchers (territories, realms, themes, documents).
 * Same role as mind-search/registry.js, just keyed by table name.
 *
 * Pinning:
 *   - Multiple set/get cycles keyed by table name
 *   - setScanMatcher(name, null) clears that key
 *   - Unrelated keys are independent
 *   - Validation on bad inputs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setScanMatcher,
  getScanMatcher,
  clearScanMatchers,
} from '../../packages/core/mind-search/scan-matcher-registry.js';

describe('scan-matcher registry', () => {
  beforeEach(() => {
    clearScanMatchers();
  });

  it('returns null when nothing is registered', () => {
    assert.equal(getScanMatcher('territory_profiles'), null);
  });

  it('registers and reads back the same matcher', () => {
    const m = { search: async () => [], preload: async () => ({}) };
    setScanMatcher('realms', m);
    assert.equal(getScanMatcher('realms'), m);
  });

  it('keys are independent', () => {
    const a = { search: async () => [], _t: 'a' };
    const b = { search: async () => [], _t: 'b' };
    setScanMatcher('realms', a);
    setScanMatcher('documents', b);
    assert.equal(getScanMatcher('realms'), a);
    assert.equal(getScanMatcher('documents'), b);
  });

  it('setScanMatcher(name, null) clears that key only', () => {
    const a = { search: async () => [] };
    const b = { search: async () => [] };
    setScanMatcher('realms', a);
    setScanMatcher('documents', b);
    setScanMatcher('realms', null);
    assert.equal(getScanMatcher('realms'), null);
    assert.equal(getScanMatcher('documents'), b);
  });

  it('clearScanMatchers() drops all keys', () => {
    setScanMatcher('realms', { search: async () => [] });
    setScanMatcher('documents', { search: async () => [] });
    clearScanMatchers();
    assert.equal(getScanMatcher('realms'), null);
    assert.equal(getScanMatcher('documents'), null);
  });

  it('rejects empty tableName', () => {
    assert.throws(() => setScanMatcher('', { search: async () => [] }), /tableName required/);
  });

  it('rejects matcher missing search()', () => {
    assert.throws(() => setScanMatcher('realms', {}), /matcher.search required/);
  });
});
