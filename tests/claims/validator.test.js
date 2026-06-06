// tests/claims/validator.test.js — evidence validator. Stubs the inference
// router (no live model); asserts the relation→ω mapping, the NON-NEGOTIABLE
// sensitive:true on every call, robust parsing, and fail-safe behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator, RELATION_OMEGA } from '../../src/claims/validator.js';

const CLAIM = { claimType: 'boundary', content: 'The user has a severe peanut allergy.' };

function stub(reply, calls = []) {
  return createValidator({
    infer: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; },
  });
}

test('maps each relation label to its evidence weight ω', async () => {
  for (const [rel, omega] of Object.entries(RELATION_OMEGA)) {
    const v = stub(`{"relation":"${rel}","rationale":"x"}`);
    const r = await v.validate('ate a peanut bar, no reaction', CLAIM);
    assert.equal(r.relation, rel);
    assert.equal(r.omega, omega);
  }
});

test('EVERY infer call passes sensitive:true (egress hard-block)', async () => {
  const calls = [];
  const v = stub('{"relation":"strong_support","rationale":"x"}', calls);
  await v.validate('carries an epipen everywhere', CLAIM);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sensitive, true);
  assert.equal(calls[0].task, 'classify');
});

test('parses JSON embedded in prose', async () => {
  const v = stub('Sure! Here is my judgment: {"relation":"weak_conflict","rationale":"ate nuts"} — done.');
  const r = await v.validate('had a peanut snack', CLAIM);
  assert.equal(r.relation, 'weak_conflict');
  assert.equal(r.omega, -0.4);
});

test('unknown/garbage relation falls back to unrelated (ω=0, no spurious update)', async () => {
  for (const reply of ['{"relation":"banana"}', 'not json at all', '{"oops":true}']) {
    const r = await stub(reply).validate('went hiking', CLAIM);
    assert.equal(r.relation, 'unrelated');
    assert.equal(r.omega, 0);
  }
});

test('infer throwing → fail-safe no-op, never throws upward', async () => {
  const v = createValidator({ infer: async () => { throw new Error('ollama down'); } });
  const r = await v.validate('something', CLAIM);
  assert.equal(r.omega, 0);
  assert.match(r.rationale, /unavailable/);
});

test('empty input → no-op without calling the model', async () => {
  const calls = [];
  const v = stub('{"relation":"strong_support"}', calls);
  const r = await v.validate('', CLAIM);
  assert.equal(r.omega, 0);
  assert.equal(calls.length, 0, 'must not call the model with nothing to judge');
});

test('rationale is truncated', async () => {
  const long = 'z'.repeat(500);
  const r = await stub(`{"relation":"unrelated","rationale":"${long}"}`).validate('x', CLAIM);
  assert.ok(r.rationale.length <= 120);
});

test('createValidator requires an infer function', () => {
  assert.throws(() => createValidator({}), /infer required/);
});
