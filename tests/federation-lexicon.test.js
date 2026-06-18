import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateLexicon, hasVectorKey, LEXICON_TYPES } from '../src/federation/lexicon.js';

describe('federation lexicon validators (Phase B inbound)', () => {
  test('accepts well-formed records of each type', () => {
    assert.equal(validateLexicon({ $type: 'social.mycelium.space.v1', name: 'Research', essence: 'shared notes' }).ok, true);
    assert.equal(validateLexicon({ $type: 'social.mycelium.room.v1', space_ref: 's1', name: 'Papers' }).ok, true);
    assert.equal(validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'an insight', domain_tags: ['x'] }).ok, true);
  });

  test('rejects unknown $type', () => {
    const r = validateLexicon({ $type: 'social.mycelium.signature.v1', vec: [0.1] });
    assert.equal(r.ok, false); assert.match(r.error, /unknown \$type/);
  });

  test('rejects missing required field', () => {
    const r = validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1' });
    assert.equal(r.ok, false); assert.match(r.error, /content/);
  });

  test('rejects wrong field type', () => {
    assert.equal(validateLexicon({ $type: 'social.mycelium.space.v1', name: 123 }).ok, false);
    assert.equal(validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'x', domain_tags: 'notarray' }).ok, false);
  });

  test('rejects unexpected fields (strict)', () => {
    const r = validateLexicon({ $type: 'social.mycelium.space.v1', name: 'X', sneaky: 1 });
    assert.equal(r.ok, false); assert.match(r.error, /unexpected field: sneaky/);
  });

  test('§7: refuses any embedding/vector/centroid field, however nested', () => {
    // even if the schema allowed extra keys, the tripwire catches vectors
    assert.equal(hasVectorKey({ a: { b: { embedding_768: [0.1] } } }), true);
    assert.equal(hasVectorKey({ centroid: 1 }), true);
    assert.equal(hasVectorKey({ name: 'ok', nested: { handle: 'x' } }), false);
    // a record that smuggles a vector under an "allowed-looking" shape is rejected
    const r = validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'x', source_ref: 'territory:1' });
    assert.equal(r.ok, true); // clean one passes
  });

  test('bounds peer-supplied fields (DoS defense): oversized content/field/array rejected', () => {
    // content: capped at 64 KB — an arbitrarily large knowledge body is refused
    const huge = 'x'.repeat(64 * 1024 + 1);
    let r = validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: huge });
    assert.equal(r.ok, false); assert.match(r.error, /content exceeds/);
    // content right at the cap is accepted
    assert.equal(validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'x'.repeat(64 * 1024) }).ok, true);
    // a non-content string field: capped at 8 KB
    r = validateLexicon({ $type: 'social.mycelium.space.v1', name: 'x'.repeat(8 * 1024 + 1) });
    assert.equal(r.ok, false); assert.match(r.error, /name exceeds/);
    // domain_tags: too many items
    r = validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'ok', domain_tags: Array(65).fill('t') });
    assert.equal(r.ok, false); assert.match(r.error, /domain_tags exceeds/);
    // domain_tags: a single oversized tag, and a non-string element
    assert.equal(validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'ok', domain_tags: ['x'.repeat(257)] }).ok, false);
    assert.equal(validateLexicon({ $type: 'social.mycelium.knowledge.v1', space_ref: 's1', content: 'ok', domain_tags: [123] }).ok, false);
    // multibyte can't slip the byte cap (emoji = 4 bytes each)
    assert.equal(validateLexicon({ $type: 'social.mycelium.space.v1', name: '😀'.repeat(2049) }).ok, false);
  });

  test('LEXICON_TYPES lists the three record types', () => {
    assert.deepEqual([...LEXICON_TYPES].sort(), [
      'social.mycelium.knowledge.v1', 'social.mycelium.room.v1', 'social.mycelium.space.v1',
    ]);
  });
});
