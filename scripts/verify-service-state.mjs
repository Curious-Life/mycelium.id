#!/usr/bin/env node
// verify:service-state — the ONE service-health taxonomy (QA6 P1 §3).
//
// serviceState() maps every supervisor status token onto exactly one of
// checking|loading|ready|degraded|failed, and isRetryable() keys the Retry offer
// off that. The two lies §3 kills, asserted directly:
//   • a LOADING service must NOT be 'failed' (no red over a thing that's coming up)
//   • an UNKNOWN service must NOT be 'ready' (no fabricated ✓; no "set up" over busy)
// Fail-closed: an unrecognised token is 'checking', never 'ready'. Mutation-proved
// by breaking the module (see the PR/handoff).

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { serviceState, isRetryable, normalizeHealth } from '../src/system/service-state.js';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  [✓] ${name}`); } catch (e) { fail++; console.log(`  [✗] ${name}\n      ${e?.message || e}`); } };

console.log('\nservice-state taxonomy (§3)');

// ── The five states, exhaustively over the real vocabulary ───────────────────
const CASES = {
  ready: ['ok', 'ready'],
  loading: ['loading', 'starting', 'downloading', 'installing_deps', 'checking', 'pulling'],
  degraded: ['no_model', 'paused', 'deps_missing', 'needs-runtime', 'unavailable'],
  failed: ['down', 'error', 'failed'],
  checking: ['unknown', '', null, undefined, 'a-token-no-supervisor-emits'],
};
for (const [state, tokens] of Object.entries(CASES)) {
  for (const tok of tokens) {
    t(`serviceState(${JSON.stringify(tok)}) === '${state}'`, () => assert.equal(serviceState(tok), state));
  }
}

// ── LIE #1: a loading service is never 'failed' (no red while it's coming up) ──
t('§3 LIE #1: no loading token maps to failed', () => {
  for (const tok of CASES.loading) assert.notEqual(serviceState(tok), 'failed', `${tok} painted a fault`);
});

// ── LIE #2: an unknown service is never 'ready' (no fabricated ✓ / "set up") ──
t('§3 LIE #2: no unknown/absent token maps to ready', () => {
  for (const tok of CASES.checking) assert.notEqual(serviceState(tok), 'ready', `${tok} faked liveness`);
});

// ── Retryability is a SEPARATE axis ──────────────────────────────────────────
t('every failed status is retryable', () => { for (const s of CASES.failed) assert.equal(isRetryable(s), true, s); });
t('a loading status is NOT retryable (nothing to retry — it IS trying)', () => { for (const s of CASES.loading) assert.equal(isRetryable(s), false, s); });
t('owner CHOICES (no_model/paused) are NOT retryable (a choice, not a retry)', () => {
  assert.equal(isRetryable('no_model'), false);
  assert.equal(isRetryable('paused'), false);
});
t('re-attemptable installs (deps_missing/needs-runtime/unavailable) ARE retryable', () => {
  assert.equal(isRetryable('deps_missing'), true);
  assert.equal(isRetryable('needs-runtime'), true);
  assert.equal(isRetryable('unavailable'), true);
});
t('unknown is NOT retryable (we do not even know there is a fault)', () => assert.equal(isRetryable('unknown'), false));

// ── normalizeHealth carries the fields through and never invents a status ─────
t('normalizeHealth(null) → checking, not ready', () => {
  const n = normalizeHealth(null);
  assert.equal(n.state, 'checking'); assert.equal(n.retryable, false); assert.equal(n.status, 'unknown');
});
t('normalizeHealth passes message/detail/model through', () => {
  const n = normalizeHealth({ status: 'down', message: 'm', detail: 'd', model: 'x' });
  assert.equal(n.state, 'failed'); assert.equal(n.retryable, true);
  assert.equal(n.message, 'm'); assert.equal(n.detail, 'd'); assert.equal(n.model, 'x');
});

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
