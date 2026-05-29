/**
 * Contract tests for the mind-search registry — the late-binding
 * holder used by db-d1's matchMessages to reach the agent-server's
 * mind-search instance without crossing package boundaries at import.
 *
 * Failure modes worth pinning:
 *   - Multiple set/get cycles must round-trip cleanly.
 *   - clearMindSearch() really clears (test-only contract).
 *   - getMindSearch() returns null when unset (callers fall back).
 *   - setMindSearch(null) is equivalent to clearing.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setMindSearch,
  getMindSearch,
  clearMindSearch,
} from '../../packages/core/mind-search/registry.js';

describe('mind-search registry', () => {
  beforeEach(() => {
    clearMindSearch();
  });

  it('returns null when nothing is registered', () => {
    assert.equal(getMindSearch(), null);
  });

  it('registers and reads back the same instance', () => {
    const fake = { _tag: 'fake-mindsearch' };
    setMindSearch(fake);
    assert.equal(getMindSearch(), fake);
  });

  it('overwrites on second set (last write wins)', () => {
    const a = { _tag: 'a' };
    const b = { _tag: 'b' };
    setMindSearch(a);
    setMindSearch(b);
    assert.equal(getMindSearch(), b);
  });

  it('setMindSearch(null) clears the registry', () => {
    setMindSearch({ _tag: 'transient' });
    setMindSearch(null);
    assert.equal(getMindSearch(), null);
  });

  it('setMindSearch(undefined) clears the registry', () => {
    setMindSearch({ _tag: 'transient' });
    setMindSearch(undefined);
    assert.equal(getMindSearch(), null);
  });

  it('clearMindSearch() resets to null', () => {
    setMindSearch({ _tag: 'transient' });
    clearMindSearch();
    assert.equal(getMindSearch(), null);
  });
});
