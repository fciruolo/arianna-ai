// The key of a local server the core starts (D-221): data/<id>.key, 0600.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';

import { DATA_DIR, resolveHome } from '@arianna/config';
import { authorization, ensureLocalKey, localKeys, readLocalKey } from '@arianna/executors';

const dir = join(resolveHome({}), DATA_DIR, 'test-tmp', randomUUID());

before(() => {
  mkdirSync(dir, { recursive: true });
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('ensureLocalKey creates a random key readable by this user only, then keeps it', () => {
  const key = ensureLocalKey(dir, 'omlx');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(join(dir, 'omlx.key')).mode & 0o777, 0o600);
  assert.equal(ensureLocalKey(dir, 'omlx'), key);
  assert.equal(readLocalKey(dir, 'omlx'), key);
  assert.equal(localKeys(dir)('omlx'), key);
  assert.notEqual(ensureLocalKey(dir, 'other'), key);
});

it('ensureLocalKey tightens a key file others can read', () => {
  const key = ensureLocalKey(dir, 'loose');
  chmodSync(join(dir, 'loose.key'), 0o644);
  assert.equal(ensureLocalKey(dir, 'loose'), key);
  assert.equal(statSync(join(dir, 'loose.key')).mode & 0o777, 0o600);
});

it('a missing or malformed key file is no key, and ensureLocalKey replaces it', () => {
  assert.equal(readLocalKey(dir, 'missing'), undefined);
  writeFileSync(join(dir, 'bad.key'), 'short\n');
  assert.equal(readLocalKey(dir, 'bad'), undefined);
  const key = ensureLocalKey(dir, 'bad');
  assert.equal(readFileSync(join(dir, 'bad.key'), 'utf8'), `${key}\n`);
});

it('an id that is not an endpoint id never names a file', () => {
  const escaping = ['..', 'escape'].join('/');
  assert.throws(() => ensureLocalKey(dir, escaping), /invalid endpoint id/);
  assert.equal(readLocalKey(dir, escaping), undefined);
  assert.equal(localKeys(dir)(escaping), undefined);
  assert.equal(localKeys(dir)('Upper'), undefined);
});

it('localKeys gives no key to an endpoint the core does not start, even with a file left', () => {
  const key = ensureLocalKey(dir, 'watched');
  assert.equal(localKeys(dir, (id) => id !== 'watched')('watched'), undefined);
  assert.equal(localKeys(dir, (id) => id === 'watched')('watched'), key);
});

it('authorization: a Bearer header with a key, nothing without', () => {
  assert.deepEqual(authorization('abc'), { authorization: 'Bearer abc' });
  assert.deepEqual(authorization(undefined), {});
});
