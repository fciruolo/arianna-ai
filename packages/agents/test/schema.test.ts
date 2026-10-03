import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validate } from '../src/schema.ts';

describe('validate', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 3 },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      kind: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('accepts a conforming value', () => {
    assert.deepEqual(validate(schema, { name: 'ab', n: 3, kind: 'a', list: ['x'] }), []);
  });

  it('reports each kind of violation', () => {
    assert.deepEqual(validate(schema, {}), ['$.name: required']);
    assert.deepEqual(validate(schema, { name: '' }), ['$.name: too short']);
    assert.deepEqual(validate(schema, { name: 'abcd' }), ['$.name: too long']);
    assert.deepEqual(validate(schema, { name: 'a', n: 1.5 }), ['$.n: expected an integer']);
    assert.deepEqual(validate(schema, { name: 'a', n: 9 }), ['$.n: above maximum']);
    assert.deepEqual(validate(schema, { name: 'a', kind: 'c' }), ['$.kind: not one of ["a","b"]']);
    assert.deepEqual(validate(schema, { name: 'a', list: [] }), ['$.list: too few items']);
    assert.deepEqual(validate(schema, { name: 'a', list: [1] }), ['$.list[0]: expected a string']);
    assert.deepEqual(validate(schema, { name: 'a', extra: 1 }), ['$.extra: not allowed']);
    assert.deepEqual(validate(schema, []), ['$: expected an object']);
  });

  it('handles const and anyOf', () => {
    const either = { anyOf: [{ const: 'x' }, { type: 'integer' }] };
    assert.deepEqual(validate(either, 'x'), []);
    assert.deepEqual(validate(either, 2), []);
    assert.deepEqual(validate(either, 'y'), ['$: matches no option']);
  });

  it('rejects keywords it does not implement, instead of ignoring them', () => {
    assert.throws(() => validate({ type: 'string', pattern: '^a' }, 'a'), /unsupported schema keyword/);
    assert.throws(() => validate({ type: 'null' }, null), /unsupported type/);
  });
});
